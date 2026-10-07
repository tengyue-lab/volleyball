import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignMatchRoles,
  balanceMatchTeams,
  balanceAssignedTeams,
  fillMatchTeams,
  MATCH_POSITIONS,
  validateMatchLocks,
} from '../src/match-balancing.ts';
import { preferredLockPositions } from '../src/match-lock-options.ts';
import { getManualSwapCandidates, swapManualTeamMembers } from '../src/match-swap.ts';

const OLD_ROLE_POOL = [
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
const alternatives = {
  Setter: ['Outside Hitter', 'Opposite'],
  'Outside Hitter': ['Middle Blocker', 'Opposite'],
  'Middle Blocker': ['Outside Hitter', 'Opposite'],
  Opposite: ['Outside Hitter', 'Middle Blocker'],
  Libero: ['Outside Hitter', 'Middle Blocker'],
};
function ranked(player) {
  return {...player, positions: [...player.positions, ...alternatives[player.positions[0]]], preferencesConfirmed: true};
}
const ROLE_POOL = OLD_ROLE_POOL.map(ranked);

const SIX_PLAYER_FORMATION = {
  Setter: 1,
  'Outside Hitter': 2,
  'Middle Blocker': 2,
  Opposite: 1,
};

test('Lock Position choices follow each player’s own saved preference order without modifying it', () => {
  const setterPreferences = Object.freeze(['Setter', 'Outside Hitter', 'Opposite']);
  const middlePreferences = Object.freeze(['Middle Blocker', 'Opposite', 'Outside Hitter']);

  assert.deepEqual(preferredLockPositions(setterPreferences), setterPreferences);
  assert.deepEqual(preferredLockPositions(middlePreferences), middlePreferences);
  assert.notDeepEqual(preferredLockPositions(setterPreferences), preferredLockPositions(middlePreferences));
  assert.deepEqual(preferredLockPositions(['Setter', 'not-a-role', 'Libero']), ['Setter', 'Libero']);
  assert.deepEqual(MATCH_POSITIONS.filter((position) => !setterPreferences.includes(position)), ['Middle Blocker', 'Libero']);
});

test('manual swap candidates allow any unlocked opponent but honor locked roles exactly', () => {
  assert.deepEqual(getManualSwapCandidates(1, [1, 2], [3, 4, 5], []), [3, 4, 5]);

  const locks = [
    { playerId: 1, team: 'A', position: 'Setter' },
    { playerId: 3, team: 'B', position: 'Outside Hitter' },
    { playerId: 4, team: 'B', position: 'Setter' },
    { playerId: 5, team: 'B', position: 'Middle Blocker' },
  ];
  assert.deepEqual(getManualSwapCandidates(1, [1, 2], [3, 4, 5], locks), [4]);
  assert.deepEqual(getManualSwapCandidates(1, [1, 2], [3], locks.slice(0, 1)), []);
  assert.deepEqual(getManualSwapCandidates(1, [1, 2], [5], [locks[0], locks[3]]), []);
});

test('manual swap exchanges only the two team memberships and carries locks with their players', () => {
  const teamA = [1, 2];
  const teamB = [3, 4];
  const pool = [1, 2, 3, 4, 5];
  const locks = [
    { playerId: 1, team: 'A', position: 'Setter' },
    { playerId: 3, team: 'B', position: 'Setter' },
    { playerId: 4, team: 'B', position: 'Outside Hitter' },
  ];
  const swapped = swapManualTeamMembers(1, 3, teamA, teamB, locks);

  assert.deepEqual(swapped, {
    teamA: [3, 2],
    teamB: [1, 4],
    locks: [
      { playerId: 1, team: 'B', position: 'Setter' },
      { playerId: 3, team: 'A', position: 'Setter' },
      { playerId: 4, team: 'B', position: 'Outside Hitter' },
    ],
  });
  assert.deepEqual(teamA, [1, 2]);
  assert.deepEqual(teamB, [3, 4]);
  assert.deepEqual(pool, [1, 2, 3, 4, 5]);
  assert.equal(swapManualTeamMembers(1, 4, teamA, teamB, locks), null);
  assert.equal(swapManualTeamMembers(1, 2, teamA, teamB, locks), null);
});

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
    ranked({ id: 13, positions: ['Outside Hitter'], elo: 1000 }),
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
    ranked({ id: 13, positions: ['Libero'], elo: 1000 }),
    ranked({ id: 14, positions: ['Libero'], elo: 1000 }),
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
    positions: ['Setter', 'Outside Hitter', 'Middle Blocker'],
    preferencesConfirmed: true,
    elo: 800 + index * 25,
  }));
  const result = balanceMatchTeams(pool);
  const byId = assignmentsById(result);

  assertFormation(result.teamAAssignments, 6);
  assertFormation(result.teamBAssignments, 6);
  assert.equal(result.preferredCount, 10);
  assert.deepEqual(result.positionShortages, [
    { position: 'Opposite', filledCount: 2 },
  ]);
  assert.deepEqual(
    [...byId.values()].filter((assignment) => assignment.assignmentStatus === 'filled')
      .map((assignment) => assignment.playerId).sort((a, b) => a - b),
    [11, 12],
  );
  assert.equal([...byId.values()].some((assignment) => assignment.assignedPosition === 'Libero'), false);
});

