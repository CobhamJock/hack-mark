import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import checkoutRoutes from './checkout';
import { closeDatabase, getDatabase } from '../db/sqlite';
import { runMigrations } from '../db/migrate';
import { seedDatabase } from '../db/seed';
import { errorHandler } from '../utils/errors';
import { StripeSession } from '../repositories/stripePayments';

const app = express();
app.use(express.json());
app.use('/api/checkout', checkoutRoutes);
app.use(errorHandler);
let session: StripeSession;
let failProvider: boolean;
let failRefund: boolean;
const calls: { url: string; form: URLSearchParams; key: string | undefined }[] = [];

beforeEach(async () => {
  await closeDatabase();
  await getDatabase(true);
  await runMigrations(true);
  await seedDatabase(false, true);
  vi.stubEnv('PAYMENT_PROVIDER', 'stripe');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_not_a_real_key');
  vi.stubEnv('CHECKOUT_PUBLIC_URL', 'http://localhost:5137');
  failProvider = false;
  failRefund = false;
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const form = new URLSearchParams(String(init.body ?? ''));
    const headers = init.headers as Record<string, string>;
    calls.push({ url, form, key: headers['Idempotency-Key'] });
    if (failProvider || (failRefund && url.endsWith('/refunds'))) {
      return new Response('private provider error', { status: 500 });
    }
    if (url.endsWith('/refunds')) {
      return Response.json({ id: 're_test', status: 'succeeded' });
    }
    if (url.endsWith('/expire')) {
      session = { ...session, status: 'expired', url: null };
      return Response.json(session);
    }
    if (url.endsWith('/checkout/sessions')) {
      let total = 0;
      for (let index = 0; form.has(`line_items[${index}][quantity]`); index++) {
        total += Number(form.get(`line_items[${index}][quantity]`)) *
          Number(form.get(`line_items[${index}][price_data][unit_amount]`));
      }
      session = {
        id: `cs_test_${form.get('client_reference_id')}`, url: 'https://checkout.stripe.com/c/pay/cs_test_checkout',
        client_reference_id: form.get('client_reference_id'),
        metadata: { checkoutId: form.get('metadata[checkoutId]') ?? undefined },
        currency: 'usd', amount_total: total,
        payment_status: 'unpaid', status: 'open', payment_intent: null,
      };
    }
    return Response.json(session);
  }));
});
afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const body = (checkoutId = randomUUID()) => ({ checkoutId, branchId: 1, items: [{ productId: 1, quantity: 2 }] });
async function start() {
  const input = body();
  const response = await request(app).post('/api/checkout').send(input);
  expect(response.status).toBe(200);
  return input;
}
function paid() {
  session = { ...session, status: 'complete', payment_status: 'paid', payment_intent: 'pi_test' };
}
async function counts() {
  const db = await getDatabase();
  return {
    orders: db.db.prepare('SELECT COUNT(*) AS count FROM orders').get(),
    details: db.db.prepare('SELECT COUNT(*) AS count FROM order_details').get(),
    stock: db.db.prepare('SELECT quantity_on_hand FROM inventory WHERE branch_id=1 AND product_id=1').get(),
  };
}

