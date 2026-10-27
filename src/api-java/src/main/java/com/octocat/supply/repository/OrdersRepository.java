package com.octocat.supply.repository;

import com.octocat.supply.model.OrderModel.CreateOrderRequest;
import com.octocat.supply.model.OrderModel.Order;
import com.octocat.supply.model.OrderModel.UpdateOrderRequest;
import com.octocat.supply.model.OrderDetailModel.CreateOrderDetailRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

@Repository
public class OrdersRepository {
    private final JdbcTemplate jdbcTemplate;
    private final InventoryRepository inventory;
    private final OrderDetailsRepository details;

    private final RowMapper<Order> mapper = (rs, rowNum) -> new Order(
        rs.getInt("order_id"),
        rs.getInt("branch_id"),
        rs.getString("order_date"),
        rs.getString("name"),
        rs.getString("description"),
        rs.getString("status")
    );

    public OrdersRepository(JdbcTemplate jdbcTemplate, InventoryRepository inventory, OrderDetailsRepository details) {
        this.jdbcTemplate = jdbcTemplate;
        this.inventory = inventory;
        this.details = details;
    }

    public List<Order> findAll() {
        return jdbcTemplate.query("SELECT * FROM orders ORDER BY order_id", mapper);
    }

    public Optional<Order> findById(int id) {
        return jdbcTemplate.query("SELECT * FROM orders WHERE order_id = ?", mapper, id).stream().findFirst();
    }

    @Transactional
    public Order create(CreateOrderRequest request) {
        inventory.requireBranch(request.branchId());
        if (request.items() != null) {
            for (var item : request.items()) {
                inventory.requireProduct(item.productId());
            }
        }
        jdbcTemplate.update(
            """
                INSERT INTO orders (branch_id, order_date, name, description, status)
                VALUES (?, ?, ?, ?, ?)
                """,
            request.branchId(),
            request.orderDate(),
            request.name(),
            request.description(),
            request.status() == null ? "pending" : request.status()
        );
        Integer id = jdbcTemplate.queryForObject("SELECT last_insert_rowid()", Integer.class);
        Order order = findById(id).orElseThrow();
        if (request.items() == null) {
            return order;
        }
        for (var item : request.items()) {
            details.create(new CreateOrderDetailRequest(id, item.productId(), item.quantity()));
        }
        return new Order(order.orderId(), order.branchId(), order.orderDate(), order.name(), order.description(),
            order.status(), details.findByOrderId(id));
    }

    public boolean update(int id, UpdateOrderRequest request) {
        return SqlUpdateBuilder.executeIfPresent(
            b -> {
                b.add("branch_id", request.branchId());
                b.add("order_date", request.orderDate());
                b.add("name", request.name());
                b.add("description", request.description());
                b.add("status", request.status());
            },
            "orders",
            "order_id",
            id,
            jdbcTemplate
        );
    }

    public boolean delete(int id) {
        return jdbcTemplate.update("DELETE FROM orders WHERE order_id = ?", id) > 0;
    }
}
