using Microsoft.AspNetCore.Mvc;
using OctoSupply.Api.Models;
using OctoSupply.Api.Repositories;
using OctoSupply.Api.Utils;

namespace OctoSupply.Api.Controllers;

[ApiController]
[InventoryAdmin]
[Route("api/inventory")]
public sealed class InventoryController(InventoryRepository repository) : ControllerBase
{
    /// <summary>Sets branch stock. Requires the configured inventory administrator bearer token.</summary>
    [HttpPut("{branchId:int}/{productId:int}")]
    [ProducesResponseType<InventoryResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<InventoryResponse>> Update(
        int branchId, int productId, [FromBody] UpdateInventoryRequest request)
    {
        if (!request.QuantityOnHand.HasValue)
        {
            throw new ValidationException("quantityOnHand is required");
        }
        return Ok(await repository.UpsertAsync(branchId, productId, request.QuantityOnHand.Value));
    }
}
