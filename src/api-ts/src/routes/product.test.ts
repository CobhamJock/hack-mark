import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import productRouter from './product';
import { runMigrations } from '../db/migrate';
import { closeDatabase, getDatabase } from '../db/sqlite';
import { errorHandler } from '../utils/errors';

let app: express.Express;

const newProduct = {
  supplierId: 1,
  name: 'SmartFeeder One',
  description: 'An automated feeder',
  price: 99.95,
  sku: 'FEEDER-001',
  unit: 'each',
  imgName: 'feeder.png',
  discount: 0,
};

describe('Product API', () => {
  beforeEach(async () => {
    await closeDatabase();
    const db = await getDatabase(true);
    await runMigrations(true);
    await db.run('INSERT INTO suppliers (supplier_id, name) VALUES (1, ?)', ['Supplier']);
    await db.run('INSERT INTO headquarters (headquarters_id, name) VALUES (1, ?)', ['HQ']);
    await db.run('INSERT INTO branches (branch_id, headquarters_id, name) VALUES (1, 1, ?), (2, 1, ?)', ['A', 'B']);

    app = express();
    app.use(express.json());
    app.use('/products', productRouter);
    app.use(errorHandler);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  const create = async (overrides = {}) =>
    (await request(app).post('/products').send({ ...newProduct, ...overrides })).body;

  it('creates a product and returns it with 201', async () => {
    const response = await request(app).post('/products').send(newProduct);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject(newProduct);
    expect(response.body.productId).toBeDefined();
  });

  it('rejects creating a product for an unknown supplier with 400', async () => {
    const response = await request(app).post('/products').send({ ...newProduct, supplierId: 999 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects creating a product missing required fields without a stack trace', async () => {
    const response = await request(app).post('/products').send({ supplierId: 1 });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });

  it('lists an empty catalogue', async () => {
    const response = await request(app).get('/products');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('lists products with stock for the requested branch only', async () => {
    const product = await create();
    await (await getDatabase(true)).run(
      'INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (2, ?, 3)',
      [product.productId],
    );

    const defaultBranch = await request(app).get('/products');
    const branchTwo = await request(app).get('/products?branchId=2');

    expect(defaultBranch.body[0]).toMatchObject({ quantityOnHand: 0, stockStatus: 'out_of_stock' });
    expect(branchTwo.body[0]).toMatchObject({ quantityOnHand: 3, stockStatus: 'low_stock' });
  });

  it.each(['0', '-1', 'abc', '1.5', '99999999999'])('rejects invalid branchId %s with 400', async (branchId) => {
    const response = await request(app).get(`/products?branchId=${branchId}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when listing for a branch that does not exist', async () => {
    const response = await request(app).get('/products?branchId=999');

    expect(response.status).toBe(404);
  });

  it('gets a product by ID', async () => {
    const product = await create();

    const response = await request(app).get(`/products/${product.productId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ productId: product.productId, name: 'SmartFeeder One' });
  });

  it('returns 404 for a missing product and 400 for a malformed ID', async () => {
    expect((await request(app).get('/products/999')).status).toBe(404);
    expect((await request(app).get('/products/abc')).status).toBe(400);
    expect((await request(app).get('/products/0')).status).toBe(400);
    expect((await request(app).get('/products/1?branchId=999')).status).toBe(404);
  });

  it('updates a product and leaves other fields unchanged', async () => {
    const product = await create();

    const response = await request(app).put(`/products/${product.productId}`).send({ price: 79.5 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ productId: product.productId, price: 79.5, name: 'SmartFeeder One' });
  });

  it('returns 404 when updating or deleting a missing product', async () => {
    expect((await request(app).put('/products/999').send({ price: 1 })).status).toBe(404);
    expect((await request(app).delete('/products/999')).status).toBe(404);
  });

  it('deletes a product and then returns 404 for it', async () => {
    const product = await create();

    const deleted = await request(app).delete(`/products/${product.productId}`);
    const fetched = await request(app).get(`/products/${product.productId}`);

    expect(deleted.status).toBe(204);
    expect(fetched.status).toBe(404);
  });

  it.each(['abc', '0', '-1', '1abc', '1.5', '99999999999'])(
    'rejects malformed ID %s on update and delete with 400',
    async (id) => {
      const product = await create();

      const put = await request(app).put(`/products/${id}`).send({ price: 1 });
      const del = await request(app).delete(`/products/${id}`);
      const unchanged = await request(app).get(`/products/${product.productId}`);

      expect(put.status).toBe(400);
      expect(del.status).toBe(400);
      expect(unchanged.body.price).toBe(newProduct.price);
    },
  );

  it('does not act on a partially numeric ID like 1abc', async () => {
    const product = await create();

    await request(app).delete(`/products/${product.productId}abc`);

    expect((await request(app).get(`/products/${product.productId}`)).status).toBe(200);
  });
});
