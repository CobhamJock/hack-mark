import axios from 'axios';
import { api } from './config';

export interface Branch {
  branchId: number;
  name: string;
}

export interface StockProduct {
  productId: number;
  name: string;
  description: string;
  price: number;
  imgName: string;
  sku: string;
  unit: string;
  supplierId: number;
  discount?: number;
  quantityOnHand: number;
  stockStatus: 'out_of_stock' | 'low_stock' | 'in_stock';
}

export async function fetchBranches(): Promise<Branch[]> {
  return (await axios.get<Branch[]>(`${api.baseURL}${api.endpoints.branches}`)).data;
}

export async function fetchStockProducts(branchId: number): Promise<StockProduct[]> {
  return (await axios.get<StockProduct[]>(`${api.baseURL}${api.endpoints.products}`, {
    params: { branchId },
  })).data;
}

export async function updateStock(branchId: number, productId: number, quantityOnHand: number, token: string) {
  return axios.put<{ branchId: number; productId: number; quantityOnHand: number }>(
    `${api.baseURL}${api.endpoints.inventory}/${branchId}/${productId}`,
    { quantityOnHand }, { headers: { Authorization: `Bearer ${token}` } },
  );
}

export function inventoryError(error: unknown): string {
  if (axios.isAxiosError<{ error?: { message?: string } }>(error)) {
    return error.response?.data.error?.message ?? 'Could not reach the inventory service. Try again.';
  }
  return 'Could not update inventory. Try again.';
}
