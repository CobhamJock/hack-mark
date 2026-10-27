import { describe, expect, it } from 'vitest';
import { buildInsertSQL, buildUpdateSQL, toCamelCase, toSnakeCase } from './sql';
import { ValidationError } from './errors';

describe('case conversion', () => {
  it('converts camelCase to snake_case and back', () => {
    expect(toSnakeCase('supplierId')).toBe('supplier_id');
    expect(toSnakeCase('name')).toBe('name');
    expect(toCamelCase('order_detail_id')).toBe('orderDetailId');
  });
});

describe('buildInsertSQL', () => {
  it('builds a parameterized insert with snake_case columns', () => {
    const { sql, values } = buildInsertSQL('products', { supplierId: 1, name: 'Toy' });

    expect(sql).toBe('INSERT INTO products (supplier_id, name) VALUES (?, ?)');
    expect(values).toEqual([1, 'Toy']);
  });

  it('binds booleans as 1 and 0 because SQLite cannot bind booleans', () => {
    const { values } = buildInsertSQL('suppliers', { active: true, verified: false });

    expect(values).toEqual([1, 0]);
  });

  it('keeps null values', () => {
    expect(buildInsertSQL('suppliers', { description: null }).values).toEqual([null]);
  });

  it('never places values in the SQL text', () => {
    const { sql } = buildInsertSQL('suppliers', { name: "x'); DROP TABLE suppliers;--" });

    expect(sql).not.toContain('DROP');
  });

  it.each([
    'name) VALUES (1); DROP TABLE suppliers; --',
    'name"',
    'na me',
    'name;',
    'Name',
    '1name',
    '',
    'a-b',
  ])('rejects the unsafe field name %j', (key) => {
    expect(() => buildInsertSQL('suppliers', { [key]: 'v' })).toThrow(ValidationError);
  });

  it('rejects object and array values', () => {
    expect(() => buildInsertSQL('suppliers', { name: { nested: 1 } })).toThrow(ValidationError);
    expect(() => buildInsertSQL('suppliers', { name: ['a'] })).toThrow(ValidationError);
  });

  it('rejects an empty payload', () => {
    expect(() => buildInsertSQL('suppliers', {})).toThrow(ValidationError);
  });
});

describe('buildUpdateSQL', () => {
  it('builds a parameterized update', () => {
    const { sql, values } = buildUpdateSQL('products', { price: 5, imgName: 'a.png' }, 'product_id = ?');

    expect(sql).toBe('UPDATE products SET price = ?, img_name = ? WHERE product_id = ?');
    expect(values).toEqual([5, 'a.png']);
  });

  it('rejects an injected SET clause in a field name', () => {
    expect(() => buildUpdateSQL('products', { "price = 0, name": 'x' }, 'product_id = ?')).toThrow(ValidationError);
  });

  it('rejects an empty update', () => {
    expect(() => buildUpdateSQL('products', {}, 'product_id = ?')).toThrow(ValidationError);
  });

  it('binds booleans as 1 and 0', () => {
    expect(buildUpdateSQL('suppliers', { active: false }, 'supplier_id = ?').values).toEqual([0]);
  });
});
