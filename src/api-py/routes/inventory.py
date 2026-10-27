from __future__ import annotations

import os
import secrets

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from models.inventory import Inventory, RouteId, UpdateInventoryRequest
from repositories.inventory import InventoryRepository
from utils.errors import ApiException

router = APIRouter(prefix="/api/inventory", tags=["Inventory"])
repository = InventoryRepository()
bearer = HTTPBearer(auto_error=False)


def require_admin(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
    token = os.getenv("INVENTORY_ADMIN_TOKEN")
    if not token:
        raise ApiException("Inventory administration is not configured", "SERVICE_UNAVAILABLE", 503)
    if credentials is None or not secrets.compare_digest(
        credentials.credentials.encode("utf-8"), token.encode("utf-8")
    ):
        raise ApiException("Inventory administrator authorization required", "FORBIDDEN", 403)


@router.put(
    "/{branchId}/{productId}",
    response_model=Inventory,
    dependencies=[Depends(require_admin)],
    responses={400: {"description": "Invalid IDs or quantity"}, 403: {"description": "Forbidden"},
               404: {"description": "Branch or product not found"}, 503: {"description": "Admin token not configured"}},
)
async def update(branchId: RouteId, productId: RouteId, request: UpdateInventoryRequest) -> Inventory:
    return await repository.upsert(branchId, productId, request.quantityOnHand)
