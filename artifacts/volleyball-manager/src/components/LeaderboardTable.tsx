import type { LeaderboardEntry } from '@workspace/api-client-react';

export default function LeaderboardTable({ players }: { players: LeaderboardEntry[] }) {
  const topFive = [...players]
    .sort((a, b) => a.placement - b.placement)
    .slice(0, 5);

  return <ol className="community-leaderboard leaderboard-list" aria-label="Public top five leaderboard" data-testid="leaderboard-top-five">
    {topFive.map((player) => <li
      className={`leaderboard-row leaderboard-place-${player.placement}`}
      key={player.id}
      data-testid={`leaderboard-place-${player.placement}`}
    >
      <span className="leaderboard-place-number">#{player.placement}</span>
      <div className="leaderboard-player-details">
        <strong className="leaderboard-player-name" title={player.name}>{player.name}</strong>
        <span className="leaderboard-player-position">{player.mostPlayedPosition ?? '—'}</span>
      </div>
      <span className={`leaderboard-tier leaderboard-tier-${player.tier.toLowerCase()}`}>{player.tier}</span>
    </li>)}
  </ol>;
}
