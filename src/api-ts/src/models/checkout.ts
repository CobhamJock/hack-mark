import { ValidationError } from '../utils/errors';

/**
 * @swagger
 * components:
 *   schemas:
 *     CheckoutResult:
 *       type: object
 *       required: [checkoutId, status, checkoutUrl, amountTotal, currency, orderId]
 *       properties:
 *         checkoutId: {type: string, format: uuid}
 *         status:
 *           type: string
 *           enum: [creating, pending, completed, refund_pending, refunded, cancelled]
 *         checkoutUrl: {type: string, nullable: true, description: Stripe-hosted URL only while pending}
 *         amountTotal: {type: integer, minimum: 50, maximum: 99999999, description: Total in USD cents}
 *         currency: {type: string, enum: [usd]}
 *         orderId: {type: integer, nullable: true}
 */
export interface CheckoutItem { productId: number; quantity: number }
export interface CheckoutRequest { checkoutId: string; branchId: number; items: CheckoutItem[] }
export interface CheckoutSnapshot extends CheckoutItem { unitPriceCents: number; name: string }
export type CheckoutStatus = 'creating' | 'pending' | 'completed' | 'refund_pending' | 'refunded' | 'cancelled';
export interface CheckoutRow {
  checkout_id: string;
  branch_id: number;
  request_json: string;
  items_json: string;
  amount_total: number;
  currency: 'usd';
  status: CheckoutStatus;
  provider_session_id: string | null;
  checkout_url: string | null;
  payment_intent_id: string | null;
  order_id: number | null;
  created_at: string;
}

export function checkoutId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new ValidationError('checkoutId must be a lowercase version 4 UUID');
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

export function parseCheckout(value: unknown): CheckoutRequest {
  if (!record(value) || !positiveInteger(value.branchId) || !Array.isArray(value.items) ||
      value.items.length === 0 || value.items.length > 100) {
    throw new ValidationError('Provide branchId and 1 to 100 items');
  }
  const id = checkoutId(value.checkoutId);
  const quantities = new Map<number, number>();
  for (const item of value.items) {
    if (!record(item) || !positiveInteger(item.productId) || !positiveInteger(item.quantity)) {
      throw new ValidationError('Each item requires positive integer productId and quantity');
    }
    const quantity = (quantities.get(item.productId) ?? 0) + item.quantity;
    if (!positiveInteger(quantity)) throw new ValidationError('Combined quantity is too large');
    quantities.set(item.productId, quantity);
  }
  return {
    checkoutId: id, branchId: value.branchId,
    items: [...quantities].sort(([first], [second]) => first - second)
      .map(([productId, quantity]) => ({ productId, quantity })),
  };
}

export function checkoutResponse(row: CheckoutRow) {
  return {
    checkoutId: row.checkout_id, status: row.status,
    checkoutUrl: row.status === 'pending' ? row.checkout_url : null,
    amountTotal: row.amount_total, currency: row.currency, orderId: row.order_id,
  };
}
