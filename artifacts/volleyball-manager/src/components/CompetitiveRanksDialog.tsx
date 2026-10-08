import { useState } from 'react';
import { getGetRankTiersQueryKey, useGetRankTiers } from '@workspace/api-client-react';
import { Info } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

function formatEloRange(minElo: number, maxElo: number | null) {
  return maxElo === null
    ? `${minElo.toLocaleString()}+`
    : `${minElo.toLocaleString()}–${maxElo.toLocaleString()}`;
}

export default function CompetitiveRanksDialog({ testId }: { testId: string }) {
  const [open, setOpen] = useState(false);
  const rangesQuery = useGetRankTiers({
    query: { queryKey: getGetRankTiersQueryKey(), enabled: open, retry: false },
  });

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <button
        type="button"
        className="rank-info-trigger"
        aria-label="View competitive rank ELO ranges"
        data-testid={testId}
      >
        <Info size={15} aria-hidden="true" />
      </button>
    </DialogTrigger>
    <DialogContent className="rank-info-dialog w-[calc(100vw-2rem)] max-w-md p-5 sm:p-6">
      <DialogHeader>
        <DialogTitle>Competitive Ranks</DialogTitle>
      </DialogHeader>
      {rangesQuery.isLoading ? <div className="rank-range-state" role="status">Loading rank ranges…</div> :
        rangesQuery.isError ? <div className="rank-range-state" role="alert">
          <span>Rank ranges could not be loaded.</span>
          <button type="button" className="button button-secondary" onClick={() => void rangesQuery.refetch()}>Try again</button>
        </div> :
          <div className="rank-range-table-wrap">
            <table className="rank-range-table" aria-label="Competitive rank ELO ranges">
              <thead><tr><th scope="col">Rank</th><th scope="col">ELO Range</th></tr></thead>
              <tbody>{(rangesQuery.data ?? []).map((range) => <tr key={range.tier}>
                <th scope="row"><span className={`rank-range-tier rank-range-tier-${range.tier.toLowerCase()}`}>{range.tier}</span></th>
                <td>{formatEloRange(range.minElo, range.maxElo)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
    </DialogContent>
  </Dialog>;
}
