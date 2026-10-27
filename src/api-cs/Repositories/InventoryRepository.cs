using Microsoft.Data.Sqlite;
using OctoSupply.Api.Data;
using OctoSupply.Api.Models;
using OctoSupply.Api.Utils;

namespace OctoSupply.Api.Repositories;

public sealed class InventoryRepository(SqliteConnectionFactory connectionFactory)
{
    public async Task<InventoryResponse> UpsertAsync(int branchId, int productId, int quantityOnHand)
    {
        if (branchId <= 0 || productId <= 0 || quantityOnHand < 0)
        {
            throw new ValidationException("IDs must be positive and quantityOnHand must be nonnegative");
        }

        await using var connection = await connectionFactory.OpenConnectionAsync();
        await using var transaction = connection.BeginTransaction();
        await RequireBranchAsync(connection, branchId, transaction);
        await using var product = connection.CreateCommand();
        product.Transaction = transaction;
        product.CommandText = "SELECT 1 FROM products WHERE product_id = $id;";
        product.Parameters.AddWithValue("$id", productId);
        if (await product.ExecuteScalarAsync() is null)
        {
            throw new NotFoundException("Product", productId);
        }

        await using var cmd = connection.CreateCommand();
        cmd.Transaction = transaction;
        cmd.CommandText = """
            INSERT INTO inventory (branch_id, product_id, quantity_on_hand)
            VALUES ($branchId, $productId, $quantity)
            ON CONFLICT (branch_id, product_id)
            DO UPDATE SET quantity_on_hand = excluded.quantity_on_hand;
            """;
        cmd.Parameters.AddWithValue("$branchId", branchId);
        cmd.Parameters.AddWithValue("$productId", productId);
        cmd.Parameters.AddWithValue("$quantity", quantityOnHand);
        await cmd.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
        return new InventoryResponse(branchId, productId, quantityOnHand);
    }

    internal static async Task RequireBranchAsync(
        SqliteConnection connection, int branchId, SqliteTransaction? transaction = null)
    {
        if (branchId <= 0)
        {
            throw new ValidationException("branchId must be a positive integer");
        }
        await using var cmd = connection.CreateCommand();
        cmd.Transaction = transaction;
        cmd.CommandText = "SELECT 1 FROM branches WHERE branch_id = $id;";
        cmd.Parameters.AddWithValue("$id", branchId);
        if (await cmd.ExecuteScalarAsync() is null)
        {
            throw new NotFoundException("Branch", branchId);
        }
    }
}
