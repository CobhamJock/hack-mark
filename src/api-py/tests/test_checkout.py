from __future__ import annotations

import asyncio
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from database.migrate import initialize_database
from models.checkout import CheckoutSnapshotItem
from services import checkout as checkout_service
from services import payment_provider
from services.payment_provider import PaymentConfig, StripeProvider, provider_error


class FakeProvider:
    def __init__(self) -> None:
        self.sessions: dict[str, dict[str, object]] = {}
        self.creates: list[tuple[str, list[CheckoutSnapshotItem]]] = []
        self.retrieves: list[str] = []
        self.expirations: list[str] = []
        self.refunds: list[tuple[str, str]] = []
        self.create_error = False
        self.retrieve_error = False
        self.expire_error = False
        self.refund_error = False
        self.refund_status = "succeeded"

    async def create_session(
        self, checkout_id: str, items: list[CheckoutSnapshotItem],
    ) -> dict[str, object]:
        self.creates.append((checkout_id, items))
        session_id = "cs_test_" + checkout_id.replace("-", "")
        self.sessions.setdefault(session_id, {
            "id": session_id, "url": "https://checkout.stripe.com/c/pay/" + session_id,
            "client_reference_id": checkout_id, "metadata": {"checkoutId": checkout_id},
            "currency": "usd", "amount_total": sum(item.quantity * item.unitPriceCents for item in items),
            "status": "open", "payment_status": "unpaid", "payment_intent": None,
        })
        if self.create_error:
            raise provider_error()
        return dict(self.sessions[session_id])

    async def retrieve_session(self, session_id: str) -> dict[str, object]:
        self.retrieves.append(session_id)
        if self.retrieve_error:
            raise provider_error()
        return dict(self.sessions[session_id])

    async def expire_session(self, session_id: str) -> dict[str, object]:
        self.expirations.append(session_id)
        if self.expire_error:
            raise provider_error()
        self.sessions[session_id]["status"] = "expired"
        return dict(self.sessions[session_id])

    async def refund(self, checkout_id: str, intent_id: str) -> dict[str, object]:
        self.refunds.append((checkout_id, intent_id))
        if self.refund_error:
            raise provider_error()
        return {"id": "re_test", "status": self.refund_status}

    def pay(self) -> dict[str, object]:
        session = next(iter(self.sessions.values()))
        session.update(status="complete", payment_status="paid", payment_intent="pi_test")
        return session


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> FakeProvider:
    monkeypatch.setenv("PAYMENT_PROVIDER", "stripe")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_do_not_leak")
    monkeypatch.setenv("CHECKOUT_PUBLIC_URL", "https://shop.example")
    fake = FakeProvider()

    def configured_provider() -> FakeProvider:
        PaymentConfig.load()
        return fake

    monkeypatch.setattr(checkout_service, "get_payment_provider", configured_provider)
    return fake


def request_body() -> dict[str, object]:
    return {"checkoutId": str(uuid4()), "branchId": 1, "items": [{"productId": 1, "quantity": 2}]}


