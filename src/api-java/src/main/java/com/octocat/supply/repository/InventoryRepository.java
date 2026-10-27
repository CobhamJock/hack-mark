package com.octocat.supply.repository;

import com.octocat.supply.exception.NotFoundException;
import com.octocat.supply.model.InventoryModel.Inventory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class InventoryRepository {
    private final JdbcTemplate jdbcTemplate;

    public InventoryRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void requireBranch(int branchId) {
        if (jdbcTemplate.queryForObject("SELECT COUNT(*) FROM branches WHERE branch_id = ?", Integer.class, branchId) == 0) {
            throw new NotFoundException("Branch not found");
        }
    }

    public void requireProduct(int productId) {
        if (jdbcTemplate.queryForObject("SELECT COUNT(*) FROM products WHERE product_id = ?", Integer.class, productId) == 0) {
            throw new NotFoundException("Product not found");
        }
    }

    @Transactional
    public Inventory upsert(int branchId, int productId, int quantityOnHand) {
        requireBranch(branchId);
        requireProduct(productId);
        jdbcTemplate.update("""
            INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (?, ?, ?)
            ON CONFLICT(branch_id, product_id) DO UPDATE SET quantity_on_hand = excluded.quantity_on_hand
            """, branchId, productId, quantityOnHand);
        return new Inventory(branchId, productId, quantityOnHand);
    }
}
