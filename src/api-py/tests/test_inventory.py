from __future__ import annotations

import asyncio
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import aiosqlite
import pytest
from fastapi.testclient import TestClient
from httpx import Response

from database.migrate import _ensure_migrations_table, _execute_sql_statements, initialize_database

ADMIN = {"Authorization": "Bearer test-inventory-admin"}
ORDER = {"branchId": 1, "orderDate": "2026-10-27", "name": "Inventory test"}


def set_stock(client: TestClient, product: int, quantity: int, branch: int = 1) -> None:
    response = client.put(
        f"/api/inventory/{branch}/{product}", json={"quantityOnHand": quantity}, headers=ADMIN
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"branchId": branch, "productId": product, "quantityOnHand": quantity}


def stock(client: TestClient, product: int, branch: int = 1) -> int:
    response = client.get(f"/api/products/{product}", params={"branchId": branch})
    assert response.status_code == 200, response.text
    return response.json()["quantityOnHand"]


def assert_error(response: Response, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code


def test_product_availability_and_branch_isolation(client: TestClient, isolated_database: Path) -> None:
    products = client.get("/api/products").json()
    assert products[0]["quantityOnHand"] == 3
    assert products[0]["stockStatus"] == "low_stock"
    assert products[1]["stockStatus"] == "out_of_stock"
    assert products[2]["stockStatus"] == "in_stock"
    assert {"name", "sku", "price", "discount"} <= products[0].keys()
    for quantity, status in [(0, "out_of_stock"), (1, "low_stock"), (5, "low_stock"), (6, "in_stock")]:
        set_stock(client, 1, quantity)
        assert client.get("/api/products/1").json()["stockStatus"] == status
    assert stock(client, 1, branch=2) == 3
    with closing(sqlite3.connect(isolated_database)) as connection, connection:
        connection.execute("DELETE FROM inventory WHERE branch_id = 1 AND product_id = 1")
    assert stock(client, 1) == 0
    assert client.get("/api/products").json()[0]["stockStatus"] == "out_of_stock"


@pytest.mark.parametrize("value", ["0", "-1", "1.5", "1.0", "true", "abc", ""])
@pytest.mark.parametrize("path", ["/api/products", "/api/products/1"])
def test_invalid_branch_query(client: TestClient, value: str, path: str) -> None:
    assert_error(client.get(path, params={"branchId": value}), 400, "VALIDATION_ERROR")


@pytest.mark.parametrize("path", ["/api/products?branchId=999", "/api/products/1?branchId=999", "/api/products/999"])
def test_missing_product_or_branch(client: TestClient, path: str) -> None:
    assert_error(client.get(path), 404, "NOT_FOUND")


@pytest.mark.parametrize("header", [None, "Bearer wrong", "Basic dGVzdA==", "Bearer"])
def test_inventory_authorization(client: TestClient, header: str | None) -> None:
    headers = {"Authorization": header} if header else {}
    response = client.put("/api/inventory/1/1", json={"quantityOnHand": 5}, headers=headers)
    assert_error(response, 403, "FORBIDDEN")
    assert "test-inventory-admin" not in response.text


def test_unconfigured_inventory_admin(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INVENTORY_ADMIN_TOKEN")
    assert_error(client.put("/api/inventory/1/1", json={"quantityOnHand": 5}, headers=ADMIN), 503, "SERVICE_UNAVAILABLE")


@pytest.mark.parametrize("quantity", [-1, 1.5, True, False, "3", None, 2147483648])
def test_invalid_stock_quantity(client: TestClient, quantity: object) -> None:
    assert_error(
        client.put("/api/inventory/1/1", json={"quantityOnHand": quantity}, headers=ADMIN),
        400, "VALIDATION_ERROR",
    )


@pytest.mark.parametrize("path,status", [
    ("/api/inventory/0/1", 400), ("/api/inventory/1/-1", 400),
    ("/api/inventory/1.0/1", 400), ("/api/inventory/999/1", 404), ("/api/inventory/1/999", 404),
])
def test_inventory_reference_validation(client: TestClient, path: str, status: int) -> None:
    assert_error(client.put(path, json={"quantityOnHand": 1}, headers=ADMIN), status,
                 "NOT_FOUND" if status == 404 else "VALIDATION_ERROR")


def test_inventory_upsert_and_maximum(client: TestClient, isolated_database: Path) -> None:
    with closing(sqlite3.connect(isolated_database)) as connection, connection:
        connection.execute("DELETE FROM inventory WHERE branch_id = 1 AND product_id = 1")
    set_stock(client, 1, 2147483647)
    assert stock(client, 1) == 2147483647
    set_stock(client, 1, 0)
    assert stock(client, 1) == 0


def test_order_items_use_server_prices_and_persist(client: TestClient) -> None:
    response = client.post("/api/orders", json={
        **ORDER, "items": [{"productId": 1, "quantity": 2, "unitPrice": 0.01}, {"productId": 3, "quantity": 4}]
    })
    assert response.status_code == 201, response.text
    order = response.json()
    assert [item["unitPrice"] for item in order["items"]] == [97.49, 89.99]
    assert [item["quantity"] for item in order["items"]] == [2, 4]
    assert all(item["orderId"] == order["orderId"] for item in order["items"])
    details = client.get("/api/order-details").json()
    assert details == order["items"]
    assert stock(client, 1) == 1
    assert stock(client, 3) == 16
    assert stock(client, 1, branch=2) == 3


@pytest.mark.parametrize("items,status", [
    ([{"productId": 1, "quantity": 2}, {"productId": 2, "quantity": 1}], 409),
    ([{"productId": 1, "quantity": 2}, {"productId": 999, "quantity": 1}], 404),
    ([{"productId": 1, "quantity": 2}, {"productId": 1, "quantity": 2}], 409),
])
def test_order_failure_rolls_back_all_writes(client: TestClient, items: list[dict[str, int]], status: int) -> None:
    response = client.post("/api/orders", json={**ORDER, "items": items})
    assert_error(response, status, "CONFLICT" if status == 409 else "NOT_FOUND")
    assert stock(client, 1) == 3
    assert client.get("/api/orders").json() == []
    assert client.get("/api/order-details").json() == []


@pytest.mark.parametrize("quantity", [0, -1, 1.5, True, "2", None, 2147483648])
def test_order_item_quantities_are_strict(client: TestClient, quantity: object) -> None:
    assert_error(client.post("/api/orders", json={**ORDER, "items": [{"productId": 1, "quantity": quantity}]}),
                 400, "VALIDATION_ERROR")


@pytest.mark.parametrize("items", [None, [], [{"productId": 1, "quantity": 1}] * 101])
def test_invalid_order_item_array(client: TestClient, items: object) -> None:
    assert_error(client.post("/api/orders", json={**ORDER, "items": items}), 400, "VALIDATION_ERROR")


@pytest.mark.parametrize("identifier", [0, -1, 1.5, True, "1"])
def test_order_ids_are_strict(client: TestClient, identifier: object) -> None:
    assert_error(client.post("/api/orders", json={**ORDER, "branchId": identifier}), 400, "VALIDATION_ERROR")
    assert_error(client.post("/api/orders", json={
        **ORDER, "items": [{"productId": identifier, "quantity": 1}]
    }), 400, "VALIDATION_ERROR")


def test_header_only_orders_remain_supported(client: TestClient) -> None:
    response = client.post("/api/orders", json=ORDER)
    assert response.status_code == 201
    assert "items" not in response.json()
    assert stock(client, 1) == 3
    assert_error(client.post("/api/orders", json={**ORDER, "branchId": 999}), 404, "NOT_FOUND")


@pytest.mark.parametrize("identifier", [2147483648, 9223372036854775808])
def test_large_positive_missing_references(client: TestClient, identifier: int) -> None:
    assert_error(client.get("/api/products", params={"branchId": identifier}), 404, "NOT_FOUND")
    assert_error(client.get(f"/api/products/{identifier}"), 404, "NOT_FOUND")
    assert_error(client.put(f"/api/inventory/1/{identifier}", json={"quantityOnHand": 1}, headers=ADMIN),
                 404, "NOT_FOUND")
    assert_error(client.post("/api/orders", json={**ORDER, "branchId": identifier}), 404, "NOT_FOUND")
    assert_error(client.post("/api/orders", json={
        **ORDER, "items": [{"productId": identifier, "quantity": 1}]
    }), 404, "NOT_FOUND")


def test_maximum_checkout_quantity(client: TestClient) -> None:
    set_stock(client, 1, 2147483647)
    response = client.post("/api/orders", json={
        **ORDER, "items": [{"productId": 1, "quantity": 2147483647}]
    })
    assert response.status_code == 201, response.text
    assert response.json()["items"][0]["quantity"] == 2147483647
    assert stock(client, 1) == 0


def test_one_hundred_order_lines_are_allowed(client: TestClient) -> None:
    set_stock(client, 1, 100)
    response = client.post("/api/orders", json={
        **ORDER, "items": [{"productId": 1, "quantity": 1}] * 100
    })
    assert response.status_code == 201, response.text
    assert len(response.json()["items"]) == 100
    assert stock(client, 1) == 0


def test_legacy_detail_stock_enforcement(client: TestClient) -> None:
    order_id = client.post("/api/orders", json=ORDER).json()["orderId"]
    detail = {"orderId": order_id, "productId": 1, "quantity": 2, "unitPrice": 1.0}
    response = client.post("/api/order-details", json=detail)
    assert response.status_code == 201, response.text
    detail_id = response.json()["orderDetailId"]
    assert stock(client, 1) == 1
    assert_error(client.post("/api/order-details", json=detail), 409, "CONFLICT")
    assert_error(client.put(f"/api/order-details/{detail_id}", json={"quantity": 4}), 409, "CONFLICT")
    assert stock(client, 1) == 1
    assert client.get(f"/api/order-details/{detail_id}").json()["quantity"] == 2
    assert client.put(f"/api/order-details/{detail_id}", json={"quantity": 3}).status_code == 200
    assert stock(client, 1) == 0
    assert_error(client.put(f"/api/orders/{order_id}", json={"branchId": 2}), 400, "VALIDATION_ERROR")
    assert client.get(f"/api/orders/{order_id}").json()["branchId"] == 1
    assert client.delete(f"/api/order-details/{detail_id}").status_code == 204
    assert stock(client, 1) == 3


@pytest.mark.parametrize("quantity", [0, -1, 1.5, True, "2", None, 2147483648])
def test_legacy_detail_quantity_validation(client: TestClient, quantity: object) -> None:
    order_id = client.post("/api/orders", json=ORDER).json()["orderId"]
    detail = {"orderId": order_id, "productId": 1, "quantity": 1, "unitPrice": 1.0}
    detail_id = client.post("/api/order-details", json=detail).json()["orderDetailId"]
    assert_error(client.post("/api/order-details", json={**detail, "quantity": quantity}), 400, "VALIDATION_ERROR")
    assert_error(client.put(f"/api/order-details/{detail_id}", json={"quantity": quantity}), 400, "VALIDATION_ERROR")
    assert stock(client, 1) == 2


def test_legacy_detail_transfer_and_order_delete(client: TestClient) -> None:
    first = client.post("/api/orders", json=ORDER).json()["orderId"]
    second = client.post("/api/orders", json={**ORDER, "branchId": 2}).json()["orderId"]
    detail_id = client.post("/api/order-details", json={
        "orderId": first, "productId": 1, "quantity": 2, "unitPrice": 1.0,
    }).json()["orderDetailId"]
    response = client.put(f"/api/order-details/{detail_id}", json={"orderId": second, "productId": 3})
    assert response.status_code == 200
    assert stock(client, 1) == 3
    assert stock(client, 3, branch=2) == 18
    assert client.delete(f"/api/orders/{second}").status_code == 204
    assert stock(client, 3, branch=2) == 20


def test_concurrent_orders_cannot_oversell(client: TestClient) -> None:
    set_stock(client, 1, 1)
    payload = {**ORDER, "items": [{"productId": 1, "quantity": 1}]}
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: client.post("/api/orders", json=payload), range(2)))
    assert sorted(response.status_code for response in responses) == [201, 409]
    assert stock(client, 1) == 0
    assert len(client.get("/api/orders").json()) == 1
    assert len(client.get("/api/order-details").json()) == 1


