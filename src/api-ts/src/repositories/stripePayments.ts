import { CheckoutRow, CheckoutSnapshot } from '../models/checkout';
import { DatabaseError } from '../utils/errors';

export interface StripeSession {
  id: string;
  url?: string | null;
  client_reference_id: string | null;
  metadata: { checkoutId?: string };
  amount_total: number | null;
  currency: string | null;
  payment_status: string;
  status: string;
  payment_intent: string | null;
}

export interface PaymentProvider {
  create(row: CheckoutRow): Promise<StripeSession>;
  retrieve(id: string): Promise<StripeSession>;
  expire(id: string): Promise<StripeSession>;
  refund(intent: string, checkoutId: string): Promise<void>;
}

export function paymentConfig(): { key: string; origin: string } {
  const key = process.env.STRIPE_SECRET_KEY;
  const origin = process.env.CHECKOUT_PUBLIC_URL;
  let validOrigin = false;
  try {
    const url = new URL(origin ?? '');
    validOrigin = !!origin && origin.replace(/\/$/, '') === url.origin &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch {
    validOrigin = false;
  }
  if (process.env.PAYMENT_PROVIDER !== 'stripe' || !key || !origin || !validOrigin) {
    throw new DatabaseError('Payment configuration is unavailable. Contact the store administrator.', 'PAYMENT_UNAVAILABLE', 503);
  }
  return { key, origin: origin.replace(/\/$/, '') };
}

export class StripePayments implements PaymentProvider {
  constructor(private readonly config: { key: string; origin: string }) {}

  private async request<T>(path: string, form?: URLSearchParams, idempotencyKey?: string): Promise<T> {
    try {
      const response = await fetch(`https://api.stripe.com/v1${path}`, {
        method: form ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.config.key}`,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: form?.toString(), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Stripe request failed');
      return await response.json() as T;
    } catch {
      throw new DatabaseError('The payment provider could not complete the request. Retry with the same checkout.',
        'PAYMENT_PROVIDER_ERROR', 502);
    }
  }

  create(row: CheckoutRow): Promise<StripeSession> {
    const form = new URLSearchParams({
      mode: 'payment', 'payment_method_types[0]': 'card',
      success_url: `${this.config.origin}/checkout?checkoutId=${row.checkout_id}&result=success`,
      cancel_url: `${this.config.origin}/checkout?checkoutId=${row.checkout_id}&result=cancel`,
      client_reference_id: row.checkout_id, 'metadata[checkoutId]': row.checkout_id,
    });
    const items: CheckoutSnapshot[] = JSON.parse(row.items_json);
    items.forEach((item, index) => {
      form.set(`line_items[${index}][quantity]`, String(item.quantity));
      form.set(`line_items[${index}][price_data][currency]`, row.currency);
      form.set(`line_items[${index}][price_data][unit_amount]`, String(item.unitPriceCents));
      form.set(`line_items[${index}][price_data][product_data][name]`, item.name);
    });
    return this.request('/checkout/sessions', form, `checkout-${row.checkout_id}`);
  }

  retrieve(id: string): Promise<StripeSession> {
    return this.request(`/checkout/sessions/${encodeURIComponent(id)}`);
  }

  expire(id: string): Promise<StripeSession> {
    return this.request(`/checkout/sessions/${encodeURIComponent(id)}/expire`, new URLSearchParams());
  }

  async refund(intent: string, id: string): Promise<void> {
    const refund = await this.request<{ status: string }>('/refunds',
      new URLSearchParams({ payment_intent: intent }), `refund-${id}`);
    if (refund.status !== 'succeeded') {
      throw new DatabaseError('Payment refund is awaiting reconciliation. Retry confirmation.', 'REFUND_PENDING', 502);
    }
  }
}
