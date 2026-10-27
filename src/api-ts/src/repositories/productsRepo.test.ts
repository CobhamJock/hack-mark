import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase } from '../db/sqlite';
import { runMigrations } from '../db/migrate';
import { NotFoundError, ValidationError } from '../utils/errors';
import { ProductsRepository } from './productsRepo';

describe('ProductsRepository', () => {
  let repository: ProductsRepository;

  beforeEach(async () => {
    await closeDatabase();
    const db = await getDatabase(true);
    await runMigrations(true);
    await db.run(
      'INSERT INTO suppliers (supplier_id, name) VALUES (?, ?)',
      [1, 'Test Supplier'],
    );
    repository = new ProductsRepository(db);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  const product = (overrides: Partial<{
    supplierId: number;
    name: string;
    description: string;
    price: number;
    sku: string;
    unit: string;
    imgName: string;
    discount: number;
  }> = {}) => ({
    supplierId: 1,
    name: 'SmartFeeder One',
    description: 'An automated feeder',
    price: 99.95,
    sku: 'FEEDER-001',
    unit: 'each',
    imgName: 'feeder.png',
    discount: 0,
    ...overrides,
  });

  it('creates a product and returns its persisted, mapped fields', async () => {
    const created = await repository.create(product());

    expect(created).toMatchObject({
      productId: expect.any(Number),
      ...product(),
    });
    await expect(repository.findById(created.productId)).resolves.toEqual(created);
  });

  it('returns an empty collection and null lookup when no products exist', async () => {
    await expect(repository.findAll()).resolves.toEqual([]);
    await expect(repository.findById(999)).resolves.toBeNull();
  });

  it('returns products in ID order and filters by supplier in name order', async () => {
    const first = await repository.create(product({ name: 'Whisker Brush' }));
    const second = await repository.create(product({ name: 'SmartFeeder One' }));
    await (await getDatabase(true)).run(
      'INSERT INTO suppliers (supplier_id, name) VALUES (?, ?)',
      [2, 'Other Supplier'],
    );
    const otherSupplier = await repository.create(product({ supplierId: 2, name: 'Cat Camera' }));

    const ids = (products: { productId: number }[]) => products.map((p) => p.productId);
    expect(ids(await repository.findAll())).toEqual([first.productId, second.productId, otherSupplier.productId]);
    expect(ids(await repository.findBySupplierId(1))).toEqual([second.productId, first.productId]);
    await expect(repository.findBySupplierId(999)).resolves.toEqual([]);
  });

  it('searches product names by partial match and sorts matches', async () => {
    const later = await repository.create(product({ name: 'SmartFeeder Mini' }));
    const earlier = await repository.create(product({ name: 'SmartFeeder One' }));
    await repository.create(product({ name: 'Cat Camera' }));

    const matches = await repository.findByName('SmartFeeder');
    expect(matches.map((p) => p.productId)).toEqual([later.productId, earlier.productId]);
    await expect(repository.findByName('no match')).resolves.toEqual([]);
  });

  it('reports stock status per branch with zero stock for unrecorded products', async () => {
    const db = await getDatabase(true);
    await db.run('INSERT INTO headquarters (headquarters_id, name) VALUES (1, ?)', ['HQ']);
    await db.run('INSERT INTO branches (branch_id, headquarters_id, name) VALUES (1, 1, ?), (2, 1, ?)', ['A', 'B']);
    const none = await repository.create(product({ name: 'None', sku: 'N' }));
    const low = await repository.create(product({ name: 'Low', sku: 'L' }));
    const boundary = await repository.create(product({ name: 'Boundary', sku: 'B' }));
    const plenty = await repository.create(product({ name: 'Plenty', sku: 'P' }));
    await db.run(
      'INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (1, ?, 0), (1, ?, 1), (1, ?, 5), (1, ?, 6), (2, ?, 50)',
      [none.productId, low.productId, boundary.productId, plenty.productId, none.productId],
    );

    const branchOne = await repository.findAll(1);
    expect(branchOne.map((p) => [p.quantityOnHand, p.stockStatus])).toEqual([
      [0, 'out_of_stock'],
      [1, 'low_stock'],
      [5, 'low_stock'],
      [6, 'in_stock'],
    ]);
    await expect(repository.findById(none.productId, 2)).resolves.toMatchObject({
      quantityOnHand: 50,
      stockStatus: 'in_stock',
    });
    await expect(repository.findById(low.productId, 2)).resolves.toMatchObject({
      quantityOnHand: 0,
      stockStatus: 'out_of_stock',
    });
    await expect(repository.findById(low.productId, 999)).resolves.toMatchObject({ quantityOnHand: 0 });
  });

  it('rejects a product for an unknown supplier with a validation error', async () => {
    await expect(repository.create(product({ supplierId: 999 }))).rejects.toBeInstanceOf(ValidationError);
  });

  it('treats SQL-like search text as a value instead of executable SQL', async () => {
    await repository.create(product({ name: 'SmartFeeder One' }));
    await repository.create(product({ name: 'Cat Camera' }));

    await expect(repository.findByName("' OR 1=1 --")).resolves.toEqual([]);
  });

  it('updates an existing product and reports missing products', async () => {
    const created = await repository.create(product());

    await expect(repository.update(created.productId, { price: 79.5 })).resolves.toMatchObject({
      ...created,
      price: 79.5,
    });
    await expect(repository.update(999, { name: 'Missing' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes an existing product, updates existence checks, and reports missing products', async () => {
    const created = await repository.create(product());

    await expect(repository.exists(created.productId)).resolves.toBe(true);
    await expect(repository.delete(created.productId)).resolves.toBeUndefined();
    await expect(repository.exists(created.productId)).resolves.toBe(false);
    await expect(repository.delete(999)).rejects.toBeInstanceOf(NotFoundError);
  });
});
