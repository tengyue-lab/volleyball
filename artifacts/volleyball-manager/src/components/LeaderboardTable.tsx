import type { LeaderboardEntry } from '@workspace/api-client-react';

function PlayerDetails({ player }: { player: LeaderboardEntry }) {
  return <div className="podium-player-details">
    <strong className="podium-player-name">{player.name}</strong>
    <span className="podium-player-position" title={player.mostPlayedPosition ? undefined : 'Position history unavailable'}>
      {player.mostPlayedPosition ?? '—'}
    </span>
    <span className="leaderboard-tier">{player.tier}</span>
  </div>;
}

export default function LeaderboardTable({ players }: { players: LeaderboardEntry[] }) {
  const podiumPlaces = [2, 1, 3];
  const lowerPlaces = players.filter((player) => player.placement > 3)
    .sort((a, b) => a.placement - b.placement);

  return <div className="community-leaderboard" aria-label="Public top five leaderboard" data-testid="leaderboard-top-five">
    <ol className="leaderboard-podium" aria-label="Top three podium">
      {podiumPlaces.map((place) => {
        const player = players.find((candidate) => candidate.placement === place);
        return player ? <li className={`podium-player podium-place-${place}`} key={player.id} data-testid={`leaderboard-place-${place}`}>
          <PlayerDetails player={player} />
          <div className="podium-block" aria-label={`Place number ${place}`}>
            <span className="podium-place-number">#{place}</span>
          </div>
        </li> : <li className="podium-player podium-player-empty" key={`empty-${place}`} aria-hidden="true" />;
      })}
    </ol>
    {lowerPlaces.length > 0 && <ol className="leaderboard-lower-places" aria-label="Fourth and fifth place">
      {lowerPlaces.map((player) => <li className="leaderboard-lower-row" key={player.id} data-testid={`leaderboard-place-${player.placement}`}>
        <span className="leaderboard-lower-number">#{player.placement}</span>
        <PlayerDetails player={player} />
      </li>)}
    </ol>}
  </div>;
}
