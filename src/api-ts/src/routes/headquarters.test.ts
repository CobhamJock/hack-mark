import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import headquartersRouter from './headquarters';
import { runMigrations } from '../db/migrate';
import { closeDatabase, getDatabase } from '../db/sqlite';
import { errorHandler } from '../utils/errors';

let app: express.Express;

const newHq = {
  name: 'Head Office',
  description: 'Main site',
  address: '1 Cat Street',
  contactPerson: 'Ada',
  email: 'ada@example.com',
  phone: '555-0100',
};

describe('Headquarters API', () => {
  beforeEach(async () => {
    await closeDatabase();
    await getDatabase(true);
    await runMigrations(true);

    app = express();
    app.use(express.json());
    app.use('/headquarters', headquartersRouter);
    app.use(errorHandler);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  const create = async (overrides = {}) =>
    (await request(app).post('/headquarters').send({ ...newHq, ...overrides })).body;

  describe('create', () => {
    it('creates headquarters and returns 201', async () => {
      const response = await request(app).post('/headquarters').send(newHq);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject(newHq);
      expect(response.body.headquartersId).toBeDefined();
    });

    it.each([
      ['missing name', { name: undefined }],
      ['blank name', { name: '   ' }],
      ['non-string name', { name: 42 }],
      ['missing address', { address: undefined }],
      ['blank address', { address: '' }],
    ])('rejects %s with 400', async (_label, overrides) => {
      const response = await request(app)
        .post('/headquarters')
        .send({ ...newHq, ...overrides });

      expect(response.status).toBe(400);
      expect((await request(app).get('/headquarters')).body).toEqual([]);
    });

    it('rejects an empty body with 400', async () => {
      expect((await request(app).post('/headquarters').send({})).status).toBe(400);
    });
  });

  describe('read', () => {
    it('lists headquarters, empty then populated', async () => {
      expect((await request(app).get('/headquarters')).body).toEqual([]);

      await create();
      await create({ name: 'Second' });

      const response = await request(app).get('/headquarters');
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
    });

    it('gets by ID and returns 404 for missing or malformed IDs', async () => {
      const hq = await create();

      expect((await request(app).get(`/headquarters/${hq.headquartersId}`)).body.name).toBe('Head Office');
      expect((await request(app).get('/headquarters/999')).status).toBe(404);
      expect((await request(app).get('/headquarters/abc')).status).toBe(404);
    });
  });

  describe('update', () => {
    it('updates headquarters when name and address are valid', async () => {
      const hq = await create();

      const response = await request(app)
        .put(`/headquarters/${hq.headquartersId}`)
        .send({ name: 'Renamed', address: '2 Dog Road' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name: 'Renamed', address: '2 Dog Road', email: newHq.email });
    });

    it('rejects invalid data with 400 rather than crashing', async () => {
      const hq = await create();

      const response = await request(app).put(`/headquarters/${hq.headquartersId}`).send({ name: 'Only name' });

      expect(response.status).toBe(400);
      expect((await request(app).get(`/headquarters/${hq.headquartersId}`)).body.name).toBe('Head Office');
    });

    it('returns 404 when updating a missing headquarters', async () => {
      const response = await request(app).put('/headquarters/999').send({ name: 'x', address: 'y' });

      expect(response.status).toBe(404);
    });
  });

  describe('delete', () => {
    it('deletes and then returns 404', async () => {
      const hq = await create();

      expect((await request(app).delete(`/headquarters/${hq.headquartersId}`)).status).toBe(204);
      expect((await request(app).get(`/headquarters/${hq.headquartersId}`)).status).toBe(404);
    });

    it('returns 404 for a missing headquarters', async () => {
      expect((await request(app).delete('/headquarters/999')).status).toBe(404);
    });

    it('cascades the delete to its branches', async () => {
      const hq = await create();
      const db = await getDatabase();
      await db.run('INSERT INTO branches (branch_id, headquarters_id, name) VALUES (1, ?, ?)', [hq.headquartersId, 'B']);

      await request(app).delete(`/headquarters/${hq.headquartersId}`);

      const remaining = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM branches');
      expect(remaining?.count).toBe(0);
    });
  });

  describe('derived endpoints', () => {
    it('returns metrics for existing headquarters', async () => {
      const hq = await create();

      const response = await request(app).get(`/headquarters/${hq.headquartersId}/metrics`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        score: hq.headquartersId,
        average: hq.headquartersId / 2,
        display: `HQ-${hq.headquartersId}0`,
      });
    });

    it('returns a location label', async () => {
      const hq = await create();

      const response = await request(app).get(`/headquarters/${hq.headquartersId}/label`);

      expect(response.status).toBe(200);
      expect(response.body.label).toContain('Head Office');
    });

    it('returns 404 from metrics and label for a missing headquarters', async () => {
      expect((await request(app).get('/headquarters/999/metrics')).status).toBe(404);
      expect((await request(app).get('/headquarters/999/label')).status).toBe(404);
    });
  });
});
