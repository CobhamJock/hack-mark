using Microsoft.Data.Sqlite;
using OctoSupply.Api.Utils;

namespace OctoSupply.Api.Data;

internal static class InventoryCommands
{
    public static async Task<int> ExecuteInventoryWriteAsync(this SqliteCommand command)
    {
        try
        {
            return await command.ExecuteNonQueryAsync();
        }
        catch (SqliteException ex) when (IsInventoryError(ex))
        {
            throw Translate(ex);
        }
    }

    public static async Task<object?> ExecuteInventoryInsertAsync(this SqliteCommand command)
    {
        try
        {
            return await command.ExecuteScalarAsync();
        }
        catch (SqliteException ex) when (IsInventoryError(ex))
        {
            throw Translate(ex);
        }
    }

    private static bool IsInventoryError(SqliteException ex) =>
        ex.SqliteErrorCode == 19 &&
        (ex.Message.Contains("Insufficient stock", StringComparison.Ordinal) ||
         ex.Message.Contains("Quantity must be a positive integer", StringComparison.Ordinal) ||
         ex.Message.Contains("Cannot change branch of an order with items", StringComparison.Ordinal));

    private static ApiException Translate(SqliteException ex) =>
        ex.Message.Contains("Insufficient stock", StringComparison.Ordinal)
            ? new ConflictException("Insufficient stock")
            : new ValidationException(ex.Message.Contains("Cannot change branch", StringComparison.Ordinal)
                ? "Cannot change branch of an order with items"
                : "Quantity must be a positive integer");
}
