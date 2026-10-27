using System.Net;
using System.Text;
using System.Text.Json;
using OctoSupply.Api.Models;
using OctoSupply.Api.Services;
using OctoSupply.Api.Utils;
using Xunit;

namespace OctoSupply.Api.Tests;

public sealed class StripePaymentProviderTests : IDisposable
{
    private readonly Dictionary<string, string?> _environment = new();
    private readonly RecordingHandler _handler = new();
    private readonly StripePaymentProvider _provider;
    private readonly string _id = Guid.NewGuid().ToString();

    public StripePaymentProviderTests()
    {
        Env("PAYMENT_PROVIDER", "stripe");
        Env("STRIPE_SECRET_KEY", "sk_test_private");
        Env("CHECKOUT_PUBLIC_URL", "http://localhost:5137");
        _provider = new(new HttpClient(_handler) { Timeout = TimeSpan.FromSeconds(15) });
    }

    public void Dispose()
    {
        foreach (var (name, value) in _environment) Environment.SetEnvironmentVariable(name, value);
        _handler.Dispose();
    }

    [Fact]
    public async Task StripeRequests_UseFixedEndpointExactSnapshotAndStableIdempotency()
    {
        _handler.Response = $$"""
            {"id":"cs_session","url":"https://checkout.stripe.com/c/pay/test","client_reference_id":"{{_id}}",
            "metadata":{"checkoutId":"{{_id}}"},"currency":"usd","amount_total":2224,"status":"open","payment_status":"unpaid"}
            """;
        var checkout = new CheckoutPayment(_id, 1, "{}",
            JsonSerializer.Serialize(new[] { new CheckoutSnapshot(1, 2, 1112, "Quoted & snapshot") }, CheckoutPayment.JsonOptions),
            2224, "creating", null, null, null, null, DateTimeOffset.UtcNow);
        await _provider.CreateAsync(checkout, CancellationToken.None);
        Assert.Equal("https://api.stripe.com/v1/checkout/sessions", _handler.Uri);
        Assert.Equal(HttpMethod.Post, _handler.Method);
        Assert.Equal($"checkout-{_id}", _handler.Key);
        Assert.Equal("Bearer sk_test_private", _handler.Authorization);
        var form = Decode(_handler.Body!);
        Assert.Equal("payment", form["mode"]);
        Assert.Equal("card", form["payment_method_types[0]"]);
        Assert.Equal($"http://localhost:5137/checkout?checkoutId={_id}&result=success", form["success_url"]);
        Assert.Equal($"http://localhost:5137/checkout?checkoutId={_id}&result=cancel", form["cancel_url"]);
        Assert.Equal(_id, form["client_reference_id"]);
        Assert.Equal(_id, form["metadata[checkoutId]"]);
        Assert.Equal("usd", form["line_items[0][price_data][currency]"]);
        Assert.Equal("1112", form["line_items[0][price_data][unit_amount]"]);
        Assert.Equal("Quoted & snapshot", form["line_items[0][price_data][product_data][name]"]);
        Assert.Equal("2", form["line_items[0][quantity]"]);
        Assert.Equal(10, form.Count);
        await _provider.RetrieveAsync("cs_session", CancellationToken.None);
        Assert.Equal(HttpMethod.Get, _handler.Method);
        Assert.Equal("https://api.stripe.com/v1/checkout/sessions/cs_session", _handler.Uri);
        await _provider.ExpireAsync("cs_session", CancellationToken.None);
        Assert.Equal(HttpMethod.Post, _handler.Method);
        Assert.Equal("https://api.stripe.com/v1/checkout/sessions/cs_session/expire", _handler.Uri);
        _handler.Response = """{"status":"succeeded"}""";
        Assert.True(await _provider.RefundAsync(_id, "pi_paid", CancellationToken.None));
        Assert.Equal("https://api.stripe.com/v1/refunds", _handler.Uri);
        Assert.Equal($"refund-{_id}", _handler.Key);
        Assert.Equal("pi_paid", Decode(_handler.Body!)["payment_intent"]);
        _handler.Response = """{"status":"pending"}""";
        Assert.False(await _provider.RefundAsync(_id, "pi_paid", CancellationToken.None));
        _handler.Response = """{"status":"failed"}""";
        Assert.False(await _provider.RefundAsync(_id, "pi_paid", CancellationToken.None));
    }

