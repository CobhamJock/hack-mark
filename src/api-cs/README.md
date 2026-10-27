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
# Card checkout

The optional Stripe hosted-card checkout uses the shared `004_checkout_payments.sql`
migration (applied automatically on startup). Set `PAYMENT_PROVIDER=stripe`,
`STRIPE_SECRET_KEY` (server only), and `CHECKOUT_PUBLIC_URL` to an origin such as
`https://shop.example.com` or `http://localhost:5137`. Only HTTPS or HTTP on
`localhost`/`127.0.0.1` is allowed, with an optional port and no credentials, path,
query, fragment, or trailing slash. Invalid configuration returns
`503 PAYMENT_UNAVAILABLE` without contacting Stripe. Never put keys in frontend
configuration or source control. Stripe requests time out after 15 seconds and
fail safely as `502 PAYMENT_PROVIDER_ERROR`.

* `POST /api/checkout`: `{checkoutId, branchId, items:[{productId,quantity}]}`.
  Supply a fresh lowercase UUID v4 as the unguessable capability/idempotency key.
  Positive integer IDs/quantities are required; up to 100 lines are combined and
  sorted by product ID, rejecting aggregate integer overflow. Reusing an ID with
  a semantically different cart returns `409 CONFLICT`.
* `POST /api/checkout/{checkoutId}/complete`: verify the session identity, USD
  amount, and paid/complete state directly with Stripe; unpaid returns
  `409 PAYMENT_PENDING`, expired unpaid becomes cancelled.
* `POST /api/checkout/{checkoutId}/cancel`: expire an unpaid open session remotely
  before persisting cancellation. Already paid sessions follow completion.

All success responses are HTTP 200:
`{checkoutId,status,checkoutUrl,amountTotal,currency:"usd",orderId}`. Totals are
integer cents; nullable fields are present as `null`. Errors use
`{error:{code,message}}`. See `checkout.http` and `/api-docs.json`.

Stock, branches, and products are checked before the first provider call. Prices
are discounted, rounded half-up to cents, and snapshotted with product names.
Each payable unit must be positive and the total must be between 50 and
99,999,999 cents (Stripe's USD minimum is 50 cents).
The durable `creating` row precedes Stripe creation (`checkout-{checkoutId}`
idempotency key); retries use the original snapshot. Unknown creating outcomes
older than 23 hours require operator reconciliation rather than session recreation.

Stock is **not reserved**. Successful payment creates one confirmed order with
snapshot prices in an immediate SQLite transaction; inventory triggers recheck
and decrement stock. A stock race or persistence failure rolls back the entire
order, then durably records `refund_pending` with the payment intent before
requesting a refund (`refund-{checkoutId}` idempotency key). Only a succeeded
refund becomes `refunded`; otherwise `502 REFUND_PENDING` is retryable through
`complete`, never creating an order thereafter. Completed/cancelled/refunded
retries do not charge or create another order.

Verification is return-driven; this issue adds no webhook. Keep capabilities
private, avoid logging provider payloads/keys, and have operators reconcile
abandoned pending payments and `refund_pending` rows through the `complete`
endpoint. Do not retry old unknown creating rows with a new payment key until
the original Stripe outcome has been reconciled.
