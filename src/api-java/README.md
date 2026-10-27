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

## Hosted payments

Configure server-only `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, and
`CHECKOUT_PUBLIC_URL` (origin only: HTTPS, or HTTP on localhost/127.0.0.1 with an
optional port; no trailing slash, credentials, query, fragment, or path).
Invalid configuration returns `503 PAYMENT_UNAVAILABLE`. Currency is fixed to USD.
Never expose or log the secret or hosted checkout URLs.

- `POST /api/checkout`: `{"checkoutId":"ed6c1980-379e-4e8f-a41d-599812710124",
  "branchId":1,"items":[{"productId":1,"quantity":2}]}`. IDs and quantities must
  be positive JSON integers up to 2147483647; at most 100 lines. Duplicate products
  combine (overflow rejected) and sort by product ID. The lowercase UUID v4 is an
  unguessable capability: keep it private. Returns `200` with
  `{checkoutId,status,checkoutUrl,amountTotal,currency:"usd",orderId}`; URL/order ID
  may be null. A semantic retry reuses the saved request and pricing snapshot;
  changed requests return `409 CONFLICT`.
- Stock, branch, products, half-up discounted cents and total (50–99999999 cents)
  are checked before Stripe. No stock is reserved. A durable `creating` row
  precedes remote calls; retries use Stripe key `checkout-{checkoutId}`. Unknown
  creation outcomes older than 23 hours require manual reconciliation, not a
  new session or payment.
- `POST /api/checkout/{checkoutId}/complete` retrieves Stripe server-side and
  verifies identity, USD currency and saved amount. Unpaid sessions return
  `409 PAYMENT_PENDING`; expired unpaid sessions become cancelled. Only paid,
  complete sessions can create a confirmed order, atomically with snapshot-priced
  details and stock allocation. Repeated/concurrent completion creates one order.
- If stock or persistence fails, order writes roll back, then the payment intent
  and `refund_pending` state commit before a Stripe refund using
  `refund-{checkoutId}`. Only a succeeded refund becomes `refunded`; failed,
  pending or uncertain refunds return `502 REFUND_PENDING`. Retry completion to
  retry the same refund; a refund-pending checkout can never create an order.
- `POST /api/checkout/{checkoutId}/cancel` verifies/expires the remote unpaid
  session before persisting cancellation; paid sessions finalize instead.
  Completed, cancelled and refunded checkouts are terminal.

Verification is return-driven; this issue adds no webhook. Operators must
reconcile abandoned pending/creating sessions and retry `complete` for known
paid sessions or `refund_pending` rows. A creating row with unknown outcome needs
Stripe-side reconciliation before any manual repair. Do not delete these durable
records or start a replacement charge blindly.
Provider errors return safe `502 PAYMENT_PROVIDER_ERROR` messages without Stripe
bodies or credentials. All errors use the standard `{error:{code,message}}` envelope.
Shared migration `004_checkout_payments.sql` is automatically applied.
Tests mock the provider: no real Stripe credentials or calls are required.

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