def post_create(client: TestClient, body: dict[str, object]) -> dict[str, object]:
    response = client.post("/api/checkout", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def complete(client: TestClient, body: dict[str, object]):
    return client.post(f"/api/checkout/{body['checkoutId']}/complete")


def cancel(client: TestClient, body: dict[str, object]):
    return client.post(f"/api/checkout/{body['checkoutId']}/cancel")


def error(response, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code
    assert "sk_test_do_not_leak" not in response.text


def execute(database: Path, sql: str, parameters: tuple = ()) -> None:
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute(sql, parameters)


def row(database: Path, sql: str, parameters: tuple = ()) -> sqlite3.Row:
    with closing(sqlite3.connect(database)) as connection:
        connection.row_factory = sqlite3.Row
        return connection.execute(sql, parameters).fetchone()


def checkout_row(database: Path) -> sqlite3.Row:
    return row(database, "SELECT * FROM checkouts")


def test_happy_path_snapshot_idempotency(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    before = row(isolated_database, "SELECT COUNT(*) AS n FROM orders")["n"]
    execute(isolated_database, "UPDATE products SET price = 1.005, discount = 0 WHERE product_id = 1")
    created = post_create(client, body)
    assert created == {
        "checkoutId": body["checkoutId"], "status": "pending", "checkoutUrl": next(
            iter(provider.sessions.values())
        )["url"], "amountTotal": 202, "currency": "usd", "orderId": None,
    }
    assert row(isolated_database, "SELECT quantity_on_hand FROM inventory WHERE branch_id=1 AND product_id=1")[0] == 3
    execute(isolated_database, "UPDATE products SET price = 999, name = 'Changed' WHERE product_id = 1")
    duplicate = {**body, "items": [{"productId": 1, "quantity": 1}, {"productId": 1, "quantity": 1}]}
    assert post_create(client, duplicate) == created
    assert len(provider.creates) == 1
    error(client.post("/api/checkout", json={**body, "branchId": 2}), 409, "CONFLICT")
    error(client.post("/api/checkout", json={**body, "items": [{"productId": 1, "quantity": 1}]}), 409, "CONFLICT")
    provider.pay()
    response = complete(client, body)
    assert response.status_code == 200, response.text
    finished = response.json()
    assert finished["status"] == "completed" and finished["orderId"] is not None
    detail = row(isolated_database, "SELECT * FROM order_details WHERE order_id = ?", (finished["orderId"],))
    assert detail["quantity"] == 2 and detail["unit_price"] == 1.01
    assert row(isolated_database, "SELECT status FROM orders WHERE order_id = ?", (finished["orderId"],))[0] == "confirmed"
    assert row(isolated_database, "SELECT COUNT(*) FROM orders")[0] == before + 1
    assert row(isolated_database, "SELECT quantity_on_hand FROM inventory WHERE branch_id=1 AND product_id=1")[0] == 1
    assert complete(client, body).json() == finished
    assert cancel(client, body).json() == finished
    assert post_create(client, body) == finished
    assert len(provider.retrieves) == 1 and not provider.refunds


def test_canonical_sort_and_semantic_retry(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = {**request_body(), "items": [{"productId": 3, "quantity": 1}, {"productId": 1, "quantity": 1}]}
    post_create(client, body)
    saved = checkout_row(isolated_database)
    canonical = json.loads(saved["request_json"])
    assert canonical["items"] == [{"productId": 1, "quantity": 1}, {"productId": 3, "quantity": 1}]
    execute(isolated_database, "UPDATE checkouts SET request_json = ?", (json.dumps(canonical, indent=4),))
    post_create(client, {**body, "items": list(reversed(body["items"]))})
    assert len(provider.creates) == 1


def test_durable_creating_retry_uses_original_snapshot(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    provider.create_error = True
    error(client.post("/api/checkout", json=body), 502, "PAYMENT_PROVIDER_ERROR")
    saved = checkout_row(isolated_database)
    assert saved["status"] == "creating"
    execute(isolated_database, "UPDATE products SET price = 55, name='Changed' WHERE product_id=1")
    execute(isolated_database, "UPDATE inventory SET quantity_on_hand=0")
    provider.create_error = False
    assert post_create(client, body)["status"] == "pending"
    assert provider.creates[0] == provider.creates[1]
    assert len(provider.sessions) == 1


def test_old_unknown_creating_requires_reconciliation(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    provider.create_error = True
    error(client.post("/api/checkout", json=body), 502, "PAYMENT_PROVIDER_ERROR")
    execute(isolated_database, "UPDATE checkouts SET created_at=datetime('now', '-24 hours')")
    error(client.post("/api/checkout", json=body), 409, "CONFLICT")
    assert len(provider.creates) == 1


def test_session_save_failure_recovers_original_charge(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    execute(isolated_database, """CREATE TRIGGER fail_session_save BEFORE UPDATE ON checkouts
            WHEN NEW.status='pending' BEGIN SELECT RAISE(ABORT, 'Persistence failure'); END""")
    error(client.post("/api/checkout", json=body), 500, "DATABASE_ERROR")
    assert checkout_row(isolated_database)["status"] == "creating"
    assert len(provider.sessions) == 1
    execute(isolated_database, "DROP TRIGGER fail_session_save")
    assert post_create(client, body)["status"] == "pending"
    assert len(provider.sessions) == 1
    assert provider.creates[0] == provider.creates[1]


def test_creating_row_is_durable_before_first_call(
    client: TestClient, provider: FakeProvider, isolated_database: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = provider.create_session

    async def verify(checkout_id: str, items: list[CheckoutSnapshotItem]) -> dict[str, object]:
        saved = checkout_row(isolated_database)
        assert saved["checkout_id"] == checkout_id
        assert saved["status"] == "creating"
        assert json.loads(saved["items_json"]) == [item.model_dump() for item in items]
        return await original(checkout_id, items)

    monkeypatch.setattr(provider, "create_session", verify)
    post_create(client, request_body())


@pytest.mark.parametrize("env,value", [
    ("PAYMENT_PROVIDER", ""), ("PAYMENT_PROVIDER", "paypal"), ("STRIPE_SECRET_KEY", ""),
    ("CHECKOUT_PUBLIC_URL", ""), ("CHECKOUT_PUBLIC_URL", "http://example.com"),
    ("CHECKOUT_PUBLIC_URL", "https://user:pass@example.com"),
    ("CHECKOUT_PUBLIC_URL", "https://example.com/"),
    ("CHECKOUT_PUBLIC_URL", "https://example.com?x=1"),
    ("CHECKOUT_PUBLIC_URL", "https://example.com#fragment"),
    ("CHECKOUT_PUBLIC_URL", "https://example.com:bad"),
    ("CHECKOUT_PUBLIC_URL", "https://example.com:70000"),
    ("CHECKOUT_PUBLIC_URL", "https://example.com:"),
    ("CHECKOUT_PUBLIC_URL", "http://127.0.0.1.evil.example"),
    ("CHECKOUT_PUBLIC_URL", "https://bad..example"),
    ("CHECKOUT_PUBLIC_URL", "https://bad%20example"),
    ("CHECKOUT_PUBLIC_URL", "https://-bad.example"),
    ("CHECKOUT_PUBLIC_URL", "https://example.com\\@evil.example"),
])
def test_invalid_config_no_provider_or_row(
    client: TestClient, provider: FakeProvider, monkeypatch: pytest.MonkeyPatch,
    isolated_database: Path, env: str, value: str,
) -> None:
    monkeypatch.setenv(env, value)
    error(client.post("/api/checkout", json=request_body()), 503, "PAYMENT_UNAVAILABLE")
    assert not provider.creates
    assert row(isolated_database, "SELECT COUNT(*) FROM checkouts")[0] == 0


@pytest.mark.parametrize("origin", [
    "https://shop.example", "https://shop.example:443", "http://localhost",
    "http://localhost:5137", "http://127.0.0.1:5137",
])
def test_valid_origins(provider: FakeProvider, monkeypatch: pytest.MonkeyPatch, origin: str) -> None:
    monkeypatch.setenv("CHECKOUT_PUBLIC_URL", origin)
    assert PaymentConfig.load().public_origin == origin


@pytest.mark.parametrize("patch", [
    {"checkoutId": "123"}, {"checkoutId": str(uuid4()).upper()},
    {"checkoutId": "00000000-0000-1000-8000-000000000000"},
    {"branchId": True}, {"branchId": "1"}, {"branchId": 0}, {"branchId": 2147483648},
    {"items": []}, {"items": None}, {"items": [{"productId": 1, "quantity": 1}] * 101},
    {"items": [{"productId": 1, "quantity": quantity} for quantity in [2147483647, 1]]},
    *[{"items": [{"productId": 1, "quantity": quantity}]}
      for quantity in [0, -1, 1.5, True, "2", 2147483648]],
    *[{"items": [{"productId": product_id, "quantity": 1}]}
      for product_id in [0, -1, 1.5, True, "1", 2147483648]],
])
def test_invalid_input(client: TestClient, provider: FakeProvider, patch: dict[str, object]) -> None:
    error(client.post("/api/checkout", json={**request_body(), **patch}), 400, "VALIDATION_ERROR")
    assert not provider.creates


@pytest.mark.parametrize("patch,status,code", [
    ({"branchId": 999}, 404, "NOT_FOUND"),
    ({"items": [{"productId": 999, "quantity": 1}]}, 404, "NOT_FOUND"),
    ({"items": [{"productId": 2, "quantity": 1}]}, 409, "CONFLICT"),
    ({"items": [{"productId": 1, "quantity": 4}]}, 409, "CONFLICT"),
])
def test_missing_references_or_stock_preprovider(
    client: TestClient, provider: FakeProvider, patch: dict[str, object], status: int, code: str,
) -> None:
    error(client.post("/api/checkout", json={**request_body(), **patch}), status, code)
    assert not provider.creates


@pytest.mark.parametrize("price,discount", [(0, 0), (-1, 0), (1, 1), (1000000, 0)])
def test_invalid_amount_preprovider(
    client: TestClient, provider: FakeProvider, isolated_database: Path, price: float, discount: float,
) -> None:
    execute(isolated_database, "UPDATE products SET price=?, discount=? WHERE product_id=1", (price, discount))
    error(client.post("/api/checkout", json=request_body()), 400, "VALIDATION_ERROR")
    assert not provider.creates


@pytest.mark.parametrize("price,quantity,total", [(0.49, 1, 49), (0.25, 2, 50)])
def test_stripe_minimum_total_before_storage_or_provider(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
    price: float, quantity: int, total: int,
) -> None:
    execute(isolated_database, "UPDATE products SET price=?, discount=0 WHERE product_id=1", (price,))
    body = {**request_body(), "items": [{"productId": 1, "quantity": quantity}]}
    response = client.post("/api/checkout", json=body)
    if total < 50:
        error(response, 400, "VALIDATION_ERROR")
        assert not provider.creates
        assert row(isolated_database, "SELECT COUNT(*) FROM checkouts")[0] == 0
    else:
        assert response.status_code == 200, response.text
        assert response.json()["amountTotal"] == 50
        assert len(provider.creates) == 1


def test_unpaid_expired_and_decline(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    post_create(client, body)
    error(complete(client, body), 409, "PAYMENT_PENDING")
    assert checkout_row(isolated_database)["order_id"] is None
    provider.retrieve_error = True
    error(complete(client, body), 502, "PAYMENT_PROVIDER_ERROR")
    provider.retrieve_error = False
    next(iter(provider.sessions.values()))["status"] = "expired"
    assert complete(client, body).json()["status"] == "cancelled"
    assert not provider.refunds


@pytest.mark.parametrize("patch", [
    {"id": "cs_other"}, {"client_reference_id": str(uuid4())}, {"metadata": {}},
    {"metadata": {"checkoutId": str(uuid4())}}, {"currency": "eur"}, {"amount_total": 1},
    {"amount_total": "202"}, {"amount_total": True}, {"payment_intent": ""},
])
def test_tampered_session_no_order(
    client: TestClient, provider: FakeProvider, isolated_database: Path, patch: dict[str, object],
) -> None:
    body = request_body()
    post_create(client, body)
    provider.pay().update(patch)
    error(complete(client, body), 502, "PAYMENT_PROVIDER_ERROR")
    assert checkout_row(isolated_database)["status"] == "pending"
    assert checkout_row(isolated_database)["order_id"] is None
    assert not provider.refunds


def test_paid_but_open_not_finalized(client: TestClient, provider: FakeProvider) -> None:
    body = request_body()
    post_create(client, body)
    provider.pay()["status"] = "open"
    error(complete(client, body), 409, "PAYMENT_PENDING")


@pytest.mark.parametrize("failure", ["stock", "insert", "complete_update"])
def test_persistence_failure_rolls_back_order_then_refunds(
    client: TestClient, provider: FakeProvider, isolated_database: Path, failure: str,
) -> None:
    body = {**request_body(), "items": [{"productId": 1, "quantity": 1}, {"productId": 3, "quantity": 1}]}
    before = row(isolated_database, "SELECT COUNT(*) FROM orders")[0]
    details_before = row(isolated_database, "SELECT COUNT(*) FROM order_details")[0]
    post_create(client, body)
    provider.pay()
    if failure == "stock":
        execute(isolated_database, "UPDATE inventory SET quantity_on_hand=0 WHERE product_id=3 AND branch_id=1")
    elif failure == "insert":
        execute(isolated_database, """CREATE TRIGGER fail_checkout_order BEFORE INSERT ON orders
                BEGIN SELECT RAISE(ABORT, 'Persistence failure'); END""")
    else:
        execute(isolated_database, """CREATE TRIGGER fail_checkout_update BEFORE UPDATE ON checkouts
                WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'Persistence failure'); END""")
    response = complete(client, body)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "refunded"
    assert response.json()["orderId"] is None
    saved = checkout_row(isolated_database)
    assert saved["payment_intent_id"] == "pi_test"
    assert saved["status"] == "refunded"
    assert row(isolated_database, "SELECT COUNT(*) FROM orders")[0] == before
    assert row(isolated_database, "SELECT COUNT(*) FROM order_details")[0] == details_before
    assert row(isolated_database, "SELECT quantity_on_hand FROM inventory WHERE product_id=1 AND branch_id=1")[0] == 3
    assert provider.refunds == [(body["checkoutId"], "pi_test")]
    assert complete(client, body).json() == response.json()
    assert post_create(client, body) == response.json()
    assert len(provider.refunds) == 1


@pytest.mark.parametrize("status", ["pending", "failed", "network"])
def test_refund_retry_never_creates_order(
    client: TestClient, provider: FakeProvider, isolated_database: Path, status: str,
) -> None:
    body = request_body()
    before = row(isolated_database, "SELECT COUNT(*) FROM orders")[0]
    post_create(client, body)
    provider.pay()
    execute(isolated_database, "UPDATE inventory SET quantity_on_hand=0 WHERE product_id=1 AND branch_id=1")
    provider.refund_status = status
    provider.refund_error = status == "network"
    error(complete(client, body), 502, "REFUND_PENDING")
    assert checkout_row(isolated_database)["status"] == "refund_pending"
    assert checkout_row(isolated_database)["payment_intent_id"] == "pi_test"
    assert post_create(client, body)["status"] == "refund_pending"
    execute(isolated_database, "UPDATE inventory SET quantity_on_hand=20 WHERE product_id=1 AND branch_id=1")
    provider.refund_error = False
    provider.refund_status = "succeeded"
    assert complete(client, body).json()["status"] == "refunded"
    assert len(provider.retrieves) == 1
    assert provider.refunds == [(body["checkoutId"], "pi_test")] * 2
    assert row(isolated_database, "SELECT COUNT(*) FROM orders")[0] == before


def test_refund_intent_must_be_durable_before_remote(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    post_create(client, body)
    provider.pay()
    execute(isolated_database, "UPDATE inventory SET quantity_on_hand=0")
    execute(isolated_database, """CREATE TRIGGER fail_refund_intent BEFORE UPDATE ON checkouts
            WHEN NEW.status='refund_pending' BEGIN SELECT RAISE(ABORT, 'Persistence failure'); END""")
    error(complete(client, body), 502, "REFUND_PENDING")
    assert not provider.refunds
    execute(isolated_database, "DROP TRIGGER fail_refund_intent")
    assert complete(client, body).json()["status"] == "refunded"


def test_cancel_is_verified_idempotent_and_paid_cancel_completes(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    created = post_create(client, body)
    provider.expire_error = True
    error(cancel(client, body), 502, "PAYMENT_PROVIDER_ERROR")
    assert checkout_row(isolated_database)["status"] == "pending"
    provider.expire_error = False
    cancelled = cancel(client, body).json()
    assert cancelled == {**created, "status": "cancelled"}
    assert cancel(client, body).json() == cancelled
    assert complete(client, body).json() == cancelled
    assert post_create(client, body) == cancelled
    assert len(provider.creates) == 1
    second = request_body()
    post_create(client, second)
    session = list(provider.sessions.values())[1]
    session.update(payment_status="paid", status="complete", payment_intent="pi_second")
    response = cancel(client, second)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert len(provider.expirations) == 2


def test_duplicate_concurrent_finalize_and_cancel(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    before = row(isolated_database, "SELECT COUNT(*) FROM orders")[0]
    post_create(client, body)
    provider.pay()
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(
            lambda index: complete(client, body) if index % 2 else cancel(client, body), range(4),
        ))
    assert all(result.status_code == 200 for result in results)
    assert len({result.json()["orderId"] for result in results}) == 1
    assert all(result.json()["status"] == "completed" for result in results)
    assert row(isolated_database, "SELECT COUNT(*) FROM orders")[0] == before + 1
    assert not provider.refunds


def test_unknown_checkout_and_invalid_id(client: TestClient, provider: FakeProvider) -> None:
    for action in ["complete", "cancel"]:
        error(client.post(f"/api/checkout/{uuid4()}/{action}"), 404, "NOT_FOUND")
        error(client.post(f"/api/checkout/not-a-uuid/{action}"), 400, "VALIDATION_ERROR")
    assert not provider.retrieves


def test_shared_migration_and_openapi(client: TestClient, isolated_database: Path) -> None:
    asyncio.run(initialize_database(seed_on_startup=True))
    assert row(isolated_database, "SELECT COUNT(*) FROM migrations WHERE filename='004_checkout_payments.sql'")[0] == 1
    paths = client.get("/openapi.json").json()["paths"]
    for path in ["/api/checkout", "/api/checkout/{checkout_id}/complete", "/api/checkout/{checkout_id}/cancel"]:
        assert paths[path]["post"]["responses"]["502"]
        assert paths[path]["post"]["responses"]["503"]


def test_stripe_wire_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"id":"cs_test"}'

    class Opener:
        def open(self, request, timeout):
            calls.append((request, timeout))
            return Response()

    monkeypatch.setattr(payment_provider, "build_opener", lambda *args: Opener())
    stripe = StripeProvider(PaymentConfig("sk_test_do_not_leak", "http://localhost:5137"))
    checkout_id = str(uuid4())
    items = [CheckoutSnapshotItem(productId=1, quantity=2, unitPriceCents=101, name="A & B")]
    asyncio.run(stripe.create_session(checkout_id, items))
    asyncio.run(stripe.create_session(checkout_id, items))
    asyncio.run(stripe.retrieve_session("cs_test"))
    asyncio.run(stripe.expire_session("cs_test"))
    asyncio.run(stripe.refund(checkout_id, "pi_test"))
    request, timeout = calls[0]
    fields = parse_qs(request.data.decode())
    assert timeout == 15
    assert request.full_url == "https://api.stripe.com/v1/checkout/sessions"
    assert request.get_header("Authorization") == "Bearer sk_test_do_not_leak"
    assert request.get_header("Idempotency-key") == f"checkout-{checkout_id}"
    assert calls[1][0].get_header("Idempotency-key") == f"checkout-{checkout_id}"
    assert fields == {
        "mode": ["payment"], "payment_method_types[0]": ["card"],
        "success_url": [f"http://localhost:5137/checkout?checkoutId={checkout_id}&result=success"],
        "cancel_url": [f"http://localhost:5137/checkout?checkoutId={checkout_id}&result=cancel"],
        "client_reference_id": [checkout_id], "metadata[checkoutId]": [checkout_id],
        "line_items[0][quantity]": ["2"], "line_items[0][price_data][currency]": ["usd"],
        "line_items[0][price_data][unit_amount]": ["101"],
        "line_items[0][price_data][product_data][name]": ["A & B"],
    }
    assert calls[2][0].method == "GET"
    assert calls[2][0].full_url.endswith("/checkout/sessions/cs_test")
    assert calls[3][0].method == "POST"
    assert calls[3][0].full_url.endswith("/checkout/sessions/cs_test/expire")
    assert calls[4][0].get_header("Idempotency-key") == f"refund-{checkout_id}"
    assert calls[4][0].full_url == "https://api.stripe.com/v1/refunds"
    assert parse_qs(calls[4][0].data.decode()) == {"payment_intent": ["pi_test"]}


def test_provider_network_error_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    class Opener:
        def open(self, request, timeout):
            raise URLError("sk_test_do_not_leak raw provider response")

    monkeypatch.setattr(payment_provider, "build_opener", lambda *args: Opener())
    stripe = StripeProvider(PaymentConfig("sk_test_do_not_leak", "https://shop.example"))
    with pytest.raises(Exception) as caught:
        asyncio.run(stripe.retrieve_session("cs_test"))
    assert str(caught.value) == "Payment provider request failed"
    assert caught.value.code == "PAYMENT_PROVIDER_ERROR"


@pytest.mark.parametrize("url", [
    "http://checkout.stripe.com/pay/test", "https://checkout.stripe.com.evil.example/pay",
    "https://checkout.stripe.com@evil.example/pay", "https://evil.example/pay",
    "https://checkout.stripe.com:443/pay", "https://checkout.stripe.com/\\evil.example",
    "https://checkout.stripe.com:8443/pay", "https://user:pass@checkout.stripe.com/pay",
])
def test_invalid_checkout_url_not_saved(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
    monkeypatch: pytest.MonkeyPatch, url: str,
) -> None:
    original = provider.create_session

    async def invalid(checkout_id: str, items: list[CheckoutSnapshotItem]) -> dict[str, object]:
        session = await original(checkout_id, items)
        session["url"] = url
        return session

    monkeypatch.setattr(provider, "create_session", invalid)
    error(client.post("/api/checkout", json=request_body()), 502, "PAYMENT_PROVIDER_ERROR")
    assert checkout_row(isolated_database)["status"] == "creating"
    assert checkout_row(isolated_database)["checkout_url"] is None


def test_cancel_requires_verified_expiration(
    client: TestClient, provider: FakeProvider, isolated_database: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = request_body()
    post_create(client, body)

    async def not_expired(session_id: str) -> dict[str, object]:
        return dict(provider.sessions[session_id])

    monkeypatch.setattr(provider, "expire_session", not_expired)
    error(cancel(client, body), 502, "PAYMENT_PROVIDER_ERROR")
    assert checkout_row(isolated_database)["status"] == "pending"


def test_expiration_racing_paid_session_finalizes(
    client: TestClient, provider: FakeProvider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = request_body()
    post_create(client, body)

    async def paid(session_id: str) -> dict[str, object]:
        return dict(provider.pay())

    monkeypatch.setattr(provider, "expire_session", paid)
    result = cancel(client, body)
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "completed"
    assert not provider.refunds


def test_concurrent_failed_finalize_only_refunds(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    body = request_body()
    before = row(isolated_database, "SELECT COUNT(*) FROM orders")[0]
    post_create(client, body)
    provider.pay()
    execute(isolated_database, "UPDATE inventory SET quantity_on_hand=0")
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: complete(client, body), range(4)))
    assert all(result.status_code == 200 and result.json()["status"] == "refunded" for result in results)
    assert row(isolated_database, "SELECT COUNT(*) FROM orders")[0] == before
    assert len(set(provider.refunds)) == 1
    assert checkout_row(isolated_database)["status"] == "refunded"


def test_completed_checkout_cannot_be_cancelled_or_refunded_in_repository(
    client: TestClient, provider: FakeProvider, isolated_database: Path,
) -> None:
    from repositories.checkouts import CheckoutsRepository

    body = request_body()
    post_create(client, body)
    provider.pay()
    completed = complete(client, body).json()
    repository = CheckoutsRepository()
    assert asyncio.run(repository.cancel(body["checkoutId"])).response().model_dump() == completed
    assert asyncio.run(repository.finalize(body["checkoutId"], "pi_other")).response().model_dump() == completed
    assert asyncio.run(repository.mark_refunded(body["checkoutId"])).response().model_dump() == completed
    assert checkout_row(isolated_database)["payment_intent_id"] == "pi_test"
