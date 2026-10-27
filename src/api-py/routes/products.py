from __future__ import annotations

from fastapi import APIRouter

from models.inventory import RouteId
from models.product import CreateProductRequest, Product, ProductAvailability, UpdateProductRequest
from repositories.products import ProductsRepository
from utils.errors import NotFoundException, ValidationException

router = APIRouter(prefix="/api/products", tags=["Products"])
repository = ProductsRepository()


@router.get("", response_model=list[ProductAvailability], responses={400: {"description": "Invalid branchId"}, 404: {"description": "Branch not found"}})
async def get_all(branchId: RouteId = 1) -> list[ProductAvailability]:
    return await repository.find_all(branchId)


@router.get("/{product_id}", response_model=ProductAvailability, responses={400: {"description": "Invalid IDs"}, 404: {"description": "Branch or product not found"}})
async def get_by_id(product_id: RouteId, branchId: RouteId = 1) -> ProductAvailability:
    product = await repository.find_available_by_id(product_id, branchId)
    if product is None:
        raise NotFoundException("Product", product_id)
    return product


@router.post("", response_model=Product, status_code=201)
async def create(request: CreateProductRequest) -> Product:
    if not request.name.strip():
        raise ValidationException("name is required")
    return await repository.create(request)


@router.put("/{product_id}", response_model=Product)
async def update(product_id: int, request: UpdateProductRequest) -> Product:
    return await repository.update(product_id, request)


@router.delete("/{product_id}", status_code=204)
async def delete(product_id: int) -> None:
    await repository.delete(product_id)
