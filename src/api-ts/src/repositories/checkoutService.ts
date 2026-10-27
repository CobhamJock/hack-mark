import { CheckoutRow, checkoutResponse, parseCheckout } from '../models/checkout';
import { CheckoutRepository } from './checkoutRepo';
import { PaymentProvider, StripeSession } from './stripePayments';
import { DatabaseError } from '../utils/errors';

export class CheckoutService {
  constructor(private readonly repo: CheckoutRepository, private readonly provider: PaymentProvider) {}

  async start(input: unknown) {
    let row = this.repo.prepare(parseCheckout(input));
    if (row.status !== 'creating') return checkoutResponse(row);
    this.repo.assertFresh(row);
    const session = await this.provider.create(row);
    this.verify(row, session, false);
    let url: URL;
    try {
      url = new URL(session.url ?? '');
    } catch {
      throw new DatabaseError('Payment provider returned an invalid checkout URL', 'PAYMENT_PROVIDER_ERROR', 502);
    }
    if (url.origin !== 'https://checkout.stripe.com' || url.username || url.password) {
      throw new DatabaseError('Payment provider returned an invalid checkout URL', 'PAYMENT_PROVIDER_ERROR', 502);
    }
    row = this.repo.attachSession(row.checkout_id, session.id, url.href);
    return checkoutResponse(row);
  }

  async complete(id: string) {
    let row = this.repo.require(id);
    if (['completed', 'refunded', 'cancelled'].includes(row.status)) return checkoutResponse(row);
    if (row.status === 'refund_pending') return this.refund(row);
    if (!row.provider_session_id) throw new DatabaseError('Retry starting this checkout first', 'PAYMENT_PENDING', 409);
    const session = await this.provider.retrieve(row.provider_session_id);
    this.verify(row, session);
    if (session.payment_status !== 'paid' || session.status !== 'complete') {
      if (session.status === 'expired' && session.payment_status !== 'paid') return checkoutResponse(this.repo.cancel(id));
      throw new DatabaseError('Payment is not confirmed. Complete payment or cancel checkout.', 'PAYMENT_PENDING', 409);
    }
    if (typeof session.payment_intent !== 'string' || !session.payment_intent) {
      throw new DatabaseError('Payment provider returned an invalid payment reference', 'PAYMENT_PROVIDER_ERROR', 502);
    }
    row = this.repo.finalize(id, session.payment_intent);
    return row.status === 'refund_pending' ? this.refund(row) : checkoutResponse(row);
  }

  async cancel(id: string) {
    const row = this.repo.require(id);
    if (['completed', 'refunded', 'cancelled', 'refund_pending'].includes(row.status)) return this.complete(id);
    if (!row.provider_session_id) {
      throw new DatabaseError('Retry starting this checkout before cancelling', 'PAYMENT_PENDING', 409);
    }
    let session = await this.provider.retrieve(row.provider_session_id);
    this.verify(row, session);
    if (session.payment_status === 'paid') return this.complete(id);
    if (session.status === 'open') {
      session = await this.provider.expire(row.provider_session_id);
      this.verify(row, session);
    }
    if (session.status !== 'expired' || session.payment_status === 'paid') {
      throw new DatabaseError('Checkout cannot yet be cancelled. Retry confirmation.', 'PAYMENT_PENDING', 409);
    }
    return checkoutResponse(this.repo.cancel(id));
  }

  private verify(row: CheckoutRow, session: StripeSession, stored = true): void {
    if (!session || typeof session.id !== 'string' || !session.id ||
        (stored && session.id !== row.provider_session_id) ||
        session.client_reference_id !== row.checkout_id || session.metadata?.checkoutId !== row.checkout_id ||
        session.currency !== row.currency || session.amount_total !== row.amount_total) {
      throw new DatabaseError('Payment verification failed. Contact support with the checkout ID.',
        'PAYMENT_VERIFICATION_FAILED', 502);
    }
  }

  private async refund(row: CheckoutRow) {
    if (!row.payment_intent_id) throw new DatabaseError('Refund reference is missing; contact support.', 'REFUND_PENDING', 502);
    try {
      await this.provider.refund(row.payment_intent_id, row.checkout_id);
    } catch {
      console.error('Checkout refund requires retry', { checkoutId: row.checkout_id });
      throw new DatabaseError('The order was not placed. Refund confirmation is pending; retry confirmation or contact support.',
        'REFUND_PENDING', 502);
    }
    return checkoutResponse(this.repo.refunded(row.checkout_id));
  }
}
