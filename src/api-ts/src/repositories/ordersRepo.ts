/**
 * Repository for orders data access
 */

import { getDatabase, DatabaseConnection } from '../db/sqlite';
import { Order } from '../models/order';
import { handleDatabaseError, NotFoundError, ValidationError } from '../utils/errors';
import { OrderDetail } from '../models/orderDetail';
import { buildInsertSQL, buildUpdateSQL, objectToCamelCase, mapDatabaseRows, DatabaseRow } from '../utils/sql';

export class OrdersRepository {
  private db: DatabaseConnection;

  constructor(db: DatabaseConnection) {
    this.db = db;
  }

  /**
   * Get all orders
   */
  async findAll(): Promise<Order[]> {
    try {
      const rows = await this.db.all<DatabaseRow>('SELECT * FROM orders ORDER BY order_id');
      return mapDatabaseRows<Order>(rows);
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  /**
   * Get order by ID
   */
  async findById(id: number): Promise<Order | null> {
    try {
      const row = await this.db.get<DatabaseRow>('SELECT * FROM orders WHERE order_id = ?', [id]);
      return row ? objectToCamelCase<Order>(row) : null;
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  /**
   * Create a new order
   */
  async create(order: Omit<Order, 'orderId'>): Promise<Order> {
    try {
      const { sql, values } = buildInsertSQL('orders', order);
      const result = await this.db.run(sql, values);

      const createdOrder = await this.findById(result.lastID || 0);
      if (!createdOrder) {
        throw new Error('Failed to retrieve created order');
      }

      return createdOrder;
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  createWithItems(input: unknown): Order & { items: OrderDetail[] } {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    if (!isRecord(input) || !Number.isInteger(input.branchId) ||
        typeof input.branchId !== 'number' || input.branchId <= 0 || input.branchId > 2147483647 ||
        typeof input.name !== 'string' || !input.name.trim() ||
        typeof input.orderDate !== 'string' || !Number.isFinite(Date.parse(input.orderDate)) ||
        !Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) {
      throw new ValidationError('Provide branchId, name, orderDate and 1 to 100 order items');
    }
    const branchId = input.branchId;
    const name = input.name;
    const orderDate = input.orderDate;
    if (input.description !== undefined && typeof input.description !== 'string') {
      throw new ValidationError('description must be a string');
    }
    if (input.status !== undefined && typeof input.status !== 'string') {
      throw new ValidationError('status must be a string');
    }
    const description = input.description ?? '';
    const status = input.status ?? 'pending';
    const items = input.items.map((item: unknown) => {
      if (!isRecord(item) || typeof item.productId !== 'number' ||
          !Number.isInteger(item.productId) || item.productId <= 0 || item.productId > 2147483647 ||
          typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) ||
          item.quantity <= 0 || item.quantity > 2147483647) {
        throw new ValidationError('Each item needs a positive integer productId and quantity');
      }
      return { productId: item.productId, quantity: item.quantity };
    });
    try {
      return this.db.db.transaction(() => {
        if (!this.db.db.prepare('SELECT branch_id FROM branches WHERE branch_id = ?').get(branchId)) {
          throw new NotFoundError('Branch', branchId);
        }
        const result = this.db.db.prepare(
          'INSERT INTO orders (branch_id, order_date, name, description, status) VALUES (?, ?, ?, ?, ?)',
        ).run(branchId, orderDate, name, description, status);
        const orderId = Number(result.lastInsertRowid);
        const details = items.map((item) => {
          const product = this.db.db.prepare<[number], { price: number; discount: number | null }>(
            'SELECT price, discount FROM products WHERE product_id = ?',
          ).get(item.productId);
          if (!product) throw new NotFoundError('Product', item.productId);
          const unitPrice = Math.round(product.price * (1 - (product.discount ?? 0)) * 100) / 100;
          const detail = this.db.db.prepare(
            'INSERT INTO order_details (order_id, product_id, quantity, unit_price, notes) VALUES (?, ?, ?, ?, ?)',
          ).run(orderId, item.productId, item.quantity, unitPrice, '');
          return {
            orderDetailId: Number(detail.lastInsertRowid), orderId,
            productId: item.productId, quantity: item.quantity, unitPrice, notes: '',
          };
        });
        return { orderId, branchId, orderDate, name, description, status, items: details };
      }).immediate();
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  /**
   * Update order by ID
   */
  async update(id: number, order: Partial<Omit<Order, 'orderId'>>): Promise<Order> {
    try {
      const { sql, values } = buildUpdateSQL('orders', order, 'order_id = ?');
      const result = await this.db.run(sql, [...values, id]);

      if (result.changes === 0) {
        throw new NotFoundError('Order', id);
      }

      const updatedOrder = await this.findById(id);
      if (!updatedOrder) {
        throw new Error('Failed to retrieve updated order');
      }

      return updatedOrder;
    } catch (error) {
      handleDatabaseError(error, 'Order', id);
    }
  }

  /**
   * Delete order by ID
   */
  async delete(id: number): Promise<void> {
    try {
      const result = await this.db.run('DELETE FROM orders WHERE order_id = ?', [id]);

      if (result.changes === 0) {
        throw new NotFoundError('Order', id);
      }
    } catch (error) {
      handleDatabaseError(error, 'Order', id);
    }
  }

  /**
   * Check if order exists
   */
  async exists(id: number): Promise<boolean> {
    try {
      const result = await this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM orders WHERE order_id = ?',
        [id],
      );
      return (result?.count || 0) > 0;
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  /**
   * Find orders by branch ID
   */
  async findByBranchId(branchId: number): Promise<Order[]> {
    try {
      const rows = await this.db.all<DatabaseRow>(
        'SELECT * FROM orders WHERE branch_id = ? ORDER BY order_date DESC',
        [branchId],
      );
      return mapDatabaseRows<Order>(rows);
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  /**
   * Find orders by status
   */
  async findByStatus(status: string): Promise<Order[]> {
    try {
      const rows = await this.db.all<DatabaseRow>(
        'SELECT * FROM orders WHERE status = ? ORDER BY order_date DESC',
        [status],
      );
      return mapDatabaseRows<Order>(rows);
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  /**
   * Find orders by date range
   */
  async findByDateRange(startDate: string, endDate: string): Promise<Order[]> {
    try {
      const rows = await this.db.all<DatabaseRow>(
        'SELECT * FROM orders WHERE order_date >= ? AND order_date <= ? ORDER BY order_date DESC',
        [startDate, endDate],
      );
      return mapDatabaseRows<Order>(rows);
    } catch (error) {
      handleDatabaseError(error);
    }
  }
}

// Factory function to create repository instance
export async function createOrdersRepository(isTest: boolean = false): Promise<OrdersRepository> {
  const db = await getDatabase(isTest);
  return new OrdersRepository(db);
}

// Singleton instance for default usage
let ordersRepo: OrdersRepository | null = null;

export async function getOrdersRepository(isTest: boolean = false): Promise<OrdersRepository> {
  const isTestEnv = isTest || process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  if (isTestEnv) {
    return createOrdersRepository(true);
  }
  if (!ordersRepo) {
    ordersRepo = await createOrdersRepository(false);
  }
  return ordersRepo;
}
