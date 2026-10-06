import type { RankLabel } from '@workspace/api-client-react';

const TIER_COLORS: Record<string, string> = {
  Iron: '#5d646a', Bronze: '#8d491c', Silver: '#566a78', Gold: '#7a5b0c',
  Platinum: '#1f6a68', Diamond: '#2c5a99', Masters: '#9b3542',
};

export function RankBadge({ rank, provisional = false, rating, testId }: { rank: RankLabel | null | undefined; provisional?: boolean; rating?: number; testId?: string }) {
  if (!rank) return <span className="rank-note" data-testid={testId}>Not recorded</span>;
  const color = TIER_COLORS[rank.split(' ')[0]] ?? '#5d646a';
  return <span className="rank-badge-wrap" data-testid={testId}>
    <span className="rank-label-and-rating"><span className="rank-badge" style={{ color, borderColor: color, background: `${color}14` }}>{rank}</span>{rating !== undefined && <span className="rating"> — {rating.toLocaleString()}</span>}</span>
    {provisional && <span className="rank-badge rank-provisional">Provisional</span>}
  </span>;
}

export type RankMovement = 'promotion' | 'demotion' | 'unchanged' | null | undefined;

export function RankTransition({ before, after, movement, provisional = false }: { before: RankLabel | null | undefined; after: RankLabel | null | undefined; movement: RankMovement; provisional?: boolean }) {
  if (!before && !after) return <span className="rank-note">Not recorded</span>;
  return <div className="rank-transition" role="group" aria-label={`${before ?? 'Not recorded'} to ${after ?? 'Not recorded'}`} data-movement={movement ?? 'unknown'}>
    <RankBadge rank={before} /><span aria-hidden="true">→</span><RankBadge rank={after} provisional={provisional} />
    {movement === 'promotion' && <strong className="rank-promotion">Promotion</strong>}
    {movement === 'demotion' && <strong className="rank-demotion">Demotion</strong>}
  </div>;
}

export default RankBadge;
