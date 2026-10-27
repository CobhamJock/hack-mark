using Microsoft.AspNetCore.Mvc;

namespace OctoSupply.Api.Utils;

public static class ApiValidation
{
    public static void Configure(ApiBehaviorOptions options) =>
        options.InvalidModelStateResponseFactory = _ => new BadRequestObjectResult(new
        {
            error = new
            {
                code = "VALIDATION_ERROR",
                message = "Validation error: request contains missing or invalid values"
            }
        });
}
