from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from models.inventory import PositiveId, PositiveQuantity
from models.order_detail import OrderDetail


class Order(BaseModel):
    orderId: int
    branchId: int
    orderDate: str
    name: str
    description: str | None = None
    status: str


class OrderWithItems(Order):
    items: list[OrderDetail]


class OrderItemRequest(BaseModel):
    productId: PositiveId
    quantity: PositiveQuantity


class CreateOrderRequest(BaseModel):
    branchId: PositiveId
    orderDate: str
    name: str
    description: str | None = None
    status: str = "pending"
    items: list[OrderItemRequest] | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("items")
    @classmethod
    def reject_null_items(cls, value: list[OrderItemRequest] | None) -> list[OrderItemRequest]:
        if value is None:
            raise ValueError("items must be a nonempty array when provided")
        return value


class UpdateOrderRequest(BaseModel):
    branchId: PositiveId | None = None
    orderDate: str | None = None
    name: str | None = None
    description: str | None = None
    status: str | None = None
