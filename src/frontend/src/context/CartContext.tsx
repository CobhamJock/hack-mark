import { createContext, ReactNode, useContext, useRef, useState } from 'react';
import { StockProduct } from '../api/inventory';

interface CartItem { productId: number; quantity: number; name: string; unitPriceCents: number }
interface CartState { branchId: number; items: CartItem[]; checkoutId: string | null; lastCheckoutId?: string }
interface CartContextValue extends CartState {
  error: string;
  add: (product: StockProduct, branchId: number, quantity: number) => string | null;
  update: (productId: number, quantity: number) => void;
  begin: () => string;
  settled: (id: string, completed: boolean) => void;
  reset: () => void;
}
const key = 'octocat-cart-v1';
const empty: CartState = { branchId: 1, items: [], checkoutId: null };
const CartContext = createContext<CartContextValue | null>(null);

function load(): { state: CartState; error: string } {
  try {
    const stored = sessionStorage.getItem(key);
    if (!stored) {
      return { state: empty, error: '' };
    }
    const state: CartState = JSON.parse(stored);
    if (!Number.isInteger(state.branchId) || state.branchId < 1 || !Array.isArray(state.items) ||
        (state.checkoutId !== null && (typeof state.checkoutId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.checkoutId))) ||
        (state.lastCheckoutId !== undefined && (typeof state.lastCheckoutId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.lastCheckoutId))) ||
        state.items.some((item) => !Number.isInteger(item.productId) || item.productId < 1 ||
          !Number.isInteger(item.quantity) || item.quantity < 1 || typeof item.name !== 'string' ||
          !Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 1)) {
      throw new Error('Invalid saved cart');
    }
    return { state, error: '' };
  } catch {
    return { state: empty, error: 'Your saved cart could not be loaded. Do not retry payment if it was already submitted; contact support. Otherwise reset the cart.' };
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(load);
  const [state, setState] = useState(initial.state);
  const current = useRef(state);
  const [error, setError] = useState(initial.error);
  const persist = (next: CartState): boolean => {
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
      current.current = next;
      setState(next);
      setError('');
      return true;
    } catch {
      setError('Cart storage is unavailable. Enable browser session storage before starting or confirming payment.');
      return false;
    }
  };
  const value: CartContextValue = {
    ...state, error,
    add(product, branchId, quantity) {
      if (state.checkoutId) {
        return 'Finish or cancel the current checkout before changing the cart.';
      }
      if (state.items.length && state.branchId !== branchId) {
        return 'Your cart belongs to another branch. Remove its items before choosing a different branch.';
      }
      const current = state.items.find((item) => item.productId === product.productId)?.quantity ?? 0;
      if (!Number.isInteger(quantity) || quantity <= 0 || current + quantity > product.quantityOnHand) {
        return `Only ${product.quantityOnHand} available at this branch, including items already in the cart.`;
      }
      const items = state.items.filter((item) => item.productId !== product.productId);
      items.push({
        productId: product.productId, name: product.name, quantity: current + quantity,
        unitPriceCents: Math.round(product.price * (1 - (product.discount ?? 0)) * 100),
      });
      return persist({ branchId, items, checkoutId: null }) ? null : 'Cart could not be saved.';
    },
    update(productId, quantity) {
      if (state.checkoutId) {
        setError('Finish or cancel the current checkout before changing the cart.');
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 2147483647) {
        setError('Choose a positive whole number, or remove the item.');
        return;
      }
      persist({ ...state, items: state.items.map((item) => item.productId === productId ? { ...item, quantity } : item)
        .filter((item) => item.quantity > 0) });
    },
    begin() {
      if (error || state.items.length === 0) {
        throw new Error(error || 'Add items before starting checkout.');
      }
      if (state.checkoutId) {
        return state.checkoutId;
      }
      const id = crypto.randomUUID();
      if (!persist({ ...state, checkoutId: id })) {
        throw new Error('Save the cart before retrying checkout.');
      }
      return id;
    },
    settled(id, completed) {
      if (current.current.checkoutId === id) {
        persist(completed ? { ...empty, lastCheckoutId: id } : { ...current.current, checkoutId: null });
      }
    },
    reset() {
      if (state.checkoutId) {
        setError('Confirm or cancel the pending checkout before resetting the cart.');
        return;
      }
      persist(empty);
    },
  };
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCart(): CartContextValue {
  const cart = useContext(CartContext);
  if (!cart) {
    throw new Error('useCart must be used within CartProvider');
  }
  return cart;
}
