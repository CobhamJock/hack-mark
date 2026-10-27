import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/branches', (route) => route.fulfill({ json: [
    { branchId: 1, name: 'Meowtown Branch' }, { branchId: 2, name: 'Tabby Terrace Branch' },
  ] }));
  await page.route('**/api/products?*', (route) => {
    const branchId = new URL(route.request().url()).searchParams.get('branchId');
    return route.fulfill({ json: [
      { productId: 1, supplierId: 1, name: 'SmartFeeder One', description: 'Feeder',
        price: 129.99, sku: 'CAT-FEED-001', unit: 'piece', imgName: 'feeder.png',
        quantityOnHand: branchId === '2' ? 20 : 3, stockStatus: branchId === '2' ? 'in_stock' : 'low_stock' },
      { productId: 2, supplierId: 1, name: 'AutoClean Litter Dome', description: 'Litter box',
        price: 199.99, sku: 'CAT-LITTER-001', unit: 'piece', imgName: 'litter-box.png',
        quantityOnHand: 0, stockStatus: 'out_of_stock' },
    ] });
  });
});

test('shows branch-specific stock and caps selection at availability', async ({ page }) => {
  await page.goto('/products');
  await expect(page.getByLabel('SmartFeeder One stock')).toContainText('Low stock');
  await expect(page.getByLabel('SmartFeeder One stock')).toContainText('3 available');
  await expect(page.getByLabel('AutoClean Litter Dome stock')).toContainText('Out of stock');
  await expect(page.locator('#increase-qty-2')).toBeDisabled();
  await expect(page.locator('#add-to-cart-2')).toBeDisabled();
  for (let count = 0; count < 3; count++) {
    await page.locator('#increase-qty-1').click();
  }
  await expect(page.locator('#qty-1')).toHaveText('3');
  await expect(page.locator('#increase-qty-1')).toBeDisabled();
  await page.getByLabel('Stock at branch').selectOption('2');
  await expect(page.getByLabel('SmartFeeder One stock')).toContainText('20 available');
  await expect(page.locator('#qty-1')).toHaveText('0');
  await page.getByAltText('SmartFeeder One', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'SmartFeeder One', exact: true })).toHaveCount(2);
  await expect(page.getByLabel('SmartFeeder One stock')).toHaveCount(2);
});

test('lets an admin save stock and shows authorization failures', async ({ page }) => {
  let saved: unknown;
  await page.route('**/api/inventory/1/1', async (route) => {
    if (route.request().headers().authorization !== 'Bearer test-inventory-token') {
      await route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Administrator token required' } } });
      return;
    }
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { branchId: 1, productId: 1, quantityOnHand: 12 } });
  });
  await page.goto('/login');
  await page.getByLabel('Email Address').fill('stock-admin@github.com');
  await page.getByLabel('Password', { exact: true }).fill('demo');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.getByRole('link', { name: 'Manage Inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Branch inventory' })).toBeVisible();
  const first = page.locator('li').filter({ has: page.getByRole('heading', { name: 'SmartFeeder One' }) });
  await expect(first.getByRole('button', { name: 'Save stock' })).toBeDisabled();
  await page.getByLabel('Inventory administrator token').fill('wrong');
  await first.getByLabel('Quantity on hand').fill('12');
  await first.getByRole('button', { name: 'Save stock' }).click();
  await expect(first.getByRole('alert')).toContainText('Administrator token required');
  await page.getByLabel('Inventory administrator token').fill('test-inventory-token');
  await first.getByRole('button', { name: 'Save stock' }).click();
  await expect(first.getByRole('status')).toContainText('Stock saved');
  expect(saved).toEqual({ quantityOnHand: 12 });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-inventory-token');
});

test('stock controls remain usable on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/products');
  await expect(page.getByLabel('Stock at branch')).toBeVisible();
  await expect(page.getByLabel('SmartFeeder One stock')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
