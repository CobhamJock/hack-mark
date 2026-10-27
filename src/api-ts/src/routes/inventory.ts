import express from 'express';
import { timingSafeEqual } from 'crypto';
import { getInventoryRepository, positiveId } from '../repositories/inventoryRepo';
import { DatabaseError } from '../utils/errors';

const router = express.Router();

/**
 * @swagger
 * /api/inventory/{branchId}/{productId}:
 *   put:
 *     summary: Set branch stock (requires INVENTORY_ADMIN_TOKEN as a Bearer token)
 *     parameters:
 *       - {in: path, name: branchId, required: true, schema: {type: integer, minimum: 1}}
 *       - {in: path, name: productId, required: true, schema: {type: integer, minimum: 1}}
 *       - {in: header, name: Authorization, required: true, schema: {type: string}}
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [quantityOnHand]
 *             properties:
 *               quantityOnHand: {type: integer, minimum: 0, maximum: 2147483647}
 *     responses:
 *       200:
 *         description: Updated branchId, productId and quantityOnHand
 *       400:
 *         description: Invalid IDs or stock quantity
 *       403:
 *         description: Missing or invalid administrator token
 *       404:
 *         description: Branch or product not found
 *       503:
 *         description: Administrator token not configured
 */
router.put('/:branchId/:productId', async (req, res, next) => {
  try {
    const token = process.env.INVENTORY_ADMIN_TOKEN;
    if (!token) throw new DatabaseError('Inventory administration is not configured', 'UNAVAILABLE', 503);
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(req.get('Authorization') ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new DatabaseError('An inventory administrator token is required', 'FORBIDDEN', 403);
    }
    const branchId = positiveId(req.params.branchId, 'branchId');
    const productId = positiveId(req.params.productId, 'productId');
    const repo = await getInventoryRepository();
    res.json(await repo.setQuantity(branchId, productId, req.body?.quantityOnHand));
  } catch (error) {
    next(error);
  }
});

export default router;
