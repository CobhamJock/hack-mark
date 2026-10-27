import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from 'react-query';
import { Link, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { checkoutError, CheckoutResult, CheckoutRequest, confirmCheckout, dollars, startCheckout } from '../../api/checkout';
import { useCart } from '../../context/CartContext';
import { useTheme } from '../../context/ThemeContext';

export default function Checkout() {
  const cart = useCart();
  const { darkMode } = useTheme();
  const [params] = useSearchParams();
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [clientError, setClientError] = useState('');
  const queryClient = useQueryClient();
  const returnedId = params.get('checkoutId');
  const returnedAction = params.get('result') === 'cancel' ? 'cancel' : 'complete';
  const returned = useQuery(['checkout-return', returnedId, returnedAction],
    () => confirmCheckout(returnedId!, returnedAction), {
      enabled: !!returnedId && (returnedId === cart.checkoutId || returnedId === cart.lastCheckoutId),
      retry: false, refetchOnWindowFocus: false, staleTime: Infinity,
    });
  const settle = (data: CheckoutResult) => {
    setResult(data);
    if (['completed', 'refunded', 'cancelled'].includes(data.status)) {
      cart.settled(data.checkoutId, data.status === 'completed' && data.orderId !== null);
      queryClient.invalidateQueries(['products', cart.branchId]);
    }
  };
  const start = useMutation((input: CheckoutRequest) => startCheckout(input), {
    onSuccess: settle,
    onError: (error, input) => {
      if (axios.isAxiosError<{ error?: { message?: string } }>(error) &&
          ([400, 404].includes(error.response?.status ?? 0) ||
            (error.response?.status === 409 && error.response.data.error?.message?.includes('Insufficient stock')))) {
        // These are pre-provider validation failures: no payment session was created.
        cart.settled(input.checkoutId, false);
      }
    },
  });
  const prepare = () => {
    try {
      setClientError('');
      const id = cart.begin();
      start.mutate({ checkoutId: id, branchId: cart.branchId,
        items: cart.items.map(({ productId, quantity }) => ({ productId, quantity })) });
    } catch (error) {
      setClientError(checkoutError(error));
    }
  };
  const confirm = useMutation((action: 'complete' | 'cancel') => confirmCheckout(cart.checkoutId!, action),
    {
      onSuccess: settle,
      onError: (error) => {
        if (axios.isAxiosError<{ error?: { code?: string } }>(error) &&
            error.response?.data.error?.code === 'REFUND_PENDING') {
          setResult((previous) => previous ? { ...previous, status: 'refund_pending', checkoutUrl: null } : previous);
        }
      },
    });
  useEffect(() => {
    if (returned.data) {
      setResult(returned.data);
      if (['completed', 'refunded', 'cancelled'].includes(returned.data.status)) {
        cart.settled(returned.data.checkoutId, returned.data.status === 'completed' && returned.data.orderId !== null);
        queryClient.invalidateQueries(['products', cart.branchId]);
      }
    }
    // Apply each server-confirmed result once; cart identity changes when settled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returned.data]);
  const busy = start.isLoading || confirm.isLoading || returned.isFetching;
  const error = start.error || confirm.error || returned.error;
  const redirect = () => {
    if (result?.checkoutUrl) {
      try {
        const url = new URL(result.checkoutUrl);
        if (url.origin !== 'https://checkout.stripe.com' || url.username || url.password) {
          throw new Error('Invalid payment link');
        }
        window.location.assign(url.href);
      } catch {
        setClientError('The payment link is invalid. Do not enter payment details; contact support.');
      }
    }
  };
  const completed = result?.status === 'completed' && result.orderId !== null;
  return (
    <section className={`min-h-screen pt-24 px-4 pb-12 ${darkMode ? 'text-light' : 'text-gray-800'}`}>
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-3">{completed ? 'Order confirmed' : 'Checkout'}</h1>
        <p className="mb-6">Review your branch order. Enter payment details securely on Stripe, then return here for confirmation.</p>
        {cart.error && <p role="alert">{cart.error}</p>}
        {completed ? <div role="status" className="rounded border-l-4 border-primary p-6">
          <h2 className="text-xl font-semibold">Order #{result.orderId}</h2>
          <p>Payment confirmed: {dollars(result.amountTotal)}. Your order has been placed.</p>
          <Link className="underline" to="/products">Continue shopping</Link>
        </div> : (
          <>
            {result?.status === 'refunded' && <p role="alert" className="mb-4">Your order could not be placed. The payment was refunded. Your cart is unchanged; review availability before trying again.</p>}
            {result?.status === 'refund_pending' && <p role="status" className="mb-4">The order was not placed. Refund confirmation is pending. Retry confirmation; do not make another payment.</p>}
            {result?.status === 'cancelled' && <p role="status" className="mb-4">Checkout cancelled. Your cart is unchanged.</p>}
            {returnedId && returnedId !== cart.checkoutId && returnedId !== cart.lastCheckoutId && !result &&
              <p role="alert">This return does not match your saved checkout. Do not submit another payment. Contact support with the checkout ID.</p>}
            {cart.error && <p role="alert">{cart.error}</p>}
            {error ? <p role="alert" className="my-4 text-red-600">{checkoutError(error)}</p> : null}
            {clientError && <p role="alert" className="my-4 text-red-600">{clientError}</p>}
            {busy && <p role="status">Checking checkout. Keep this page open...</p>}
            {!!cart.items.length && (
              <div className="rounded border border-gray-400 p-5 space-y-4">
                <p className="text-sm font-semibold">Branch {cart.branchId} · {cart.items.length} {cart.items.length === 1 ? 'product line' : 'product lines'}</p>
                <ul className="divide-y divide-gray-400">{cart.items.map((item) => <li className="py-3 flex justify-between gap-4" key={item.productId}>
                  <span>{item.name} × {item.quantity}</span><span className="font-mono">{dollars(item.unitPriceCents * item.quantity)}</span>
                </li>)}</ul>
                <p className="text-xl font-semibold">Total {result?.status === 'pending' ? dollars(result.amountTotal) :
                  `${dollars(cart.items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0))} estimated`}</p>
                <p className="text-sm">Stock is checked again after payment. If an item sells out, no order is placed and the payment is refunded.</p>
                {!result || result.status !== 'pending' ? <button disabled={busy || !!cart.error}
                  onClick={prepare} className="bg-primary text-gray-900 font-semibold rounded px-5 py-3 disabled:opacity-50 focus:ring-2">
                  {cart.checkoutId ? 'Retry checkout setup' : 'Prepare secure payment'}
                </button> : <button disabled={busy} onClick={redirect}
                  className="bg-primary text-gray-900 font-semibold rounded px-5 py-3 disabled:opacity-50 focus:ring-2">Pay {dollars(result.amountTotal)} on Stripe</button>}
                {cart.checkoutId && <div className="flex flex-wrap gap-4">
                  <button disabled={busy} onClick={() => confirm.mutate('complete')} className="underline disabled:opacity-50">Confirm payment / retry refund</button>
                  <button disabled={busy} onClick={() => confirm.mutate('cancel')} className="underline disabled:opacity-50">Cancel checkout</button>
                  <p className="text-sm break-all w-full">Checkout reference: <span className="font-mono">{cart.checkoutId}</span>. Keep this private.</p>
                </div>}
              </div>
            )}
            {!cart.items.length && !busy && <p>No items to check out. <Link className="underline" to="/products">Browse products</Link></p>}
            <Link to="/cart" className="inline-block underline mt-6">Back to cart</Link>
          </>
        )}
      </div>
    </section>
  );
}