test('manual teams receive exact roles without changing their team membership', () => {
  const pool = [
    ...ROLE_POOL,
    ranked({ id: 13, positions: ['Libero'], elo: 1000 }),
    ranked({ id: 14, positions: ['Libero'], elo: 1000 }),
  ];
  const teamAIds = [1, 3, 4, 7, 8, 11, 13];
  const teamBIds = pool.map((player) => player.id).filter((id) => !teamAIds.includes(id));
  const result = assignMatchRoles(pool, teamAIds, teamBIds);

  assert.deepEqual(result.teamAAssignments.map((assignment) => assignment.playerId).sort((a, b) => a - b), teamAIds.sort((a, b) => a - b));
  assert.deepEqual(result.teamBAssignments.map((assignment) => assignment.playerId).sort((a, b) => a - b), teamBIds.sort((a, b) => a - b));
  assertFormation(result.teamAAssignments, 7);
  assertFormation(result.teamBAssignments, 7);
});

test('rank order materially changes positions, not just boolean eligibility', () => {
  const original = assignmentsById(balanceMatchTeams(ROLE_POOL));
  assert.equal(original.get(1).assignedPosition, 'Setter');
  assert.equal(original.get(3).assignedPosition, 'Outside Hitter');
  const pool = ROLE_POOL.map((p) => p.id === 1 ? {...p, positions: ['Outside Hitter', 'Setter', 'Opposite']} :
    p.id === 3 ? {...p, positions: ['Setter', 'Outside Hitter', 'Middle Blocker']} : p);
  const changed = assignmentsById(balanceMatchTeams(pool));
  assert.equal(changed.get(1).assignedPosition, 'Outside Hitter');
  assert.equal(changed.get(3).assignedPosition, 'Setter');
});

test('specialist is protected against equally ranked flexible player', () => {
  const pool = ROLE_POOL.map((p) => ({...p, elo: 1000}));
  pool[0].positions = ['Setter', 'Outside Hitter', 'Opposite'];
  pool[2].positions = ['Setter', 'Outside Hitter', 'Middle Blocker', 'Opposite', 'Libero'];
  const result = assignmentsById(balanceMatchTeams(pool));
  assert.equal(result.get(1).assignedPosition, 'Setter');
  assert.equal(result.get(3).assignedPosition, 'Outside Hitter');
});

test('input shuffle has no effect on canonical output for 12, 13 and 14', () => {
  for (const n of [12, 13, 14]) {
    const pool = [...ROLE_POOL, ranked({id:13, positions:['Libero'],elo:5000}),
      ranked({id:14, positions:['Libero'],elo:0})].slice(0,n);
    const result = balanceMatchTeams(pool);
    assert.deepEqual(balanceMatchTeams([...pool].reverse()), result);
  }
});

