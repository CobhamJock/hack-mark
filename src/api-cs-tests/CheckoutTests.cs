using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using OctoSupply.Api.Controllers;
using OctoSupply.Api.Data;
using OctoSupply.Api.Models;
using OctoSupply.Api.Repositories;
using OctoSupply.Api.Services;
using OctoSupply.Api.Utils;
using Xunit;

namespace OctoSupply.Api.Tests;

public sealed class CheckoutTests : IAsyncLifetime
{
    private readonly Dictionary<string, string?> _environment = new();
    private readonly FakeProvider _provider = new();
    private string _db = null!;
    private SqliteConnectionFactory _factory = null!;
    private WebApplication _app = null!;
    private HttpClient _client = null!;
    private string _id = Guid.NewGuid().ToString();

    public async Task InitializeAsync()
    {
        var root = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (root is not null && !Directory.Exists(Path.Combine(root.FullName, "src", "database", "migrations")))
            root = root.Parent;
        _db = Path.Combine(root!.FullName, "src", "api-cs-tests", $"checkout-tests-{Guid.NewGuid():N}.db");
        Env("DB_FILE", _db);
        Env("DB_MIGRATIONS_DIR", Path.Combine(root.FullName, "src", "database", "migrations"));
        Env("PAYMENT_PROVIDER", "stripe");
        Env("STRIPE_SECRET_KEY", "sk_test_never_sent");
        Env("CHECKOUT_PUBLIC_URL", "http://localhost:5137");
        _factory = new(NullLogger<SqliteConnectionFactory>.Instance);
        await new DatabaseMigrator(_factory, NullLogger<DatabaseMigrator>.Instance).InitializeAsync(false);
        await Sql("""
            INSERT INTO suppliers(supplier_id,name) VALUES(1,'Supplier');
            INSERT INTO headquarters(headquarters_id,name) VALUES(1,'HQ');
            INSERT INTO branches(branch_id,headquarters_id,name) VALUES(1,1,'Branch');
            INSERT INTO products(product_id,supplier_id,name,price,discount,sku,unit)
            VALUES(1,1,'First',12.35,0.1,'ONE','each'),(2,1,'Second',3.25,0,'TWO','each');
            INSERT INTO inventory(branch_id,product_id,quantity_on_hand) VALUES(1,1,20),(1,2,20);
            """);
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddControllers().AddApplicationPart(typeof(CheckoutController).Assembly)
            .ConfigureApiBehaviorOptions(ApiValidation.Configure);
        builder.Services.AddOpenApi();
        builder.Services.AddSingleton(_factory);
        builder.Services.AddScoped<CheckoutsRepository>();
        builder.Services.AddScoped<ICheckoutService, CheckoutService>();
        builder.Services.AddSingleton<IPaymentProvider>(_provider);
        _app = builder.Build();
        _app.UseMiddleware<ErrorHandlingMiddleware>();
        _app.MapControllers();
        _app.MapOpenApi("/api-docs.json");
        await _app.StartAsync();
        _client = new() { BaseAddress = new Uri(_app.Services.GetRequiredService<IServer>().Features
            .Get<IServerAddressesFeature>()!.Addresses.Single()) };
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await _app.DisposeAsync();
        SqliteConnection.ClearAllPools();
        foreach (var (name, value) in _environment) Environment.SetEnvironmentVariable(name, value);
        foreach (var suffix in new[] { "", "-wal", "-shm" })
            if (File.Exists(_db + suffix)) File.Delete(_db + suffix);
    }

