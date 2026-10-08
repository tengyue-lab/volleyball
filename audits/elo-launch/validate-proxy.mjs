/** Short actual 12/13/14-player comparison, not a long-run replacement study. */
import { writeFileSync } from 'node:fs';
import { balanceMatchTeams, assignMatchRoles, balanceAssignedTeams } from '../../artifacts/volleyball-manager/src/match-balancing.ts';
import { randomGenerator, mean } from './model.mjs';

const roles = ['Setter', 'Outside Hitter', 'Middle Blocker', 'Opposite', 'Libero'];
const cases = [];
for (const size of [12, 13, 14]) for (let seed = 1; seed <= 8; seed += 1) {
  const rng = randomGenerator(seed * 20261);
  const players = Array.from({ length: size }, (_, i) => {
    const primary = roles[i % 5];
    const others = roles.filter((r) => r !== primary);
    return {
      id: i + 1, elo: 600 + Math.floor(rng() * 600), positions: [primary, others[Math.floor(rng() * 4)]],
      preferencesConfirmed: true, preferredRolePriority: rng() < 0.25,
      prioritySince: String(i).padStart(8, '0'),
    };
  });
  const start = performance.now();
  const actual = balanceMatchTeams(players);
  const actualMs = performance.now() - start;
  const shuffled = players.map((p) => ({ p, key: rng() })).sort((a, b) => a.key - b.key).map((x) => x.p);
  const a = shuffled.slice(0, Math.floor(size / 2)).map((p) => p.id);
  const b = shuffled.slice(Math.floor(size / 2)).map((p) => p.id);
  const assignment = assignMatchRoles(players, a, b);
  const proxy = balanceAssignedTeams(players, { ...assignment, teamAIds: a, teamBIds: b }, []);
  const averageGap = (result) => {
    const rating = (ids) => mean(ids.map((id) => players.find((p) => p.id === id).elo));
    return Math.abs(rating(result.teamAIds) - rating(result.teamBIds));
  };
  cases.push({ size, seed, actualMs, actualPreferred: actual.preferredCount, proxyPreferred: proxy.preferredCount,
    actualGap: averageGap(actual), proxyGap: averageGap(proxy) });
}
writeFileSync('audits/elo-launch/results/proxy-validation.json', JSON.stringify(cases, null, 2));
console.log(JSON.stringify(cases.reduce((acc, row) => {
  const group = acc[row.size] ?? [];
  group.push(row);
  acc[row.size] = group;
  return acc;
}, {})));
