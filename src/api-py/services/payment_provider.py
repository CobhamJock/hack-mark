from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from models.checkout import CheckoutSnapshotItem
from utils.errors import ApiException


def provider_error() -> ApiException:
    return ApiException("Payment provider request failed", "PAYMENT_PROVIDER_ERROR", 502)


@dataclass(frozen=True)
class PaymentConfig:
    secret_key: str
    public_origin: str

    @classmethod
    def load(cls) -> PaymentConfig:
        key = os.getenv("STRIPE_SECRET_KEY", "")
        origin = os.getenv("CHECKOUT_PUBLIC_URL", "")
        try:
            parsed = urlsplit(origin)
            hostname = parsed.hostname or ""
            if ":" in hostname:
                valid_hostname = isinstance(ipaddress.ip_address(hostname), ipaddress.IPv6Address)
            else:
                valid_hostname = bool(re.fullmatch(
                    r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", hostname,
                )) and all(
                    label and len(label) <= 63 and not label.startswith("-") and not label.endswith("-")
                    for label in hostname.split(".")
                ) and len(hostname) <= 253
            valid = (
                os.getenv("PAYMENT_PROVIDER") == "stripe"
                and bool(key.strip())
                and key == key.strip()
                and not any(ord(character) < 33 or ord(character) > 126 for character in key)
                and valid_hostname
                and parsed.username is None
                and parsed.password is None
                and not parsed.path
                and "?" not in origin
                and "#" not in origin
                and not any(character.isspace() or character == "\\" for character in origin)
                and (parsed.scheme == "https" or (
                    parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
                ))
                and (parsed.port is None or 1 <= parsed.port <= 65535)
                and not parsed.netloc.endswith(":")
            )
        except ValueError:
            valid = False
        if not valid:
            raise ApiException("Payment configuration unavailable", "PAYMENT_UNAVAILABLE", 503)
        return cls(key, origin)


class PaymentProvider(Protocol):
    async def create_session(
        self, checkout_id: str, items: list[CheckoutSnapshotItem]
    ) -> dict[str, object]: ...

    async def retrieve_session(self, session_id: str) -> dict[str, object]: ...
    async def expire_session(self, session_id: str) -> dict[str, object]: ...
    async def refund(self, checkout_id: str, intent_id: str) -> dict[str, object]: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class StripeProvider:
    def __init__(self, config: PaymentConfig) -> None:
        self.config = config

    async def _request(
        self, method: str, path: str, fields: dict[str, str] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, object]:
        def send() -> dict[str, object]:
            headers = {"Authorization": f"Bearer {self.config.secret_key}"}
            if idempotency_key:
                headers["Idempotency-Key"] = idempotency_key
            data = None
            if method == "POST":
                headers["Content-Type"] = "application/x-www-form-urlencoded"
                data = urlencode(fields or {}).encode("utf-8")
            request = Request(f"https://api.stripe.com/v1{path}", data=data, headers=headers, method=method)
            try:
                # Never forward credentials through a provider redirect.
                with build_opener(_NoRedirect()).open(request, timeout=15) as response:
                    result = json.load(response)
                if not isinstance(result, dict):
                    raise ValueError("Invalid response")
                return result
            except Exception:
                raise provider_error() from None

        return await asyncio.to_thread(send)

    @staticmethod
    def _session_path(session_id: str) -> str:
        if not re.fullmatch(r"cs_[A-Za-z0-9_]+", session_id):
            raise provider_error()
        return f"/checkout/sessions/{session_id}"

    async def create_session(
        self, checkout_id: str, items: list[CheckoutSnapshotItem]
    ) -> dict[str, object]:
        base = f"{self.config.public_origin}/checkout?checkoutId={checkout_id}&result="
        fields = {
            "mode": "payment",
            "payment_method_types[0]": "card",
            "success_url": base + "success",
            "cancel_url": base + "cancel",
            "client_reference_id": checkout_id,
            "metadata[checkoutId]": checkout_id,
        }
        for index, item in enumerate(items):
            prefix = f"line_items[{index}]"
            fields[f"{prefix}[quantity]"] = str(item.quantity)
            fields[f"{prefix}[price_data][currency]"] = "usd"
            fields[f"{prefix}[price_data][unit_amount]"] = str(item.unitPriceCents)
            fields[f"{prefix}[price_data][product_data][name]"] = item.name
        return await self._request("POST", "/checkout/sessions", fields, f"checkout-{checkout_id}")

    async def retrieve_session(self, session_id: str) -> dict[str, object]:
        return await self._request("GET", self._session_path(session_id))

    async def expire_session(self, session_id: str) -> dict[str, object]:
        return await self._request("POST", self._session_path(session_id) + "/expire")

    async def refund(self, checkout_id: str, intent_id: str) -> dict[str, object]:
        return await self._request(
            "POST", "/refunds", {"payment_intent": intent_id}, f"refund-{checkout_id}"
        )


def get_payment_provider() -> PaymentProvider:
    return StripeProvider(PaymentConfig.load())
