using System.Text.Json.Serialization;

namespace OctoSupply.Api.Models;

public sealed record OrderDetail(
    int OrderDetailId,
    int OrderId,
    int ProductId,
    int Quantity,
    double UnitPrice,
    string? Notes);

public sealed class CreateOrderDetailRequest
{
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int OrderId { get; set; }
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int ProductId { get; set; }
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int Quantity { get; set; }
    public double UnitPrice { get; set; }
    public string? Notes { get; set; }
}

public sealed class UpdateOrderDetailRequest
{
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int? OrderId { get; set; }
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int? ProductId { get; set; }
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int? Quantity { get; set; }
    public double? UnitPrice { get; set; }
    public string? Notes { get; set; }
}