test('confirmation, 1–5 unique supported ranks and zero Setter are hard gates', () => {
  for (const change of [
    {preferencesConfirmed:false}, {positions:[]},
    {positions:['Setter','Outside Hitter','Middle Blocker','Opposite','Libero','Setter']},
    {positions:['Setter','Setter','Opposite']}, {positions:['Setter','Unsupported','Opposite']},
  ]) assert.throws(() => balanceMatchTeams(ROLE_POOL.map((p,i) => i === 0 ? {...p,...change} : p)), /confirm/);
  assert.throws(() => balanceMatchTeams(ROLE_POOL.map((p) => ({...p, positions:['Outside Hitter','Middle Blocker','Opposite']}))), /Setter/);
  assert.throws(() => balanceMatchTeams(ROLE_POOL.slice(0,11)), /12/);
  assert.throws(() => balanceMatchTeams([...ROLE_POOL.slice(0,11), ROLE_POOL[0]]), /duplicate/);
});

const SINGLE_ROLE_POOL = OLD_ROLE_POOL.map((p) => ({...p, preferencesConfirmed:true}));
const locked = (playerId, team, position) => ({playerId,team,position});

test('single-preference profiles match without invented alternatives and preserve auto output', () => {
  const before = structuredClone(SINGLE_ROLE_POOL);
  const result = balanceMatchTeams(SINGLE_ROLE_POOL);
  assert.equal(result.preferredCount,12);
  assert.equal(result.totalEloGap,0);
  assertFormation(result.teamAAssignments,6); assertFormation(result.teamBAssignments,6);
  assert.deepEqual(SINGLE_ROLE_POOL,before);
  assert.deepEqual(fillMatchTeams(ROLE_POOL,[]),balanceMatchTeams(ROLE_POOL));
  for (const a of assignmentsById(result).values()) assert.equal(a.preferenceRank,1);
});

test('single-preference contested roles keep Filled fallback and compensation scoring', () => {
  const pool = SINGLE_ROLE_POOL.map((p) => ({...p,positions:['Setter'],elo:1000+p.id,
    preferredRolePriority:p.id===1,prioritySince:p.id===1?'2026-01-01':null}));
  const result = fillMatchTeams(pool,[]);
  assert.equal(result.preferredCount,2);
  assert.equal(assignmentsById(result).get(1).assignedPosition,'Setter');
  assert.equal(result.positionShortages.reduce((n,s) => n+s.filledCount,0),10);
});

test('lock validity and formation capacity allow two OH/MB, never two S or unselected roles', () => {
  const base = [locked(3,'A','Outside Hitter'),locked(4,'A','Outside Hitter')];
  assert.doesNotThrow(() => validateMatchLocks(SINGLE_ROLE_POOL,base));
  assert.doesNotThrow(() => validateMatchLocks(SINGLE_ROLE_POOL,[locked(7,'B','Middle Blocker'),locked(8,'B','Middle Blocker')]));
  assert.throws(() => validateMatchLocks(SINGLE_ROLE_POOL,[...base,locked(5,'A','Outside Hitter')]),/Team A: Outside Hitter.*only 2/);
  assert.throws(() => validateMatchLocks(SINGLE_ROLE_POOL,[locked(1,'A','Setter'),locked(2,'A','Setter')]),/Team A: Setter.*only 1/);
  assert.throws(() => validateMatchLocks(SINGLE_ROLE_POOL,[locked(3,'A','Setter')]),/ranked preferences/);
  assert.throws(() => validateMatchLocks(SINGLE_ROLE_POOL,[locked(1,'A','Setter'),locked(1,'B','Setter')]),/multiple/);
  assert.throws(() => validateMatchLocks(SINGLE_ROLE_POOL,[locked(99,'A','Setter')]),/selected pool/);
});