    [Fact]
    public async Task HappyPath_UsesCanonicalSnapshotAndCreatesExactlyOneOrder()
    {
        var pending = await Created();
        Assert.Equal("pending", pending.Status);
        Assert.Equal(2224, pending.AmountTotal);
        Assert.Equal("usd", pending.Currency);
        Assert.Equal(20, await Scalar("SELECT quantity_on_hand FROM inventory WHERE product_id=1;"));
        Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM checkouts WHERE status='pending';"));
        Assert.Equal(1112, _provider.Snapshot!.Items[0].UnitPriceCents);
        var canonical = JsonDocument.Parse(_provider.Snapshot.RequestJson).RootElement;
        Assert.Equal(2, canonical.GetProperty("items")[0].GetProperty("quantity").GetInt32());
        await Sql("UPDATE products SET price=900,name='Changed' WHERE product_id=1;");
        await Created("""[{"quantity":1,"productId":1},{"productId":1,"quantity":1}]""");
        Assert.Equal(1, _provider.Creates);
        _provider.Paid();
        var completed = await Complete();
        Assert.Equal("completed", completed.Status);
        Assert.NotNull(completed.OrderId);
        var calls = _provider.Retrieves;
        Assert.Equal(completed, await Complete());
        Assert.Equal(calls, _provider.Retrieves);
        Env("STRIPE_SECRET_KEY", null);
        Assert.Equal(completed, await Created());
        Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM orders WHERE status='confirmed';"));
        Assert.Equal(18, await Scalar("SELECT quantity_on_hand FROM inventory WHERE product_id=1;"));
        Assert.Equal(1112, await Scalar("SELECT CAST(ROUND(unit_price*100) AS INTEGER) FROM order_details;"));
        Assert.Equal(0, _provider.Refunds);
    }

    [Fact]
    public async Task RequestRetry_IsSemanticAndMismatchConflicts()
    {
        await Created("""[{"productId":2,"quantity":1},{"productId":1,"quantity":1},{"productId":1,"quantity":1}]""");
        await Sql("""
            UPDATE checkouts SET request_json='{"items":[{"quantity":1,"productId":2},{"quantity":2,"productId":1}],"branchId":1}';
            """);
        await Created("""[{"productId":1,"quantity":2},{"productId":2,"quantity":1}]""");
        await Error(await Create("""[{"productId":1,"quantity":3}]"""), 409, "CONFLICT");
        Assert.Equal(1, _provider.Creates);
    }

    [Fact]
    public async Task CreatingRow_IsDurableBeforeProvider_AndRecoversSameSnapshot()
    {
        _provider.CreateFailure = true;
        _provider.BeforeCreate = async checkout =>
        {
            Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM checkouts WHERE status='creating';"));
            Assert.Null(checkout.ProviderSessionId);
        };
        await Error(await Create(), 502, "PAYMENT_PROVIDER_ERROR");
        var snapshot = _provider.Snapshot;
        await Sql("UPDATE products SET price=100; DELETE FROM inventory;");
        _provider.CreateFailure = false;
        await Created();
        Assert.Equal(snapshot, _provider.Snapshot);
        Assert.Equal(2, _provider.Creates);
        Assert.Equal(2224, _provider.Snapshot!.AmountTotal);
    }

    [Fact]
    public async Task UnknownCreatingOlderThan23Hours_RequiresReconciliation()
    {
        _provider.CreateFailure = true;
        await Create();
        await Sql("UPDATE checkouts SET created_at=datetime('now','-24 hours');");
        await Error(await Create(), 409, "CONFLICT");
        Assert.Equal(1, _provider.Creates);
    }

    [Fact]
    public async Task UnpaidDeclinedAndProviderFailure_NeverCreateOrder()
    {
        await Created();
        await Error(await Post("complete"), 409, "PAYMENT_PENDING");
        _provider.RetrieveFailure = true;
        await Error(await Post("complete"), 502, "PAYMENT_PROVIDER_ERROR");
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM orders;"));
        Assert.Equal(20, await Scalar("SELECT quantity_on_hand FROM inventory WHERE product_id=1;"));
        _provider.RetrieveFailure = false;
        _provider.Session = _provider.Session! with { Status = "expired" };
        Assert.Equal("cancelled", (await Complete()).Status);
        var retrieves = _provider.Retrieves;
        Assert.Equal("cancelled", (await Complete()).Status);
        Assert.Equal(retrieves, _provider.Retrieves);
    }

