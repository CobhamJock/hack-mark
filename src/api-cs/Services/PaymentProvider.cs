using System.Net.Http.Headers;
using System.Text.Json;
using OctoSupply.Api.Models;
using OctoSupply.Api.Utils;

namespace OctoSupply.Api.Services;

public sealed record PaymentSession(string Id, string? Url, string? ClientReferenceId,
    string? CheckoutId, string? Currency, long? AmountTotal, string? Status,
    string? PaymentStatus, string? PaymentIntentId);

public interface IPaymentProvider
{
    void ValidateConfiguration();
    Task<PaymentSession> CreateAsync(CheckoutPayment checkout, CancellationToken ct);
    Task<PaymentSession> RetrieveAsync(string sessionId, CancellationToken ct);
    Task<PaymentSession> ExpireAsync(string sessionId, CancellationToken ct);
    Task<bool> RefundAsync(string checkoutId, string paymentIntentId, CancellationToken ct);
}

public sealed class StripePaymentProvider(HttpClient client) : IPaymentProvider
{
    public static ApiException ProviderError() =>
        new("The payment provider could not process the request.", "PAYMENT_PROVIDER_ERROR", 502);

    private static (string Key, string Origin) Configuration()
    {
        var key = Environment.GetEnvironmentVariable("STRIPE_SECRET_KEY");
        var origin = Environment.GetEnvironmentVariable("CHECKOUT_PUBLIC_URL");
        if (Environment.GetEnvironmentVariable("PAYMENT_PROVIDER") != "stripe" ||
            string.IsNullOrWhiteSpace(key) || key.Any(char.IsWhiteSpace) ||
            origin is null || !Uri.TryCreate(origin, UriKind.Absolute, out var uri) ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/" ||
            origin.Contains('\\') ||
            // An origin contains no trailing path separator, including a bare slash.
            origin != uri.GetLeftPart(UriPartial.Authority) ||
            (uri.Scheme != "https" && !(uri.Scheme == "http" &&
                (uri.Host == "localhost" || uri.Host == "127.0.0.1"))))
            throw new ApiException("Payment configuration is unavailable.", "PAYMENT_UNAVAILABLE", 503);
        return (key, origin);
    }

    public void ValidateConfiguration() => Configuration();

    public async Task<PaymentSession> CreateAsync(CheckoutPayment checkout, CancellationToken ct)
    {
        var (_, origin) = Configuration();
        var fields = new Dictionary<string, string>
        {
            ["mode"] = "payment", ["payment_method_types[0]"] = "card",
            ["success_url"] = $"{origin}/checkout?checkoutId={checkout.CheckoutId}&result=success",
            ["cancel_url"] = $"{origin}/checkout?checkoutId={checkout.CheckoutId}&result=cancel",
            ["client_reference_id"] = checkout.CheckoutId,
            ["metadata[checkoutId]"] = checkout.CheckoutId
        };
        var index = 0;
        foreach (var item in checkout.Items)
        {
            var prefix = $"line_items[{index++}]";
            fields[$"{prefix}[quantity]"] = item.Quantity.ToString(System.Globalization.CultureInfo.InvariantCulture);
            fields[$"{prefix}[price_data][currency]"] = "usd";
            fields[$"{prefix}[price_data][unit_amount]"] = item.UnitPriceCents.ToString(System.Globalization.CultureInfo.InvariantCulture);
            fields[$"{prefix}[price_data][product_data][name]"] = item.Name;
        }
        using var json = await SendAsync(HttpMethod.Post, "checkout/sessions", fields,
            $"checkout-{checkout.CheckoutId}", ct);
        return Session(json.RootElement);
    }

    public async Task<PaymentSession> RetrieveAsync(string sessionId, CancellationToken ct)
    {
        using var json = await SendAsync(HttpMethod.Get,
            $"checkout/sessions/{Uri.EscapeDataString(sessionId)}", null, null, ct);
        return Session(json.RootElement);
    }

    public async Task<PaymentSession> ExpireAsync(string sessionId, CancellationToken ct)
    {
        using var json = await SendAsync(HttpMethod.Post,
            $"checkout/sessions/{Uri.EscapeDataString(sessionId)}/expire", new(), null, ct);
        return Session(json.RootElement);
    }

    public async Task<bool> RefundAsync(string checkoutId, string paymentIntentId, CancellationToken ct)
    {
        using var json = await SendAsync(HttpMethod.Post, "refunds",
            new() { ["payment_intent"] = paymentIntentId }, $"refund-{checkoutId}", ct);
        return Text(json.RootElement, "status") == "succeeded";
    }

    private async Task<JsonDocument> SendAsync(HttpMethod method, string path,
        Dictionary<string, string>? form, string? key, CancellationToken ct)
    {
        var (secret, _) = Configuration();
        try
        {
            using var request = new HttpRequestMessage(method, $"https://api.stripe.com/v1/{path}");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
            if (key is not null) request.Headers.Add("Idempotency-Key", key);
            if (form is not null) request.Content = new FormUrlEncodedContent(form);
            using var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) throw ProviderError();
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException or FormatException)
        {
            throw ProviderError();
        }
    }

    private static string? Text(JsonElement json, string name) =>
        json.ValueKind == JsonValueKind.Object && json.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static PaymentSession Session(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object || string.IsNullOrWhiteSpace(Text(json, "id")))
            throw ProviderError();
        var metadata = json.TryGetProperty("metadata", out var meta) && meta.ValueKind == JsonValueKind.Object
            ? Text(meta, "checkoutId") : null;
        long? amount = json.TryGetProperty("amount_total", out var total) &&
            total.ValueKind == JsonValueKind.Number && total.TryGetInt64(out var number) ? number : null;
        return new(Text(json, "id")!, Text(json, "url"), Text(json, "client_reference_id"), metadata,
            Text(json, "currency"), amount, Text(json, "status"), Text(json, "payment_status"),
            Text(json, "payment_intent"));
    }
}