test('Fill preserves every locked team and role, frees unlocked membership, and is deterministic', () => {
  const locks = [locked(1,'A','Setter'),locked(3,'A','Outside Hitter'),locked(4,'A','Outside Hitter'),
    locked(2,'B','Setter'),locked(7,'B','Middle Blocker')];
  const beforePool=structuredClone(SINGLE_ROLE_POOL), beforeLocks=structuredClone(locks);
  const result=fillMatchTeams(SINGLE_ROLE_POOL,locks), roles=assignmentsById(result);
  for (const lock of locks) {
    assert.ok((lock.team==='A'?result.teamAIds:result.teamBIds).includes(lock.playerId));
    assert.equal(roles.get(lock.playerId).assignedPosition,lock.position);
    assert.equal(roles.get(lock.playerId).assignmentStatus,'preferred');
    assert.equal(roles.get(lock.playerId).preferenceRank,1);
  }
  assertFormation(result.teamAAssignments,6); assertFormation(result.teamBAssignments,6);
  assert.equal(result.preferredCount,12);
  assert.deepEqual(fillMatchTeams([...SINGLE_ROLE_POOL].reverse(),[...locks].reverse()),result);
  assert.deepEqual(SINGLE_ROLE_POOL,beforePool); assert.deepEqual(locks,beforeLocks);
});

test('ELO balancing excludes locked players and preserves all assigned ranks/statuses', () => {
  const a=[2,5,6,9,10,12],b=[1,3,4,7,8,11];
  const roster={...assignMatchRoles(SINGLE_ROLE_POOL,a,b),teamAIds:a,teamBIds:b};
  const locks=[locked(2,'A','Setter'),locked(12,'A','Opposite')];
  const result=balanceAssignedTeams(SINGLE_ROLE_POOL,roster,locks);
  assert.ok(result.teamAIds.includes(2)); assert.ok(result.teamAIds.includes(12));
  assert.ok(result.totalEloGap<roster.totalEloGap);
  assert.deepEqual(assignmentsById(result),assignmentsById(roster));
  const allLocks=[...roster.teamAAssignments.map((a)=>locked(a.playerId,'A',a.assignedPosition)),
    ...roster.teamBAssignments.map((a)=>locked(a.playerId,'B',a.assignedPosition))];
  const frozen=balanceAssignedTeams(SINGLE_ROLE_POOL,roster,allLocks);
  assert.equal(frozen.totalEloGap,roster.totalEloGap);
  assert.deepEqual([...frozen.teamAIds].sort((a,b)=>a-b),[...a].sort((a,b)=>a-b));
  assert.throws(()=>balanceAssignedTeams(SINGLE_ROLE_POOL,roster,[locked(1,'A','Setter')]),/keep their team and position/);
});

test('a non-first preferred role may be locked and retains its exact saved rank', () => {
  const player=ROLE_POOL[0], position=player.positions[1];
  const result=fillMatchTeams(ROLE_POOL,[locked(player.id,'A',position)]);
  const role=assignmentsById(result).get(player.id);
  assert.equal(role.assignedPosition,position);
  assert.equal(role.assignmentStatus,'preferred');
  assert.equal(role.preferenceRank,2);
});

test('Libero locks enforce team sizes and report the impossible slot clearly', () => {
  const pool=[...SINGLE_ROLE_POOL,{id:13,positions:['Libero'],elo:1000,preferencesConfirmed:true},
    {id:14,positions:['Libero'],elo:1000,preferencesConfirmed:true}];
  assert.throws(()=>fillMatchTeams(pool.slice(0,13),[locked(13,'A','Libero'),locked(3,'B','Libero')]),/ranked preferences/);
  const twoLiberoPool=pool.slice(0,13).map((p)=>p.id===3?{...p,positions:['Libero','Outside Hitter']}:p);
  assert.throws(()=>fillMatchTeams(twoLiberoPool,[locked(13,'A','Libero'),locked(3,'B','Libero')]),/only one Libero slot/);
  const twelve=pool.filter((p)=>![11,12].includes(p.id));
  assert.throws(()=>fillMatchTeams(twelve,[locked(13,'A','Libero')]),/Libero.*only 0/);
  const thirteen=fillMatchTeams(pool.slice(0,13),[locked(13,'B','Libero')]);
  assert.equal(thirteen.teamBIds.length,7); assert.ok(thirteen.teamBIds.includes(13));
  assert.equal(assignmentsById(thirteen).get(13).assignedPosition,'Libero');
  const fourteen=fillMatchTeams(pool,[locked(13,'A','Libero'),locked(14,'B','Libero')]);
  assertFormation(fourteen.teamAAssignments,7); assertFormation(fourteen.teamBAssignments,7);
});

