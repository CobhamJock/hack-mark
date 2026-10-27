from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, BeforeValidator, Field

PositiveId = Annotated[int, Field(strict=True, gt=0)]
PositiveQuantity = Annotated[int, Field(strict=True, gt=0, le=2147483647)]
StockQuantity = Annotated[int, Field(strict=True, ge=0, le=2147483647)]


def _parse_id(value: object) -> int:
    if isinstance(value, str) and value.isascii() and value.isdigit():
        return int(value)
    if type(value) is int:
        return value
    raise ValueError("ID must be a positive integer")


RouteId = Annotated[PositiveId, BeforeValidator(_parse_id)]


class UpdateInventoryRequest(BaseModel):
    quantityOnHand: StockQuantity


class Inventory(BaseModel):
    branchId: int
    productId: int
    quantityOnHand: int
