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
- `PAYMENT_PROVIDER=stripe` (required for hosted checkout; no other providers are enabled)
- `STRIPE_SECRET_KEY` (server-only Stripe secret; use a test-mode key for local development)
- `CHECKOUT_PUBLIC_URL` (required origin, such as `https://shop.example` or
  `http://localhost:5137`; HTTPS except localhost/127.0.0.1 HTTP; optional port;
  no credentials, trailing slash, path, query, or fragment)
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

## Hosted card payments

The Python API uses the shared `004_checkout_payments.sql` migration. Stripe requests use
the standard library, a fixed `https://api.stripe.com/v1` endpoint, and a 15-second timeout;
no additional payment dependency is needed. No card numbers pass through this API.

- `POST /api/checkout` accepts
  `{"checkoutId":"<lowercase UUID v4>","branchId":1,"items":[{"productId":1,"quantity":2}]}`.
  Generate and retain one unpredictable UUID per checkout; it is a bearer capability.
  IDs and quantities are strict positive integers up to 2147483647, with 1–100 input lines.
  Duplicate products are combined and sorted; aggregate overflow is rejected.
  The server validates branch, products, availability, and discounted prices before contacting
  Stripe. Prices are rounded half-up to USD cents; every price must be positive and the
  total must not exceed 99999999 cents. The price/name snapshot and canonical request are
  durable **before** the external request. Retrying the UUID with a semantically different
  branch or quantities returns `409 CONFLICT`; retries reuse the original snapshot, not
  current prices. The response is `200`:
  `{"checkoutId":"...","status":"pending","checkoutUrl":"https://checkout.stripe.com/...",
  "amountTotal":202,"currency":"usd","orderId":null}`.
- Redirect to `checkoutUrl`. Stripe success/cancel returns go to
  `${CHECKOUT_PUBLIC_URL}/checkout?checkoutId=...&result=success|cancel`.
  A browser return is **not proof of payment**.
- `POST /api/checkout/{checkoutId}/complete` retrieves Stripe's session server-side and
  verifies its ID, checkout references, currency, and amount. Unpaid sessions return
  `409 PAYMENT_PENDING`; expired unpaid sessions become `cancelled`. Only a paid, complete
  session with a payment intent creates a confirmed order, using snapshot prices.
  The order, details, inventory trigger writes, and completed status commit atomically.
  Repeated/concurrent completion cannot create duplicate orders.
- Stock is **not reserved** while the customer pays. If inventory changes, or order persistence
  fails after payment, the order transaction rolls back. The API durably records
  `refund_pending` and the payment intent before requesting a refund. Only Stripe's
  `succeeded` refund becomes `refunded`; a pending/failed/network refund returns
  `502 REFUND_PENDING`. Retry the same completion endpoint to finish the same refund;
  a `refund_pending` checkout never tries to create an order again. If SQLite cannot persist
  the refund intent, no refund is sent; retry completion and reconcile operationally.
- `POST /api/checkout/{checkoutId}/cancel` verifies Stripe first, expires an unpaid open
  session remotely, and only then records `cancelled`. A paid session is finalized instead.
  Already completed, cancelled, or refunded checkouts return their stored status without
  another remote request. Cancellation cannot refund a completed order.
- Missing/invalid configuration returns `503 PAYMENT_UNAVAILABLE` without provider calls.
  Provider failures or invalid session responses return `502 PAYMENT_PROVIDER_ERROR` with
  safe messages. Errors use `{"error":{"code":"...","message":"..."}}`.

Creation uses Stripe idempotency key `checkout-{checkoutId}`, and refunds use
`refund-{checkoutId}`. A retry in `creating` reuses the saved snapshot and original key.
If a checkout is still `creating` after 23 hours, creation returns `409 CONFLICT` requiring
manual reconciliation rather than risking a second charge after provider key expiry.

Verification is return-driven; this issue adds no webhook or background reconciliation worker.
Operators must reconcile abandoned `pending` payments and `refund_pending` entries against
Stripe, retrying `/complete` with the original checkout ID. For an old `creating` entry,
inspect Stripe's metadata/client reference and resolve the existing session/payment before
any manual state repair; do not generate a fresh checkout to bypass an unknown charge.
Keep secret keys and capability IDs out of logs, tickets, and public URLs other than the
intended checkout return. The generated OpenAPI/Swagger documents all three routes,
request/response models, and error status codes.

## Tests

From `src/api-py`, run `python -m pytest tests -q`. Tests use isolated project-local SQLite
databases and the real shared migration/seed scripts, including trigger enforcement and
concurrent checkout. Test databases are removed afterward.
Payment tests mock the provider boundary (including transport/form-contract tests); they
never contact Stripe or use real cards.
