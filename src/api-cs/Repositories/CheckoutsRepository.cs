using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using OctoSupply.Api.Data;
using OctoSupply.Api.Models;
using OctoSupply.Api.Utils;

namespace OctoSupply.Api.Repositories;

public sealed class CheckoutsRepository(SqliteConnectionFactory factory, ILogger<CheckoutsRepository> logger)
{
    private static string Json<T>(T value) => JsonSerializer.Serialize(value, CheckoutPayment.JsonOptions);

    public async Task<CheckoutPayment?> FindAsync(string id, CancellationToken ct)
    {
        await using var connection = await factory.OpenConnectionAsync();
        return await ReadAsync(connection, null, id, ct);
    }

    public async Task<CheckoutPayment> GetOrCreateAsync(string id, CheckoutRequestData request, CancellationToken ct)
    {
        await using var connection = await factory.OpenConnectionAsync();
        await using var transaction = connection.BeginTransaction(deferred: false);
        var existing = await ReadAsync(connection, transaction, id, ct);
        if (existing is not null)
        {
            var stored = JsonSerializer.Deserialize<CheckoutRequestData>(existing.RequestJson, CheckoutPayment.JsonOptions)!;
            if (stored.BranchId != request.BranchId || !stored.Items.OrderBy(i => i.ProductId).SequenceEqual(request.Items))
                throw new ConflictException("checkoutId was already used with a different request");
            return existing;
        }

        await using (var branch = Command(connection, transaction,
            "SELECT COUNT(*) FROM branches WHERE branch_id=$branch;", ("$branch", request.BranchId)))
        {
            if (Convert.ToInt32(await branch.ExecuteScalarAsync(ct)) == 0)
                throw new NotFoundException("Branch", request.BranchId);
        }
        var items = new List<CheckoutSnapshot>();
        long amount = 0;
        foreach (var item in request.Items)
        {
            await using var product = Command(connection, transaction, """
                SELECT p.price, COALESCE(p.discount,0), p.name, COALESCE(i.quantity_on_hand,0)
                FROM products p LEFT JOIN inventory i ON i.product_id=p.product_id AND i.branch_id=$branch
                WHERE p.product_id=$product;
                """, ("$branch", request.BranchId), ("$product", item.ProductId));
            await using var reader = await product.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct)) throw new NotFoundException("Product", item.ProductId);
            if (reader.GetInt64(3) < item.Quantity)
                throw new ApiException("Insufficient stock.", "INSUFFICIENT_STOCK", 409);
            decimal cents;
            try
            {
                cents = Math.Round(reader.GetDecimal(0) * (1 - reader.GetDecimal(1)) * 100,
                    0, MidpointRounding.AwayFromZero);
            }
            catch (Exception ex) when (ex is OverflowException or FormatException)
            {
                throw new ValidationException("Product price is not payable");
            }
            if (cents is <= 0 or > 99999999) throw new ValidationException("Product price is not payable");
            amount += (long)cents * item.Quantity;
            if (amount > 99999999) throw new ValidationException("Checkout exceeds the USD payment limit");
            items.Add(new(item.ProductId, item.Quantity, (int)cents, reader.GetString(2)));
        }
        if (amount < 50) throw new ValidationException("Checkout must total at least 50 USD cents");
        await using (var insert = Command(connection, transaction, """
            INSERT INTO checkouts(checkout_id,branch_id,request_json,items_json,amount_total,currency)
            VALUES($id,$branch,$request,$items,$amount,'usd');
            """, ("$id", id), ("$branch", request.BranchId), ("$request", Json(request)),
            ("$items", Json(items)), ("$amount", amount)))
            await insert.ExecuteNonQueryAsync(ct);
        var created = (await ReadAsync(connection, transaction, id, ct))!;
        await transaction.CommitAsync(ct);
        return created;
    }

    public async Task<CheckoutPayment> SaveSessionAsync(string id, string session, string url, CancellationToken ct)
    {
        await using var connection = await factory.OpenConnectionAsync();
        await using var cmd = Command(connection, null, """
            UPDATE checkouts SET provider_session_id=$session,checkout_url=$url,status='pending'
            WHERE checkout_id=$id AND status='creating';
            """, ("$id", id), ("$session", session), ("$url", url));
        await cmd.ExecuteNonQueryAsync(ct);
        return (await ReadAsync(connection, null, id, ct))!;
    }

    public async Task<CheckoutPayment> SetStateAsync(string id, string from, string to, CancellationToken ct)
    {
        await using var connection = await factory.OpenConnectionAsync();
        await using var cmd = Command(connection, null,
            "UPDATE checkouts SET status=$to WHERE checkout_id=$id AND status=$from;",
            ("$id", id), ("$to", to), ("$from", from));
        await cmd.ExecuteNonQueryAsync(ct);
        return (await ReadAsync(connection, null, id, ct))!;
    }

    public async Task<CheckoutPayment> FinalizeAsync(string id, string intent, CancellationToken ct)
    {
        await using var connection = await factory.OpenConnectionAsync();
        // Keep the write lock across rollback and refund_pending persistence: another
        // finalizer must never complete an order while this finalizer decides to refund.
        await using var transaction = connection.BeginTransaction(deferred: false);
        var checkout = (await ReadAsync(connection, transaction, id, ct))!;
        if (checkout.Status != "pending") return checkout;
        transaction.Save("order_creation");
        try
        {
            await using var order = Command(connection, transaction, """
                INSERT INTO orders(branch_id,order_date,name,status)
                VALUES($branch,strftime('%Y-%m-%dT%H:%M:%fZ','now'),$name,'confirmed');
                SELECT last_insert_rowid();
                """, ("$branch", checkout.BranchId), ("$name", $"Checkout {id}"));
            var orderId = Convert.ToInt32(await order.ExecuteScalarAsync(ct));
            foreach (var item in checkout.Items)
            {
                await using var detail = Command(connection, transaction, """
                    INSERT INTO order_details(order_id,product_id,quantity,unit_price)
                    VALUES($order,$product,$quantity,$price);
                    """, ("$order", orderId), ("$product", item.ProductId),
                    ("$quantity", item.Quantity), ("$price", item.UnitPriceCents / 100m));
                await detail.ExecuteNonQueryAsync(ct);
            }
            await using var complete = Command(connection, transaction, """
                UPDATE checkouts SET status='completed',order_id=$order,payment_intent_id=$intent
                WHERE checkout_id=$id;
                """, ("$order", orderId), ("$intent", intent), ("$id", id));
            await complete.ExecuteNonQueryAsync(ct);
        }
        catch (Exception ex) when (ex is SqliteException or OverflowException)
        {
            transaction.Rollback("order_creation");
            logger.LogWarning("Paid checkout order persistence failed; scheduling refund");
            await using var refund = Command(connection, transaction, """
                UPDATE checkouts SET status='refund_pending',payment_intent_id=$intent WHERE checkout_id=$id;
                """, ("$id", id), ("$intent", intent));
            await refund.ExecuteNonQueryAsync(CancellationToken.None);
        }
        var result = (await ReadAsync(connection, transaction, id, CancellationToken.None))!;
        await transaction.CommitAsync(CancellationToken.None);
        return result;
    }

    private static SqliteCommand Command(SqliteConnection connection, SqliteTransaction? transaction,
        string sql, params (string Key, object Value)[] parameters)
    {
        var cmd = connection.CreateCommand();
        cmd.Transaction = transaction;
        cmd.CommandText = sql;
        foreach (var (key, value) in parameters) cmd.Parameters.AddWithValue(key, value);
        return cmd;
    }

    private static async Task<CheckoutPayment?> ReadAsync(SqliteConnection connection, SqliteTransaction? transaction,
        string id, CancellationToken ct)
    {
        await using var cmd = Command(connection, transaction, "SELECT * FROM checkouts WHERE checkout_id=$id;", ("$id", id));
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        string? Text(string name) => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetString(reader.GetOrdinal(name));
        return new(id, reader.GetInt32(reader.GetOrdinal("branch_id")), Text("request_json")!,
            Text("items_json")!, reader.GetInt32(reader.GetOrdinal("amount_total")), Text("status")!,
            Text("provider_session_id"), Text("checkout_url"), Text("payment_intent_id"),
            reader.IsDBNull(reader.GetOrdinal("order_id")) ? null : reader.GetInt32(reader.GetOrdinal("order_id")),
            DateTimeOffset.Parse(Text("created_at")!, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal));
    }
}
