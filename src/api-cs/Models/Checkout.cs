using System.Text.Json;
using System.Text.Json.Serialization;

namespace OctoSupply.Api.Models;

/// <summary>Starts or recovers an idempotent USD card checkout.</summary>
public sealed record CreateCheckoutRequest
{
    public string? CheckoutId { get; init; }
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int BranchId { get; init; }
    public IReadOnlyList<CheckoutItemRequest?>? Items { get; init; }
}

/// <summary>A product quantity requested for checkout.</summary>
public sealed record CheckoutItemRequest
{
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int ProductId { get; init; }
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int Quantity { get; init; }
}

/// <summary>The durable payment state, totals in cents, and optional confirmed order.</summary>
public sealed record CheckoutResponse(string CheckoutId, string Status, string? CheckoutUrl,
    int AmountTotal, string Currency, int? OrderId);

public sealed record CheckoutLine(int ProductId, int Quantity);
public sealed record CheckoutRequestData(int BranchId, IReadOnlyList<CheckoutLine> Items);
public sealed record CheckoutSnapshot(int ProductId, int Quantity, int UnitPriceCents, string Name);
public sealed record CheckoutPayment(string CheckoutId, int BranchId, string RequestJson, string ItemsJson,
    int AmountTotal, string Status, string? ProviderSessionId, string? CheckoutUrl,
    string? PaymentIntentId, int? OrderId, DateTimeOffset CreatedAt)
{
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public CheckoutResponse Response => new(CheckoutId, Status, CheckoutUrl, AmountTotal, "usd", OrderId);
    public IReadOnlyList<CheckoutSnapshot> Items =>
        JsonSerializer.Deserialize<CheckoutSnapshot[]>(ItemsJson, JsonOptions)!;
}
