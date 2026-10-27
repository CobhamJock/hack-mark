import express from 'express';
import { getDatabase } from '../db/sqlite';
import { checkoutId } from '../models/checkout';
import { CheckoutRepository } from '../repositories/checkoutRepo';
import { CheckoutService } from '../repositories/checkoutService';
import { StripePayments, paymentConfig } from '../repositories/stripePayments';

const router = express.Router();
async function service() {
  const config = paymentConfig();
  return new CheckoutService(new CheckoutRepository(await getDatabase()), new StripePayments(config));
}

/**
 * @swagger
 * /api/checkout:
 *   post:
 *     summary: Create or resume an idempotent Stripe-hosted checkout
 *     description: Prices are calculated on the server. Keep the UUID secret and reuse it for retries.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [checkoutId, branchId, items]
 *             properties:
 *               checkoutId: {type: string, format: uuid}
 *               branchId: {type: integer, minimum: 1}
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 100
 *                 items:
 *                   type: object
 *                   required: [productId, quantity]
 *                   properties:
 *                     productId: {type: integer, minimum: 1}
 *                     quantity: {type: integer, minimum: 1, maximum: 2147483647}
 *     responses:
 *       200:
 *         description: Checkout state and server-calculated total
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/CheckoutResult'}
 *       400: {description: Invalid cart}
 *       404: {description: Missing branch or product}
 *       409: {description: Insufficient stock or idempotency conflict}
 *       502: {description: Payment provider unavailable}
 *       503: {description: Payment configuration missing}
 * /api/checkout/{id}/complete:
 *   post:
 *     summary: Verify Stripe payment and atomically create an order, or retry a pending refund
 *     parameters:
 *       - {in: path, name: id, required: true, schema: {type: string, format: uuid}}
 *     responses:
 *       200:
 *         description: Only completed with orderId is an order confirmation
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/CheckoutResult'}
 *       409: {description: Payment not confirmed}
 *       502: {description: Provider verification or refund pending; retry same checkout}
 * /api/checkout/{id}/cancel:
 *   post:
 *     summary: Expire unpaid Stripe checkout, or finalize an already-paid checkout
 *     parameters:
 *       - {in: path, name: id, required: true, schema: {type: string, format: uuid}}
 *     responses:
 *       200:
 *         description: Cancelled or already-completed checkout state
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/CheckoutResult'}
 *       409: {description: Cancellation not yet confirmed}
 *       502: {description: Provider unavailable; keep cart and retry}
 */
router.post('/', async (req, res, next) => {
  try {
    res.json(await (await service()).start(req.body));
  } catch (error) { next(error); }
});
router.post('/:id/complete', async (req, res, next) => {
  try {
    res.json(await (await service()).complete(checkoutId(req.params.id)));
  } catch (error) { next(error); }
});
router.post('/:id/cancel', async (req, res, next) => {
  try {
    res.json(await (await service()).cancel(checkoutId(req.params.id)));
  } catch (error) { next(error); }
});
export default router;
