# Cart payments

The shared React cart uses Stripe-hosted Checkout with the same API contract in
TypeScript, C#, Python and Java. This feature builds on branch inventory (issue #1).
The application never accepts or stores card numbers, security codes or Stripe secret
keys in the browser. Provider calls use Stripe's fixed HTTPS API endpoint.

## Configuration

Set these variables in the selected API process:

| Variable | Value |
| --- | --- |
| `PAYMENT_PROVIDER` | `stripe` |
| `STRIPE_SECRET_KEY` | Your Stripe **test-mode** secret key for development |
| `CHECKOUT_PUBLIC_URL` | Frontend origin, for example `http://localhost:5137` |

Use your own Stripe account and environment variables; do not commit keys.
The public URL must be an origin (no credentials, path, query or fragment).
HTTPS is required except for local `localhost` or `127.0.0.1` development.
The API's existing CORS configuration must allow that frontend origin. USD is the
only supported currency. Configure the frontend's existing API URL for the selected API.

No payment provider is silently simulated when configuration is absent: checkout
returns `503 PAYMENT_UNAVAILABLE`. Automated tests replace the provider boundary;
they never submit real payments.

## Customer flow

1. Select the stock branch, choose quantities and add products to the cart.
2. Open **Cart**. Correct invalid/unavailable quantities before continuing.
3. Open checkout and choose **Prepare secure payment**. The server validates current
   stock, computes discounted prices in integer cents, and stores an immutable cart snapshot.
4. Review the server total and choose **Pay … on Stripe**. Enter payment details on
   Stripe's hosted page, not in this application.
5. On return, the API retrieves the session directly from Stripe. A URL parameter,
   browser message or unpaid session can never confirm an order.
6. Only a verified paid session produces an order and clears the cart. Unpaid/declined
   sessions leave the cart intact. Cancellation expires the unpaid provider session
   before unlocking cart edits. If payment already succeeded, cancellation finalizes it.

Cart contents and the retry reference are stored in browser **session storage** so
navigation/reloads and hosted payment redirects preserve the cart. They are not a
server-side shopping cart or an authenticated customer account. Keep the checkout UUID
private: it is an unguessable capability to operate that checkout. Do not share return
URLs, enable analytics logging of their query strings, or delete browser storage while
a payment is unresolved. The UI prevents edits during an unresolved checkout.

## API

All responses use camelCase. Errors use the existing `{error: {code, message}}` envelope.

`POST /api/checkout`

```json
{
  "checkoutId": "4611bd55-d597-4cb0-9e7b-48ce65d6c6d3",
  "branchId": 1,
  "items": [{"productId": 1, "quantity": 2}]
}
```

Use a cryptographically generated lowercase UUID v4 and reuse it for every retry of
the **same** cart. Payment totals must be USD 0.50–999,999.99. Quantities/IDs must be positive integers, with a maximum quantity
of 2147483647. Accepts 1–100 lines; duplicate products are combined before checking
stock and totals. Changing a cart bound to an existing UUID returns `409 CONFLICT`.
Prices supplied by the client are never authoritative.

```json
{
  "checkoutId": "4611bd55-d597-4cb0-9e7b-48ce65d6c6d3",
  "status": "pending",
  "checkoutUrl": "https://checkout.stripe.com/...",
  "amountTotal": 19498,
  "currency": "usd",
  "orderId": null
}
```

`POST /api/checkout/{checkoutId}/complete` verifies the stored provider session ID,
client reference, checkout metadata, amount and currency against the snapshot.
Paid sessions create a `confirmed` order and its details using snapshot unit prices.
The allocation triggers recheck stock inside the same transaction. Repeating this
operation returns the same order, not another charge or order.

`POST /api/checkout/{checkoutId}/cancel` expires an unpaid checkout. An already-paid
session follows the completion flow instead. Neither endpoint accepts payment status
or order prices from the browser.

Response status values: `creating`, `pending`, `completed`, `refund_pending`, `refunded`,
`cancelled`. Only `completed` **with an order ID** is an order confirmation.
`409 PAYMENT_PENDING` means payment is not yet confirmed. Provider/verification errors
return 502. Retain the cart and retry the same reference.

## Consistency, refunds and reconciliation

SQLite and a remote payment provider cannot share one atomic transaction. This
implementation checks stock before creating the payment session but **does not reserve
it while the customer is on Stripe**. If stock sells out, or an order/detail write
fails after payment, every order/stock write is rolled back. The durable checkout
record moves to `refund_pending` before the API requests a refund. Only a provider
refund with status `succeeded` marks it `refunded`.

Creation uses Stripe idempotency key `checkout-{UUID}`; refund uses `refund-{UUID}`.
Refund failure returns `502 REFUND_PENDING`. Subsequent completion calls retry that
refund and can never create an order for that reference. A successful refund keeps
the cart intact. Do not submit a new payment while the previous outcome is unknown.

**Operational requirement:** confirmation is return-driven; this feature does not
install Stripe webhooks or a scheduler. Before using live payments, arrange regular
operator reconciliation (or add verified webhooks/background reconciliation). Customers
may close the browser after paying, or a request/process may fail before persisting a
provider response. Query unresolved records with an authorized database tool:

```sql
SELECT checkout_id, status, provider_session_id, payment_intent_id, created_at
FROM checkouts
WHERE status IN ('creating', 'pending', 'refund_pending')
ORDER BY created_at;
```

- For `pending` or `refund_pending`, retry the completion endpoint and inspect Stripe's
  corresponding session/payment/refund when it remains unresolved.
- For a recent `creating` record, retry the original start request from `request_json`
  with its original checkout ID. Snapshot data remains unchanged.
- For `creating` records older than 23 hours, automatic recreation is blocked because
  provider idempotency retention is finite. Reconcile in Stripe using its client
  reference/checkout metadata before taking any manual action. Never assign a new
  retry key merely to resolve an unknown outcome.
- If refund success could not be persisted and the provider idempotency window has
  elapsed, confirm the refund in Stripe before correcting local state. A pending
  refund is not a successful order.

Do not delete checkout audit records or referenced paid orders, overwrite payment
references, or change configuration to a different Stripe account while payments are
unresolved. Paid order references use `ON DELETE RESTRICT` to preserve reconciliation.
The migration has a manual rollback note: reconcile payments/refunds before dropping
the checkout table. Historical migrations and seed stock are unchanged.

## Verification

API tests inject/fake the provider boundary and cover successful payment, unpaid
sessions, invalid carts/configuration, server pricing, snapshot retries, identity/amount
tampering, concurrent completion, stock races, write rollback, refund retries and
cancellation. Frontend Playwright tests cover cart persistence, inline quantity errors,
hosted redirect/return, cart retention, refund/cancel outcomes and mobile layouts.

To manually test Stripe's actual hosted page, configure a Stripe test account and
use Stripe's published test payment methods. Never use real card details in tests.
No live Stripe transaction is required or claimed by the automated test suite.
