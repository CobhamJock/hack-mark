import axios from 'axios';
import { api } from './config';

export interface CheckoutItem { productId: number; quantity: number }
export interface CheckoutRequest { checkoutId: string; branchId: number; items: CheckoutItem[] }
export interface CheckoutResult {
  checkoutId: string;
  status: 'creating' | 'pending' | 'completed' | 'refund_pending' | 'refunded' | 'cancelled';
  checkoutUrl: string | null;
  amountTotal: number;
  currency: 'usd';
  orderId: number | null;
}

export async function startCheckout(body: CheckoutRequest): Promise<CheckoutResult> {
  return (await axios.post<CheckoutResult>(`${api.baseURL}/api/checkout`, body)).data;
}

export async function confirmCheckout(id: string, action: 'complete' | 'cancel'): Promise<CheckoutResult> {
  return (await axios.post<CheckoutResult>(`${api.baseURL}/api/checkout/${id}/${action}`)).data;
}

export function checkoutError(error: unknown): string {
  if (axios.isAxiosError<{ error?: { message?: string } }>(error)) {
    return error.response?.data.error?.message ?? 'Could not reach checkout. Keep this cart and retry.';
  }
  return error instanceof Error ? error.message : 'Checkout could not be completed. Keep this cart and retry.';
}

export const dollars = (cents: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
}).format(cents / 100);
