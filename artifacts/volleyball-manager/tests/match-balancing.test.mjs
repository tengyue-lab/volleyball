import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignMatchRoles,
  balanceMatchTeams,
} from '../src/match-balancing.ts';

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

const SIX_PLAYER_FORMATION = {
  Setter: 1,
  'Outside Hitter': 2,
  'Middle Blocker': 2,
  Opposite: 1,
};

function assertFormation(assignments, playerCount) {
  const counts = Object.fromEntries(
    assignments.map((assignment) => [
      assignment.assignedPosition,
      (assignments.filter((item) => item.assignedPosition === assignment.assignedPosition).length),
    ]),
  );
  const expected = {
    ...SIX_PLAYER_FORMATION,
    ...(playerCount === 7 ? { Libero: 1 } : {}),
  };
  assert.deepEqual(counts, expected);
  assert.equal(assignments.length, playerCount);
  assert.equal(new Set(assignments.map((assignment) => assignment.playerId)).size, playerCount);
}

function assignmentsById(result) {
  return new Map(
    [...result.teamAAssignments, ...result.teamBAssignments]
      .map((assignment) => [assignment.playerId, assignment]),
  );
}

test('12-player auto-balance assigns exact six-player formations and minimizes the ELO gap', () => {
  const result = balanceMatchTeams(ROLE_POOL);

  assertFormation(result.teamAAssignments, 6);
  assertFormation(result.teamBAssignments, 6);
  assert.equal(result.positionShortages.length, 0);
  assert.equal(result.preferredCount, 12);
  assert.equal(result.totalEloGap, 0);
  assert.equal(result.teamAIds.length, 6);
  assert.equal(result.teamBIds.length, 6);
  assert.equal(result.underdogCoreGetsLibero, null);
});

test('13-player pool gets a Filled Libero role on the seven-player team and keeps it with the lower core', () => {
  const pool = [
    ...ROLE_POOL,
    { id: 13, positions: ['Outside Hitter'], elo: 1000 },
  ];
  const result = balanceMatchTeams(pool);
  const sevenAssignments = result.teamAAssignments.length === 7
    ? result.teamAAssignments
    : result.teamBAssignments;
  const sixIds = result.teamAAssignments.length === 6 ? result.teamAIds : result.teamBIds;
  const teamSevenIds = result.teamAAssignments.length === 7 ? result.teamAIds : result.teamBIds;
  const sevenPlayers = pool.filter((player) => teamSevenIds.includes(player.id));
  const sixPlayers = pool.filter((player) => sixIds.includes(player.id));
  const liberoAssignment = sevenAssignments.find((assignment) =>
    assignment.assignedPosition === 'Libero',
  );

  assertFormation(sevenAssignments, 7);
  assertFormation(
    result.teamAAssignments.length === 6 ? result.teamAAssignments : result.teamBAssignments,
    6,
  );
  assert.ok(liberoAssignment);
  assert.equal(liberoAssignment.assignmentStatus, 'filled');
  assert.equal(
    [...result.teamAAssignments, ...result.teamBAssignments]
      .filter((assignment) => assignment.assignedPosition === 'Libero').length,
    1,
  );
  assert.equal(result.underdogCoreGetsLibero, true);
  const sevenCoreElo = sevenPlayers
    .filter((player) => player.id !== liberoAssignment.playerId)
    .reduce((sum, player) => sum + player.elo, 0);
  const sixElo = sixPlayers.reduce((sum, player) => sum + player.elo, 0);
  assert.ok(sevenCoreElo <= sixElo);
});

test('14-player pool assigns one of every role to each seven-player team', () => {
  const pool = [
    ...ROLE_POOL,
    { id: 13, positions: ['Libero'], elo: 1000 },
    { id: 14, positions: ['Libero'], elo: 1000 },
  ];
  const result = balanceMatchTeams(pool);

  assertFormation(result.teamAAssignments, 7);
  assertFormation(result.teamBAssignments, 7);
  assert.equal(result.positionShortages.length, 0);
  assert.equal(result.teamAIds.length, 7);
  assert.equal(result.teamBIds.length, 7);
  assert.equal(result.underdogCoreGetsLibero, null);
});

test('short roles are Filled by the highest-ELO available players and counted by position', () => {
  const pool = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    positions: ['Setter'],
    elo: 800 + index * 25,
  }));
  const result = balanceMatchTeams(pool);
  const byId = assignmentsById(result);

  assertFormation(result.teamAAssignments, 6);
  assertFormation(result.teamBAssignments, 6);
  assert.equal(result.preferredCount, 2);
  assert.deepEqual(result.positionShortages, [
    { position: 'Outside Hitter', filledCount: 4 },
    { position: 'Middle Blocker', filledCount: 4 },
    { position: 'Opposite', filledCount: 2 },
  ]);
  assert.deepEqual(
    [...byId.values()].filter((assignment) => assignment.assignmentStatus === 'preferred')
      .map((assignment) => assignment.playerId).sort((a, b) => a - b),
    [1, 2],
  );
  assert.equal([...byId.values()].some((assignment) => assignment.assignedPosition === 'Libero'), false);
});

test('manual teams receive exact roles without changing their team membership', () => {
  const pool = [
    ...ROLE_POOL,
    { id: 13, positions: ['Libero'], elo: 1000 },
    { id: 14, positions: ['Libero'], elo: 1000 },
  ];
  const teamAIds = [1, 3, 4, 7, 8, 11, 13];
  const teamBIds = pool.map((player) => player.id).filter((id) => !teamAIds.includes(id));
  const result = assignMatchRoles(pool, teamAIds, teamBIds);

  assert.deepEqual(result.teamAAssignments.map((assignment) => assignment.playerId).sort((a, b) => a - b), teamAIds.sort((a, b) => a - b));
  assert.deepEqual(result.teamBAssignments.map((assignment) => assignment.playerId).sort((a, b) => a - b), teamBIds.sort((a, b) => a - b));
  assertFormation(result.teamAAssignments, 7);
  assertFormation(result.teamBAssignments, 7);
});