describe('Hosted payment checkout', () => {
  it('uses server prices, snapshots totals and sends only hosted form data', async () => {
    const input = body();
    const response = await request(app).post('/api/checkout').send({ ...input, amountTotal: 1 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'pending', amountTotal: 19498, currency: 'usd', orderId: null });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(calls[0].form.get('line_items[0][price_data][unit_amount]')).toBe('9749');
    expect(calls[0].form.get('success_url')).toContain(`checkoutId=${input.checkoutId}&result=success`);
    expect(calls[0].form.get('payment_method_types[0]')).toBe('card');
    expect(calls[0].key).toBe(`checkout-${input.checkoutId}`);
    expect((await counts()).orders).toEqual({ count: 0 });
  });

  it.each([
    { price: 19.99, discount: 0.5, cents: 1000 },
    { price: 1.005, discount: 0, cents: 101 },
    { price: 19.99, discount: 0.4999999999, cents: 1000 },
    { price: 19.99, discount: 0.5000000001, cents: 999 },
    { price: 129.99, discount: 0.25, cents: 9749 },
    { price: 10, discount: 1e-7, cents: 1000 },
  ])('rounds discounted decimal prices half-up ($price, $discount)', async ({ price, discount, cents }) => {
    const db = await getDatabase();
    await db.run('UPDATE products SET price=?,discount=? WHERE product_id=1', [price, discount]);
    const input = body();
    const response = await request(app).post('/api/checkout').send(input);
    expect(response.status).toBe(200);
    expect(response.body.amountTotal).toBe(cents * 2);
    expect(calls[0].form.get('line_items[0][price_data][unit_amount]')).toBe(String(cents));
    const snapshot = db.db.prepare<[string], { items_json: string }>(
      'SELECT items_json FROM checkouts WHERE checkout_id=?').get(input.checkoutId);
    if (!snapshot) throw new Error('Checkout snapshot was not persisted');
    expect(JSON.parse(snapshot.items_json)).toEqual([
      { productId: 1, quantity: 2, unitPriceCents: cents, name: 'SmartFeeder One' },
    ]);
    expect((await request(app).post('/api/checkout').send(input)).body.amountTotal).toBe(cents * 2);
    expect(calls).toHaveLength(1);
    paid();
    const completed = await request(app).post(`/api/checkout/${input.checkoutId}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ status: 'completed', amountTotal: cents * 2 });
    expect(db.db.prepare('SELECT quantity,unit_price FROM order_details').get())
      .toEqual({ quantity: 2, unit_price: cents / 100 });
  });

  it('verifies payment and creates exactly one confirmed order with stock allocation', async () => {
    const input = await start();
    paid();
    await (await getDatabase()).run('UPDATE products SET price = 999 WHERE product_id=1');
    const first = await request(app).post(`/api/checkout/${input.checkoutId}/complete`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'completed', amountTotal: 19498 });
    const second = await request(app).post(`/api/checkout/${input.checkoutId}/complete`);
    expect(second.body).toEqual(first.body);
    expect(await counts()).toEqual({ orders: { count: 1 }, details: { count: 1 }, stock: { quantity_on_hand: 1 } });
    const db = await getDatabase();
    expect(db.db.prepare('SELECT status FROM orders').get()).toEqual({ status: 'confirmed' });
    expect(db.db.prepare('SELECT unit_price FROM order_details').get()).toEqual({ unit_price: 97.49 });
  });

  it('keeps unpaid or declined sessions pending with no order or stock change', async () => {
    const input = await start();
    const response = await request(app).post(`/api/checkout/${input.checkoutId}/complete`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PAYMENT_PENDING');
    expect(await counts()).toEqual({ orders: { count: 0 }, details: { count: 0 }, stock: { quantity_on_hand: 3 } });
  });

  it('resumes checkout idempotently and rejects a different cart for the same key', async () => {
    const input = await start();
    const again = await request(app).post('/api/checkout').send(input);
    expect(again.body.status).toBe('pending');
    expect(calls).toHaveLength(1);
    const conflict = await request(app).post('/api/checkout').send({ ...input, items: [{ productId: 1, quantity: 1 }] });
    expect(conflict.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('combines duplicate lines for stock checks and stable retries', async () => {
    const input = body();
    const response = await request(app).post('/api/checkout').send({
      ...input, items: [{ productId: 1, quantity: 1 }, { productId: 1, quantity: 1 }],
    });
    expect(response.status).toBe(200);
    expect((await request(app).post('/api/checkout').send(input)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('rejects invalid carts and unavailable stock before any provider call', async () => {
    for (const quantity of [0, -1, 0.5, '2', true, null, 2147483648]) {
      expect((await request(app).post('/api/checkout').send({
        ...body(), items: [{ productId: 1, quantity }],
      })).status).toBe(400);
    }
    expect((await request(app).post('/api/checkout').send({ ...body(), items: [] })).status).toBe(400);
    expect((await request(app).post('/api/checkout').send({ ...body(), checkoutId: 'not-uuid' })).status).toBe(400);
    expect((await request(app).post('/api/checkout').send({ ...body(), items: [{ productId: 1, quantity: 4 }] })).status).toBe(409);
    expect((await request(app).post('/api/checkout').send({ ...body(), branchId: 999 })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('does not contact Stripe with missing or unsafe configuration', async () => {
    for (const origin of ['https://site.test/path', 'http://public.test', 'https://user:pass@site.test', 'invalid']) {
      vi.stubEnv('CHECKOUT_PUBLIC_URL', origin);
      expect((await request(app).post('/api/checkout').send(body())).status).toBe(503);
    }
    vi.stubEnv('CHECKOUT_PUBLIC_URL', 'http://localhost:5137');
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect((await request(app).post('/api/checkout').send(body())).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('enforces Stripe minimum and maximum totals before contacting the provider', async () => {
    const db = await getDatabase();
    await db.run('UPDATE products SET price=0.01,discount=0 WHERE product_id=1');
    expect((await request(app).post('/api/checkout').send(body())).status).toBe(400);
    await db.run('UPDATE products SET price=1000000 WHERE product_id=1');
    expect((await request(app).post('/api/checkout').send(body())).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM checkouts').get()).toEqual({ count: 0 });
  });

  it('rejects a provider checkout URL outside its exact HTTPS origin', async () => {
    const input = body();
    failProvider = true;
    await request(app).post('/api/checkout').send(input);
    failProvider = false;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      id: 'cs_test', url: 'https://checkout.stripe.com:444/unsafe',
      client_reference_id: input.checkoutId, metadata: { checkoutId: input.checkoutId },
      amount_total: 19498, currency: 'usd', payment_status: 'unpaid', status: 'open', payment_intent: null,
    })));
    const response = await request(app).post('/api/checkout').send(input);
    expect(response.status).toBe(502);
    expect((await counts()).orders).toEqual({ count: 0 });
  });

  it('recovers provider failure with the same snapshot and idempotency key', async () => {
    const input = body();
    failProvider = true;
    const failed = await request(app).post('/api/checkout').send(input);
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain('private provider error');
    failProvider = false;
    await (await getDatabase()).run('UPDATE products SET price = 999 WHERE product_id=1');
    expect((await request(app).post('/api/checkout').send(input)).body.amountTotal).toBe(19498);
    expect(calls[0].key).toBe(calls[1].key);
  });

  it('handles transport failure explicitly without exposing provider credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout sk_test_not_a_real_key'); }));
    const response = await request(app).post('/api/checkout').send(body());
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('sk_test');
    expect((await counts()).orders).toEqual({ count: 0 });
  });

  it('does not cancel locally while provider cancellation is unconfirmed', async () => {
    const input = await start();
    failProvider = true;
    expect((await request(app).post(`/api/checkout/${input.checkoutId}/cancel`)).status).toBe(502);
    expect((await getDatabase()).db.prepare('SELECT status FROM checkouts').get()).toEqual({ status: 'pending' });
    expect((await counts()).orders).toEqual({ count: 0 });
  });

  it('does not recreate an unknown session after Stripe idempotency retention', async () => {
    const input = body();
    failProvider = true;
    await request(app).post('/api/checkout').send(input);
    await (await getDatabase()).run("UPDATE checkouts SET created_at='2020-01-01 00:00:00'");
    failProvider = false;
    const response = await request(app).post('/api/checkout').send(input);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('RECONCILIATION_REQUIRED');
    expect(calls).toHaveLength(1);
  });

  it.each(['amount', 'currency', 'reference', 'metadata', 'session'])('rejects mismatched payment %s', async (field) => {
    const input = await start();
    paid();
    if (field === 'amount') session.amount_total = 1;
    if (field === 'currency') session.currency = 'eur';
    if (field === 'reference') session.client_reference_id = randomUUID();
    if (field === 'metadata') session.metadata = {};
    if (field === 'session') session.id = 'cs_other';
    const response = await request(app).post(`/api/checkout/${input.checkoutId}/complete`);
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect((await counts()).orders).toEqual({ count: 0 });
  });

  it('refunds a paid checkout if stock has sold out, without creating an order', async () => {
    const input = await start();
    paid();
    await (await getDatabase()).run('UPDATE inventory SET quantity_on_hand=0 WHERE branch_id=1 AND product_id=1');
    const response = await request(app).post(`/api/checkout/${input.checkoutId}/complete`);
    expect(response.body.status).toBe('refunded');
    expect((await counts()).orders).toEqual({ count: 0 });
    expect(calls.find((call) => call.url.endsWith('/refunds'))?.key).toBe(`refund-${input.checkoutId}`);
    expect((await request(app).post(`/api/checkout/${input.checkoutId}/complete`)).body.status).toBe('refunded');
    expect(calls.filter((call) => call.url.endsWith('/refunds'))).toHaveLength(1);
  });

  it('durably retries a failed refund and never creates an order afterward', async () => {
    const input = await start();
    paid();
    const db = await getDatabase();
    db.db.exec(`CREATE TRIGGER reject_paid_order BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT,'Write failure'); END;`);
    failRefund = true;
    const failed = await request(app).post(`/api/checkout/${input.checkoutId}/complete`);
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('REFUND_PENDING');
    expect(db.db.prepare('SELECT status FROM checkouts').get()).toEqual({ status: 'refund_pending' });
    db.db.exec('DROP TRIGGER reject_paid_order');
    failRefund = false;
    const retried = await request(app).post(`/api/checkout/${input.checkoutId}/complete`);
    expect(retried.body.status).toBe('refunded');
    expect(calls.filter((call) => call.url.endsWith('/refunds')).map((call) => call.key))
      .toEqual([`refund-${input.checkoutId}`, `refund-${input.checkoutId}`]);
    expect(await counts()).toEqual({ orders: { count: 0 }, details: { count: 0 }, stock: { quantity_on_hand: 3 } });
  });

  it('rolls back earlier order lines when a later line write fails', async () => {
    const input = { ...body(), items: [{ productId: 1, quantity: 1 }, { productId: 3, quantity: 1 }] };
    expect((await request(app).post('/api/checkout').send(input)).status).toBe(200);
    paid();
    (await getDatabase()).db.exec(`CREATE TRIGGER reject_line BEFORE INSERT ON order_details
      WHEN NEW.product_id=3 BEGIN SELECT RAISE(ABORT,'Line failure'); END;`);
    expect((await request(app).post(`/api/checkout/${input.checkoutId}/complete`)).body.status).toBe('refunded');
    expect(await counts()).toEqual({ orders: { count: 0 }, details: { count: 0 }, stock: { quantity_on_hand: 3 } });
  });

  it('serializes competing completion requests without duplicate orders or refunds', async () => {
    const input = await start();
    paid();
    const responses = await Promise.all([1, 2].map(() => request(app).post(`/api/checkout/${input.checkoutId}/complete`)));
    expect(responses[0].body).toEqual(responses[1].body);
    expect((await counts()).orders).toEqual({ count: 1 });
    expect(calls.filter((call) => call.url.endsWith('/refunds'))).toHaveLength(0);
  });

  it('expires unpaid checkout before cancelling and finalizes paid cancellations', async () => {
    const input = await start();
    const cancel = await request(app).post(`/api/checkout/${input.checkoutId}/cancel`);
    expect(cancel.body.status).toBe('cancelled');
    expect(calls.some((call) => call.url.endsWith('/expire'))).toBe(true);
    expect((await request(app).post('/api/checkout').send(input)).body.status).toBe('cancelled');
    const other = await start();
    paid();
    expect((await request(app).post(`/api/checkout/${other.checkoutId}/cancel`)).body.status).toBe('completed');
  });

  it('treats expired sessions as cancelled and rejects invalid or missing IDs', async () => {
    const input = await start();
    session.status = 'expired';
    expect((await request(app).post(`/api/checkout/${input.checkoutId}/complete`)).body.status).toBe('cancelled');
    expect((await request(app).post('/api/checkout/not-uuid/complete')).status).toBe(400);
    expect((await request(app).post(`/api/checkout/${randomUUID()}/complete`)).status).toBe(404);
  });
});
