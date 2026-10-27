from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import cast

import aiosqlite

from database.sqlite import get_connection
from models.checkout import CheckoutResponse, CheckoutSnapshotItem, CheckoutStatus, CreateCheckoutRequest
from repositories.inventory import require_branch
from utils.errors import ApiException, ConflictException, NotFoundException, ValidationException

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Checkout:
    checkout_id: str
    branch_id: int
    request_json: str
    items_json: str
    amount_total: int
    status: CheckoutStatus
    provider_session_id: str | None
    checkout_url: str | None
    payment_intent_id: str | None
    order_id: int | None
    created_at: str

    @property
    def items(self) -> list[CheckoutSnapshotItem]:
        return [CheckoutSnapshotItem.model_validate(item) for item in json.loads(self.items_json)]

    def response(self) -> CheckoutResponse:
        return CheckoutResponse(
            checkoutId=self.checkout_id, status=self.status, checkoutUrl=self.checkout_url,
            amountTotal=self.amount_total, orderId=self.order_id,
        )


class CheckoutsRepository:
    @staticmethod
    async def _get(connection: aiosqlite.Connection, checkout_id: str) -> Checkout | None:
        cursor = await connection.execute("SELECT * FROM checkouts WHERE checkout_id = ?", (checkout_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        return Checkout(
            checkout_id=row["checkout_id"], branch_id=row["branch_id"], request_json=row["request_json"],
            items_json=row["items_json"], amount_total=row["amount_total"],
            status=cast(CheckoutStatus, row["status"]), provider_session_id=row["provider_session_id"],
            checkout_url=row["checkout_url"], payment_intent_id=row["payment_intent_id"],
            order_id=row["order_id"], created_at=row["created_at"],
        )

    async def get(self, checkout_id: str) -> Checkout:
        async with get_connection() as connection:
            row = await self._get(connection, checkout_id)
        if row is None:
            raise ApiException("Checkout not found", "NOT_FOUND", 404)
        return row

    async def prepare(self, request: CreateCheckoutRequest) -> Checkout:
        quantities: dict[int, int] = {}
        for item in request.items:
            quantity = quantities.get(item.productId, 0) + item.quantity
            if quantity > 2147483647:
                raise ValidationException("Combined quantity exceeds the maximum")
            quantities[item.productId] = quantity
        canonical = {
            "branchId": request.branchId,
            "items": [{"productId": product_id, "quantity": quantities[product_id]}
                      for product_id in sorted(quantities)],
        }
        async with get_connection() as connection:
            await connection.execute("BEGIN IMMEDIATE")
            existing = await self._get(connection, request.checkoutId)
            if existing is not None:
                if json.loads(existing.request_json) != canonical:
                    raise ConflictException("Checkout request differs from the original")
                return existing
            await require_branch(connection, request.branchId)
            items: list[CheckoutSnapshotItem] = []
            total = 0
            for product_id, quantity in sorted(quantities.items()):
                cursor = await connection.execute(
                    """SELECT p.name, p.price, p.discount, COALESCE(i.quantity_on_hand, 0) AS stock
                       FROM products p LEFT JOIN inventory i
                       ON i.product_id = p.product_id AND i.branch_id = ?
                       WHERE p.product_id = ?""", (request.branchId, product_id),
                )
                product = await cursor.fetchone()
                if product is None:
                    raise NotFoundException("Product", product_id)
                if product["stock"] < quantity:
                    raise ConflictException("Insufficient stock")
                try:
                    cents = (Decimal(str(product["price"])) * (
                        Decimal("1") - Decimal(str(product["discount"] or 0))
                    ) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
                    if not cents.is_finite() or cents <= 0 or cents > 99999999:
                        raise InvalidOperation
                    unit_price = int(cents)
                except (InvalidOperation, ValueError, OverflowError):
                    raise ValidationException("Product has an invalid payment price") from None
                total += unit_price * quantity
                if total > 99999999:
                    raise ValidationException("Payment total exceeds the maximum")
                items.append(CheckoutSnapshotItem(
                    productId=product_id, quantity=quantity, unitPriceCents=unit_price, name=product["name"],
                ))
            if total < 50:
                raise ValidationException("Payment total must be at least 50 USD cents")
            await connection.execute(
                """INSERT INTO checkouts
                   (checkout_id, branch_id, request_json, items_json, amount_total, currency)
                   VALUES (?, ?, ?, ?, ?, 'usd')""",
                (request.checkoutId, request.branchId, json.dumps(canonical, separators=(",", ":")),
                 json.dumps([item.model_dump() for item in items], separators=(",", ":")), total),
            )
            await connection.commit()
        return await self.get(request.checkoutId)

    async def save_session(self, checkout_id: str, session_id: str, url: str) -> Checkout:
        async with get_connection() as connection:
            await connection.execute(
                """UPDATE checkouts SET provider_session_id = ?, checkout_url = ?, status = 'pending'
                   WHERE checkout_id = ? AND status = 'creating'""", (session_id, url, checkout_id),
            )
            await connection.commit()
        return await self.get(checkout_id)

    async def cancel(self, checkout_id: str) -> Checkout:
        async with get_connection() as connection:
            await connection.execute(
                """UPDATE checkouts SET status = 'cancelled'
                   WHERE checkout_id = ? AND status IN ('creating', 'pending')""", (checkout_id,),
            )
            await connection.commit()
        return await self.get(checkout_id)

    async def finalize(self, checkout_id: str, intent_id: str) -> Checkout:
        async with get_connection() as connection:
            await connection.execute("BEGIN IMMEDIATE")
            checkout = await self._get(connection, checkout_id)
            if checkout is None:
                raise ApiException("Checkout not found", "NOT_FOUND", 404)
            if checkout.status not in {"pending", "creating"}:
                return checkout
            try:
                await connection.execute(
                    "UPDATE checkouts SET payment_intent_id = ? WHERE checkout_id = ?", (intent_id, checkout_id),
                )
                cursor = await connection.execute(
                    """INSERT INTO orders (branch_id, order_date, name, status)
                       VALUES (?, CURRENT_TIMESTAMP, ?, 'confirmed')""",
                    (checkout.branch_id, f"Checkout {checkout_id}"),
                )
                order_id = cursor.lastrowid
                for item in checkout.items:
                    await connection.execute(
                        """INSERT INTO order_details (order_id, product_id, quantity, unit_price)
                           VALUES (?, ?, ?, ?)""",
                        (order_id, item.productId, item.quantity, item.unitPriceCents / 100),
                    )
                await connection.execute(
                    "UPDATE checkouts SET status = 'completed', order_id = ? WHERE checkout_id = ?",
                    (order_id, checkout_id),
                )
                await connection.commit()
            except Exception:
                await connection.rollback()
                logger.error("Checkout order persistence failed; initiating durable refund")
                # Another finalizer can win after rollback. Never refund its completed order.
                try:
                    await connection.execute("BEGIN IMMEDIATE")
                    await connection.execute(
                        """UPDATE checkouts SET status = 'refund_pending', payment_intent_id = ?
                           WHERE checkout_id = ? AND status IN ('creating', 'pending')""",
                        (intent_id, checkout_id),
                    )
                    await connection.commit()
                except sqlite3.Error:
                    await connection.rollback()
                    logger.error("Unable to persist checkout refund intent; manual reconciliation required")
                    raise ApiException(
                        "Payment reconciliation required; retry completion", "REFUND_PENDING", 502,
                    ) from None
        return await self.get(checkout_id)

    async def mark_refunded(self, checkout_id: str) -> Checkout:
        async with get_connection() as connection:
            await connection.execute(
                "UPDATE checkouts SET status = 'refunded' WHERE checkout_id = ? AND status = 'refund_pending'",
                (checkout_id,),
            )
            await connection.commit()
        return await self.get(checkout_id)
