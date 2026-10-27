using Microsoft.Data.Sqlite;
using OctoSupply.Api.Data;
using OctoSupply.Api.Models;
using OctoSupply.Api.Utils;

namespace OctoSupply.Api.Repositories;

public sealed class OrdersRepository(SqliteConnectionFactory connectionFactory)
{
    private readonly SqliteConnectionFactory _connectionFactory = connectionFactory;

    public async Task<IReadOnlyList<Order>> FindAllAsync()
    {
        const string sql = "SELECT * FROM orders ORDER BY order_id;";
        await using var connection = await _connectionFactory.OpenConnectionAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        await using var reader = await cmd.ExecuteReaderAsync();
        var items = new List<Order>();
        while (await reader.ReadAsync())
        {
            items.Add(Map(reader));
        }
        return items;
    }

    public async Task<Order?> FindByIdAsync(int id)
    {
        const string sql = "SELECT * FROM orders WHERE order_id = $id;";
        await using var connection = await _connectionFactory.OpenConnectionAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$id", id);
        await using var reader = await cmd.ExecuteReaderAsync();
        return await reader.ReadAsync() ? Map(reader) : null;
    }

    public async Task<Order> CreateAsync(CreateOrderRequest request)
    {
        if (request.ItemsSpecified &&
            (request.Items is null || request.Items.Count is < 1 or > 100 ||
             request.Items.Any(item => item is null || item.ProductId <= 0 || item.Quantity <= 0)))
        {
            throw new ValidationException("items must contain 1 to 100 lines with positive integer productId and quantity");
        }

        const string sql = """
            INSERT INTO orders (branch_id, order_date, name, description, status)
            VALUES ($branchId, $orderDate, $name, $description, $status);
            SELECT last_insert_rowid();
            """;

        await using var connection = await _connectionFactory.OpenConnectionAsync();
        await using var transaction = connection.BeginTransaction();
        if (request.ItemsSpecified)
        {
            await InventoryRepository.RequireBranchAsync(connection, request.BranchId, transaction);
        }
        await using var cmd = connection.CreateCommand();
        cmd.Transaction = transaction;
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$branchId", request.BranchId);
        cmd.Parameters.AddWithValue("$orderDate", request.OrderDate);
        cmd.Parameters.AddWithValue("$name", request.Name);
        cmd.Parameters.AddWithValue("$description", (object?)request.Description ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$status", request.Status);

        var id = Convert.ToInt32(await cmd.ExecuteScalarAsync());
        List<OrderDetail>? items = null;
        if (request.ItemsSpecified)
        {
            items = [];
            foreach (var item in request.Items!)
            {
                await using var product = connection.CreateCommand();
                product.Transaction = transaction;
                product.CommandText = "SELECT price, discount FROM products WHERE product_id = $id;";
                product.Parameters.AddWithValue("$id", item!.ProductId);
                decimal price;
                await using (var reader = await product.ExecuteReaderAsync())
                {
                    if (!await reader.ReadAsync())
                    {
                        throw new NotFoundException("Product", item.ProductId);
                    }
                    price = Math.Round(reader.GetDecimal(0) * (1 - reader.GetDecimal(1)),
                        2, MidpointRounding.AwayFromZero);
                }

                await using var detail = connection.CreateCommand();
                detail.Transaction = transaction;
                detail.CommandText = """
                    INSERT INTO order_details (order_id, product_id, quantity, unit_price)
                    VALUES ($orderId, $productId, $quantity, $unitPrice);
                    SELECT last_insert_rowid();
                    """;
                detail.Parameters.AddWithValue("$orderId", id);
                detail.Parameters.AddWithValue("$productId", item.ProductId);
                detail.Parameters.AddWithValue("$quantity", item.Quantity);
                detail.Parameters.AddWithValue("$unitPrice", price);
                var detailId = Convert.ToInt32(await detail.ExecuteInventoryInsertAsync());
                await using var persisted = connection.CreateCommand();
                persisted.Transaction = transaction;
                persisted.CommandText = "SELECT * FROM order_details WHERE order_detail_id = $id;";
                persisted.Parameters.AddWithValue("$id", detailId);
                await using var persistedReader = await persisted.ExecuteReaderAsync();
                await persistedReader.ReadAsync();
                items.Add(OrderDetailsRepository.Map(persistedReader));
            }
        }
        await using var getOrder = connection.CreateCommand();
        getOrder.Transaction = transaction;
        getOrder.CommandText = "SELECT * FROM orders WHERE order_id = $id;";
        getOrder.Parameters.AddWithValue("$id", id);
        Order created;
        await using (var reader = await getOrder.ExecuteReaderAsync())
        {
            if (!await reader.ReadAsync()) throw new DatabaseException("Failed to retrieve created Order");
            created = Map(reader) with { Items = items };
        }
        await transaction.CommitAsync();
        return created;
    }

    public async Task<Order> UpdateAsync(int id, UpdateOrderRequest request)
    {
        var updates = new List<string>();
        var parameters = new List<SqliteParameter>();
        if (request.BranchId.HasValue) { updates.Add("branch_id = $branchId"); parameters.Add(new SqliteParameter("$branchId", request.BranchId.Value)); }
        if (request.OrderDate is not null) { updates.Add("order_date = $orderDate"); parameters.Add(new SqliteParameter("$orderDate", request.OrderDate)); }
        if (request.Name is not null) { updates.Add("name = $name"); parameters.Add(new SqliteParameter("$name", request.Name)); }
        if (request.Description is not null) { updates.Add("description = $description"); parameters.Add(new SqliteParameter("$description", request.Description)); }
        if (request.Status is not null) { updates.Add("status = $status"); parameters.Add(new SqliteParameter("$status", request.Status)); }

        if (updates.Count == 0)
        {
            throw new ValidationException("No fields provided for update");
        }

        var sql = $"UPDATE orders SET {string.Join(", ", updates)} WHERE order_id = $id;";
        await using var connection = await _connectionFactory.OpenConnectionAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$id", id);
        foreach (var parameter in parameters)
        {
            cmd.Parameters.Add(parameter);
        }
        var changes = await cmd.ExecuteInventoryWriteAsync();
        if (changes == 0)
        {
            throw new NotFoundException("Order", id);
        }

        return await FindByIdAsync(id) ?? throw new DatabaseException("Failed to retrieve updated Order");
    }

    public async Task DeleteAsync(int id)
    {
        const string sql = "DELETE FROM orders WHERE order_id = $id;";
        await using var connection = await _connectionFactory.OpenConnectionAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$id", id);
        var changes = await cmd.ExecuteNonQueryAsync();
        if (changes == 0)
        {
            throw new NotFoundException("Order", id);
        }
    }

    private static Order Map(SqliteDataReader reader) =>
        new(
            OrderId: reader.GetInt32(reader.GetOrdinal("order_id")),
            BranchId: reader.GetInt32(reader.GetOrdinal("branch_id")),
            OrderDate: reader.GetString(reader.GetOrdinal("order_date")),
            Name: reader.GetString(reader.GetOrdinal("name")),
            Description: reader["description"] as string,
            Status: reader.GetString(reader.GetOrdinal("status"))
        );
}
