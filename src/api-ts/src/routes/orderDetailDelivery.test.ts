import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import orderDetailDeliveryRouter from './orderDetailDelivery';
import { runMigrations } from '../db/migrate';
import { closeDatabase, getDatabase } from '../db/sqlite';
import { errorHandler } from '../utils/errors';

let app: express.Express;

describe('OrderDetailDelivery API', () => {
  beforeEach(async () => {
    await closeDatabase();
    const db = await getDatabase(true);
    await runMigrations(true);
    await db.run('INSERT INTO suppliers (supplier_id, name) VALUES (1, ?)', ['Supplier']);
    await db.run('INSERT INTO headquarters (headquarters_id, name) VALUES (1, ?)', ['HQ']);
    await db.run('INSERT INTO branches (branch_id, headquarters_id, name) VALUES (1, 1, ?)', ['Branch']);
    await db.run(
      `INSERT INTO products (product_id, supplier_id, name, description, price, sku, unit, img_name, discount)
       VALUES (1, 1, 'P', 'D', 10, 'SKU', 'each', 'p.png', 0)`,
    );
    await db.run("INSERT INTO orders (order_id, branch_id, order_date, name) VALUES (1, 1, '2025-01-01', 'O')");
    await db.run('INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (1, 1, 50)');
    await db.run('INSERT INTO order_details (order_detail_id, order_id, product_id, quantity, unit_price) VALUES (1, 1, 1, 10, 10)');
    await db.run("INSERT INTO deliveries (delivery_id, supplier_id, delivery_date, name) VALUES (1, 1, '2025-01-02', 'D')");

    app = express();
    app.use(express.json());
    app.use('/order-detail-deliveries', orderDetailDeliveryRouter);
    app.use(errorHandler);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  const body = { orderDetailId: 1, deliveryId: 1, quantity: 4, notes: 'first batch' };
  const create = async (overrides = {}) =>
    (await request(app).post('/order-detail-deliveries').send({ ...body, ...overrides })).body;

  it('creates a record and returns 201', async () => {
    const response = await request(app).post('/order-detail-deliveries').send(body);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject(body);
    expect(response.body.orderDetailDeliveryId).toBeDefined();
  });

  it('rejects an unknown order detail or delivery with 400', async () => {
    expect((await request(app).post('/order-detail-deliveries').send({ ...body, orderDetailId: 999 })).status).toBe(400);
    expect((await request(app).post('/order-detail-deliveries').send({ ...body, deliveryId: 999 })).status).toBe(400);
  });

  it('rejects a record without a quantity with 400', async () => {
    const response = await request(app).post('/order-detail-deliveries').send({ orderDetailId: 1, deliveryId: 1 });

    expect(response.status).toBe(400);
  });

  it('lists records, empty then populated', async () => {
    expect((await request(app).get('/order-detail-deliveries')).body).toEqual([]);

    await create();
    await create({ quantity: 2 });

    const response = await request(app).get('/order-detail-deliveries');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
  });

  it('gets by ID and returns 404 for missing or malformed IDs', async () => {
    const record = await create();

    const found = await request(app).get(`/order-detail-deliveries/${record.orderDetailDeliveryId}`);

    expect(found.body.quantity).toBe(4);
    expect((await request(app).get('/order-detail-deliveries/999')).status).toBe(404);
    expect((await request(app).get('/order-detail-deliveries/abc')).status).toBe(404);
  });

  it('updates a record and returns 404 for a missing one', async () => {
    const record = await create();

    const updated = await request(app)
      .put(`/order-detail-deliveries/${record.orderDetailDeliveryId}`)
      .send({ quantity: 9 });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ quantity: 9, notes: 'first batch' });
    expect((await request(app).put('/order-detail-deliveries/999').send({ quantity: 1 })).status).toBe(404);
  });

  it('rejects an update that points at a missing delivery with 400', async () => {
    const record = await create();

    const response = await request(app)
      .put(`/order-detail-deliveries/${record.orderDetailDeliveryId}`)
      .send({ deliveryId: 999 });

    expect(response.status).toBe(400);
  });

  it('deletes a record and returns 404 for a missing one', async () => {
    const record = await create();

    expect((await request(app).delete(`/order-detail-deliveries/${record.orderDetailDeliveryId}`)).status).toBe(204);
    expect((await request(app).get(`/order-detail-deliveries/${record.orderDetailDeliveryId}`)).status).toBe(404);
    expect((await request(app).delete('/order-detail-deliveries/999')).status).toBe(404);
  });
});
