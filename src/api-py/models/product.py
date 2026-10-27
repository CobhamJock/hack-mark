from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class Product(BaseModel):
    productId: int
    supplierId: int
    name: str
    description: str | None = None
    price: float
    sku: str
    unit: str
    imgName: str | None = None
    discount: float


class ProductAvailability(Product):
    quantityOnHand: int
    stockStatus: Literal["out_of_stock", "low_stock", "in_stock"]


class CreateProductRequest(BaseModel):
    supplierId: int
    name: str
    description: str | None = None
    price: float
    sku: str
    unit: str
    imgName: str | None = None
    discount: float = 0.0


class UpdateProductRequest(BaseModel):
    supplierId: int | None = None
    name: str | None = None
    description: str | None = None
    price: float | None = None
    sku: str | None = None
    unit: str | None = None
    imgName: str | None = None
    discount: float | None = None
