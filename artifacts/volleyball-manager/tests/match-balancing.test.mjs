import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceMatchTeams } from '../src/match-balancing.ts';

const ROLE_POOL = [
  { id: 1, positions: ['Setter'], elo: 500 },
  { id: 2, positions: ['Setter'], elo: 1500 },
  { id: 3, positions: ['Outside Hitter'], elo: 800 },
  { id: 4, positions: ['Outside Hitter'], elo: 900 },
  { id: 5, positions: ['Outside Hitter'], elo: 1100 },
  { id: 6, positions: ['Outside Hitter'], elo: 1200 },
  { id: 7, positions: ['Middle Blocker'], elo: 800 },
  { id: 8, positions: ['Middle Blocker'], elo: 900 },
  { id: 9, positions: ['Middle Blocker'], elo: 1100 },
  { id: 10, positions: ['Middle Blocker'], elo: 1200 },
  { id: 11, positions: ['Opposite'], elo: 500 },
  { id: 12, positions: ['Opposite'], elo: 1500 },
];

test('12-player pool gets complete formations, split setters, and the smallest total-ELO gap', () => {
  const result = balanceMatchTeams(ROLE_POOL);
  assert.equal(result.formationComplete, true);
  assert.equal(result.setterOverload, 0);
  assert.equal(result.liberoRuleSatisfied, true);
  assert.equal(result.totalEloGap, 0);
  assert.equal(result.teamAIds.length, 6);
  assert.equal(result.teamBIds.length, 6);
});

test('13-player pool puts the Libero on the lower or tied six-player core', () => {
  const pool = [
    ...ROLE_POOL.map((player) => player.id === 3 ? { ...player, elo: 500 } : player),
    { id: 13, positions: ['Libero'], elo: 1000 },
  ];
  const result = balanceMatchTeams(pool);
  const teamA = pool.filter((player) => result.teamAIds.includes(player.id));
  const teamB = pool.filter((player) => result.teamBIds.includes(player.id));
  const seven = teamA.length === 7 ? teamA : teamB;
  const six = teamA.length === 6 ? teamA : teamB;
  const libero = seven.find((player) => player.positions.includes('Libero'));

  assert.ok(libero);
  assert.equal(six.some((player) => player.positions.includes('Libero')), false);
  assert.equal(result.liberoRuleSatisfied, true);
  assert.equal(result.underdogCoreGetsLibero, true);
  assert.ok(seven.reduce((sum, player) => sum + player.elo, 0) - libero.elo <
    six.reduce((sum, player) => sum + player.elo, 0));
});

test('14-player pool assigns one Libero-capable player to each team', () => {
  const pool = [
    ...ROLE_POOL,
    { id: 13, positions: ['Libero'], elo: 1000 },
    { id: 14, positions: ['Libero'], elo: 1000 },
  ];
  const result = balanceMatchTeams(pool);
  const teamA = pool.filter((player) => result.teamAIds.includes(player.id));
  const teamB = pool.filter((player) => result.teamBIds.includes(player.id));

  assert.equal(result.formationComplete, true);
  assert.equal(result.liberoRuleSatisfied, true);
  assert.ok(teamA.some((player) => player.positions.includes('Libero')));
  assert.ok(teamB.some((player) => player.positions.includes('Libero')));
  assert.equal(teamA.length, 7);
  assert.equal(teamB.length, 7);
});

test('insufficient role positions return the best available split instead of failing', () => {
  const pool = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    positions: ['Setter'],
    elo: 1000,
  }));
  const result = balanceMatchTeams(pool);

  assert.equal(result.formationComplete, false);
  assert.equal(result.positionCoverage, 2);
  assert.equal(result.setterOverload, 10);
  assert.equal(result.teamAIds.length, 6);
  assert.equal(result.teamBIds.length, 6);
});