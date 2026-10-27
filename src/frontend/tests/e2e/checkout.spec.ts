import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/branches', (route) => route.fulfill({ json: [{ branchId: 1, name: 'Meowtown Branch' }] }));
  await page.route('**/api/products?*', (route) => route.fulfill({ json: [{
    productId: 1, supplierId: 1, name: 'SmartFeeder One', description: 'Branch feeder',
    price: 129.99, discount: 0.25, sku: 'CAT-FEED-001', unit: 'piece', imgName: 'feeder.png',
    quantityOnHand: 3, stockStatus: 'low_stock',
  }] }));
});

async function addToCart(page: import('@playwright/test').Page) {
  await page.goto('/products');
  await page.locator('#increase-qty-1').click();
  await page.locator('#add-to-cart-1').click();
  await expect(page.getByRole('status')).toContainText('Added 1 SmartFeeder One');
  await page.getByRole('link', { name: 'Cart (1)' }).click();
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
}

test('cart persists across navigation and reload; invalid quantities block checkout', async ({ page }) => {
  await addToCart(page);
  await page.reload();
  await expect(page.getByLabel('Quantity for SmartFeeder One')).toHaveValue('1');
  await page.getByLabel('Quantity for SmartFeeder One').fill('0');
  await expect(page.getByRole('alert')).toContainText('Choose a whole number');
  await expect(page.getByRole('link', { name: 'Go to checkout' })).toHaveCount(0);
  await page.getByLabel('Quantity for SmartFeeder One').fill('2');
  await expect(page.getByRole('link', { name: 'Go to checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove SmartFeeder One' }).click();
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
});

test('hosted payment return confirms the order and only then clears cart', async ({ page }) => {
  let checkoutId = '';
  await page.route('**/api/checkout', async (route) => {
    const body = route.request().postDataJSON();
    checkoutId = body.checkoutId;
    expect(body.items).toEqual([{ productId: 1, quantity: 1 }]);
    expect(body).not.toHaveProperty('amountTotal');
    await route.fulfill({ json: { checkoutId, status: 'pending', checkoutUrl: 'https://checkout.stripe.com/c/pay/test',
      amountTotal: 9749, currency: 'usd', orderId: null } });
  });
  await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<h1>Hosted payment form (test fixture)</h1>',
  }));
  await page.route('**/api/checkout/*/complete', (route) => route.fulfill({ json: {
    checkoutId, status: 'completed', checkoutUrl: null, amountTotal: 9749, currency: 'usd', orderId: 42,
  } }));
  await addToCart(page);
  await page.getByRole('link', { name: 'Go to checkout' }).click();
  await page.getByRole('button', { name: 'Prepare secure payment' }).click();
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay $97.49 on Stripe' }).click();
  await expect(page.getByRole('heading', { name: 'Hosted payment form (test fixture)' })).toBeVisible();
  await page.goto(`/checkout?checkoutId=${checkoutId}&result=success`);
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Order #42');
  await expect(page.getByRole('link', { name: 'Cart (0)' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('sk_test');
});

test('unpaid payment leaves cart intact; confirmed cancellation unlocks it', async ({ page }) => {
  let checkoutId = '';
  await page.route('**/api/checkout', async (route) => {
    checkoutId = route.request().postDataJSON().checkoutId;
    await route.fulfill({ json: { checkoutId, status: 'pending', checkoutUrl: 'https://checkout.stripe.com/c/pay/test',
      amountTotal: 9749, currency: 'usd', orderId: null } });
  });
  await page.route('**/api/checkout/*/complete', (route) => route.fulfill({
    status: 409, json: { error: { code: 'PAYMENT_PENDING', message: 'Payment is not confirmed. Your cart is unchanged.' } },
  }));
  await page.route('**/api/checkout/*/cancel', (route) => route.fulfill({ json: {
    checkoutId, status: 'cancelled', checkoutUrl: null, amountTotal: 9749, currency: 'usd', orderId: null,
  } }));
  await addToCart(page);
  await page.getByRole('link', { name: 'Go to checkout' }).click();
  await page.getByRole('button', { name: 'Prepare secure payment' }).click();
  await page.goto(`/checkout?checkoutId=${checkoutId}&result=success`);
  await expect(page.getByRole('alert')).toContainText('Payment is not confirmed');
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel checkout', exact: true }).click();
  await expect(page.getByText('Checkout cancelled. Your cart is unchanged.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to cart' }).click();
  await expect(page.getByLabel('Quantity for SmartFeeder One')).toBeEnabled();
});

test('provider configuration failures preserve the same retry key and cart', async ({ page }) => {
  const keys: string[] = [];
  await page.route('**/api/checkout', async (route) => {
    keys.push(route.request().postDataJSON().checkoutId);
    await route.fulfill({ status: 503, json: { error: {
      code: 'PAYMENT_UNAVAILABLE', message: 'Payment configuration is unavailable.',
    } } });
  });
  await addToCart(page);
  await page.getByRole('link', { name: 'Go to checkout' }).click();
  await page.getByRole('button', { name: 'Prepare secure payment' }).click();
  await expect(page.getByRole('alert')).toContainText('Payment configuration is unavailable');
  await page.getByRole('button', { name: 'Retry checkout setup' }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  await page.getByRole('link', { name: 'Back to cart' }).click();
  await expect(page.getByLabel('Quantity for SmartFeeder One')).toHaveValue('1');
});

test('refund failure stays retryable and a refund keeps cart intact', async ({ page }) => {
  let checkoutId = '';
  let calls = 0;
  await page.route('**/api/checkout', async (route) => {
    checkoutId = route.request().postDataJSON().checkoutId;
    await route.fulfill({ json: { checkoutId, status: 'pending', checkoutUrl: 'https://checkout.stripe.com/c/pay/test',
      amountTotal: 9749, currency: 'usd', orderId: null } });
  });
  await page.route('**/api/checkout/*/complete', async (route) => {
    calls++;
    if (calls === 1) {
      await route.fulfill({ status: 502, json: { error: { code: 'REFUND_PENDING', message: 'Refund confirmation is pending; retry confirmation.' } } });
    } else {
      await route.fulfill({ json: { checkoutId, status: 'refunded', checkoutUrl: null, amountTotal: 9749, currency: 'usd', orderId: null } });
    }
  });
  await addToCart(page);
  await page.getByRole('link', { name: 'Go to checkout' }).click();
  await page.getByRole('button', { name: 'Prepare secure payment' }).click();
  await page.getByRole('button', { name: 'Confirm payment / retry refund' }).click();
  await expect(page.getByRole('alert')).toContainText('Refund confirmation is pending');
  await expect(page.getByRole('status')).toContainText('do not make another payment');
  await expect(page.getByRole('button', { name: 'Pay $97.49 on Stripe' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm payment / retry refund' }).click();
  await expect(page.getByRole('alert')).toContainText('payment was refunded');
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();
});

test('prepayment stock errors unlock the unchanged cart for correction', async ({ page }) => {
  await page.route('**/api/checkout', (route) => route.fulfill({ status: 409,
    json: { error: { code: 'CONFLICT', message: 'Conflict: Insufficient stock' } } }));
  await addToCart(page);
  await page.getByRole('link', { name: 'Go to checkout' }).click();
  await page.getByRole('button', { name: 'Prepare secure payment' }).click();
  await expect(page.getByRole('alert')).toContainText('Insufficient stock');
  await page.getByRole('link', { name: 'Back to cart' }).click();
  await expect(page.getByLabel('Quantity for SmartFeeder One')).toBeEnabled();
});

test('cart and checkout are usable at mobile widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await addToCart(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Go to checkout' }).click();
  await expect(page.getByRole('button', { name: 'Prepare secure payment' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
