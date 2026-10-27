using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace OctoSupply.Api.Models;

public sealed record Order(
    int OrderId,
    int BranchId,
    string OrderDate,
    string Name,
    string? Description,
    string Status)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<OrderDetail>? Items { get; init; }
}

/// <summary>Creates an order, optionally allocating up to 100 product lines.</summary>
public sealed record CreateOrderRequest
{
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    [Range(1, int.MaxValue)]
    public int BranchId { get; init; }
    public string OrderDate { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string? Description { get; init; }
    public string Status { get; init; } = "pending";

    private IReadOnlyList<CreateOrderItemRequest?>? _items;
    public IReadOnlyList<CreateOrderItemRequest?>? Items
    {
        get => _items;
        init { _items = value; ItemsSpecified = true; }
    }

    [JsonIgnore]
    public bool ItemsSpecified { get; private init; }
}

/// <summary>A product and positive integer quantity to allocate at the server price.</summary>
public sealed record CreateOrderItemRequest
{
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    [Range(1, int.MaxValue)]
    public int ProductId { get; init; }
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    [Range(1, int.MaxValue)]
    public int Quantity { get; init; }
}

public sealed class UpdateOrderRequest
{
    public int? BranchId { get; set; }
    public string? OrderDate { get; set; }
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Status { get; set; }
}
