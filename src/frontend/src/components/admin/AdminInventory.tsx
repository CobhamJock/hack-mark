import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from 'react-query';
import { Navigate } from 'react-router-dom';
import { fetchStockProducts, inventoryError, StockProduct, updateStock } from '../../api/inventory';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import BranchSelect from '../BranchSelect';
import StockBadge from '../StockBadge';

function StockRow({ product, branchId, token }: { product: StockProduct; branchId: number; token: string }) {
  const [quantity, setQuantity] = useState(String(product.quantityOnHand));
  const [validation, setValidation] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation((count: number) => updateStock(branchId, product.productId, count, token), {
    onSuccess: () => queryClient.invalidateQueries(['products', branchId]),
  });
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d+$/.test(quantity) || Number(quantity) > 2147483647) {
      setValidation('Enter a non-negative whole number up to 2147483647.');
      return;
    }
    setValidation('');
    mutation.mutate(Number(quantity));
  };
  return (
    <li className="border-b border-gray-400 py-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
        <div>
          <h2 className="font-semibold">{product.name}</h2>
          <p className="font-mono text-sm">{product.sku}</p>
          <StockBadge product={product} />
        </div>
        <form onSubmit={save} className="flex flex-wrap gap-2 items-end">
          <div>
            <label htmlFor={`stock-${product.productId}`} className="block text-sm mb-1">Quantity on hand</label>
            <input id={`stock-${product.productId}`} type="number" min="0" max="2147483647" step="1"
              value={quantity} onChange={(event) => setQuantity(event.target.value)}
              className="w-32 rounded border border-gray-400 px-3 py-2 text-gray-800 bg-white focus:ring-2 focus:ring-primary"
              required aria-describedby={`stock-feedback-${product.productId}`} />
          </div>
          <button type="submit" disabled={!token || mutation.isLoading}
            className="rounded bg-primary px-4 py-2 text-gray-900 font-semibold disabled:opacity-50 focus:ring-2 focus:ring-primary">
            {mutation.isLoading ? 'Saving...' : 'Save stock'}
          </button>
        </form>
      </div>
      <div id={`stock-feedback-${product.productId}`}>
        {(validation || mutation.error) ? <p role="alert" className="text-red-600 mt-2">
          {validation || inventoryError(mutation.error)}
        </p> : null}
        {mutation.isSuccess && <p role="status" className="mt-2">Stock saved.</p>}
      </div>
    </li>
  );
}

export default function AdminInventory() {
  const { isAdmin } = useAuth();
  const { darkMode } = useTheme();
  const [branchId, setBranchId] = useState(1);
  const [token, setToken] = useState('');
  const products = useQuery(['products', branchId], () => fetchStockProducts(branchId), { enabled: isAdmin });
  if (!isAdmin) {
    return <Navigate to="/login" replace />;
  }
  return (
    <div className={`min-h-screen pt-24 px-4 pb-12 ${darkMode ? 'bg-dark text-light' : 'bg-gray-100 text-gray-800'}`}>
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Branch inventory</h1>
        <p className="mb-6">Count what is on hand, then update the selected branch. Low stock means 5 or fewer available.</p>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end mb-6">
          <BranchSelect branchId={branchId} onChange={setBranchId} />
          <div>
            <label htmlFor="inventory-token" className="block text-sm font-medium mb-1">Inventory administrator token</label>
            <input id="inventory-token" type="password" autoComplete="off" value={token}
              onChange={(event) => setToken(event.target.value)}
              className="rounded border border-gray-400 bg-white text-gray-800 px-3 py-2 focus:ring-2 focus:ring-primary" />
          </div>
        </div>
        <p className="text-sm mb-4">The token is used only for stock updates and is not saved in browser storage.</p>
        {products.isLoading && <p role="status">Loading inventory...</p>}
        {products.error ? <p role="alert">{inventoryError(products.error)}</p> : null}
        {products.data?.length === 0 && <p>No products yet. Add products before recording stock.</p>}
        <ul>{products.data?.map((product) => <StockRow key={`${branchId}-${product.productId}`}
          product={product} branchId={branchId} token={token} />)}</ul>
      </div>
    </div>
  );
}
