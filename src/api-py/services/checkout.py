from __future__ import annotations

import logging
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from models.checkout import CheckoutResponse, CreateCheckoutRequest
from repositories.checkouts import Checkout, CheckoutsRepository
from services.payment_provider import PaymentProvider, get_payment_provider, provider_error
from utils.errors import ApiException, ConflictException

logger = logging.getLogger(__name__)
TERMINAL = {"completed", "cancelled", "refunded"}


class CheckoutService:
    def __init__(self, repository: CheckoutsRepository | None = None) -> None:
        self.repository = repository or CheckoutsRepository()

    @staticmethod
    def _validate_session(checkout: Checkout, session: dict[str, object]) -> None:
        metadata = session.get("metadata")
        if (
            session.get("id") != checkout.provider_session_id
            or session.get("client_reference_id") != checkout.checkout_id
            or not isinstance(metadata, dict)
            or metadata.get("checkoutId") != checkout.checkout_id
            or session.get("currency") != "usd"
            or type(session.get("amount_total")) is not int
            or session.get("amount_total") != checkout.amount_total
        ):
            raise provider_error()

    async def create(self, request: CreateCheckoutRequest) -> CheckoutResponse:
        # Validate configuration even for retries, but never perform a remote request for terminal rows.
        provider = get_payment_provider()
        checkout = await self.repository.prepare(request)
        if checkout.status != "creating":
            return checkout.response()
        created_at = datetime.fromisoformat(checkout.created_at).replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - created_at >= timedelta(hours=23):
            raise ConflictException("Checkout reconciliation required; provider outcome is unknown")
        session = await provider.create_session(checkout.checkout_id, checkout.items)
        session_id, url = session.get("id"), session.get("url")
        if not isinstance(session_id, str) or not re.fullmatch(r"cs_[A-Za-z0-9_]+", session_id):
            raise provider_error()
        if not isinstance(url, str):
            raise provider_error()
        try:
            parsed = urlsplit(url)
            valid_url = (
                url.startswith("https://checkout.stripe.com/")
                and parsed.scheme == "https" and parsed.netloc == "checkout.stripe.com"
                and parsed.username is None and parsed.password is None and parsed.port is None
                and not any(character.isspace() or character == "\\" for character in url)
            )
        except ValueError:
            valid_url = False
        if not valid_url:
            raise provider_error()
        return (await self.repository.save_session(checkout.checkout_id, session_id, url)).response()

    async def _refund(self, checkout: Checkout, provider: PaymentProvider) -> CheckoutResponse:
        if not checkout.payment_intent_id:
            raise ApiException("Payment refund requires reconciliation", "REFUND_PENDING", 502)
        try:
            refund = await provider.refund(checkout.checkout_id, checkout.payment_intent_id)
            if refund.get("status") != "succeeded":
                raise ApiException("Payment refund is pending; retry completion", "REFUND_PENDING", 502)
            return (await self.repository.mark_refunded(checkout.checkout_id)).response()
        except (ApiException, sqlite3.Error):
            logger.error("Checkout refund not confirmed; durable retry required")
            raise ApiException("Payment refund is pending; retry completion", "REFUND_PENDING", 502) from None

    async def _finish_paid(
        self, checkout: Checkout, session: dict[str, object], provider: PaymentProvider,
    ) -> CheckoutResponse:
        intent = session.get("payment_intent")
        if session.get("payment_status") != "paid" or session.get("status") != "complete":
            raise ApiException("Payment is not complete", "PAYMENT_PENDING", 409)
        if not isinstance(intent, str) or not intent.strip():
            raise provider_error()
        result = await self.repository.finalize(checkout.checkout_id, intent)
        if result.status == "refund_pending":
            return await self._refund(result, provider)
        return result.response()

    async def complete(self, checkout_id: str) -> CheckoutResponse:
        checkout = await self.repository.get(checkout_id)
        if checkout.status in TERMINAL:
            return checkout.response()
        provider = get_payment_provider()
        if checkout.status == "refund_pending":
            return await self._refund(checkout, provider)
        if not checkout.provider_session_id:
            raise ConflictException("Checkout creation is incomplete; retry the original checkout request")
        session = await provider.retrieve_session(checkout.provider_session_id)
        self._validate_session(checkout, session)
        if session.get("payment_status") == "unpaid" and session.get("status") == "expired":
            return (await self.repository.cancel(checkout_id)).response()
        return await self._finish_paid(checkout, session, provider)

    async def cancel(self, checkout_id: str) -> CheckoutResponse:
        checkout = await self.repository.get(checkout_id)
        if checkout.status in TERMINAL:
            return checkout.response()
        provider = get_payment_provider()
        if checkout.status == "refund_pending":
            return await self._refund(checkout, provider)
        if not checkout.provider_session_id:
            raise ConflictException("Checkout creation is incomplete; retry the original checkout request")
        session = await provider.retrieve_session(checkout.provider_session_id)
        self._validate_session(checkout, session)
        if session.get("payment_status") == "paid":
            return await self._finish_paid(checkout, session, provider)
        if session.get("payment_status") != "unpaid":
            raise provider_error()
        if session.get("status") == "open":
            session = await provider.expire_session(checkout.provider_session_id)
            self._validate_session(checkout, session)
            if session.get("payment_status") == "paid":
                return await self._finish_paid(checkout, session, provider)
        if session.get("payment_status") != "unpaid" or session.get("status") != "expired":
            raise provider_error()
        return (await self.repository.cancel(checkout_id)).response()
