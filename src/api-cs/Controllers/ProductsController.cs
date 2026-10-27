using Microsoft.AspNetCore.Mvc;
using OctoSupply.Api.Models;
using OctoSupply.Api.Repositories;
using OctoSupply.Api.Utils;

namespace OctoSupply.Api.Controllers;

[ApiController]
[Route("api/products")]
public sealed class ProductsController(ProductsRepository repository) : ControllerBase
{
    private readonly ProductsRepository _repository = repository;

    [HttpGet]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IReadOnlyList<Product>>> GetAll([FromQuery] int branchId = 1) =>
        Ok(await _repository.FindAllAsync(branchId));

    [HttpGet("{id:int}")]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<Product>> GetById(int id, [FromQuery] int branchId = 1)
    {
        if (id <= 0) throw new ValidationException("id must be a positive integer");
        var item = await _repository.FindByIdAsync(id, branchId);
        return item is null ? throw new NotFoundException("Product", id) : Ok(item);
    }

    [HttpPost]
    public async Task<ActionResult<Product>> Create([FromBody] CreateProductRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
        {
            throw new ValidationException("name is required");
        }

        var created = await _repository.CreateAsync(request);
        return CreatedAtAction(nameof(GetById), new { id = created.ProductId }, created);
    }

    [HttpPut("{id:int}")]
    public async Task<ActionResult<Product>> Update(int id, [FromBody] UpdateProductRequest request) =>
        Ok(await _repository.UpdateAsync(id, request));

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await _repository.DeleteAsync(id);
        return NoContent();
    }
}