def test_shared_migrations_are_idempotent_and_constraints_apply(client: TestClient, isolated_database: Path) -> None:
    asyncio.run(initialize_database(seed_on_startup=True))
    with closing(sqlite3.connect(isolated_database)) as connection, connection:
        assert connection.execute("SELECT COUNT(*) FROM migrations").fetchone()[0] == 3
        assert connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'inventory_%'").fetchone()[0] == 5
        for quantity in [-1, 1.5]:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute("UPDATE inventory SET quantity_on_hand = ? WHERE branch_id = 1 AND product_id = 1", (quantity,))
        connection.execute("INSERT INTO orders (order_id, branch_id, order_date, name) VALUES (100, 1, '2026-10-27', 'trigger')")
        with pytest.raises(sqlite3.IntegrityError, match="Quantity must be a positive integer"):
            connection.execute("INSERT INTO order_details (order_id, product_id, quantity, unit_price) VALUES (100, 1, 0, 1)")
        with pytest.raises(sqlite3.IntegrityError, match="Insufficient stock"):
            connection.execute("INSERT INTO order_details (order_id, product_id, quantity, unit_price) VALUES (100, 1, 4, 1)")
    assert stock(client, 1) == 3


def test_migration_script_and_tracking_roll_back_together() -> None:
    async def verify() -> None:
        async with aiosqlite.connect(":memory:") as connection:
            await _ensure_migrations_table(connection)
            script = "CREATE TABLE rollback_probe (value INTEGER); INSERT INTO missing_table VALUES (1);"
            with pytest.raises(aiosqlite.OperationalError):
                await _execute_sql_statements(connection, script, "999_failure.sql")
            cursor = await connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE name = 'rollback_probe'")
            assert (await cursor.fetchone())[0] == 0
            cursor = await connection.execute("SELECT COUNT(*) FROM migrations")
            assert (await cursor.fetchone())[0] == 0
            await _execute_sql_statements(connection, "CREATE TABLE rollback_probe (value INTEGER);", "999_failure.sql")
            with pytest.raises(aiosqlite.IntegrityError):
                await _execute_sql_statements(connection, "CREATE TABLE second_probe (value INTEGER);", "999_failure.sql")
            cursor = await connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE name = 'second_probe'")
            assert (await cursor.fetchone())[0] == 0
    asyncio.run(verify())


