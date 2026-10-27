import { StockProduct } from '../api/inventory';

export default function StockBadge({ product }: { product: StockProduct }) {
  const status = product.stockStatus === 'out_of_stock' ? 'Out of stock'
    : product.stockStatus === 'low_stock' ? 'Low stock' : 'In stock';
  return (
    <p className="my-3 flex flex-wrap items-baseline gap-2 text-sm" aria-label={`${product.name} stock`}>
      <span className={`rounded px-2 py-1 font-semibold ${
        product.stockStatus === 'out_of_stock' ? 'bg-red-100 text-red-800'
          : product.stockStatus === 'low_stock' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'
      }`}>{status}</span>
      <span className="font-mono tabular-nums">{product.quantityOnHand} available</span>
    </p>
  );
}
