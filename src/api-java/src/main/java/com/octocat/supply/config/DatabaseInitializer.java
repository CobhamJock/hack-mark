package com.octocat.supply.config;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Comparator;
import java.util.List;

@Component
public class DatabaseInitializer implements ApplicationRunner {
    private final DataSource dataSource;

    public DatabaseInitializer(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    @Override
    public void run(ApplicationArguments args) throws Exception {
        try (Connection connection = dataSource.getConnection()) {
            ensureMigrationsTable(connection);
            applyMigrations(connection);
            seedIfNeeded(connection);
        }
    }

    private void ensureMigrationsTable(Connection connection) throws Exception {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                CREATE TABLE IF NOT EXISTS migrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    version INTEGER NOT NULL,
                    filename TEXT NOT NULL UNIQUE,
                    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """);
        }
    }

    private void applyMigrations(Connection connection) throws Exception {
        Path migrationsDir = resolvePath("../database/migrations", true);
        if (!Files.exists(migrationsDir)) {
            throw new IllegalStateException("Migrations directory not found: " + migrationsDir);
        }

        List<Path> files;
        try (var stream = Files.list(migrationsDir)) {
            files = stream
                .filter(path -> path.getFileName().toString().endsWith(".sql"))
                .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                .toList();
        }

        for (Path file : files) {
            String filename = file.getFileName().toString();
            if (isMigrationApplied(connection, filename)) {
                continue;
            }

            applyMigration(connection, file);
        }
    }

    void applyMigration(Connection connection, Path file) throws Exception {
        connection.setAutoCommit(false);
        try {
            executeSqlFile(connection, file);
            try (var statement = connection.prepareStatement("INSERT INTO migrations (version, filename) VALUES (?, ?)")) {
                statement.setInt(1, parseMigrationVersion(file.getFileName().toString()));
                statement.setString(2, file.getFileName().toString());
                statement.executeUpdate();
            }
            connection.commit();
        } catch (Exception ex) {
            connection.rollback();
            throw ex;
        } finally {
            connection.setAutoCommit(true);
        }
    }

    private boolean isMigrationApplied(Connection connection, String filename) throws Exception {
        try (var statement = connection.prepareStatement("SELECT COUNT(*) FROM migrations WHERE filename = ?")) {
            statement.setString(1, filename);
            try (ResultSet resultSet = statement.executeQuery()) {
                return resultSet.next() && resultSet.getInt(1) > 0;
            }
        }
    }

    private void seedIfNeeded(Connection connection) throws Exception {
        boolean shouldSeed = true;
        try (Statement statement = connection.createStatement();
             ResultSet resultSet = statement.executeQuery("SELECT COUNT(*) FROM suppliers")) {
            if (resultSet.next()) {
                shouldSeed = resultSet.getInt(1) == 0;
            }
        } catch (Exception ignored) {
            shouldSeed = true;
        }

        if (!shouldSeed) {
            return;
        }

        Path seedDir = resolvePath("../database/seed", false);
        if (!Files.exists(seedDir)) {
            return;
        }

        List<Path> files;
        try (var stream = Files.list(seedDir)) {
            files = stream
                .filter(path -> path.getFileName().toString().endsWith(".sql"))
                .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                .toList();
        }

        connection.setAutoCommit(false);
        try {
            for (Path file : files) {
                executeSqlFile(connection, file);
            }
            connection.commit();
        } catch (Exception ex) {
            connection.rollback();
            throw ex;
        } finally {
            connection.setAutoCommit(true);
        }
    }

    private void executeSqlFile(Connection connection, Path file) throws Exception {
        try (Statement statement = connection.createStatement()) {
            // Xerial's executeUpdate uses sqlite3_exec to parse the complete script,
            // preserving semicolons inside trigger bodies and quoted strings.
            statement.executeUpdate(Files.readString(file));
        }
    }

    private int parseMigrationVersion(String filename) {
        String prefix = filename.split("_", 2)[0];
        try {
            return Integer.parseInt(prefix);
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    private Path resolvePath(String relativePath, boolean allowEnvOverride) {
        if (allowEnvOverride) {
            String override = System.getenv("DB_MIGRATIONS_DIR");
            if (override != null && !override.isBlank()) {
                return Paths.get(override).toAbsolutePath().normalize();
            }
        }
        return Paths.get(relativePath).toAbsolutePath().normalize();
    }
}
