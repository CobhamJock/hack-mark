import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('child_process', () => ({ execFile: vi.fn(), exec: vi.fn() }));

import { execFile, exec } from 'child_process';
import deliveryRouter from './delivery';
import { runMigrations } from '../db/migrate';
import { closeDatabase, getDatabase } from '../db/sqlite';
import { errorHandler } from '../utils/errors';

const execFileMock = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;
let app: express.Express;

const newDelivery = {
  supplierId: 1,
  deliveryDate: '2025-03-01',
  name: 'March restock',
  description: 'Quarterly delivery',
  status: 'pending',
};

describe('Delivery API', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null, out: string) => void) => {
      cb(null, 'notified');
    });
    await closeDatabase();
    const db = await getDatabase(true);
    await runMigrations(true);
    await db.run('INSERT INTO suppliers (supplier_id, name) VALUES (1, ?)', ['Supplier']);

    app = express();
    app.use(express.json());
    app.use('/deliveries', deliveryRouter);
    app.use(errorHandler);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  const create = async (overrides = {}) =>
    (await request(app).post('/deliveries').send({ ...newDelivery, ...overrides })).body;

  describe('CRUD', () => {
    it('creates a delivery and returns 201', async () => {
      const response = await request(app).post('/deliveries').send(newDelivery);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject(newDelivery);
      expect(response.body.deliveryId).toBeDefined();
    });

    it('rejects a delivery for an unknown supplier with 400', async () => {
      const response = await request(app).post('/deliveries').send({ ...newDelivery, supplierId: 999 });

      expect(response.status).toBe(400);
    });

    it('rejects a delivery missing required fields with 400', async () => {
      const response = await request(app).post('/deliveries').send({ supplierId: 1 });

      expect(response.status).toBe(400);
    });

    it('lists deliveries, empty then populated', async () => {
      expect((await request(app).get('/deliveries')).body).toEqual([]);

      await create();
      await create({ name: 'Second' });
      const response = await request(app).get('/deliveries');

      expect(response.status).toBe(200);
      expect(response.body.map((d: { name: string }) => d.name)).toEqual(['March restock', 'Second']);
    });

    it('gets a delivery by ID and returns 404 when missing or malformed', async () => {
      const delivery = await create();

      const found = await request(app).get(`/deliveries/${delivery.deliveryId}`);

      expect(found.status).toBe(200);
      expect(found.body.name).toBe('March restock');
      expect((await request(app).get('/deliveries/999')).status).toBe(404);
      expect((await request(app).get('/deliveries/abc')).status).toBe(404);
    });

    it('updates a delivery and returns 404 for a missing one', async () => {
      const delivery = await create();

      const updated = await request(app).put(`/deliveries/${delivery.deliveryId}`).send({ name: 'Renamed' });

      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: 'Renamed', status: 'pending' });
      expect((await request(app).put('/deliveries/999').send({ name: 'x' })).status).toBe(404);
    });

    it('deletes a delivery and returns 404 for a missing one', async () => {
      const delivery = await create();

      expect((await request(app).delete(`/deliveries/${delivery.deliveryId}`)).status).toBe(204);
      expect((await request(app).get(`/deliveries/${delivery.deliveryId}`)).status).toBe(404);
      expect((await request(app).delete('/deliveries/999')).status).toBe(404);
    });
  });

  describe('PUT /:id/status', () => {
    it('updates the status without notifying when no partner is given', async () => {
      const delivery = await create();

      const response = await request(app).put(`/deliveries/${delivery.deliveryId}/status`).send({ status: 'shipped' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('shipped');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing delivery', async () => {
      const response = await request(app).put('/deliveries/999/status').send({ status: 'shipped' });

      expect(response.status).toBe(404);
    });

    it('returns 400 when the status is missing', async () => {
      const delivery = await create();

      const response = await request(app).put(`/deliveries/${delivery.deliveryId}/status`).send({});

      expect(response.status).toBe(400);
    });

    it('notifies a valid partner using an argument array and returns the output', async () => {
      const delivery = await create();

      const response = await request(app)
        .put(`/deliveries/${delivery.deliveryId}/status`)
        .send({ status: 'shipped', deliveryPartner: 'Acme Freight-2' });

      expect(response.status).toBe(200);
      expect(response.body.delivery.status).toBe('shipped');
      expect(response.body.commandOutput).toBe('notified');
      expect(execFileMock).toHaveBeenCalledWith('notify', ['Acme Freight-2'], expect.any(Function));
    });

    it('returns 500 when the notify command fails', async () => {
      execFileMock.mockImplementation((_c: string, _a: string[], cb: (e: Error | null, out: string) => void) => {
        cb(new Error('notify missing'), '');
      });
      const delivery = await create();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const response = await request(app)
        .put(`/deliveries/${delivery.deliveryId}/status`)
        .send({ status: 'shipped', deliveryPartner: 'Acme' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('notify missing');
      errorSpy.mockRestore();
    });

    it.each([
      'acme; rm -rf /',
      'acme && whoami',
      'acme | cat /etc/passwd',
      '$(whoami)',
      '`whoami`',
      'acme\nwhoami',
      '-flag',
      'a'.repeat(101),
    ])('rejects shell metacharacters in the partner name (%j) without running a command', async (partner) => {
      const delivery = await create();

      const response = await request(app)
        .put(`/deliveries/${delivery.deliveryId}/status`)
        .send({ status: 'shipped', deliveryPartner: partner });

      expect(response.status).toBe(400);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(vi.mocked(exec)).not.toHaveBeenCalled();
      expect((await request(app).get(`/deliveries/${delivery.deliveryId}`)).body.status).toBe('pending');
    });

    it('rejects a non-string partner such as an array or object', async () => {
      const delivery = await create();

      const asArray = await request(app)
        .put(`/deliveries/${delivery.deliveryId}/status`)
        .send({ status: 'shipped', deliveryPartner: ['a', 'b'] });
      const asObject = await request(app)
        .put(`/deliveries/${delivery.deliveryId}/status`)
        .send({ status: 'shipped', deliveryPartner: { name: 'a' } });

      expect(asArray.status).toBe(400);
      expect(asObject.status).toBe(400);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});
