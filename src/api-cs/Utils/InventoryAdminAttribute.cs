using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc.Filters;

namespace OctoSupply.Api.Utils;

[AttributeUsage(AttributeTargets.Class)]
public sealed class InventoryAdminAttribute : Attribute, IAuthorizationFilter
{
    public void OnAuthorization(AuthorizationFilterContext context)
    {
        var token = Environment.GetEnvironmentVariable("INVENTORY_ADMIN_TOKEN");
        if (string.IsNullOrWhiteSpace(token))
        {
            throw new ApiException("Inventory administration is not configured", "SERVICE_UNAVAILABLE", 503);
        }

        var header = context.HttpContext.Request.Headers.Authorization.ToString();
        var supplied = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..] : "";
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
        if (!CryptographicOperations.FixedTimeEquals(expectedHash, suppliedHash))
        {
            throw new ApiException("Inventory administration requires authorization", "FORBIDDEN", 403);
        }
    }
}
