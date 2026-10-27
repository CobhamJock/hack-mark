from __future__ import annotations

import aiosqlite

from database.sqlite import get_connection
from models.inventory import Inventory
from utils.errors import NotFoundException


async def require_branch(connection: aiosqlite.Connection, branch_id: int) -> None:
    if branch_id > 9223372036854775807:
        raise NotFoundException("Branch", branch_id)
    cursor = await connection.execute("SELECT 1 FROM branches WHERE branch_id = ?;", (branch_id,))
    if await cursor.fetchone() is None:
        raise NotFoundException("Branch", branch_id)


class InventoryRepository:
    async def upsert(self, branch_id: int, product_id: int, quantity: int) -> Inventory:
        async with get_connection() as connection:
            await connection.execute("BEGIN IMMEDIATE;")
            try:
                await require_branch(connection, branch_id)
                if product_id > 9223372036854775807:
                    raise NotFoundException("Product", product_id)
                cursor = await connection.execute("SELECT 1 FROM products WHERE product_id = ?;", (product_id,))
                if await cursor.fetchone() is None:
                    raise NotFoundException("Product", product_id)
                await connection.execute(
                    """
                    INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (?, ?, ?)
                    ON CONFLICT (branch_id, product_id)
                    DO UPDATE SET quantity_on_hand = excluded.quantity_on_hand;
                    """,
                    (branch_id, product_id, quantity),
                )
                await connection.commit()
            except Exception:
                await connection.rollback()
                raise
        return Inventory(branchId=branch_id, productId=product_id, quantityOnHand=quantity)
