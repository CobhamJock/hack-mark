package com.octocat.supply.config;

import org.junit.jupiter.api.Test;
import org.sqlite.SQLiteDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class DatabaseInitializerTest {
    @Test
    void sharedMigrationParsesWholeTriggerBodiesAndRecordsMigrationAtomically() throws Exception {
        SQLiteDataSource source = new SQLiteDataSource();
        source.setUrl("jdbc:sqlite::memory:");
        DatabaseInitializer initializer = new DatabaseInitializer(source);
        try (Connection connection = source.getConnection()) {
            initializeSchema(connection);
            initializer.applyMigration(connection, Path.of("..", "database", "migrations", "003_branch_inventory.sql"));
            try (var statement = connection.createStatement();
                 var result = statement.executeQuery("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'inventory_%'")) {
                assertThat(result.getInt(1)).isEqualTo(5);
            }
            try (var statement = connection.createStatement()) {
                statement.executeUpdate(Files.readString(Path.of("..", "database", "seed", "001_suppliers.sql")));
                statement.executeUpdate(Files.readString(Path.of("..", "database", "seed", "002_headquarters.sql")));
                statement.executeUpdate(Files.readString(Path.of("..", "database", "seed", "003_branches.sql")));
                statement.executeUpdate(Files.readString(Path.of("..", "database", "seed", "004_products.sql")));
                statement.executeUpdate("INSERT INTO orders (order_id, branch_id, order_date, name) VALUES (1, 1, '2026-10-27', 'Trigger test')");
                assertThatThrownBy(() -> statement.executeUpdate(
                    "INSERT INTO order_details (order_id, product_id, quantity, unit_price) VALUES (1, 1, 1, 1)"))
                    .isInstanceOf(SQLException.class).hasMessageContaining("Insufficient stock");
                assertThatThrownBy(() -> statement.executeUpdate(
                    "INSERT INTO order_details (order_id, product_id, quantity, unit_price) VALUES (1, 1, 0, 1)"))
                    .isInstanceOf(SQLException.class).hasMessageContaining("Quantity must be a positive integer");
            }
            assertThat(connection.getAutoCommit()).isTrue();
        }
    }

    @Test
    void failureToRecordMigrationRollsBackAllDdlAndTriggers() throws Exception {
        SQLiteDataSource source = new SQLiteDataSource();
        source.setUrl("jdbc:sqlite::memory:");
        DatabaseInitializer initializer = new DatabaseInitializer(source);
        try (Connection connection = source.getConnection()) {
            initializeSchema(connection);
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("""
                    CREATE TRIGGER reject_migration BEFORE INSERT ON migrations
                    BEGIN SELECT RAISE(ABORT, 'test migration failure'); END;
                    """);
            }
            assertThatThrownBy(() -> initializer.applyMigration(connection,
                Path.of("..", "database", "migrations", "003_branch_inventory.sql")))
                .isInstanceOf(SQLException.class).hasMessageContaining("test migration failure");
            try (var statement = connection.createStatement();
                 var result = statement.executeQuery("SELECT COUNT(*) FROM sqlite_master WHERE name = 'inventory' OR name LIKE 'inventory_%'")) {
                assertThat(result.getInt(1)).isZero();
            }
            try (var statement = connection.createStatement();
                 var result = statement.executeQuery("SELECT COUNT(*) FROM migrations")) {
                assertThat(result.getInt(1)).isZero();
            }
            assertThat(connection.getAutoCommit()).isTrue();
        }
    }

    @Test
    void historicalDetailsDoNotInventStockAndFirstUpdateAllocatesFullQuantity() throws Exception {
        SQLiteDataSource source = new SQLiteDataSource();
        source.setUrl("jdbc:sqlite::memory:");
        DatabaseInitializer initializer = new DatabaseInitializer(source);
        try (Connection connection = source.getConnection()) {
            initializeSchema(connection);
            try (var statement = connection.createStatement()) {
                for (String file : new String[]{"001_suppliers.sql", "002_headquarters.sql", "003_branches.sql", "004_products.sql"}) {
                    statement.executeUpdate(Files.readString(Path.of("..", "database", "seed", file)));
                }
                statement.executeUpdate("""
                    INSERT INTO orders (order_id, branch_id, order_date, name) VALUES
                    (1, 1, '2026-10-27', 'Historical detail delete'),
                    (2, 1, '2026-10-27', 'Historical order delete'),
                    (3, 1, '2026-10-27', 'Historical detail update');
                    INSERT INTO order_details (order_detail_id, order_id, product_id, quantity, unit_price) VALUES
                    (1, 1, 1, 2, 97.49), (2, 2, 1, 2, 97.49), (3, 3, 1, 2, 97.49);
                    """);
            }
            initializer.applyMigration(connection, Path.of("..", "database", "migrations", "003_branch_inventory.sql"));
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (1, 1, 5)");
                statement.executeUpdate("DELETE FROM order_details WHERE order_detail_id = 1");
                assertStock(connection, 5);
                statement.executeUpdate("DELETE FROM orders WHERE order_id = 2");
                assertStock(connection, 5);
                assertThatThrownBy(() -> statement.executeUpdate("UPDATE order_details SET quantity = 6 WHERE order_detail_id = 3"))
                    .isInstanceOf(SQLException.class).hasMessageContaining("Insufficient stock");
                assertStock(connection, 5);
                statement.executeUpdate("UPDATE order_details SET quantity = 3 WHERE order_detail_id = 3");
                assertStock(connection, 2);
                statement.executeUpdate("DELETE FROM orders WHERE order_id = 3");
                assertStock(connection, 5);
            }
            try (var statement = connection.createStatement();
                 var result = statement.executeQuery("SELECT COUNT(*) FROM inventory_allocations")) {
                assertThat(result.getInt(1)).isZero();
            }
        }
    }

    private void assertStock(Connection connection, int expected) throws Exception {
        try (var statement = connection.createStatement();
             var result = statement.executeQuery("SELECT quantity_on_hand FROM inventory WHERE branch_id = 1 AND product_id = 1")) {
            assertThat(result.getInt(1)).isEqualTo(expected);
        }
    }

    private void initializeSchema(Connection connection) throws Exception {
        try (var statement = connection.createStatement()) {
            statement.executeUpdate("PRAGMA foreign_keys = ON");
            statement.executeUpdate(Files.readString(Path.of("..", "database", "migrations", "001_init.sql")));
            statement.executeUpdate(Files.readString(Path.of("..", "database", "migrations", "002_add_supplier_status_fields.sql")));
            statement.executeUpdate("CREATE TABLE migrations (version INTEGER NOT NULL, filename TEXT NOT NULL UNIQUE)");
        }
    }
}
