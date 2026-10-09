export function formatRankRange(tier: string, minElo: number, maxElo: number | null) {
  if (tier === 'Iron' && minElo === 0 && maxElo === 849) return 'Below 850';
  return maxElo === null
    ? `${minElo.toLocaleString()}+`
    : `${minElo.toLocaleString()}–${maxElo.toLocaleString()}`;
}
