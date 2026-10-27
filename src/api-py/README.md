# OctoSupply API (Python)

FastAPI port of the OctoSupply API.

## Run

```bash
pip install -r requirements.txt
uvicorn main:app --reload --port 3000
```

Default API URL: `http://localhost:3000`

## Environment

- `PORT` (used by Makefile/uvicorn command, default `3000`)
- `DB_FILE` (default: `./data/app.db`)
- `API_CORS_ORIGINS` (comma-separated override; optional)
- `DB_MIGRATIONS_DIR` (optional override for migrations directory)
- `INVENTORY_ADMIN_TOKEN` (required for stock updates; send as `Authorization: Bearer <token>`)

## Database

On startup, the API applies SQL migrations from:

- `../database/migrations/*.sql`

and seeds from:

- `../database/seed/*.sql`

## OpenAPI

- OpenAPI JSON: `http://localhost:3000/openapi.json`
- Swagger UI: `http://localhost:3000/docs`

## Inventory and checkout

- `GET /api/products` and `GET /api/products/{id}` accept `branchId` (positive integer, default `1`).
  They return existing product fields plus `quantityOnHand` and `stockStatus`:
  `out_of_stock` at zero, `low_stock` from 1 through 5, and `in_stock` above 5.
  Missing stock rows mean zero; nonexistent branches or products return `404`.
- `PUT /api/inventory/{branchId}/{productId}` accepts `{"quantityOnHand": 12}` and returns
  `{"branchId": 1, "productId": 1, "quantityOnHand": 12}` with `200`.
  Quantity must be an integer from zero through 2147483647 (strings and booleans are rejected).
  Missing/incorrect bearer credentials return `403`; an unset admin token returns `503`.
  Unknown branch/product references return `404`.
- `POST /api/orders` preserves the header-only request. Optionally add a nonempty `items` array
  of at most 100 `{"productId": 1, "quantity": 2}` lines. Quantities must be strict positive
  integers up to 2147483647. Unit prices come from the stored product price and discount,
  rounded to cents (half up), not client input. The `201` response includes persisted order-detail
  objects in `items` when supplied. Explicit `items: null` is invalid.
- Checkout runs in one immediate SQLite transaction. Shared database triggers allocate stock,
  including legacy order-detail create/update/delete paths. Insufficient stock returns
  `409` (`CONFLICT`) with no partial writes. Detail deletion or order deletion restores only
  stock allocated after migration 003; historical lines do not invent stock on deletion.
  Editing historical quantities allocates the new quantity from available stock.
  changing the branch of an order with details returns `400` (`VALIDATION_ERROR`).
- Invalid request shapes/IDs/quantities use `400` with the standard
  `{"error": {"code": "VALIDATION_ERROR", "message": "..."}}` envelope, including legacy detail
  requests (instead of FastAPI's default `422`). Product write responses and header-only order
  responses retain their existing fields. No intentional inventory contract deviations.

## Tests

From `src/api-py`, run `python -m pytest tests -q`. Tests use isolated project-local SQLite
databases and the real shared migration/seed scripts, including trigger enforcement and
concurrent checkout. Test databases are removed afterward.
