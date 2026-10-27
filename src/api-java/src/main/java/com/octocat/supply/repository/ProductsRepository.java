package com.octocat.supply.repository;

import com.octocat.supply.model.ProductModel.CreateProductRequest;
import com.octocat.supply.model.ProductModel.Product;
import com.octocat.supply.model.ProductModel.UpdateProductRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public class ProductsRepository {
    private final JdbcTemplate jdbcTemplate;

    private final RowMapper<Product> mapper = (rs, rowNum) -> new Product(
        rs.getInt("product_id"),
        rs.getInt("supplier_id"),
        rs.getString("name"),
        rs.getString("description"),
        rs.getDouble("price"),
        rs.getString("sku"),
        rs.getString("unit"),
        rs.getString("img_name"),
        rs.getDouble("discount"),
        rs.getLong("quantity_on_hand")
    );

    public ProductsRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<Product> findAll() {
        return findAll(1);
    }

    public List<Product> findAll(int branchId) {
        return jdbcTemplate.query("""
            SELECT p.*, COALESCE(i.quantity_on_hand, 0) AS quantity_on_hand
            FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id AND i.branch_id = ?
            ORDER BY p.product_id
            """, mapper, branchId);
    }

    public Optional<Product> findById(int id) {
        return findById(id, 1);
    }

    public Optional<Product> findById(int id, int branchId) {
        return jdbcTemplate.query("""
            SELECT p.*, COALESCE(i.quantity_on_hand, 0) AS quantity_on_hand
            FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id AND i.branch_id = ?
            WHERE p.product_id = ?
            """, mapper, branchId, id).stream().findFirst();
    }

    public Product create(CreateProductRequest request) {
        jdbcTemplate.update(
            """
                INSERT INTO products (supplier_id, name, description, price, sku, unit, img_name, discount)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
            request.supplierId(),
            request.name(),
            request.description(),
            request.price(),
            request.sku(),
            request.unit(),
            request.imgName(),
            request.discount() == null ? 0d : request.discount()
        );
        Integer id = jdbcTemplate.queryForObject("SELECT last_insert_rowid()", Integer.class);
        return findById(id).orElseThrow();
    }

    public boolean update(int id, UpdateProductRequest request) {
        return SqlUpdateBuilder.executeIfPresent(
            b -> {
                b.add("supplier_id", request.supplierId());
                b.add("name", request.name());
                b.add("description", request.description());
                b.add("price", request.price());
                b.add("sku", request.sku());
                b.add("unit", request.unit());
                b.add("img_name", request.imgName());
                b.add("discount", request.discount());
            },
            "products",
            "product_id",
            id,
            jdbcTemplate
        );
    }

    public boolean delete(int id) {
        return jdbcTemplate.update("DELETE FROM products WHERE product_id = ?", id) > 0;
    }
}
