import { useQuery } from 'react-query';
import { fetchBranches } from '../api/inventory';

export default function BranchSelect({ branchId, onChange }: { branchId: number; onChange: (id: number) => void }) {
  const { data: branches, isLoading, error } = useQuery('branches', fetchBranches, { staleTime: 60_000 });
  return (
    <div>
      <label className="block text-sm font-medium mb-1" htmlFor="stock-branch">Stock at branch</label>
      <select id="stock-branch" value={branchId} disabled={isLoading || !!error}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded border border-gray-400 bg-white text-gray-800 px-3 py-2 focus:ring-2 focus:ring-primary">
        {!branches?.some((branch) => branch.branchId === branchId) && <option value={branchId}>Select a branch</option>}
        {branches?.map((branch) => <option key={branch.branchId} value={branch.branchId}>{branch.name}</option>)}
      </select>
      {error ? <p role="alert" className="text-red-600">Could not load branches. Refresh to try again.</p> : null}
    </div>
  );
}
