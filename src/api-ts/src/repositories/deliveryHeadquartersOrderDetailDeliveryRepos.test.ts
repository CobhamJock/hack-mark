import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeliveriesRepository } from './deliveriesRepo';
import { HeadquartersRepository } from './headquartersRepo';
import { OrderDetailDeliveriesRepository } from './orderDetailDeliveriesRepo';
import { runMigrations } from '../db/migrate';
import { closeDatabase, getDatabase, DatabaseConnection } from '../db/sqlite';
import { NotFoundError, ValidationError } from '../utils/errors';

let db: DatabaseConnection;

beforeEach(async () => {
  await closeDatabase();
  db = await getDatabase(true);
  await runMigrations(true);
  await db.run('INSERT INTO suppliers (supplier_id, name) VALUES (1, ?), (2, ?)', ['S1', 'S2']);
});

afterEach(async () => {
  await closeDatabase();
});

describe('DeliveriesRepository', () => {
  const base = { supplierId: 1, deliveryDate: '2025-03-10', name: 'D', description: 'desc', status: 'pending' };

  it('creates, finds, updates, checks existence and deletes', async () => {
    const repo = new DeliveriesRepository(db);

    const created = await repo.create(base);
    expect(created).toMatchObject(base);
    expect(await repo.findById(created.deliveryId)).toEqual(created);
    expect(await repo.exists(created.deliveryId)).toBe(true);

    const updated = await repo.update(created.deliveryId, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');

    await repo.delete(created.deliveryId);
    expect(await repo.findById(created.deliveryId)).toBeNull();
    expect(await repo.exists(created.deliveryId)).toBe(false);
  });

  it('returns empty results when there is no data', async () => {
    const repo = new DeliveriesRepository(db);

    expect(await repo.findAll()).toEqual([]);
    expect(await repo.findBySupplierId(1)).toEqual([]);
    expect(await repo.findByStatus('pending')).toEqual([]);
    expect(await repo.findByDateRange('2000-01-01', '2100-01-01')).toEqual([]);
  });

  it('throws NotFoundError when updating, deleting or changing status of a missing delivery', async () => {
    const repo = new DeliveriesRepository(db);

    await expect(repo.update(999, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.delete(999)).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.updateStatus(999, 'shipped')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects creation for an unknown supplier and an empty update', async () => {
    const repo = new DeliveriesRepository(db);
    const created = await repo.create(base);

    await expect(repo.create({ ...base, supplierId: 999 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.update(created.deliveryId, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects unknown and injected field names', async () => {
    const repo = new DeliveriesRepository(db);
    const created = await repo.create(base);

    await expect(
      repo.update(created.deliveryId, { bogus: 'x' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repo.update(created.deliveryId, { 'name = name, status': 'x' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await repo.findById(created.deliveryId))?.status).toBe('pending');
  });

  it('filters by supplier, status and date range, newest first', async () => {
    const repo = new DeliveriesRepository(db);
    const a = await repo.create({ ...base, deliveryDate: '2025-01-01', status: 'pending' });
    const b = await repo.create({ ...base, deliveryDate: '2025-02-01', status: 'shipped' });
    const c = await repo.create({ ...base, supplierId: 2, deliveryDate: '2025-03-01', status: 'shipped' });

    expect((await repo.findBySupplierId(1)).map((d) => d.deliveryId)).toEqual([b.deliveryId, a.deliveryId]);
    expect((await repo.findByStatus('shipped')).map((d) => d.deliveryId)).toEqual([c.deliveryId, b.deliveryId]);
    expect((await repo.findByDateRange('2025-02-01', '2025-03-01')).map((d) => d.deliveryId)).toEqual([
      c.deliveryId,
      b.deliveryId,
    ]);
    expect(await repo.findByDateRange('2026-01-01', '2026-12-31')).toEqual([]);
    expect(await repo.findByStatus("x' OR '1'='1")).toEqual([]);
  });

  it('updates status', async () => {
    const repo = new DeliveriesRepository(db);
    const created = await repo.create(base);

    expect((await repo.updateStatus(created.deliveryId, 'delivered')).status).toBe('delivered');
  });

  it('removes deliveries when their supplier is deleted', async () => {
    const repo = new DeliveriesRepository(db);
    const created = await repo.create(base);

    await db.run('DELETE FROM suppliers WHERE supplier_id = 1');

    expect(await repo.findById(created.deliveryId)).toBeNull();
  });
});

describe('HeadquartersRepository', () => {
  const base = { name: 'Head Office', description: 'd', address: '1 St', contactPerson: 'A', email: 'a@x.com', phone: '1' };

  it('creates, finds, updates, checks existence and deletes', async () => {
    const repo = new HeadquartersRepository(db);

    const created = await repo.create(base);
    expect(created).toMatchObject(base);
    expect(await repo.findById(created.headquartersId)).toEqual(created);
    expect(await repo.exists(created.headquartersId)).toBe(true);
    expect((await repo.update(created.headquartersId, { name: 'New' })).name).toBe('New');

    await repo.delete(created.headquartersId);
    expect(await repo.findById(created.headquartersId)).toBeNull();
    expect(await repo.exists(created.headquartersId)).toBe(false);
  });

  it('throws NotFoundError for missing IDs on update and delete', async () => {
    const repo = new HeadquartersRepository(db);

    await expect(repo.update(999, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.delete(999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a missing name and unknown fields', async () => {
    const repo = new HeadquartersRepository(db);

    await expect(repo.create({ ...base, name: undefined } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.create({ ...base, floorCount: 3 } as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it('lists in ID order and searches names by partial, case-insensitive match', async () => {
    const repo = new HeadquartersRepository(db);
    await repo.create({ ...base, name: 'Zeta Tower' });
    await repo.create({ ...base, name: 'Alpha Tower' });
    await repo.create({ ...base, name: 'Other' });

    expect((await repo.findAll()).map((h) => h.name)).toEqual(['Zeta Tower', 'Alpha Tower', 'Other']);
    expect((await repo.findByName('tower')).map((h) => h.name)).toEqual(['Alpha Tower', 'Zeta Tower']);
    expect(await repo.findByName('nothing')).toEqual([]);
    expect(await repo.findByName("' OR '1'='1")).toEqual([]);
  });
});

describe('OrderDetailDeliveriesRepository', () => {
  beforeEach(async () => {
    await db.run('INSERT INTO headquarters (headquarters_id, name) VALUES (1, ?)', ['HQ']);
    await db.run('INSERT INTO branches (branch_id, headquarters_id, name) VALUES (1, 1, ?)', ['B']);
    await db.run(
      `INSERT INTO products (product_id, supplier_id, name, description, price, sku, unit, img_name, discount)
       VALUES (1, 1, 'P', 'D', 10, 'SKU', 'each', 'p.png', 0)`,
    );
    await db.run('INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (1, 1, 100)');
    await db.run("INSERT INTO orders (order_id, branch_id, order_date, name) VALUES (1, 1, '2025-01-01', 'O')");
    await db.run('INSERT INTO order_details (order_detail_id, order_id, product_id, quantity, unit_price) VALUES (1, 1, 1, 10, 10), (2, 1, 1, 5, 10)');
    await db.run("INSERT INTO deliveries (delivery_id, supplier_id, delivery_date, name) VALUES (1, 1, '2025-01-02', 'D1'), (2, 1, '2025-01-03', 'D2')");
  });

  const base = { orderDetailId: 1, deliveryId: 1, quantity: 3, notes: 'n' };

  it('creates, finds, updates, checks existence and deletes', async () => {
    const repo = new OrderDetailDeliveriesRepository(db);

    const created = await repo.create(base);
    expect(created).toMatchObject(base);
    expect(await repo.findById(created.orderDetailDeliveryId)).toEqual(created);
    expect(await repo.exists(created.orderDetailDeliveryId)).toBe(true);
    expect((await repo.update(created.orderDetailDeliveryId, { quantity: 7 })).quantity).toBe(7);

    await repo.delete(created.orderDetailDeliveryId);
    expect(await repo.findById(created.orderDetailDeliveryId)).toBeNull();
    expect(await repo.exists(created.orderDetailDeliveryId)).toBe(false);
  });

  it('throws NotFoundError for missing IDs on update and delete', async () => {
    const repo = new OrderDetailDeliveriesRepository(db);

    await expect(repo.update(999, { quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.delete(999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects unknown references and a missing quantity', async () => {
    const repo = new OrderDetailDeliveriesRepository(db);

    await expect(repo.create({ ...base, orderDetailId: 999 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.create({ ...base, deliveryId: 999 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.create({ ...base, quantity: undefined } as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it('finds by order detail and by delivery in ID order', async () => {
    const repo = new OrderDetailDeliveriesRepository(db);
    const a = await repo.create({ ...base, orderDetailId: 1, deliveryId: 1 });
    const b = await repo.create({ ...base, orderDetailId: 1, deliveryId: 2 });
    const c = await repo.create({ ...base, orderDetailId: 2, deliveryId: 1 });

    expect((await repo.findByOrderDetailId(1)).map((r) => r.orderDetailDeliveryId)).toEqual([
      a.orderDetailDeliveryId,
      b.orderDetailDeliveryId,
    ]);
    expect((await repo.findByDeliveryId(1)).map((r) => r.orderDetailDeliveryId)).toEqual([
      a.orderDetailDeliveryId,
      c.orderDetailDeliveryId,
    ]);
    expect(await repo.findByOrderDetailId(999)).toEqual([]);
    expect(await repo.findByDeliveryId(999)).toEqual([]);
  });

  it('sums delivered quantity per order detail and returns 0 when none', async () => {
    const repo = new OrderDetailDeliveriesRepository(db);
    await repo.create({ ...base, quantity: 3, deliveryId: 1 });
    await repo.create({ ...base, quantity: 4, deliveryId: 2 });
    await repo.create({ ...base, orderDetailId: 2, quantity: 5 });

    expect(await repo.getTotalQuantityByOrderDetailId(1)).toBe(7);
    expect(await repo.getTotalQuantityByOrderDetailId(2)).toBe(5);
    expect(await repo.getTotalQuantityByOrderDetailId(999)).toBe(0);
  });

  it('removes records when their delivery is deleted', async () => {
    const repo = new OrderDetailDeliveriesRepository(db);
    const created = await repo.create(base);

    await db.run('DELETE FROM deliveries WHERE delivery_id = 1');

    expect(await repo.findById(created.orderDetailDeliveryId)).toBeNull();
  });
});
