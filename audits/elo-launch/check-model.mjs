import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { updatesFor, kFor, expectedWin } from './model.mjs';

const cases = JSON.parse(readFileSync('/tmp/elo-audit-parity.json', 'utf8'));
for (const fixture of cases) {
  const actual = updatesFor(fixture.a, fixture.b, fixture.winnerA);
  for (let i = 0; i < actual.length; i += 1) {
    for (const key of ['playerId', 'eloBefore', 'eloAfter', 'changeAmount', 'kUsed', 'matchesPlayedBefore', 'matchesPlayedAfter']) {
      assert.equal(actual[i][key], fixture.expected[i][key], key);
    }
  }
}
for (const [n, k] of [[0, 60], [9, 60], [10, 40], [29, 40], [30, 32], [59, 32], [60, 20]]) assert.equal(kFor('current', n), k);
assert.equal(expectedWin(800, 800), 0.5);
assert.ok(expectedWin(1200, 800) > 0.9);
assert.equal(updatesFor([{ id: 1, elo: 0, matchesPlayed: 0 }], [{ id: 2, elo: 0, matchesPlayed: 60 }], false)[0].eloAfter, 0);
console.log(`PASS: ${cases.length} synthetic match fixtures agree with safely extracted production arithmetic; K boundaries, expected-win and floor checks pass.`);
