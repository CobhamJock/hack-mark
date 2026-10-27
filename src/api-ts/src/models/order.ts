/**
 * @swagger
 * components:
 *   schemas:
 *     Order:
 *       type: object
 *       required:
 *         - orderId
 *         - branchId
 *         - orderDate
 *       properties:
 *         items:
 *           type: array
 *           minItems: 1
 *           maxItems: 100
 *           description: Optional on create; inserts order and stock-checked lines atomically. Prices come from the server.
 *           items:
 *             type: object
 *             required: [productId, quantity]
 *             properties:
 *               productId: {type: integer, minimum: 1}
 *               quantity: {type: integer, minimum: 1, maximum: 2147483647}
 *               orderDetailId: {type: integer, readOnly: true}
 *               orderId: {type: integer, readOnly: true}
 *               unitPrice: {type: number, readOnly: true}
 *               notes: {type: string, readOnly: true}
 *         orderId:
 *           type: integer
 *           description: The unique identifier for the order
 *         branchId:
 *           type: integer
 *           description: The ID of the branch that placed the order
 *         orderDate:
 *           type: string
 *           format: date-time
 *           description: The date and time when the order was placed
 *         name:
 *           type: string
 *           description: The name of the order
 *         description:
 *           type: string
 *           description: Additional details about the order
 *         status:
 *           type: string
 *           description: The current status of the order
 *           enum: [pending, processing, shipped, delivered, cancelled]
 */
export interface Order {
  orderId: number;
  branchId: number;
  orderDate: string;
  name: string;
  description: string;
  status: string;
}