    [Theory]
    [InlineData(402, """{"error":{"message":"DECLINED sk_test_private"}}""")]
    [InlineData(500, "sk_test_private")]
    [InlineData(200, "not json sk_test_private")]
    [InlineData(200, "[]")]
    [InlineData(200, "{}")]
    public async Task StripeErrors_AreSafe502(int status, string body)
    {
        _handler.Status = (HttpStatusCode)status;
        _handler.Response = body;
        var error = await Assert.ThrowsAsync<ApiException>(() => _provider.RetrieveAsync("cs_session", CancellationToken.None));
        Assert.Equal(502, error.StatusCode);
        Assert.Equal("PAYMENT_PROVIDER_ERROR", error.Code);
        Assert.DoesNotContain("sk_test", error.Message);
        Assert.DoesNotContain("DECLINED", error.Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task StripeNetworkAndTimeout_AreSafe502(bool timeout)
    {
        _handler.Failure = timeout ? new TaskCanceledException("sk_test_private") : new HttpRequestException("sk_test_private");
        var error = await Assert.ThrowsAsync<ApiException>(() => _provider.RetrieveAsync("cs_session", CancellationToken.None));
        Assert.Equal("PAYMENT_PROVIDER_ERROR", error.Code);
        Assert.DoesNotContain("sk_test", error.Message);
    }

    [Theory]
    [InlineData("https://shop.example.com")]
    [InlineData("https://shop.example.com:8443")]
    [InlineData("http://localhost")]
    [InlineData("http://127.0.0.1:5137")]
    public void PublicOrigins_AreSupported(string origin)
    {
        Env("CHECKOUT_PUBLIC_URL", origin);
        _provider.ValidateConfiguration();
    }

    [Theory]
    [InlineData("http://localhost.evil.test")]
    [InlineData("https://example.com/checkout")]
    [InlineData("https://example.com/../")]
    [InlineData("https://example.com?")]
    [InlineData("https://example.com#")]
    [InlineData("https://example.com\\")]
    [InlineData("https://user@example.com")]
    [InlineData("ftp://example.com")]
    public async Task InvalidOrigin_Is503WithoutHttp(string origin)
    {
        Env("CHECKOUT_PUBLIC_URL", origin);
        var error = await Assert.ThrowsAsync<ApiException>(() => _provider.RetrieveAsync("cs_session", CancellationToken.None));
        Assert.Equal(503, error.StatusCode);
        Assert.Null(_handler.Uri);
    }

    private void Env(string name, string? value)
    {
        _environment.TryAdd(name, Environment.GetEnvironmentVariable(name));
        Environment.SetEnvironmentVariable(name, value);
    }

    private static Dictionary<string, string> Decode(string form) =>
        form.Split('&').Select(part => part.Split('=', 2)).ToDictionary(
            pair => WebUtility.UrlDecode(pair[0]), pair => WebUtility.UrlDecode(pair[1]));

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public string Response = "{}";
        public HttpStatusCode Status = HttpStatusCode.OK;
        public Exception? Failure;
        public string? Uri, Key, Body, Authorization;
        public HttpMethod? Method;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Uri = request.RequestUri!.AbsoluteUri;
            Method = request.Method;
            Key = request.Headers.TryGetValues("Idempotency-Key", out var values) ? values.Single() : null;
            Authorization = request.Headers.Authorization?.ToString();
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            if (Failure is not null) throw Failure;
            return new(Status) { Content = new StringContent(Response, Encoding.UTF8, "application/json") };
        }
    }
}
