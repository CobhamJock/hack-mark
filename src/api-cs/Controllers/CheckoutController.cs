using Microsoft.AspNetCore.Mvc;
using OctoSupply.Api.Models;
using OctoSupply.Api.Services;

namespace OctoSupply.Api.Controllers;

[ApiController]
[Route("api/checkout")]
[Produces("application/json")]
[ProducesResponseType(StatusCodes.Status400BadRequest)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
[ProducesResponseType(StatusCodes.Status409Conflict)]
[ProducesResponseType(StatusCodes.Status502BadGateway)]
[ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
public sealed class CheckoutController(ICheckoutService service) : ControllerBase
{
    /// <summary>Starts or recovers a checkout using a lowercase UUID v4 idempotency capability.</summary>
    [HttpPost]
    [ProducesResponseType<CheckoutResponse>(StatusCodes.Status200OK)]
    public async Task<ActionResult<CheckoutResponse>> Create([FromBody] CreateCheckoutRequest request, CancellationToken ct) =>
        Ok(await service.CreateAsync(request, ct));

    /// <summary>Verifies Stripe payment and atomically creates an order, or retries a required refund.</summary>
    [HttpPost("{id}/complete")]
    [ProducesResponseType<CheckoutResponse>(StatusCodes.Status200OK)]
    public async Task<ActionResult<CheckoutResponse>> Complete(string id, CancellationToken ct) =>
        Ok(await service.CompleteAsync(id, ct));

    /// <summary>Expires an unpaid Stripe session; paid sessions follow completion instead.</summary>
    [HttpPost("{id}/cancel")]
    [ProducesResponseType<CheckoutResponse>(StatusCodes.Status200OK)]
    public async Task<ActionResult<CheckoutResponse>> Cancel(string id, CancellationToken ct) =>
        Ok(await service.CancelAsync(id, ct));
}
