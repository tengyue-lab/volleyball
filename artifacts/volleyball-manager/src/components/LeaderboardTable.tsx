import type { LeaderboardEntry } from '@workspace/api-client-react';
import { RankBadge } from './RankBadge';

/** The API supplies rating order; public rows never need numeric ratings. */
export default function LeaderboardTable({ players }: { players: LeaderboardEntry[] }) {
  return <div className="table-wrap"><table className="data-table leaderboard-table" role="table" aria-label="Public player rankings">
    <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Rank</th><th role="columnheader" scope="col">Player</th><th role="columnheader" scope="col">Provisional status</th></tr></thead>
    <tbody role="rowgroup">{players.map((player) => <tr role="row" key={player.id} data-testid={`row-ranking-${player.id}`}>
      <td role="cell" data-label="Rank"><RankBadge rank={player.rank} testId={`badge-rank-${player.id}`} /></td>
      <td role="cell" data-label="Player"><div className="player-name">{player.name}</div></td>
      <td role="cell" data-label="Provisional status">{player.provisional && <span className="rank-badge rank-provisional">Provisional</span>}</td>
    </tr>)}</tbody>
  </table></div>;
}
