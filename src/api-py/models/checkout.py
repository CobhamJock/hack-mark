from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

CheckoutId = Annotated[
    str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
]
CheckoutInteger = Annotated[int, Field(strict=True, gt=0, le=2147483647)]
CheckoutStatus = Literal["creating", "pending", "completed", "cancelled", "refund_pending", "refunded"]


class CheckoutItem(BaseModel):
    productId: CheckoutInteger
    quantity: CheckoutInteger


class CreateCheckoutRequest(BaseModel):
    checkoutId: CheckoutId
    branchId: CheckoutInteger
    items: list[CheckoutItem] = Field(min_length=1, max_length=100)


class CheckoutSnapshotItem(CheckoutItem):
    unitPriceCents: int
    name: str


class CheckoutResponse(BaseModel):
    checkoutId: str
    status: CheckoutStatus
    checkoutUrl: str | None
    amountTotal: int
    currency: Literal["usd"] = "usd"
    orderId: int | None
