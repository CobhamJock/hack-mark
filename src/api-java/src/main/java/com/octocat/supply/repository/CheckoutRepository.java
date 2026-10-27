package com.octocat.supply.repository;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.octocat.supply.exception.ConflictException;
import com.octocat.supply.exception.DatabaseException;
import com.octocat.supply.exception.NotFoundException;
import com.octocat.supply.exception.ValidationException;
import com.octocat.supply.model.CheckoutModel.*;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Repository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.sql.DataSource;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

@Repository
public class CheckoutRepository {
    private static final Logger log = LoggerFactory.getLogger(CheckoutRepository.class);
    private final DataSource dataSource;
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public CheckoutRepository(DataSource dataSource, ObjectMapper json) {
        this.dataSource = dataSource;
        this.jdbc = new JdbcTemplate(dataSource);
        this.json = json;
    }

    public Checkout get(String id) {
        return get(jdbc, id);
    }

    private Checkout get(JdbcTemplate db, String id) {
        List<Checkout> rows = db.query("SELECT * FROM checkouts WHERE checkout_id = ?", (r, n) ->
            new Checkout(r.getString("checkout_id"), r.getInt("branch_id"), r.getString("request_json"),
                r.getString("items_json"), r.getInt("amount_total"), r.getString("status"),
                r.getString("provider_session_id"), r.getString("checkout_url"),
                r.getString("payment_intent_id"), (Integer) r.getObject("order_id"), r.getString("created_at")), id);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public Checkout require(String id) {
        Checkout checkout = get(id);
        if (checkout == null) {
            throw new NotFoundException("Checkout not found");
        }
        return checkout;
    }

    public Checkout createOrRead(String id, Request request) {
        return immediate(db -> {
            Checkout existing = get(db, id);
            if (existing != null) {
                if (!read(existing.requestJson(), Request.class).equals(request)) {
                    throw new ConflictException("Checkout ID already has a different request");
                }
                return existing;
            }
            if (db.queryForObject("SELECT COUNT(*) FROM branches WHERE branch_id = ?", Integer.class,
                    request.branchId()) == 0) {
                throw new NotFoundException("Branch not found");
            }
            List<Snapshot> items = new ArrayList<>();
            long total = 0;
            for (Item item : request.items()) {
                List<Snapshot> found = db.query("""
                    SELECT p.name, p.price, COALESCE(p.discount, 0) discount,
                        COALESCE(i.quantity_on_hand, 0) stock
                    FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id AND i.branch_id = ?
                    WHERE p.product_id = ?
                    """, (r, n) -> {
                    if (r.getLong("stock") < item.quantity()) {
                        throw new ConflictException("Insufficient stock");
                    }
                    try {
                        BigDecimal price = new BigDecimal(r.getString("price"));
                        BigDecimal discount = new BigDecimal(r.getString("discount"));
                        if (price.signum() <= 0 || discount.signum() < 0 || discount.compareTo(BigDecimal.ONE) > 0) {
                            throw new ArithmeticException();
                        }
                        int cents = price.multiply(BigDecimal.ONE.subtract(discount)).movePointRight(2)
                            .setScale(0, RoundingMode.HALF_UP).intValueExact();
                        if (cents <= 0) {
                            throw new ArithmeticException();
                        }
                        return new Snapshot(item.productId(), item.quantity(), cents, r.getString("name"));
                    } catch (ArithmeticException | NumberFormatException ex) {
                        throw new ValidationException("Product price is not payable");
                    }
                }, request.branchId(), item.productId());
                if (found.isEmpty()) {
                    throw new NotFoundException("Product not found");
                }
                Snapshot snapshot = found.get(0);
                total += (long) snapshot.quantity() * snapshot.unitPriceCents();
                if (total > 99999999) {
                    throw new ValidationException("Checkout total exceeds payment limit");
                }
                items.add(snapshot);
            }
            if (total < 50) {
                throw new ValidationException("Checkout total must be at least 50 cents");
            }
            db.update("""
                INSERT INTO checkouts(checkout_id, branch_id, request_json, items_json, amount_total, currency)
                VALUES (?, ?, ?, ?, ?, 'usd')
                """, id, request.branchId(), write(request), write(items), (int) total);
            return get(db, id);
        });
    }

    public List<Snapshot> snapshots(Checkout checkout) {
        try {
            return json.readValue(checkout.itemsJson(), new TypeReference<List<Snapshot>>() {});
        } catch (Exception ex) {
            throw new DatabaseException("Invalid checkout snapshot");
        }
    }

    public Checkout saveSession(String id, String sessionId, String url) {
        return immediate(db -> {
            db.update("""
                UPDATE checkouts SET provider_session_id = ?, checkout_url = ?, status = 'pending'
                WHERE checkout_id = ? AND status = 'creating'
                """, sessionId, url, id);
            return get(db, id);
        });
    }

    public Checkout cancel(String id) {
        return immediate(db -> {
            db.update("UPDATE checkouts SET status = 'cancelled' WHERE checkout_id = ? AND status = 'pending'", id);
            return get(db, id);
        });
    }

    public Checkout refunded(String id) {
        return immediate(db -> {
            db.update("UPDATE checkouts SET status = 'refunded' WHERE checkout_id = ? AND status = 'refund_pending'", id);
            return get(db, id);
        });
    }

    public Checkout finalizePaid(String id, String intent) {
        return immediate(db -> {
            Checkout current = get(db, id);
            if ("completed".equals(current.status()) || "refund_pending".equals(current.status())
                    || "refunded".equals(current.status())) {
                return current;
            }
            if (!"pending".equals(current.status()) && !"cancelled".equals(current.status())) {
                throw new ConflictException("Checkout cannot be finalized");
            }
            db.execute("SAVEPOINT checkout_order");
            try {
                db.update("""
                    INSERT INTO orders(branch_id, order_date, name, status)
                    VALUES (?, CURRENT_TIMESTAMP, ?, 'confirmed')
                    """, current.branchId(), "Checkout " + id);
                int orderId = db.queryForObject("SELECT last_insert_rowid()", Integer.class);
                for (Snapshot item : snapshots(current)) {
                    db.update("""
                        INSERT INTO order_details(order_id, product_id, quantity, unit_price)
                        VALUES (?, ?, ?, ?)
                        """, orderId, item.productId(), item.quantity(), BigDecimal.valueOf(item.unitPriceCents(), 2));
                }
                db.update("""
                    UPDATE checkouts SET status = 'completed', order_id = ?, payment_intent_id = ?
                    WHERE checkout_id = ?
                    """, orderId, intent, id);
                db.execute("RELEASE checkout_order");
            } catch (DataAccessException ex) {
                // Keep the paid intent durable, but roll back every order/stock write before refunding.
                db.execute("ROLLBACK TO checkout_order");
                db.execute("RELEASE checkout_order");
                db.update("UPDATE checkouts SET status = 'refund_pending', payment_intent_id = ? WHERE checkout_id = ?",
                    intent, id);
                log.warn("Checkout {} order rolled back; refund reconciliation required", id);
            }
            return get(db, id);
        });
    }

    private <T> T immediate(Function<JdbcTemplate, T> action) {
        try (Connection connection = dataSource.getConnection()) {
            JdbcTemplate db = new JdbcTemplate(new SingleConnectionDataSource(connection, true));
            db.execute("BEGIN IMMEDIATE");
            try {
                T result = action.apply(db);
                db.execute("COMMIT");
                return result;
            } catch (RuntimeException ex) {
                db.execute("ROLLBACK");
                throw ex;
            }
        } catch (SQLException ex) {
            throw new DatabaseException("Checkout persistence failed");
        }
    }

    private String write(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (Exception ex) {
            throw new DatabaseException("Checkout persistence failed");
        }
    }

    private <T> T read(String value, Class<T> type) {
        try {
            return json.readValue(value, type);
        } catch (Exception ex) {
            throw new DatabaseException("Invalid checkout request");
        }
    }
}