test('one eligible Setter permits the second Setter to be Filled', () => {
  const pool = ROLE_POOL.map((p) => p.id === 2 ? {...p, positions:['Outside Hitter','Middle Blocker','Opposite']} : p);
  const result = balanceMatchTeams(pool);
  assert.equal(result.positionShortages.find((s) => s.position === 'Setter').filledCount, 1);
  assertFormation(result.teamAAssignments, 6);
  assertFormation(result.teamBAssignments, 6);
});

test('ELO Balancer improves fixed-role roster without changing ranks or statuses', () => {
  const a = [2,5,6,9,10,12], b = [1,3,4,7,8,11];
  const roles = assignMatchRoles(ROLE_POOL,a,b);
  const initial = {...roles, teamAIds:a,teamBIds:b};
  const balanced = balanceAssignedTeams(ROLE_POOL, initial);
  assert.ok(balanced.totalEloGap < initial.totalEloGap);
  assert.deepEqual(assignmentsById(balanced), assignmentsById(initial));
  assert.equal(balanced.rankCost, initial.rankCost);
});

test('priority grants one-rank top-choice bonus and ELO/wait/ID resolve contention', () => {
  const pool = ROLE_POOL.map((p) => ({...p, elo:1000}));
  pool[2].positions = ['Setter','Outside Hitter','Middle Blocker'];
  for (const [highId, olderId, expected] of [[3,1,3],[1,3,1],[null,3,3],[null,null,1]]) {
    const pending = pool.map((p) => [1,3].includes(p.id) ? {...p,
      preferredRolePriority:true, elo:p.id === highId ? 1500 : 1000,
      prioritySince:p.id === olderId ? '2026-01-01T00:00:00Z' : '2026-02-01T00:00:00Z'} : p);
    // Both contenders are on one fixed side, so only one Setter slot is
    // available to them. Auto-splitting can legally give both a Setter slot.
    const result = assignMatchRoles(pending,[1,3,4,7,8,11],[2,5,6,9,10,12]), byId = assignmentsById(result);
    assert.equal(byId.get(expected).assignedPosition,'Setter');
    assert.equal(byId.get(expected === 1 ? 3 : 1).assignedPosition,'Outside Hitter');
    assert.equal(result.rankCost, 0);
    assertFormation(result.teamAAssignments,6); assertFormation(result.teamBAssignments,6);
  }
});

test('priority cannot turn an unselected role into Preferred and does not mutate players', () => {
  const pool = Array.from({length:12}, (_,i) => ({id:i+1,elo:1000+i,
    positions:['Setter','Outside Hitter','Middle Blocker'],preferencesConfirmed:true,
    preferredRolePriority:true,prioritySince:'2026-01-01T00:00:00Z'}));
  const before = structuredClone(pool);
  const result = balanceMatchTeams(pool);
  assert.deepEqual(pool,before);
  for (const a of assignmentsById(result).values()) {
    const p = pool.find((p) => p.id === a.playerId);
    assert.equal(a.assignmentStatus, p.positions.includes(a.assignedPosition) ? 'preferred' : 'filled');
    assert.equal(a.preferenceRank, a.assignmentStatus === 'filled' ? null : p.positions.indexOf(a.assignedPosition)+1);
  }
});