def test_historical_upgrade_only_restores_post_upgrade_allocations() -> None:
    async def verify() -> None:
        shared = Path(__file__).resolve().parents[2] / "database"
        async with aiosqlite.connect(":memory:") as connection:
            await connection.execute("PRAGMA foreign_keys = ON")
            for filename in ["001_init.sql", "002_add_supplier_status_fields.sql"]:
                await _execute_sql_statements(connection, (shared / "migrations" / filename).read_text(encoding="utf-8"))
            for seed in sorted((shared / "seed").glob("*.sql")):
                if seed.name != "005_inventory.sql":
                    await _execute_sql_statements(connection, seed.read_text(encoding="utf-8"))
            for order_id in [1, 2, 3]:
                await connection.execute(
                    "INSERT INTO orders (order_id, branch_id, order_date, name) VALUES (?, 1, '2026-10-27', 'Historical')",
                    (order_id,),
                )
                await connection.execute(
                    "INSERT INTO order_details (order_detail_id, order_id, product_id, quantity, unit_price) VALUES (?, ?, 1, 10, 1)",
                    (order_id, order_id),
                )
            await connection.commit()
            await _execute_sql_statements(
                connection, (shared / "migrations" / "003_branch_inventory.sql").read_text(encoding="utf-8")
            )
            await _execute_sql_statements(
                connection, "INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (1, 1, 3);"
            )

            async def assert_state(quantity: int, allocations: int) -> None:
                cursor = await connection.execute("SELECT quantity_on_hand FROM inventory WHERE branch_id = 1 AND product_id = 1")
                assert (await cursor.fetchone())[0] == quantity
                cursor = await connection.execute("SELECT COUNT(*) FROM inventory_allocations")
                assert (await cursor.fetchone())[0] == allocations

            await connection.execute("DELETE FROM order_details WHERE order_detail_id = 1")
            await assert_state(3, 0)
            await connection.execute("DELETE FROM orders WHERE order_id = 2")
            await assert_state(3, 0)
            with pytest.raises(aiosqlite.IntegrityError, match="Insufficient stock"):
                await connection.execute("UPDATE order_details SET quantity = 4 WHERE order_detail_id = 3")
            await assert_state(3, 0)
            cursor = await connection.execute("SELECT quantity FROM order_details WHERE order_detail_id = 3")
            assert (await cursor.fetchone())[0] == 10
            await connection.execute("UPDATE order_details SET quantity = 2 WHERE order_detail_id = 3")
            await assert_state(1, 1)
            await connection.execute("DELETE FROM orders WHERE order_id = 3")
            await assert_state(3, 0)
    asyncio.run(verify())
