import { DatabaseConnection } from '../db/sqlite';
import { CheckoutRequest, CheckoutRow, CheckoutSnapshot } from '../models/checkout';
import { ConflictError, DatabaseError, NotFoundError, ValidationError } from '../utils/errors';

export class CheckoutRepository {
  constructor(private readonly connection: DatabaseConnection) {}

  find(id: string): CheckoutRow | undefined {
    return this.connection.db.prepare<[string], CheckoutRow>('SELECT * FROM checkouts WHERE checkout_id = ?').get(id);
  }

  require(id: string): CheckoutRow {
    const row = this.find(id);
    if (!row) throw new NotFoundError('Checkout', id);
    return row;
  }

  prepare(input: CheckoutRequest): CheckoutRow {
    const canonical = JSON.stringify({ branchId: input.branchId, items: input.items });
    return this.connection.db.transaction(() => {
      const existing = this.find(input.checkoutId);
      if (existing) {
        const request: unknown = JSON.parse(existing.request_json);
        // JSON produced by this API is canonical; normalize object ordering for cross-API retries.
        const stored = request as { branchId: number; items: { productId: number; quantity: number }[] };
        const normalized = JSON.stringify({
          branchId: stored.branchId,
          items: stored.items.map(({ productId, quantity }) => ({ productId, quantity })),
        });
        if (canonical !== normalized) throw new ConflictError('Checkout ID is already bound to another cart');
        return existing;
      }
      if (!this.connection.db.prepare('SELECT branch_id FROM branches WHERE branch_id = ?').get(input.branchId)) {
        throw new NotFoundError('Branch', input.branchId);
      }
      let total = 0;
      const snapshots: CheckoutSnapshot[] = input.items.map((item) => {
        const product = this.connection.db.prepare<[number, number], {
          name: string; price: number; discount: number | null; quantity_on_hand: number;
        }>(`SELECT p.name, p.price, p.discount, COALESCE(i.quantity_on_hand,0) AS quantity_on_hand
          FROM products p LEFT JOIN inventory i ON i.product_id=p.product_id AND i.branch_id=?
          WHERE p.product_id=?`).get(input.branchId, item.productId);
        if (!product) throw new NotFoundError('Product', item.productId);
        if (product.quantity_on_hand < item.quantity) throw new ConflictError('Insufficient stock');
        const cents = Math.round(product.price * (1 - (product.discount ?? 0)) * 100);
        if (!Number.isSafeInteger(cents) || cents <= 0) throw new ValidationError('Product price cannot be paid online');
        total += cents * item.quantity;
        if (!Number.isSafeInteger(total) || total > 99999999) throw new ValidationError('Cart total exceeds the payment limit');
        return { ...item, unitPriceCents: cents, name: product.name };
      });
      if (total < 50) throw new ValidationError('The minimum online payment is USD 0.50');
      this.connection.db.prepare(`INSERT INTO checkouts
        (checkout_id,branch_id,request_json,items_json,amount_total,currency)
        VALUES(?,?,?,?,?,'usd')`).run(input.checkoutId, input.branchId, canonical, JSON.stringify(snapshots), total);
      return this.require(input.checkoutId);
    }).immediate();
  }

  attachSession(id: string, sessionId: string, url: string): CheckoutRow {
    this.connection.db.prepare(`UPDATE checkouts SET provider_session_id=?, checkout_url=?, status='pending'
      WHERE checkout_id=? AND status='creating'`).run(sessionId, url, id);
    return this.require(id);
  }

  finalize(id: string, paymentIntent: string): CheckoutRow {
    return this.connection.db.transaction(() => {
      const row = this.require(id);
      if (row.status !== 'pending') return row;
      try {
        // The savepoint rolls back every order/stock write but keeps the refund marker durable.
        this.connection.db.transaction(() => {
          const result = this.connection.db.prepare(`INSERT INTO orders
            (branch_id,order_date,name,description,status) VALUES(?,?,'Paid checkout',?,'confirmed')`)
            .run(row.branch_id, new Date().toISOString(), `Checkout ${id}`);
          const orderId = Number(result.lastInsertRowid);
          const items: CheckoutSnapshot[] = JSON.parse(row.items_json);
          const insert = this.connection.db.prepare(`INSERT INTO order_details
            (order_id,product_id,quantity,unit_price,notes) VALUES(?,?,?,?,'')`);
          for (const item of items) insert.run(orderId, item.productId, item.quantity, item.unitPriceCents / 100);
          this.connection.db.prepare(`UPDATE checkouts SET status='completed',order_id=?,payment_intent_id=?
            WHERE checkout_id=?`).run(orderId, paymentIntent, id);
        })();
      } catch {
        console.error('Paid checkout order could not be persisted; refund reconciliation required', { checkoutId: id });
        this.connection.db.prepare(`UPDATE checkouts SET status='refund_pending',payment_intent_id=?
          WHERE checkout_id=?`).run(paymentIntent, id);
      }
      return this.require(id);
    }).immediate();
  }

  refunded(id: string): CheckoutRow {
    this.connection.db.prepare(`UPDATE checkouts SET status='refunded'
      WHERE checkout_id=? AND status='refund_pending'`).run(id);
    return this.require(id);
  }

  cancel(id: string): CheckoutRow {
    this.connection.db.prepare(`UPDATE checkouts SET status='cancelled'
      WHERE checkout_id=? AND status='pending'`).run(id);
    return this.require(id);
  }

  assertFresh(row: CheckoutRow): void {
    const created = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
    if (!Number.isFinite(created) || Date.now() - created > 23 * 60 * 60 * 1000) {
      throw new DatabaseError('Checkout creation needs payment reconciliation. Contact support with the checkout ID.',
        'RECONCILIATION_REQUIRED', 409);
    }
  }
}
