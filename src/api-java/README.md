# OctoSupply API (Java)

Spring Boot 3 port of the OctoSupply API.

## Run

```bash
mvn spring-boot:run
```

Default API URL: `http://localhost:3000`

## Environment

- `PORT` (default: `3000`)
- `DB_FILE` (default: `./data/app.db`)
- `API_CORS_ORIGINS` (comma-separated override; optional)
- `DB_MIGRATIONS_DIR` (optional override for migrations directory)
- `INVENTORY_ADMIN_TOKEN` (required only for inventory administration; keep this server-side)

## Database

On startup, the API applies SQL migrations from:

- `../database/migrations/*.sql`

and seeds from:

- `../database/seed/*.sql`

Migration scripts are executed intact by SQLite (including multi-statement trigger
bodies), transactionally with their migration-history entry. Fresh databases receive
the shared inventory seed; existing databases start with zero stock until an
administrator enters real counts.

## Branch inventory and orders

- `GET /api/products` and `GET /api/products/{id}` accept an optional positive
  integer `branchId` (default `1`). Unknown branches return `404`. Products retain
  their existing fields and add integer `quantityOnHand` (zero for missing inventory)
  and `stockStatus`: `out_of_stock` at zero, `low_stock` at 1–5, and `in_stock` above 5.
- `PUT /api/inventory/{branchId}/{productId}` accepts
  `{"quantityOnHand": 10}` and returns `{branchId, productId, quantityOnHand}` with
  `200`. Both IDs must be positive and reference existing records (`404` otherwise).
  Send `Authorization: Bearer <INVENTORY_ADMIN_TOKEN>`. Missing/incorrect authorization
  returns `403 FORBIDDEN`; an unconfigured token returns `503 SERVICE_UNAVAILABLE`.
- `POST /api/orders` preserves the header-only payload (`branchId`, `orderDate`,
  `name`, optional `description` and `status`). Optionally include a nonempty
  `items` array of at most 100 `{productId, quantity}` lines. The `201` response
  includes the existing order fields plus persisted `items` containing
  `orderDetailId`, `orderId`, `productId`, `quantity`, and `unitPrice`.
  Prices are computed from server product prices and discounts, rounded to cents
  using half-up rounding; client prices are ignored. Explicit `items: null` is invalid.
- All quantities must be JSON integers (not strings, booleans, or fractions).
  On-hand counts permit zero; item quantities must be positive. Maximum input
  quantity is `2147483647`. IDs in JSON bodies follow the same strict integer rule.
- Order headers, details, and stock allocation commit together. Insufficient stock
  returns `409 CONFLICT` without partial writes, including for duplicate product
  lines. Shared database triggers also protect legacy order-detail create, update,
  move, and delete paths. Detail responses include the persisted `unitPrice`;
  legacy detail creation also derives its price from the server.
  Changing the branch of an order with details returns `400 VALIDATION_ERROR`.
  Historical pre-inventory details do not refund stock on deletion; their first
  quantity/product/order update must allocate the full new quantity and is then
  tracked by the shared `inventory_allocations` table.

Errors use `{"error":{"code":"...","message":"..."}}` and never include tokens.
No inventory-contract parity deviations are intentional. Existing Java header-only
orders still require `orderDate` as in the original Java API; omitting `items` does
not add an `items` field to the response.

## Verification

```bash
mvn test
mvn -DskipTests package
```

Inventory API integration tests and in-memory migration tests use the shared
`../database/migrations` scripts, including `003_branch_inventory.sql`, rather than
a duplicated test schema.

## OpenAPI

- OpenAPI JSON: `http://localhost:3000/api-docs.json`
- Swagger UI: `http://localhost:3000/api-docs`
