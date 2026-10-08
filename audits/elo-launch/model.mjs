/** Audit-only arithmetic. Never imported by the application. */
export const configurations = {
  current: { label: 'Four-stage 60/40/32/20', provisional: 60 },
  two64_24: { label: 'Two-stage 64/24', provisional: 64, established: 24 },
  two48_24: { label: 'Two-stage 48/24', provisional: 48, established: 24 },
  two64_32: { label: 'Two-stage 64/32', provisional: 64, established: 32 },
};

export function kFor(configuration, count) {
  if (count < 0) throw new Error('Invalid appearance count');
  if (configuration !== 'current') {
    return count < 10 ? configurations[configuration].provisional : configurations[configuration].established;
  }
  return count < 10 ? 60 : count < 30 ? 40 : count < 60 ? 32 : 20;
}

export function expectedWin(averageA, averageB, scale = 400) {
  const exponent = (averageB - averageA) / scale;
  return exponent > 308 ? 0 : exponent < -308 ? 1 : 1 / (1 + 10 ** exponent);
}

export function updatesFor(a, b, winnerA, configuration = 'current') {
  const average = (team) => team.reduce((sum, p) => sum + p.elo, 0) / team.length;
  const expectedA = expectedWin(average(a), average(b));
  return [...a.map((p) => [p, expectedA, Number(winnerA)]), ...b.map((p) => [p, 1 - expectedA, Number(!winnerA)])]
    .map(([player, expected, actual]) => {
      const k = kFor(configuration, player.matchesPlayed);
      const unrounded = player.elo + k * (actual - expected);
      const rounded = Math.floor(unrounded + 0.5);
      return {
        playerId: player.id, eloBefore: player.elo, eloAfter: Math.max(0, rounded),
        changeAmount: Math.max(0, rounded) - player.elo, kUsed: k,
        matchesPlayedBefore: player.matchesPlayed, matchesPlayedAfter: player.matchesPlayed + 1,
        unroundedChange: unrounded - player.elo, roundingChange: rounded - unrounded,
        floorChange: Math.max(0, rounded) - rounded,
      };
    });
}

export const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  return sorted[Math.floor(pos)] + (sorted[Math.ceil(pos)] - sorted[Math.floor(pos)]) * (pos % 1);
}
export const sd = (values) => values.length ? Math.sqrt(mean(values.map((x) => (x - mean(values)) ** 2))) : null;
function ranks(values) {
  const order = values.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value);
  const result = [];
  for (let start = 0; start < order.length;) {
    let end = start + 1;
    while (end < order.length && order[end].value === order[start].value) end += 1;
    for (let i = start; i < end; i += 1) result[order[i].i] = (start + end - 1) / 2;
    start = end;
  }
  return result;
}
export function correlation(x, y) {
  if (x.length < 3) return null;
  const mx = mean(x), my = mean(y), sx = sd(x), sy = sd(y);
  return sx && sy ? mean(x.map((v, i) => (v - mx) * (y[i] - my))) / (sx * sy) : null;
}
export const spearman = (players) => correlation(ranks(players.map((p) => p.skill)), ranks(players.map((p) => p.elo)));
export function pairAccuracy(players) {
  let correct = 0, count = 0;
  for (let i = 0; i < players.length; i += 1) for (let j = i + 1; j < players.length; j += 1) {
    const skillDifference = players[i].skill - players[j].skill;
    const ratingDifference = players[i].elo - players[j].elo;
    if (Math.abs(skillDifference) < 100) continue;
    count += 1;
    correct += ratingDifference === 0 ? 0.5 : Number(skillDifference * ratingDifference > 0);
  }
  return count ? correct / count : null;
}
export function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
