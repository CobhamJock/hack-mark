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
using OctoSupply.Api.Utils;
using Xunit;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace OctoSupply.Api.Tests;

public sealed class InventoryTests : IAsyncLifetime
{
    private readonly Dictionary<string, string?> _environment = new();
    private string _dbPath = null!;
    private WebApplication _app = null!;
    private HttpClient _client = null!;
    private SqliteConnectionFactory _factory = null!;
    private string _root = null!;

    public async Task InitializeAsync()
    {
        var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "src", "database", "migrations")))
            directory = directory.Parent;
        _root = directory?.FullName ?? throw new InvalidOperationException("Repository root not found");
        _dbPath = Path.Combine(_root, "src", "api-cs-tests", $"inventory-tests-{Guid.NewGuid():N}.db");
        SetEnvironment("DB_FILE", _dbPath);
        SetEnvironment("DB_MIGRATIONS_DIR", Path.Combine(_root, "src", "database", "migrations"));
        SetEnvironment("INVENTORY_ADMIN_TOKEN", "test-inventory-admin");
        _factory = new SqliteConnectionFactory(NullLogger<SqliteConnectionFactory>.Instance);
        await new DatabaseMigrator(_factory, NullLogger<DatabaseMigrator>.Instance).InitializeAsync(false);
        await ExecuteAsync("""
            INSERT INTO suppliers (supplier_id, name) VALUES (1, 'Supplier');
            INSERT INTO headquarters (headquarters_id, name) VALUES (1, 'HQ');
            INSERT INTO branches (branch_id, headquarters_id, name) VALUES (1, 1, 'One'), (2, 1, 'Two');
            INSERT INTO products (product_id, supplier_id, name, price, sku, unit, discount)
                VALUES (1, 1, 'First', 12.35, 'ONE', 'each', 0.1),
                       (2, 1, 'Second', 3.25, 'TWO', 'each', 0);
            """);

        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddControllers().AddApplicationPart(typeof(ProductsController).Assembly)
            .ConfigureApiBehaviorOptions(ApiValidation.Configure);
        builder.Services.AddSingleton(_factory);
        builder.Services.AddScoped<ProductsRepository>();
        builder.Services.AddScoped<OrdersRepository>();
        builder.Services.AddScoped<OrderDetailsRepository>();
        builder.Services.AddScoped<InventoryRepository>();
        _app = builder.Build();
        _app.UseMiddleware<ErrorHandlingMiddleware>();
        _app.MapControllers();
        await _app.StartAsync();
        var address = _app.Services.GetRequiredService<IServer>().Features
            .Get<IServerAddressesFeature>()!.Addresses.Single();
        _client = new HttpClient { BaseAddress = new Uri(address) };
        Assert.Equal(HttpStatusCode.OK, (await _client.GetAsync("/api/products")).StatusCode);
    }

    public async Task DisposeAsync()
    {
        _client?.Dispose();
        if (_app is not null) await _app.DisposeAsync();
        SqliteConnection.ClearAllPools();
        foreach (var (name, value) in _environment)
            Environment.SetEnvironmentVariable(name, value);
        foreach (var suffix in new[] { "", "-wal", "-shm" })
            if (File.Exists(_dbPath + suffix)) File.Delete(_dbPath + suffix);
    }

    [Fact]
    public async Task Products_IncludeBranchStockAndStatus_DefaultAndMissingStock()
    {
        await SetStockAsync(1, 1, 6);
        await SetStockAsync(2, 1, 5);
        var first = await JsonAsync(await _client.GetAsync("/api/products/1"));
        Assert.Equal(6, first.GetProperty("quantityOnHand").GetInt32());
        Assert.Equal("in_stock", first.GetProperty("stockStatus").GetString());
        Assert.Equal("First", first.GetProperty("name").GetString());
        var other = await JsonAsync(await _client.GetAsync("/api/products/1?branchId=2"));
        Assert.Equal(5, other.GetProperty("quantityOnHand").GetInt32());
        Assert.Equal("low_stock", other.GetProperty("stockStatus").GetString());
        var list = await JsonAsync(await _client.GetAsync("/api/products?branchId=2"));
        Assert.Equal(0, list[1].GetProperty("quantityOnHand").GetInt32());
        Assert.Equal("out_of_stock", list[1].GetProperty("stockStatus").GetString());
        await SetStockAsync(1, 1, 1);
        Assert.Equal("low_stock", (await JsonAsync(await _client.GetAsync("/api/products/1")))
            .GetProperty("stockStatus").GetString());
        foreach (var path in new[] { "/api/products?branchId=999", "/api/products/1?branchId=999" })
            await AssertErrorAsync(await _client.GetAsync(path), 404, "NOT_FOUND");
        foreach (var branch in new[] { "0", "-1", "1.5", "true", "2147483648" })
            await AssertErrorAsync(await _client.GetAsync($"/api/products?branchId={branch}"), 400, "VALIDATION_ERROR");
    }

    [Fact]
    public async Task Inventory_RequiresConfiguredBearerToken_BeforeBindingAndWrites()
    {
        SetEnvironment("INVENTORY_ADMIN_TOKEN", null);
        await AssertErrorAsync(await PutAsync("/api/inventory/1/1", "{}"), 503, "SERVICE_UNAVAILABLE");
        SetEnvironment("INVENTORY_ADMIN_TOKEN", "test-inventory-admin");
        await AssertErrorAsync(await PutAsync("/api/inventory/1/1", "{}"), 403, "FORBIDDEN");
        _client.DefaultRequestHeaders.Authorization = new("Bearer", "wrong");
        await AssertErrorAsync(await PutAsync("/api/inventory/1/1", """{"quantityOnHand":2}"""), 403, "FORBIDDEN");
        Authorize();
        var response = await PutAsync("/api/inventory/1/1", """{"quantityOnHand":2147483647}""");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new InventoryResponse(1, 1, int.MaxValue),
            await response.Content.ReadFromJsonAsync<InventoryResponse>());
        await SetStockAsync(1, 1, 0);
        Assert.Equal(0, await StockAsync(1));
        foreach (var path in new[] { "/api/inventory/999/1", "/api/inventory/1/999" })
            await AssertErrorAsync(await PutAsync(path, """{"quantityOnHand":0}"""), 404, "NOT_FOUND");
        foreach (var path in new[] { "/api/inventory/0/1", "/api/inventory/1/-1" })
            await AssertErrorAsync(await PutAsync(path, """{"quantityOnHand":0}"""), 400, "VALIDATION_ERROR");
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"quantityOnHand":null}""")]
    [InlineData("""{"quantityOnHand":-1}""")]
    [InlineData("""{"quantityOnHand":1.5}""")]
    [InlineData("""{"quantityOnHand":"2"}""")]
    [InlineData("""{"quantityOnHand":true}""")]
    [InlineData("""{"quantityOnHand":2147483648}""")]
    public async Task Inventory_RejectsInvalidQuantities(string body)
    {
        Authorize();
        await AssertErrorAsync(await PutAsync("/api/inventory/1/1", body), 400, "VALIDATION_ERROR");
        Assert.Equal(0, await StockAsync(1));
    }

    [Fact]
    public async Task Orders_AllocateMultipleLinesAtServerPrices_AndPreserveHeaderOnlyContract()
    {
        await SetStockAsync(1, 1, 10);
        await SetStockAsync(1, 2, 4);
        var response = await PostOrderAsync("""[{"productId":1,"quantity":2,"unitPrice":0.01},{"productId":2,"quantity":3}]""");
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var order = await response.Content.ReadFromJsonAsync<Order>();
        Assert.NotNull(response.Headers.Location);
        Assert.Equal(2, order!.Items!.Count);
        Assert.Equal(11.12, order.Items[0].UnitPrice);
        Assert.Equal(3.25, order.Items[1].UnitPrice);
        var details = new OrderDetailsRepository(_factory);
        foreach (var item in order.Items)
            Assert.Equal(item, await details.FindByIdAsync(item.OrderDetailId));
        Assert.Equal(8, await StockAsync(1));
        Assert.Equal(1, await StockAsync(2));
        var header = await _client.PostAsJsonAsync("/api/orders", new { branchId = 1, name = "Legacy", orderDate = "2026-10-27" });
        Assert.Equal(HttpStatusCode.Created, header.StatusCode);
        Assert.False((await JsonAsync(header)).TryGetProperty("items", out _));
    }

    [Theory]
    [InlineData("""[{"productId":1,"quantity":2},{"productId":2,"quantity":5}]""", 409, "CONFLICT")]
    [InlineData("""[{"productId":1,"quantity":2},{"productId":999,"quantity":1}]""", 404, "NOT_FOUND")]
    [InlineData("""[{"productId":1,"quantity":3},{"productId":1,"quantity":3}]""", 409, "CONFLICT")]
    public async Task Orders_RollBackHeaderDetailsAndStock(string items, int status, string code)
    {
        await SetStockAsync(1, 1, 5);
        await SetStockAsync(1, 2, 2);
        await AssertErrorAsync(await PostOrderAsync(items), status, code);
        Assert.Empty(await new OrdersRepository(_factory).FindAllAsync());
        Assert.Empty(await new OrderDetailsRepository(_factory).FindAllAsync());
        Assert.Equal(5, await StockAsync(1));
        Assert.Equal(2, await StockAsync(2));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("[null]")]
    [InlineData("""[{"productId":0,"quantity":1}]""")]
    [InlineData("""[{"productId":1,"quantity":0}]""")]
    [InlineData("""[{"productId":1,"quantity":-1}]""")]
    [InlineData("""[{"productId":1,"quantity":1.5}]""")]
    [InlineData("""[{"productId":1,"quantity":"2"}]""")]
    [InlineData("""[{"productId":true,"quantity":2}]""")]
    [InlineData("""[{"productId":1,"quantity":true}]""")]
    [InlineData("""[{"productId":1,"quantity":2147483648}]""")]
    public async Task Orders_RejectInvalidItems(string items)
    {
        await AssertErrorAsync(await PostOrderAsync(items), 400, "VALIDATION_ERROR");
        Assert.Empty(await new OrdersRepository(_factory).FindAllAsync());
    }

    [Fact]
    public async Task Orders_EnforceLineLimitAndBranchReferences()
    {
        var items = JsonSerializer.Serialize(Enumerable.Repeat(new { productId = 1, quantity = 1 }, 101));
        await AssertErrorAsync(await PostOrderAsync(items), 400, "VALIDATION_ERROR");
        await AssertErrorAsync(await _client.PostAsJsonAsync("/api/orders", new
        {
            branchId = 999, name = "Missing", orderDate = "2026-10-27", items = new[] { new { productId = 1, quantity = 1 } }
        }), 404, "NOT_FOUND");
        await SetStockAsync(1, 1, 100);
        items = JsonSerializer.Serialize(Enumerable.Repeat(new { productId = 1, quantity = 1 }, 100));
        Assert.Equal(HttpStatusCode.Created, (await PostOrderAsync(items)).StatusCode);
        Assert.Equal(0, await StockAsync(1));
    }

    [Fact]
    public async Task Orders_ConcurrentAllocationsCannotOversell()
    {
        await SetStockAsync(1, 1, 5);
        var responses = await Task.WhenAll(
            PostOrderAsync("""[{"productId":1,"quantity":3}]"""),
            PostOrderAsync("""[{"productId":1,"quantity":3}]"""));
        Assert.Single(responses, response => response.StatusCode == HttpStatusCode.Created);
        await AssertErrorAsync(Assert.Single(responses, response => response.StatusCode != HttpStatusCode.Created),
            409, "CONFLICT");
        Assert.Equal(2, await StockAsync(1));
        Assert.Single(await new OrdersRepository(_factory).FindAllAsync());
        Assert.Single(await new OrderDetailsRepository(_factory).FindAllAsync());
    }

    [Fact]
    public async Task Orders_AcceptMaximumIntegerQuantity_RejectNonpositiveBranch()
    {
        await SetStockAsync(1, 1, int.MaxValue);
        var response = await PostOrderAsync($$"""[{"productId":1,"quantity":{{int.MaxValue}}}]""");
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal(int.MaxValue, (await response.Content.ReadFromJsonAsync<Order>())!.Items![0].Quantity);
        Assert.Equal(0, await StockAsync(1));
        await AssertErrorAsync(await _client.PostAsJsonAsync("/api/orders", new
        {
            branchId = 0, name = "Invalid", orderDate = "2026-10-27", items = new[] { new { productId = 1, quantity = 1 } }
        }), 400, "VALIDATION_ERROR");
    }

    [Fact]
    public async Task LegacyDetails_EnforceStockOnInsertUpdateMoveDelete_AndBlockBranchChanges()
    {
        await SetStockAsync(1, 1, 5);
        await SetStockAsync(1, 2, 4);
        await SetStockAsync(2, 1, 1);
        var orders = new OrdersRepository(_factory);
        var first = await orders.CreateAsync(new() { BranchId = 1, Name = "First", OrderDate = "2026-10-27" });
        var second = await orders.CreateAsync(new() { BranchId = 2, Name = "Second", OrderDate = "2026-10-27" });
        var response = await _client.PostAsJsonAsync("/api/order-details", new
        {
            orderId = first.OrderId, productId = 1, quantity = 3, unitPrice = 12.35
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var detail = (await response.Content.ReadFromJsonAsync<OrderDetail>())!;
        Assert.Equal(2, await StockAsync(1));
        var path = $"/api/order-details/{detail.OrderDetailId}";
        await AssertErrorAsync(await PutAsync(path, """{"quantity":6}"""), 409, "CONFLICT");
        Assert.Equal(2, await StockAsync(1));
        await AssertErrorAsync(await PutAsync(path, $$"""{"orderId":{{second.OrderId}}}"""), 409, "CONFLICT");
        Assert.Equal(2, await StockAsync(1));
        await AssertErrorAsync(await PutAsync($"/api/orders/{first.OrderId}", """{"branchId":2}"""), 400, "VALIDATION_ERROR");
        Assert.Equal(HttpStatusCode.OK, (await PutAsync(path, """{"productId":2,"quantity":2}""")).StatusCode);
        Assert.Equal(5, await StockAsync(1));
        Assert.Equal(2, await StockAsync(2));
        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync(path)).StatusCode);
        Assert.Equal(4, await StockAsync(2));
        await AssertErrorAsync(await _client.PostAsJsonAsync("/api/order-details", new
        {
            orderId = first.OrderId, productId = 2, quantity = 5, unitPrice = 3.25
        }), 409, "CONFLICT");
        var created = await new OrderDetailsRepository(_factory).CreateAsync(new()
        {
            OrderId = first.OrderId, ProductId = 1, Quantity = 2, UnitPrice = 12.35
        });
        await orders.DeleteAsync(first.OrderId);
        Assert.Equal(5, await StockAsync(1));
        Assert.Null(await new OrderDetailsRepository(_factory).FindByIdAsync(created.OrderDetailId));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("1.5")]
    [InlineData("\"2\"")]
    [InlineData("true")]
    [InlineData("2147483648")]
    public async Task LegacyDetails_RejectInvalidQuantitiesOnCreateAndUpdate(string quantity)
    {
        await SetStockAsync(1, 1, 5);
        var order = await new OrdersRepository(_factory).CreateAsync(new()
        {
            BranchId = 1, Name = "Legacy", OrderDate = "2026-10-27"
        });
        var details = new OrderDetailsRepository(_factory);
        var detail = await details.CreateAsync(new() { OrderId = order.OrderId, ProductId = 1, Quantity = 1, UnitPrice = 1 });
        await AssertErrorAsync(await PutAsync($"/api/order-details/{detail.OrderDetailId}",
            $$"""{"quantity":{{quantity}}}"""), 400, "VALIDATION_ERROR");
        await AssertErrorAsync(await _client.PostAsync("/api/order-details", Body(
            $$"""{"orderId":{{order.OrderId}},"productId":1,"quantity":{{quantity}},"unitPrice":1}""")),
            400, "VALIDATION_ERROR");
        Assert.Equal(4, await StockAsync(1));
    }

    [Fact]
    public async Task SharedMigration_TriggersRejectRawInvalidWrites_AndAreAppliedOnce()
    {
        await new DatabaseMigrator(_factory, NullLogger<DatabaseMigrator>.Instance).InitializeAsync(false);
        var order = await new OrdersRepository(_factory).CreateAsync(new()
        {
            BranchId = 1, Name = "Raw", OrderDate = "2026-10-27"
        });
        var ex = await Assert.ThrowsAsync<SqliteException>(() => ExecuteAsync(
            $"INSERT INTO order_details (order_id, product_id, quantity, unit_price) VALUES ({order.OrderId}, 1, 0, 1);"));
        Assert.Contains("Quantity must be a positive integer", ex.Message);
        ex = await Assert.ThrowsAsync<SqliteException>(() => ExecuteAsync(
            $"INSERT INTO order_details (order_id, product_id, quantity, unit_price) VALUES ({order.OrderId}, 1, 1, 1);"));
        Assert.Contains("Insufficient stock", ex.Message);
    }

    [Fact]
    public async Task SharedMigration_HistoricalDetailsDoNotInventStockAfterUpgrade()
    {
        await ExecuteAsync("""
            DROP TRIGGER inventory_detail_insert;
            DROP TRIGGER inventory_detail_update;
            DROP TRIGGER inventory_detail_delete;
            DROP TRIGGER inventory_order_delete;
            DROP TRIGGER inventory_order_branch_update;
            DROP TABLE inventory_allocations;
            DROP TABLE inventory;
            DELETE FROM migrations WHERE filename = '003_branch_inventory.sql';
            INSERT INTO orders (order_id, branch_id, order_date, name) VALUES
                (1, 1, '2026-10-27', 'Historical detail delete'),
                (2, 1, '2026-10-27', 'Historical order delete'),
                (3, 1, '2026-10-27', 'Historical detail edit');
            INSERT INTO order_details (order_detail_id, order_id, product_id, quantity, unit_price) VALUES
                (1, 1, 1, 7, 1), (2, 2, 1, 7, 1), (3, 3, 1, 7, 1);
            """);
        await new DatabaseMigrator(_factory, NullLogger<DatabaseMigrator>.Instance).InitializeAsync(false);
        Assert.Equal(0, await StockAsync(1));
        await SetStockAsync(1, 1, 10);
        var details = new OrderDetailsRepository(_factory);
        await details.DeleteAsync(1);
        Assert.Equal(10, await StockAsync(1));
        await new OrdersRepository(_factory).DeleteAsync(2);
        Assert.Equal(10, await StockAsync(1));
        await details.UpdateAsync(3, new() { Quantity = 3 });
        Assert.Equal(7, await StockAsync(1));
        await details.DeleteAsync(3);
        Assert.Equal(10, await StockAsync(1));
    }

    [Fact]
    public async Task Migrator_FailedScriptRollsBackSchemaAndMigrationHistory()
    {
        var directory = Path.Combine(_root, "src", "api-cs-tests", $"migration-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            await File.WriteAllTextAsync(Path.Combine(directory, "004_failed.sql"), """
                CREATE TABLE migration_should_rollback (id INTEGER);
                INSERT INTO table_that_does_not_exist VALUES (1);
                """);
            SetEnvironment("DB_MIGRATIONS_DIR", directory);
            await Assert.ThrowsAsync<SqliteException>(() =>
                new DatabaseMigrator(_factory, NullLogger<DatabaseMigrator>.Instance).InitializeAsync(false));
            await using var connection = await _factory.OpenConnectionAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT (SELECT COUNT(*) FROM sqlite_master WHERE name = 'migration_should_rollback') +
                    (SELECT COUNT(*) FROM migrations WHERE filename = '004_failed.sql');
                """;
            Assert.Equal(0L, await command.ExecuteScalarAsync());
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    private void SetEnvironment(string name, string? value)
    {
        if (!_environment.ContainsKey(name)) _environment.Add(name, Environment.GetEnvironmentVariable(name));
        Environment.SetEnvironmentVariable(name, value);
    }

    private void Authorize() => _client.DefaultRequestHeaders.Authorization = new("Bearer", "test-inventory-admin");

    private async Task SetStockAsync(int branchId, int productId, int quantity)
    {
        Authorize();
        var response = await _client.PutAsJsonAsync($"/api/inventory/{branchId}/{productId}", new { quantityOnHand = quantity });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private async Task<int> StockAsync(int productId) =>
        (await JsonAsync(await _client.GetAsync($"/api/products/{productId}"))).GetProperty("quantityOnHand").GetInt32();

    private async Task ExecuteAsync(string sql)
    {
        await using var connection = await _factory.OpenConnectionAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }

    private Task<HttpResponseMessage> PostOrderAsync(string items) =>
        _client.PostAsync("/api/orders", Body(
            $$"""{"branchId":1,"name":"Inventory order","orderDate":"2026-10-27","items":{{items}}}"""));

    private Task<HttpResponseMessage> PutAsync(string path, string body) => _client.PutAsync(path, Body(body));
    private static StringContent Body(string body) => new(body, Encoding.UTF8, "application/json");
    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        JsonSerializer.Deserialize<JsonElement>(await response.Content.ReadAsStringAsync());

    private static async Task AssertErrorAsync(HttpResponseMessage response, int status, string code)
    {
        Assert.Equal(status, (int)response.StatusCode);
        Assert.Equal(code, (await JsonAsync(response)).GetProperty("error").GetProperty("code").GetString());
    }
}
