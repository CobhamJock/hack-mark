using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace OctoSupply.Api.Models;

/// <summary>Stock held by a branch for one product.</summary>
public sealed record InventoryResponse(int BranchId, int ProductId, int QuantityOnHand);

/// <summary>Replaces the on-hand stock count with a nonnegative integer.</summary>
public sealed record UpdateInventoryRequest
{
    [Required, Range(0, int.MaxValue)]
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public int? QuantityOnHand { get; init; }
}
