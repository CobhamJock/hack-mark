import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from 'react-query';
import { useCart } from '../../context/CartContext';
import { useTheme } from '../../context/ThemeContext';
import { fetchStockProducts } from '../../api/inventory';
import { dollars } from '../../api/checkout';

export default function Cart() {
  const cart = useCart();
  const { darkMode } = useTheme();
  const [invalid, setInvalid] = useState<Record<number, boolean>>({});
  const stock = useQuery(['products', cart.branchId], () => fetchStockProducts(cart.branchId),
    { enabled: cart.items.length > 0, refetchOnWindowFocus: true });
  const unavailable = cart.items.some((item) => (stock.data?.find((product) => product.productId === item.productId)
    ?.quantityOnHand ?? 0) < item.quantity);
  const blocked = Object.values(invalid).some(Boolean) || unavailable || !!stock.error || stock.isLoading || !!cart.error;
  return (
    <section className={`min-h-screen pt-24 px-4 pb-12 ${darkMode ? 'text-light' : 'text-gray-800'}`}>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-3">Your cart</h1>
        <p className="mb-6">Branch {cart.branchId} · Prices are confirmed when checkout starts.</p>
        {cart.error && <p role="alert" className="text-red-600 mb-4">{cart.error}</p>}
        {!cart.items.length ? <p>Your cart is empty. <Link className="underline" to="/products">Browse products</Link></p> : (
          <>
            <ul className="divide-y divide-gray-400">
              {cart.items.map((item) => {
                const available = stock.data?.find((product) => product.productId === item.productId)?.quantityOnHand ?? 0;
                return <li key={item.productId} className="py-5 flex flex-wrap items-center justify-between gap-4">
                  <div><h2 className="font-semibold">{item.name}</h2><p>{dollars(item.unitPriceCents)} per item</p>
                    <p className="text-sm">{available} available</p></div>
                  <div>
                    <label className="block text-sm" htmlFor={`cart-qty-${item.productId}`}>Quantity for {item.name}</label>
                    <input id={`cart-qty-${item.productId}`} type="number" min="1" step="1" max={available}
                      disabled={!!cart.checkoutId} defaultValue={item.quantity}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const count = Number(raw);
                        const valid = /^\d+$/.test(raw) && Number.isInteger(count) && count > 0 && count <= available;
                        setInvalid((previous) => ({ ...previous, [item.productId]: !valid }));
                        if (valid) { cart.update(item.productId, count); }
                      }}
                      className="w-24 rounded border p-2 text-gray-800 bg-white focus:ring-2 focus:ring-primary"
                      aria-describedby={`cart-error-${item.productId}`} />
                    {(invalid[item.productId] || item.quantity > available) &&
                      <p id={`cart-error-${item.productId}`} role="alert" className="text-red-600">Choose a whole number from 1 to {available}, or remove the item.</p>}
                    <button disabled={!!cart.checkoutId} onClick={() => {
                      cart.update(item.productId, 0);
                      setInvalid((previous) => ({ ...previous, [item.productId]: false }));
                    }} className="ml-3 underline disabled:opacity-50">Remove {item.name}</button>
                  </div>
                </li>;
              })}
            </ul>
            {stock.error ? <p role="alert">Could not check availability. <button className="underline" onClick={() => stock.refetch()}>Retry stock check</button></p> : null}
            <p className="text-xl font-semibold my-6">Estimated total <span className="font-mono">{dollars(cart.items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0))}</span></p>
            {cart.checkoutId ? <Link to="/checkout" className="underline">Resume or cancel pending checkout</Link> : (
              blocked ? <p role="status">Resolve cart errors before checkout.</p> :
                <Link to="/checkout" className="inline-block rounded bg-primary px-6 py-3 text-gray-900 font-semibold focus:ring-2">Go to checkout</Link>
            )}
          </>
        )}
        {cart.error && !cart.checkoutId && <button className="underline mt-4" onClick={cart.reset}>Reset cart</button>}
      </div>
    </section>
  );
}
