from __future__ import annotations

import logging
import sqlite3
from collections.abc import Awaitable

from fastapi import APIRouter

from models.checkout import CheckoutId, CheckoutResponse, CreateCheckoutRequest
from services.checkout import CheckoutService
from utils.errors import ApiException

router = APIRouter(prefix="/api/checkout", tags=["Checkout"])
service = CheckoutService()
RESPONSES = {
    400: {"description": "Invalid checkout ID, request, quantities or prices"},
    404: {"description": "Checkout, branch or product not found"},
    409: {"description": "Conflicting retry, stock shortage, pending payment or reconciliation required"},
    500: {"description": "Database persistence unavailable; retry the same checkout"},
    502: {"description": "PAYMENT_PROVIDER_ERROR or REFUND_PENDING; safe to retry the same checkout"},
    503: {"description": "PAYMENT_UNAVAILABLE: invalid or missing Stripe configuration"},
}


async def _safe_database(operation: Awaitable[CheckoutResponse]) -> CheckoutResponse:
    try:
        return await operation
    except sqlite3.Error:
        logging.getLogger(__name__).error("Checkout database persistence failed")
        raise ApiException("Checkout persistence unavailable; retry the same checkout", "DATABASE_ERROR", 500) from None


@router.post("", response_model=CheckoutResponse, responses=RESPONSES, summary="Create or retry a Stripe checkout")
async def create(request: CreateCheckoutRequest) -> CheckoutResponse:
    return await _safe_database(service.create(request))


@router.post(
    "/{checkout_id}/complete", response_model=CheckoutResponse, responses=RESPONSES,
    summary="Verify payment server-side and atomically create an order, or retry a refund",
)
async def complete(checkout_id: CheckoutId) -> CheckoutResponse:
    return await _safe_database(service.complete(checkout_id))


@router.post(
    "/{checkout_id}/cancel", response_model=CheckoutResponse, responses=RESPONSES,
    summary="Expire an unpaid Stripe checkout; finalize if already paid",
)
async def cancel(checkout_id: CheckoutId) -> CheckoutResponse:
    return await _safe_database(service.cancel(checkout_id))
