from __future__ import annotations

from fastapi import APIRouter

from models.order import CreateOrderRequest, Order, OrderWithItems, UpdateOrderRequest
from repositories.orders import OrdersRepository
from utils.errors import NotFoundException, ValidationException

router = APIRouter(prefix="/api/orders", tags=["Orders"])
repository = OrdersRepository()


@router.get("", response_model=list[Order])
async def get_all() -> list[Order]:
    return await repository.find_all()


@router.get("/{order_id}", response_model=Order)
async def get_by_id(order_id: int) -> Order:
    order = await repository.find_by_id(order_id)
    if order is None:
        raise NotFoundException("Order", order_id)
    return order


@router.post(
    "", response_model=OrderWithItems | Order, status_code=201,
    responses={400: {"description": "Invalid order or items"}, 404: {"description": "Branch or product not found"},
               409: {"description": "Insufficient stock; no writes committed"}},
)
async def create(request: CreateOrderRequest) -> Order | OrderWithItems:
    if not request.name.strip():
        raise ValidationException("name is required")
    if request.branchId <= 0:
        raise ValidationException("branchId is required")
    if not request.orderDate.strip():
        raise ValidationException("orderDate is required")
    return await repository.create(request)


@router.put("/{order_id}", response_model=Order)
async def update(order_id: int, request: UpdateOrderRequest) -> Order:
    return await repository.update(order_id, request)


@router.delete("/{order_id}", status_code=204)
async def delete(order_id: int) -> None:
    await repository.delete(order_id)
