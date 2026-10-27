from __future__ import annotations

from pydantic import BaseModel, field_validator

from models.inventory import PositiveId, PositiveQuantity


class OrderDetail(BaseModel):
    orderDetailId: int
    orderId: int
    productId: int
    quantity: int
    unitPrice: float
    notes: str | None = None


class CreateOrderDetailRequest(BaseModel):
    orderId: PositiveId
    productId: PositiveId
    quantity: PositiveQuantity
    unitPrice: float
    notes: str | None = None


class UpdateOrderDetailRequest(BaseModel):
    orderId: PositiveId | None = None
    productId: PositiveId | None = None
    quantity: PositiveQuantity | None = None
    unitPrice: float | None = None
    notes: str | None = None

    @field_validator("orderId", "productId", "quantity")
    @classmethod
    def reject_null_numbers(cls, value: int | None) -> int:
        if value is None:
            raise ValueError("IDs and quantity cannot be null")
        return value
