import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import supplierRouter from './supplier';
import { runMigrations } from '../db/migrate';
import { closeDatabase, getDatabase } from '../db/sqlite';
import { errorHandler } from '../utils/errors';

let app: express.Express;

const newSupplier = {
  name: 'Acme Pet Supplies',
  description: 'Feeders and toys',
  contactPerson: 'Bob',
  email: 'bob@example.com',
  phone: '555-0199',
  active: true,
  verified: false,
};

describe('Supplier API', () => {
  beforeEach(async () => {
    await closeDatabase();
    await getDatabase(true);
    await runMigrations(true);

    app = express();
    app.use(express.json());
    app.use('/suppliers', supplierRouter);
    app.use(errorHandler);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  const create = async (overrides = {}) =>
    (await request(app).post('/suppliers').send({ ...newSupplier, ...overrides })).body;

  it('creates a supplier and returns 201', async () => {
    const response = await request(app).post('/suppliers').send(newSupplier);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject(newSupplier);
    expect(response.body.supplierId).toBeDefined();
  });

  it('rejects a supplier without a name with 400', async () => {
    const response = await request(app).post('/suppliers').send({ description: 'no name' });

    expect(response.status).toBe(400);
  });

  it('lists suppliers, empty then populated', async () => {
    expect((await request(app).get('/suppliers')).body).toEqual([]);

    await create();
    await create({ name: 'Second' });

    const response = await request(app).get('/suppliers');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
  });

  it('gets by ID and returns 404 for missing or malformed IDs', async () => {
    const supplier = await create();

    expect((await request(app).get(`/suppliers/${supplier.supplierId}`)).body.name).toBe('Acme Pet Supplies');
    expect((await request(app).get('/suppliers/999')).status).toBe(404);
    expect((await request(app).get('/suppliers/abc')).status).toBe(404);
  });

  it('updates a supplier and returns 404 for a missing one', async () => {
    const supplier = await create();

    const updated = await request(app).put(`/suppliers/${supplier.supplierId}`).send({ name: 'Renamed' });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Renamed', email: newSupplier.email });
    expect((await request(app).put('/suppliers/999').send({ name: 'x' })).status).toBe(404);
  });

  it('deletes a supplier and returns 404 for a missing one', async () => {
    const supplier = await create();

    expect((await request(app).delete(`/suppliers/${supplier.supplierId}`)).status).toBe(204);
    expect((await request(app).get(`/suppliers/${supplier.supplierId}`)).status).toBe(404);
    expect((await request(app).delete('/suppliers/999')).status).toBe(404);
  });

  describe('GET /:id/status', () => {
    it('reports APPROVED for an active supplier', async () => {
      const supplier = await create({ active: true });

      const response = await request(app).get(`/suppliers/${supplier.supplierId}/status`);

      expect(response.body).toEqual({ status: 'APPROVED' });
    });

    it.each([true, false])('reports PENDING for an inactive supplier (verified=%s)', async (verified) => {
      const supplier = await create({ active: false, verified });

      const response = await request(app).get(`/suppliers/${supplier.supplierId}/status`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'PENDING' });
    });

    it('returns 404 for a missing supplier', async () => {
      expect((await request(app).get('/suppliers/999/status')).status).toBe(404);
    });
  });
});
