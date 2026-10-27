/**
 * @swagger
 * tags:
 *   name: Products
 *   description: API endpoints for managing products
 */

/**
 * @swagger
 * /api/products:
 *   get:
 *     summary: Returns all products
 *     parameters:
 *       - in: query
 *         name: branchId
 *         schema: {type: integer, minimum: 1, default: 1}
 *         description: Branch whose stock to include
 *     tags: [Products]
 *     responses:
 *       200:
 *         description: List of all products
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 *   post:
 *     summary: Create a new product
 *     tags: [Products]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       201:
 *         description: Product created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *
 * /api/products/{id}:
 *   get:
 *     summary: Get a product by ID
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: branchId
 *         schema: {type: integer, minimum: 1, default: 1}
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Product ID
 *     responses:
 *       200:
 *         description: Product found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       404:
 *         description: Product not found
 *   put:
 *     summary: Update a product
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Product ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       200:
 *         description: Product updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       404:
 *         description: Product not found
 *   delete:
 *     summary: Delete a product
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Product ID
 *     responses:
 *       204:
 *         description: Product deleted successfully
 *       404:
 *         description: Product not found
 */

import express from 'express';
import { Product } from '../models/product';
import { getProductsRepository } from '../repositories/productsRepo';
import { NotFoundError } from '../utils/errors';
import { getInventoryRepository, positiveId } from '../repositories/inventoryRepo';

const router = express.Router();

// Create a new product
router.post('/', async (req, res, next) => {
  try {
    const repo = await getProductsRepository();
    const newProduct = await repo.create(req.body as Omit<Product, 'productId'>);
    res.status(201).json(newProduct);
  } catch (error) {
    next(error);
  }
});

// Get all products
router.get('/', async (req, res, next) => {
  try {
    const branchId = positiveId(req.query.branchId ?? '1', 'branchId');
    await (await getInventoryRepository()).requireBranch(branchId);
    const repo = await getProductsRepository();
    const products = await repo.findAll(branchId);
    res.json(products);
  } catch (error) {
    next(error);
  }
});

// Get a product by ID
router.get('/:id', async (req, res, next) => {
  try {
    const branchId = positiveId(req.query.branchId ?? '1', 'branchId');
    await (await getInventoryRepository()).requireBranch(branchId);
    const repo = await getProductsRepository();
    const product = await repo.findById(positiveId(req.params.id, 'productId'), branchId);
    if (product) {
      res.json(product);
    } else {
      res.status(404).send('Product not found');
    }
  } catch (error) {
    next(error);
  }
});

// Update a product by ID
router.put('/:id', async (req, res, next) => {
  try {
    const repo = await getProductsRepository();
    const updatedProduct = await repo.update(positiveId(req.params.id, 'productId'), req.body);
    res.json(updatedProduct);
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(404).send('Product not found');
    } else {
      next(error);
    }
  }
});

// Delete a product by ID
router.delete('/:id', async (req, res, next) => {
  try {
    const repo = await getProductsRepository();
    await repo.delete(positiveId(req.params.id, 'productId'));
    res.status(204).send();
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(404).send('Product not found');
    } else {
      next(error);
    }
  }
});

export default router;