    [Theory]
    [InlineData("amount")]
    [InlineData("currency")]
    [InlineData("id")]
    [InlineData("reference")]
    [InlineData("metadata")]
    [InlineData("intent")]
    [InlineData("status")]
    public async Task TamperedSession_IsRejected(string field)
    {
        await Created();
        _provider.Paid();
        var s = _provider.Session!;
        _provider.Session = field switch
        {
            "amount" => s with { AmountTotal = 1 },
            "currency" => s with { Currency = "eur" },
            "id" => s with { Id = "other" },
            "reference" => s with { ClientReferenceId = Guid.NewGuid().ToString() },
            "metadata" => s with { CheckoutId = null },
            "intent" => s with { PaymentIntentId = "" },
            _ => s with { Status = "open" }
        };
        await Error(await Post("complete"), 502, "PAYMENT_PROVIDER_ERROR");
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM orders;"));
        Assert.Equal(0, _provider.Refunds);
    }

    [Fact]
    public async Task MissingStockBranchAndProduct_FailBeforeProvider()
    {
        await Sql("DELETE FROM inventory;");
        await Error(await Create(), 409, "INSUFFICIENT_STOCK");
        await Error(await Create("""[{"productId":999,"quantity":1}]"""), 404, "NOT_FOUND");
        await Error(await Create(branch: 999), 404, "NOT_FOUND");
        Assert.Equal(0, _provider.Creates);
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM checkouts;"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task StockRaceOrPersistenceFailure_RollsBackThenDurablyRefunds(bool persistenceFailure)
    {
        await Created("""[{"productId":1,"quantity":2},{"productId":2,"quantity":1}]""");
        _provider.Paid();
        if (persistenceFailure)
            await Sql("""
                CREATE TRIGGER fail_completion BEFORE UPDATE OF status ON checkouts
                WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'Injected failure'); END;
                """);
        else await Sql("UPDATE inventory SET quantity_on_hand=0 WHERE product_id=2;");
        _provider.BeforeRefund = async () =>
        {
            Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM checkouts WHERE status='refund_pending' AND payment_intent_id='pi_test';"));
            Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM orders;"));
            Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM order_details;"));
            Assert.Equal(20, await Scalar("SELECT quantity_on_hand FROM inventory WHERE product_id=1;"));
        };
        Assert.Equal("refunded", (await Complete()).Status);
        Assert.Equal("refunded", (await Complete()).Status);
        Assert.Equal(1, _provider.Refunds);
        Assert.Equal("refunded", (await Created("""[{"productId":1,"quantity":2},{"productId":2,"quantity":1}]""")).Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RefundFailure_IsDurableAndRetryNeverCreatesAnOrder(bool network)
    {
        await Created("""[{"productId":1,"quantity":2},{"productId":2,"quantity":1}]""");
        _provider.Paid();
        await Sql("UPDATE inventory SET quantity_on_hand=0 WHERE product_id=2;");
        _provider.RefundSucceeds = false;
        _provider.RefundFailure = network;
        await Error(await Post("complete"), 502, "REFUND_PENDING");
        Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM checkouts WHERE status='refund_pending';"));
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM orders;"));
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM order_details;"));
        Assert.Equal(20, await Scalar("SELECT quantity_on_hand FROM inventory WHERE product_id=1;"));
        await Sql("UPDATE inventory SET quantity_on_hand=20;");
        _provider.RefundSucceeds = true;
        _provider.RefundFailure = false;
        Assert.Equal("refunded", (await Complete()).Status);
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM orders;"));
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM order_details;"));
        Assert.Equal(20, await Scalar("SELECT quantity_on_hand FROM inventory WHERE product_id=1;"));
        Assert.Equal(2, _provider.Refunds);
    }

    [Fact]
    public async Task ConcurrentFinalization_OnlyOneOrderAndStockAllocation()
    {
        await Created();
        _provider.Paid();
        _provider.RetrieveDelay = true;
        var responses = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => Post("complete")));
        foreach (var response in responses) Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var results = await Task.WhenAll(responses.Select(r => r.Content.ReadFromJsonAsync<CheckoutResponse>()));
        Assert.Single(results.Select(r => r!.OrderId).Distinct());
        Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM orders;"));
        Assert.Equal(18, await Scalar("SELECT quantity_on_hand FROM inventory WHERE product_id=1;"));
        Assert.Equal(0, _provider.Refunds);
    }

    [Fact]
    public async Task Cancel_ExpiresBeforePersistence_AndPaidCompletesInstead()
    {
        await Created();
        _provider.ExpireFailure = true;
        await Error(await Post("cancel"), 502, "PAYMENT_PROVIDER_ERROR");
        Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM checkouts WHERE status='pending';"));
        _provider.ExpireFailure = false;
        Assert.Equal("cancelled", (await Read(await Post("cancel"))).Status);
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM orders;"));
        var calls = _provider.Retrieves;
        Assert.Equal("cancelled", (await Read(await Post("cancel"))).Status);
        Assert.Equal(calls, _provider.Retrieves);
        _id = Guid.NewGuid().ToString();
        await Created();
        _provider.Paid();
        Assert.Equal("completed", (await Read(await Post("cancel"))).Status);
    }

    [Fact]
    public async Task Cancel_WhenPaymentWinsExpiryRace_CompletesInsteadOfCancelling()
    {
        await Created();
        _provider.ExpirePays = true;
        Assert.Equal("completed", (await Read(await Post("cancel"))).Status);
        Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM orders;"));
        Assert.Equal(0, _provider.Refunds);
    }

    [Theory]
    [InlineData("upper")]
    [InlineData("newline")]
    [InlineData("version")]
    public async Task Capability_MustBeExactlyLowercaseUuidV4(string variant)
    {
        var id = variant switch
        {
            "upper" => "ABCDEFAB-1234-4234-8234-123456789012",
            "newline" => _id + "\n",
            _ => "abcdefab-1234-1234-8234-123456789012"
        };
        var response = await _client.PostAsJsonAsync("/api/checkout",
            new { checkoutId = id, branchId = 1, items = new[] { new { productId = 1, quantity = 1 } } });
        await Error(response, 400, "VALIDATION_ERROR");
        Assert.Equal(0, _provider.Creates);
    }

    [Theory]
    [InlineData("""{"checkoutId":"BAD","branchId":1,"items":[{"productId":1,"quantity":1}]}""")]
    [InlineData("""{"branchId":1,"items":[{"productId":1,"quantity":1}]}""")]
    [InlineData("""{"checkoutId":"ID","branchId":2147483648,"items":[{"productId":1,"quantity":1}]}""")]
    [InlineData("""{"checkoutId":"ID","branchId":"1","items":[{"productId":1,"quantity":1}]}""")]
    [InlineData("""{"checkoutId":"ID","branchId":1,"items":[]}""")]
    [InlineData("""{"checkoutId":"ID","branchId":1,"items":[null]}""")]
    [InlineData("""{"checkoutId":"ID","branchId":1,"items":[{"productId":1,"quantity":1.5}]}""")]
    [InlineData("""{"checkoutId":"ID","branchId":1,"items":[{"productId":1,"quantity":"1"}]}""")]
    [InlineData("""{"checkoutId":"ID","branchId":1,"items":[{"productId":1,"quantity":0}]}""")]
    [InlineData("""{"checkoutId":"ID","branchId":1,"items":[{"productId":1,"quantity":2147483647},{"productId":1,"quantity":1}]}""")]
    public async Task InvalidRequests_AreStandardValidationErrors(string body)
    {
        await Error(await _client.PostAsync("/api/checkout", new StringContent(body.Replace("ID", _id),
            Encoding.UTF8, "application/json")), 400, "VALIDATION_ERROR");
        Assert.Equal(0, _provider.Creates);
    }

    [Fact]
    public async Task LineAndAmountLimits_AreEnforced_AndHalfCentRoundsUp()
    {
        var tooMany = JsonSerializer.Serialize(Enumerable.Repeat(new { productId = 1, quantity = 1 }, 101));
        await Error(await Create(tooMany), 400, "VALIDATION_ERROR");
        await Sql("UPDATE products SET price=1000000 WHERE product_id=1;");
        await Error(await Create(), 400, "VALIDATION_ERROR");
        await Sql("UPDATE products SET price=0 WHERE product_id=1;");
        await Error(await Create(), 400, "VALIDATION_ERROR");
        await Sql("UPDATE products SET price=0.245,discount=0 WHERE product_id=1;");
        Assert.Equal(50, (await Created()).AmountTotal);
    }

    [Fact]
    public async Task TotalBelowStripeMinimum_IsRejectedBeforePersistenceOrProvider()
    {
        await Sql("UPDATE products SET price=0.49,discount=0 WHERE product_id=1;");
        await Error(await Create("""[{"productId":1,"quantity":1}]"""), 400, "VALIDATION_ERROR");
        Assert.Equal(0, _provider.Creates);
        Assert.Equal(0, await Scalar("SELECT COUNT(*) FROM checkouts;"));
        await Sql("UPDATE products SET price=0.50 WHERE product_id=1;");
        Assert.Equal(50, (await Created("""[{"productId":1,"quantity":1}]""")).AmountTotal);
    }

    [Theory]
    [InlineData("https://checkout.stripe.com:8443/c/pay/test")]
    [InlineData("https://user:pass@checkout.stripe.com/c/pay/test")]
    [InlineData("http://checkout.stripe.com/c/pay/test")]
    [InlineData("https://checkout.stripe.com.evil.test/c/pay/test")]
    public async Task CheckoutRedirect_RequiresExactStripeOrigin(string url)
    {
        _provider.CheckoutUrl = url;
        await Error(await Create(), 502, "PAYMENT_PROVIDER_ERROR");
        Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM checkouts WHERE status='creating' AND checkout_url IS NULL;"));
    }

    [Fact]
    public async Task MissingCheckout_AndOpenApi()
    {
        await Error(await Post("complete"), 404, "NOT_FOUND");
        await Error(await Post("cancel"), 404, "NOT_FOUND");
        var json = await _client.GetStringAsync("/api-docs.json");
        Assert.Contains("/api/checkout/{id}/complete", json);
        Assert.Contains("/api/checkout/{id}/cancel", json);
        Assert.Contains("CheckoutResponse", json);
    }

    [Fact]
    public async Task SharedMigration_IsAppliedOnceAndEnforcesConstraints()
    {
        await new DatabaseMigrator(_factory, NullLogger<DatabaseMigrator>.Instance).InitializeAsync(false);
        Assert.Equal(1, await Scalar("SELECT COUNT(*) FROM migrations WHERE version=4;"));
        await Created();
        foreach (var sql in new[]
        {
            "UPDATE checkouts SET currency='eur';", "UPDATE checkouts SET amount_total=0;",
            "UPDATE checkouts SET status='unknown';", "UPDATE checkouts SET branch_id=999;"
        })
            await Assert.ThrowsAsync<SqliteException>(() => Sql(sql));
    }

    [Theory]
    [InlineData("PAYMENT_PROVIDER", "other")]
    [InlineData("STRIPE_SECRET_KEY", "")]
    [InlineData("CHECKOUT_PUBLIC_URL", "http://example.com")]
    [InlineData("CHECKOUT_PUBLIC_URL", "https://example.com/path")]
    [InlineData("CHECKOUT_PUBLIC_URL", "https://user:pass@example.com")]
    [InlineData("CHECKOUT_PUBLIC_URL", "https://example.com?x=1")]
    [InlineData("CHECKOUT_PUBLIC_URL", "https://example.com#fragment")]
    public async Task InvalidConfiguration_Is503BeforeAnyRemoteCall(string name, string value)
    {
        Env(name, value);
        await Error(await Create(), 503, "PAYMENT_UNAVAILABLE");
        Assert.Equal(0, _provider.Creates);
    }

    private Task<HttpResponseMessage> Create(string items = """[{"productId":1,"quantity":2}]""", int branch = 1) =>
        _client.PostAsync("/api/checkout", new StringContent(
            $$"""{"checkoutId":"{{_id}}","branchId":{{branch}},"items":{{items}}}""", Encoding.UTF8, "application/json"));
    private Task<HttpResponseMessage> Post(string action) => _client.PostAsync($"/api/checkout/{_id}/{action}", null);
    private async Task<CheckoutResponse> Created(string items = """[{"productId":1,"quantity":2}]""") => await Read(await Create(items));
    private async Task<CheckoutResponse> Complete() => await Read(await Post("complete"));
    private static async Task<CheckoutResponse> Read(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<CheckoutResponse>())!;
    }
    private static async Task Error(HttpResponseMessage response, int status, string code)
    {
        Assert.Equal(status, (int)response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Equal(code, JsonDocument.Parse(body).RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.DoesNotContain("sk_test", body);
    }
    private void Env(string name, string? value)
    {
        _environment.TryAdd(name, Environment.GetEnvironmentVariable(name));
        Environment.SetEnvironmentVariable(name, value);
    }
    private async Task Sql(string sql)
    {
        await using var connection = await _factory.OpenConnectionAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }
    private async Task<long> Scalar(string sql)
    {
        await using var connection = await _factory.OpenConnectionAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        return Convert.ToInt64(await cmd.ExecuteScalarAsync());
    }

    private sealed class FakeProvider : IPaymentProvider
    {
        public int Creates, Retrieves, Refunds;
        public bool CreateFailure, RetrieveFailure, RefundFailure, ExpireFailure, RetrieveDelay, ExpirePays;
        public bool RefundSucceeds = true;
        public CheckoutPayment? Snapshot;
        public string CheckoutUrl = "https://checkout.stripe.com/c/pay/test";
        public PaymentSession? Session;
        public Func<CheckoutPayment, Task>? BeforeCreate;
        public Func<Task>? BeforeRefund;
        public void ValidateConfiguration()
        {
            using var client = new HttpClient();
            new StripePaymentProvider(client).ValidateConfiguration();
        }
        public async Task<PaymentSession> CreateAsync(CheckoutPayment checkout, CancellationToken ct)
        {
            Interlocked.Increment(ref Creates);
            Snapshot = checkout;
            if (BeforeCreate is not null) await BeforeCreate(checkout);
            if (CreateFailure) throw StripePaymentProvider.ProviderError();
            return Session = new($"cs_test_{checkout.CheckoutId}", CheckoutUrl, checkout.CheckoutId,
                checkout.CheckoutId, "usd", checkout.AmountTotal, "open", "unpaid", null);
        }
        public void Paid() => Session = Session! with { Status = "complete", PaymentStatus = "paid", PaymentIntentId = "pi_test" };
        public async Task<PaymentSession> RetrieveAsync(string sessionId, CancellationToken ct)
        {
            Interlocked.Increment(ref Retrieves);
            if (RetrieveDelay) await Task.Delay(30, ct);
            if (RetrieveFailure) throw StripePaymentProvider.ProviderError();
            return Session!;
        }
        public Task<PaymentSession> ExpireAsync(string sessionId, CancellationToken ct)
        {
            if (ExpireFailure) throw StripePaymentProvider.ProviderError();
            if (ExpirePays) Paid();
            else Session = Session! with { Status = "expired" };
            return Task.FromResult(Session!);
        }
        public async Task<bool> RefundAsync(string checkoutId, string paymentIntentId, CancellationToken ct)
        {
            Interlocked.Increment(ref Refunds);
            Assert.Equal("pi_test", paymentIntentId);
            if (BeforeRefund is not null) await BeforeRefund();
            if (RefundFailure) throw StripePaymentProvider.ProviderError();
            return RefundSucceeds;
        }
    }
}
