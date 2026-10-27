import { DatabaseConnection, getDatabase } from '../db/sqlite';
import { NotFoundError, ValidationError } from '../utils/errors';

export function positiveId(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return Number(value);
}

export class InventoryRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async requireBranch(branchId: number): Promise<void> {
    if (!await this.db.get('SELECT branch_id FROM branches WHERE branch_id = ?', [branchId])) {
      throw new NotFoundError('Branch', branchId);
    }
  }

  async setQuantity(branchId: number, productId: number, quantityOnHand: unknown) {
    if (typeof quantityOnHand !== 'number' || !Number.isInteger(quantityOnHand) ||
        quantityOnHand < 0 || quantityOnHand > 2147483647) {
      throw new ValidationError('quantityOnHand must be a non-negative integer up to 2147483647');
    }
    await this.requireBranch(branchId);
    if (!await this.db.get('SELECT product_id FROM products WHERE product_id = ?', [productId])) {
      throw new NotFoundError('Product', productId);
    }
    await this.db.run(`INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (?, ?, ?)
      ON CONFLICT(branch_id, product_id) DO UPDATE SET quantity_on_hand = excluded.quantity_on_hand`,
    [branchId, productId, quantityOnHand]);
    return { branchId, productId, quantityOnHand };
  }
}

export async function getInventoryRepository(): Promise<InventoryRepository> {
  return new InventoryRepository(await getDatabase());
}
