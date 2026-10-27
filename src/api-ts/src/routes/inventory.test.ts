import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import productRoutes from './product';
import inventoryRoutes from './inventory';
import orderRoutes from './order';
import detailRoutes from './orderDetail';
import { closeDatabase, getDatabase, DatabaseConnection } from '../db/sqlite';
import { runMigrations, MigrationRunner } from '../db/migrate';
import { seedDatabase } from '../db/seed';
import { errorHandler } from '../utils/errors';

const app = express();
app.use(express.json());
app.use('/api/products', productRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/order-details', detailRoutes);
app.use(errorHandler);

beforeEach(async () => {
  await closeDatabase();
  await getDatabase(true);
  await runMigrations(true);
  await seedDatabase(false, true);
  vi.stubEnv('INVENTORY_ADMIN_TOKEN', 'inventory-test-token');
});

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
});

const order = (items: { productId: number; quantity: number }[]) => ({
  branchId: 1, name: 'Stock order', orderDate: '2026-10-27T12:00:00Z', items,
});
const setStock = (quantityOnHand: unknown, branchId = 1, productId = 1) =>
  request(app).put(`/api/inventory/${branchId}/${productId}`)
    .set('Authorization', 'Bearer inventory-test-token').send({ quantityOnHand });

describe('Branch inventory', () => {
  it('exposes deterministic availability and branch isolation', async () => {
    const response = await request(app).get('/api/products?branchId=1');
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({ quantityOnHand: 3, stockStatus: 'low_stock' });
    expect(response.body[1]).toMatchObject({ quantityOnHand: 0, stockStatus: 'out_of_stock' });
    expect(response.body[2]).toMatchObject({ quantityOnHand: 20, stockStatus: 'in_stock' });
    expect((await setStock(8)).body).toEqual({ branchId: 1, productId: 1, quantityOnHand: 8 });
    expect((await request(app).get('/api/products/1?branchId=2')).body.quantityOnHand).toBe(3);
    expect((await request(app).get('/api/products/1')).body.stockStatus).toBe('in_stock');
  });

  it('treats missing records as zero and upserts after valid references', async () => {
    await (await getDatabase()).run('DELETE FROM inventory WHERE branch_id = 1 AND product_id = 1');
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(0);
    expect((await setStock(7)).status).toBe(200);
    expect((await setStock(1, 999)).status).toBe(404);
    expect((await setStock(1, 1, 999)).status).toBe(404);
    expect((await request(app).get('/api/products?branchId=999')).status).toBe(404);
    expect((await request(app).get('/api/products?branchId=1.5')).status).toBe(400);
  });

  it('protects administration and rejects invalid quantities without changes', async () => {
    expect((await request(app).put('/api/inventory/1/1').send({ quantityOnHand: 10 })).status).toBe(403);
    expect((await request(app).put('/api/inventory/1/1')
      .set('Authorization', 'Bearer wrong').send({ quantityOnHand: 10 })).status).toBe(403);
    for (const invalid of [-1, 0.5, '2', null, true, 2147483648]) {
      expect((await setStock(invalid)).status).toBe(400);
    }
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(3);
    vi.stubEnv('INVENTORY_ADMIN_TOKEN', '');
    expect((await setStock(1)).status).toBe(503);
  });

  it('creates an order and details and decrements stock atomically using server prices', async () => {
    const response = await request(app).post('/api/orders').send(order([{ productId: 1, quantity: 2 }]));
    expect(response.status).toBe(201);
    expect(response.body.items[0]).toMatchObject({ productId: 1, quantity: 2, unitPrice: 97.49 });
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(1);
    expect((await request(app).get('/api/products/1?branchId=2')).body.quantityOnHand).toBe(3);
  });

  it('rolls back earlier lines and the order if a later line has insufficient stock', async () => {
    const response = await request(app).post('/api/orders')
      .send(order([{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }]));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect((await request(app).get('/api/orders')).body).toEqual([]);
    expect((await request(app).get('/api/order-details')).body).toEqual([]);
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(3);
  });

  it('rolls back when a referenced product is missing or a write fails', async () => {
    const missing = await request(app).post('/api/orders')
      .send(order([{ productId: 1, quantity: 2 }, { productId: 999, quantity: 1 }]));
    expect(missing.status).toBe(404);
    const db = await getDatabase();
    db.db.exec(`CREATE TRIGGER fail_second_line BEFORE INSERT ON order_details
      WHEN NEW.product_id = 3 BEGIN SELECT RAISE(ABORT, 'Simulated write failure'); END;`);
    const failed = await request(app).post('/api/orders')
      .send(order([{ productId: 1, quantity: 2 }, { productId: 3, quantity: 1 }]));
    expect(failed.status).toBe(500);
    expect((await request(app).get('/api/orders')).body).toEqual([]);
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(3);
  });

  it('serializes competing orders without overselling', async () => {
    const responses = await Promise.all([1, 2].map(() => request(app).post('/api/orders')
      .send(order([{ productId: 1, quantity: 2 }]))));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(1);
  });

  it('enforces legacy detail writes and restores stock on detail and order deletion', async () => {
    const response = await request(app).post('/api/orders').send(order([{ productId: 1, quantity: 2 }]));
    const detail = response.body.items[0];
    expect((await request(app).post('/api/order-details')
      .send({ orderId: response.body.orderId, productId: 1, quantity: 2, unitPrice: 1 })).status).toBe(409);
    expect((await request(app).put(`/api/order-details/${detail.orderDetailId}`)
      .send({ quantity: 4 })).status).toBe(409);
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(1);
    expect((await request(app).put(`/api/orders/${response.body.orderId}`)
      .send({ branchId: 2 })).status).toBe(400);
    expect((await request(app).delete(`/api/order-details/${detail.orderDetailId}`)).status).toBe(204);
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(3);
    const second = await request(app).post('/api/orders').send(order([{ productId: 1, quantity: 3 }]));
    expect((await request(app).delete(`/api/orders/${second.body.orderId}`)).status).toBe(204);
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(3);
  });

  it('rejects invalid order item quantities and empty items without writes', async () => {
    for (const quantity of [0, -1, 0.5, '2', true, null]) {
      const response = await request(app).post('/api/orders')
        .send({ ...order([]), items: [{ productId: 1, quantity }] });
      expect(response.status).toBe(400);
    }
    expect((await request(app).post('/api/orders').send(order([]))).status).toBe(400);
    expect((await request(app).get('/api/orders')).body).toEqual([]);
  });

  it('validates legacy quantities and handles updates that move an allocation between branches', async () => {
    const header = await request(app).post('/api/orders').send({
      branchId: 1, name: 'Legacy header', orderDate: '2026-10-27', description: '', status: 'pending',
    });
    expect(header.status).toBe(201);
    for (const quantity of [0, -1, 0.5, '2', true, null]) {
      expect((await request(app).post('/api/order-details').send({
        orderId: header.body.orderId, productId: 1, quantity, unitPrice: 1,
      })).status).toBe(400);
    }
    const placed = await request(app).post('/api/orders').send(order([{ productId: 1, quantity: 2 }]));
    const otherBranch = await request(app).post('/api/orders').send({
      branchId: 2, name: 'Other branch', orderDate: '2026-10-27', description: '', status: 'pending',
    });
    expect((await request(app).put(`/api/order-details/${placed.body.items[0].orderDetailId}`)
      .send({ orderId: otherBranch.body.orderId, quantity: 3 })).status).toBe(200);
    expect((await request(app).get('/api/products/1')).body.quantityOnHand).toBe(3);
    expect((await request(app).get('/api/products/1?branchId=2')).body.quantityOnHand).toBe(0);
  });

  it('upgrades an existing database without inventing stock and can rerun migrations', async () => {
    const db = await getDatabase();
    expect(() => db.db.prepare('UPDATE inventory SET quantity_on_hand = -1').run()).toThrow();
    const old = new Database(':memory:');
    try {
      const migrationDir = path.resolve(__dirname, '../../../database/migrations');
      old.exec(readFileSync(path.join(migrationDir, '001_init.sql'), 'utf8'));
      old.exec(readFileSync(path.join(migrationDir, '002_add_supplier_status_fields.sql'), 'utf8'));
      old.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY, filename TEXT);
        INSERT INTO migrations VALUES(1, '001_init.sql'),(2, '002_add_supplier_status_fields.sql');`);
      old.pragma('foreign_keys = ON');
      old.exec(`INSERT INTO suppliers(supplier_id,name) VALUES(1,'Supplier');
        INSERT INTO headquarters(headquarters_id,name) VALUES(1,'HQ');
        INSERT INTO branches(branch_id,headquarters_id,name) VALUES(1,1,'Branch');
        INSERT INTO products(product_id,supplier_id,name,price,sku,unit) VALUES(1,1,'Item',1,'SKU','piece');
        INSERT INTO orders(order_id,branch_id,order_date,name) VALUES(1,1,'2026-10-27','Old order'),
          (2,1,'2026-10-27','Another old order');
        INSERT INTO order_details(order_detail_id,order_id,product_id,quantity,unit_price)
          VALUES(1,1,1,2,1),(2,2,1,2,1);`);
      const runner = new MigrationRunner(new DatabaseConnection(old), migrationDir);
      await runner.runMigrations();
      await runner.runMigrations();
      expect(await runner.getCurrentVersion()).toBe(3);
      expect(old.prepare('SELECT COUNT(*) AS count FROM inventory').get()).toEqual({ count: 0 });
      old.exec('INSERT INTO inventory VALUES(1,1,5); DELETE FROM orders WHERE order_id = 1;');
      expect(old.prepare('SELECT quantity_on_hand FROM inventory').get()).toEqual({ quantity_on_hand: 5 });
      old.exec('UPDATE order_details SET quantity = 1 WHERE order_detail_id = 2;');
      expect(old.prepare('SELECT quantity_on_hand FROM inventory').get()).toEqual({ quantity_on_hand: 4 });
      old.exec('DELETE FROM orders WHERE order_id = 2;');
      expect(old.prepare('SELECT quantity_on_hand FROM inventory').get()).toEqual({ quantity_on_hand: 5 });
    } finally {
      old.close();
    }
  });

  it('enforces availability across separate SQLite connections', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'octocat-stock-'));
    const dbFile = path.join(directory, 'stock.db');
    const first = new Database(dbFile);
    const second = new Database(dbFile);
    try {
      const migrations = path.resolve(__dirname, '../../../database/migrations');
      first.pragma('foreign_keys = ON');
      first.exec(readFileSync(path.join(migrations, '001_init.sql'), 'utf8'));
      first.exec(readFileSync(path.join(migrations, '003_branch_inventory.sql'), 'utf8'));
      first.exec(`INSERT INTO suppliers(supplier_id,name) VALUES(1,'Supplier');
        INSERT INTO headquarters(headquarters_id,name) VALUES(1,'HQ');
        INSERT INTO branches(branch_id,headquarters_id,name) VALUES(1,1,'Branch');
        INSERT INTO products(product_id,supplier_id,name,price,sku,unit) VALUES(1,1,'Item',1,'SKU','piece');
        INSERT INTO inventory VALUES(1,1,1);
        INSERT INTO orders(order_id,branch_id,order_date,name) VALUES(1,1,'2026-10-27','Order');`);
      first.prepare('INSERT INTO order_details(order_id,product_id,quantity,unit_price) VALUES(1,1,1,1)').run();
      expect(() => second.prepare(
        'INSERT INTO order_details(order_id,product_id,quantity,unit_price) VALUES(1,1,1,1)',
      ).run()).toThrow('Insufficient stock');
    } finally {
      second.close();
      first.close();
      rmSync(directory, { recursive: true });
    }
  });
});
