# OctoSupply API (C#)

ASP.NET Core (.NET 10) port of the OctoSupply API.

## Run

```bash
dotnet restore
dotnet run
```

Default API URL: `http://localhost:3000`

## Environment

- `PORT` (default: `3000`)
- `DB_FILE` (default: `./data/app.db`)
- `API_CORS_ORIGINS` (comma-separated override; optional)
- `INVENTORY_ADMIN_TOKEN` (required for administrative inventory writes; never put the token in source control)

## Database

On startup, the API applies SQL migrations from:

- `../database/migrations/*.sql`

and seeds from:

- `../database/seed/*.sql`

Each migration script and its migration-history entry are committed in one transaction.
Scripts are executed intact, including multi-statement SQLite triggers.

## Branch inventory and orders

- `GET /api/products` and `GET /api/products/{id}` accept `branchId` (positive integer,
  default `1`). Unknown branches return `404`. Products include `quantityOnHand`
  (zero when no inventory row exists) and `stockStatus`: `out_of_stock` at zero,
  `low_stock` for 1–5, and `in_stock` above 5.
- `PUT /api/inventory/{branchId}/{productId}` accepts
  `{"quantityOnHand": 10}`. The quantity must be a JSON integer from 0 to
  2147483647. Supply `Authorization: Bearer <INVENTORY_ADMIN_TOKEN>`.
  An unconfigured token returns `503`; missing/wrong authorization returns `403`.
  Unknown branches/products return `404`. Success returns
  `{branchId, productId, quantityOnHand}` with status `200`.
- `POST /api/orders` preserves the header-only payload. Optional `items` must be a
  nonempty array of at most 100 `{productId, quantity}` lines with positive integer
  IDs/quantities (maximum 2147483647). Prices come from the stored product price
  and discount, rounded to cents (midpoints away from zero), not client input.
  The order, details, and stock allocation commit atomically. The `201` response
  includes persisted `items` only when items were supplied.
- Shared database triggers also protect legacy order-detail create/update/delete
  operations. Insufficient stock returns `409 CONFLICT`; invalid quantities and
  branch changes on orders with details return `400 VALIDATION_ERROR`.

Numeric strings, booleans, fractional values, and overflowing quantities are
rejected. Errors retain the API's `{error: {code, message}}` envelope, including
model-binding failures. See `inventory.http` for examples. No intentional
inventory-contract parity deviations; header-only orders retain existing behavior.

## OpenAPI

- OpenAPI JSON: `http://localhost:3000/api-docs.json`

## Tests

Run C# tests from the `src/` directory:

```bash
make test-cs
```
