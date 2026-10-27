package com.octocat.supply.repository;

import com.octocat.supply.model.OrderDetailModel.CreateOrderDetailRequest;
import com.octocat.supply.model.OrderDetailModel.OrderDetail;
import com.octocat.supply.model.OrderDetailModel.UpdateOrderDetailRequest;
import com.octocat.supply.exception.NotFoundException;
import com.octocat.supply.model.ProductModel.Product;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Optional;

@Repository
public class OrderDetailsRepository {
    private final JdbcTemplate jdbcTemplate;
    private final ProductsRepository products;

    private final RowMapper<OrderDetail> mapper = (rs, rowNum) -> new OrderDetail(
        rs.getInt("order_detail_id"),
        rs.getInt("order_id"),
        rs.getInt("product_id"),
        rs.getInt("quantity"),
        rs.getDouble("unit_price")
    );

    public OrderDetailsRepository(JdbcTemplate jdbcTemplate, ProductsRepository products) {
        this.jdbcTemplate = jdbcTemplate;
        this.products = products;
    }

    public List<OrderDetail> findAll() {
        return jdbcTemplate.query("SELECT * FROM order_details ORDER BY order_detail_id", mapper);
    }

    public Optional<OrderDetail> findById(int id) {
        return jdbcTemplate.query("SELECT * FROM order_details WHERE order_detail_id = ?", mapper, id).stream().findFirst();
    }

    public List<OrderDetail> findByOrderId(int orderId) {
        return jdbcTemplate.query("SELECT * FROM order_details WHERE order_id = ? ORDER BY order_detail_id", mapper, orderId);
    }

    @Transactional
    public OrderDetail create(CreateOrderDetailRequest request) {
        if (jdbcTemplate.queryForObject("SELECT COUNT(*) FROM orders WHERE order_id = ?", Integer.class, request.orderId()) == 0) {
            throw new NotFoundException("Order not found");
        }
        Product product = products.findById(request.productId()).orElseThrow(() -> new NotFoundException("Product not found"));
        BigDecimal unitPrice = BigDecimal.valueOf(product.price())
            .multiply(BigDecimal.ONE.subtract(BigDecimal.valueOf(product.discount())))
            .setScale(2, RoundingMode.HALF_UP);
        jdbcTemplate.update(
            """
                INSERT INTO order_details (order_id, product_id, quantity, unit_price)
                VALUES (?, ?, ?, ?)
                """,
            request.orderId(),
            request.productId(),
            request.quantity(),
            unitPrice
        );
        Integer id = jdbcTemplate.queryForObject("SELECT last_insert_rowid()", Integer.class);
        return findById(id).orElseThrow();
    }

    public boolean update(int id, UpdateOrderDetailRequest request) {
        return SqlUpdateBuilder.executeIfPresent(
            b -> {
                b.add("order_id", request.orderId());
                b.add("product_id", request.productId());
                b.add("quantity", request.quantity());
            },
            "order_details",
            "order_detail_id",
            id,
            jdbcTemplate
        );
    }

    public boolean delete(int id) {
        return jdbcTemplate.update("DELETE FROM order_details WHERE order_detail_id = ?", id) > 0;
    }
}
