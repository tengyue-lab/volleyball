import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getManualSwapCandidates, preserveSwappedRoles, swapManualTeamMembers } from '../src/match-swap.ts';
import { fillMatchTeams, validateMatchLocks } from '../src/match-balancing.ts';
import {
  freshSession, clearDeletedMatchSession, restoreFailedDeletionSession, localToday, nextSession, nextGameSession, editSession, latestCompletedMatch, reconcileSession,
  resultActionsReady, selectionCanContinue, updateMatchSessionStep, validMatchDate, visiblePool,
} from '../src/match-session.ts';

const now = new Date(2026, 9, 7, 0, 15);
const createMatchSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const assignedPlayerSource = await readFile(new URL('../src/components/AssignedPlayer.tsx', import.meta.url), 'utf8');
const createMatchStyles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
const clearTeamStart = createMatchSource.indexOf('  function clearTeamAssignments()');
const clearTeamEnd = createMatchSource.indexOf('\n  function clearPlayerSelection()', clearTeamStart);
const clearTeamSource = createMatchSource.slice(clearTeamStart, clearTeamEnd);
const modeTransitionStart = createMatchSource.indexOf('  function backToTeamSelection()');
const modeTransitionEnd = createMatchSource.indexOf('\n  function fillManualTeams()', modeTransitionStart);
const modeTransitionSource = createMatchSource.slice(modeTransitionStart, modeTransitionEnd);
const modeTransitionsCompiled = await transformWithEsbuild(`
  export function makeModeTransitions(env) {
    const { teamA, teamB, locks, pendingMode, mode, setTeamA, setTeamB, setLocks,
      setBalanceResult, setBalancedProfiles, setSwapSelectionId, setCreateError,
      setSavedRolesInvalidated, setMode, setShowTeamModeSelection, setPendingMode } = env;
    ${clearTeamSource}
    ${modeTransitionSource}
    return { backToTeamSelection, cancelModeSwitch, confirmModeSwitch, changeMode };
  }`, 'team-mode-transitions.ts', { loader: 'ts', format: 'esm' });
const { makeModeTransitions } = await import(`data:text/javascript;base64,${Buffer.from(modeTransitionsCompiled.code).toString('base64')}`);
const pool = Array.from({ length: 14 }, (_, i) => ({
  id: i + 1, name: `Player ${String(i + 1).padStart(2, '0')}`,
  positions: i < 2 ? ['Setter', 'Opposite'] : ['Outside Hitter'],
  preferencesConfirmed: true, elo: 800 + i, preferredRolePriority: false,
}));
function completed(n = 14) {
  return {
    id: 9, status: 'completed', scoreA: 3, scoreB: 1, winner: 'Team A',
    matchDate: '2026-09-01', completedAt: '2026-10-07T00:00:00Z',
    teamA: structuredClone(pool.slice(0, 7)), teamB: structuredClone(pool.slice(7, n)),
  };
}
async function load(name) {
  const source = await readFile(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8');
  const out = await transformWithEsbuild(source, `${name}.tsx`, { loader: 'tsx', jsx: 'automatic', format: 'esm' });
  let code = out.code.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    .replaceAll('from "react"', `from ${JSON.stringify(import.meta.resolve('react'))}`);
  if (name === 'MatchDeleteConfirmation') {
    const dependency = await transformWithEsbuild(await readFile(new URL('../src/components/ConfirmDialog.tsx', import.meta.url), 'utf8'), 'ConfirmDialog.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
    const dep = dependency.code.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime'))).replaceAll('from "react"', `from ${JSON.stringify(import.meta.resolve('react'))}`);
    code = code.replace('"./ConfirmDialog"', JSON.stringify(`data:text/javascript;base64,${Buffer.from(dep).toString('base64')}`));
  }
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const history = await load('MatchHistoryDetails');
const MatchHistoryDetails = history.default;
const { default: ConfirmDialog } = await load('ConfirmDialog');
const { default: SavedRosterSummary } = await load('SavedRosterSummary');
const { default: MatchDeleteConfirmation } = await load('MatchDeleteConfirmation');

test('Create Match keeps Date, Players and Teams as distinct stages', () => {
  const shortcutStart = createMatchSource.indexOf('<aside className="panel next-game-shortcut"');
  const shortcutEnd = createMatchSource.indexOf('</aside>', shortcutStart);
  const dateStart = createMatchSource.indexOf('<section className="panel session-date"');
  const dateEnd = createMatchSource.indexOf('</section>', dateStart);
  const dateMarkup = createMatchSource.slice(dateStart, dateEnd);
  const balanceButtonMarker = createMatchSource.indexOf('data-testid="button-auto-balance"');
  const balanceButton = createMatchSource.slice(createMatchSource.lastIndexOf('<button', balanceButtonMarker), createMatchSource.indexOf('</button>', balanceButtonMarker));

  assert.ok(shortcutStart >= 0 && shortcutEnd > shortcutStart && shortcutStart < dateStart);
  assert.match(createMatchSource.slice(shortcutStart, shortcutEnd), /data-testid="button-next-game"/);
  assert.equal((dateMarkup.match(/data-testid="button-date-continue"/g) ?? []).length, 1);
  assert.ok(!dateMarkup.includes('Next Game'));
  assert.match(createMatchSource, /className="pool-selection" hidden=\{!stepVisibility\.players\} data-testid="step-player-selection"/);
  assert.match(createMatchSource, /className="team-step" hidden=\{!stepVisibility\.teams\} data-testid="step-team-assignment"/);
  assert.match(createMatchSource, /className="match-builder-layout" hidden=\{stepVisibility\.date\}/);
  assert.match(createMatchSource, /const \[mode, setMode\] = useState<'auto' \| 'manual' \| null>\(null\)/);
  assert.match(createMatchSource, /const \[showTeamModeSelection, setShowTeamModeSelection\] = useState\(true\)/);
  const chooserStart = createMatchSource.indexOf('{showTeamModeSelection ? <section className="team-mode-selection"');
  const builderStart = createMatchSource.indexOf(': <>', chooserStart);
  const chooser = createMatchSource.slice(chooserStart, builderStart);
  assert.match(chooser, /data-testid="button-mode-choice-auto"[\s\S]*Auto Balance[\s\S]*Automatically generate balanced teams\./);
  assert.match(chooser, /data-testid="button-mode-choice-manual"[\s\S]*Manual Selection[\s\S]*Build and assign teams yourself\./);
  assert.doesNotMatch(chooser, /Team A|Team B|button-auto-balance|button-fill/);
  assert.match(createMatchSource, /data-testid="button-auto-balance"/);
  assert.match(createMatchSource, /data-testid="button-fill"/);
  assert.match(createMatchSource, /{stepVisibility\.teams && !showTeamModeSelection && mode === 'auto' && <div className="pool-actions">/);
  assert.match(createMatchSource, /{stepVisibility\.teams && !showTeamModeSelection && mode === 'manual' && <>/);
  assert.match(createMatchSource, /{mode !== null && <div className="team-columns">/);
  assert.match(createMatchSource, /balanceMatchTeams\(selectedPlayers\)/);
  assert.match(balanceButton, /onClick=\{autoBalance\}/);
  assert.match(balanceButton, /Generate Balanced Teams/);
  assert.doesNotMatch(createMatchSource, /button-elo-balance|function eloBalance/);
});

function teamModeFixture(overrides = {}) {
  const state = {
    teamA: [1, 2], teamB: [3, 4], locks: [{ playerId: 1, team: 'A', position: 'Setter' }],
    balanceResult: { teamAIds: [1, 2], teamBIds: [3, 4] }, balancedProfiles: 'profiles',
    swapSelectionId: 1, createError: 'previous error', savedRolesInvalidated: false,
    mode: 'auto', showTeamModeSelection: false, pendingMode: null,
    selectedPlayerIds: Array.from({ length: 12 }, (_, index) => index + 1), matchDate: '2026-10-08',
    ...overrides,
  };
  const setters = Object.fromEntries([
    'TeamA', 'TeamB', 'Locks', 'BalanceResult', 'BalancedProfiles', 'SwapSelectionId',
    'CreateError', 'SavedRolesInvalidated', 'Mode', 'ShowTeamModeSelection', 'PendingMode',
  ].map((name) => {
    const key = name[0].toLowerCase() + name.slice(1);
    return [`set${name}`, (value) => { state[key] = value; }];
  }));
  return { state, actions: () => makeModeTransitions({ ...state, ...setters }) };
}

test('mode selection starts without team controls; choosing either mode opens only that mode’s builder', () => {
  const manual = teamModeFixture({ mode: null, showTeamModeSelection: true, teamA: [], teamB: [], locks: [] });
  manual.actions().changeMode('manual');
  assert.equal(manual.state.mode, 'manual');
  assert.equal(manual.state.showTeamModeSelection, false);
  assert.deepEqual(manual.state.selectedPlayerIds, Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(manual.state.matchDate, '2026-10-08');

  const automatic = teamModeFixture({ mode: null, showTeamModeSelection: true, teamA: [], teamB: [], locks: [] });
  automatic.actions().changeMode('auto');
  assert.equal(automatic.state.mode, 'auto');
  assert.equal(automatic.state.showTeamModeSelection, false);
});

test('back preserves assignments and switching mode requires confirmation before clearing them', () => {
  const f = teamModeFixture();
  const previous = structuredClone(f.state);
  f.actions().backToTeamSelection();
  assert.equal(f.state.showTeamModeSelection, true);
  assert.equal(f.state.mode, 'auto');
  for (const key of ['teamA', 'teamB', 'locks', 'selectedPlayerIds']) assert.deepEqual(f.state[key], previous[key]);
  assert.equal(f.state.matchDate, previous.matchDate);

  f.actions().changeMode('auto');
  assert.equal(f.state.showTeamModeSelection, false);
  assert.deepEqual(f.state.teamA, previous.teamA);
  f.actions().backToTeamSelection();
  f.actions().changeMode('manual');
  assert.equal(f.state.pendingMode, 'manual');
  assert.deepEqual(f.state.teamA, previous.teamA);
  assert.deepEqual(f.state.teamB, previous.teamB);
  assert.deepEqual(f.state.locks, previous.locks);
  assert.match(createMatchSource, /pendingMode !== null && <ConfirmDialog[^>]+title="Switch team mode\?"/);
  assert.match(createMatchSource, /Switching modes will discard your current team assignments and role locks\. Continue\?/);

  f.actions().cancelModeSwitch();
  assert.equal(f.state.pendingMode, null);
  assert.deepEqual(f.state.teamA, previous.teamA);
  f.actions().changeMode('manual');
  f.actions().confirmModeSwitch();
  assert.equal(f.state.mode, 'manual');
  assert.equal(f.state.showTeamModeSelection, false);
  assert.deepEqual(f.state.teamA, []);
  assert.deepEqual(f.state.teamB, []);
  assert.deepEqual(f.state.locks, []);
  assert.equal(f.state.balanceResult, null);
  assert.deepEqual(f.state.selectedPlayerIds, previous.selectedPlayerIds);
  assert.equal(f.state.matchDate, previous.matchDate);
});

test('team mode choices stack at phone widths and keep 44-pixel tap targets', () => {
  assert.match(createMatchStyles, /\.team-mode-choice-grid\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,230px\),1fr\)\)/);
  assert.match(createMatchStyles, /@media\(max-width:600px\)\{[\s\S]*?\.team-mode-choice-grid\{grid-template-columns:1fr\}/);
  assert.match(createMatchStyles, /\.team-mode-card\{[^}]*min-height:96px/);
  assert.match(createMatchStyles, /\.team-mode-icon\{width:44px;height:44px/);
});

test('Players Clear Selection and Teams Clear Selection have separate effects', () => {
  const teamClear = createMatchSource.match(/function clearTeamAssignments\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  const playerClear = createMatchSource.match(/function clearPlayerSelection\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';

  assert.match(teamClear, /setTeamA\(\[\]\)/);
  assert.match(teamClear, /setTeamB\(\[\]\)/);
  assert.match(teamClear, /setLocks\(\[\]\)/);
  assert.match(teamClear, /setBalanceResult\(null\)/);
  assert.doesNotMatch(teamClear, /setSelectedPlayerIds|setDraft|updateMatchSessionStep/);

  assert.match(playerClear, /setSelectedPlayerIds\(\[\]\)/);
  assert.match(playerClear, /clearTeamAssignments\(\)/);
  assert.match(createMatchSource, /onClick=\{clearPlayerSelection\}[^>]*data-testid="button-clear-pool"/);
  assert.equal((createMatchSource.match(/onClick=\{clearTeamAssignments\}[^>]*data-testid="button-clear-teams"/g) ?? []).length, 2);
  assert.match(createMatchSource, /stepVisibility\.teams && !showTeamModeSelection && mode === 'auto'/);
  assert.match(createMatchSource, /stepVisibility\.teams && !showTeamModeSelection && mode === 'manual'/);
});

test('Lock Position menu renders each player’s saved preferences through the ordered filter', () => {
  assert.match(assignedPlayerSource, /preferredLockPositions\(player\.positions\)/);
  assert.match(assignedPlayerSource, /lockOptions\.map\(\(position\) => <button/);
  assert.match(assignedPlayerSource, /onClick=\{\(\) => choose\(position\)\}/);
  assert.doesNotMatch(assignedPlayerSource, /MATCH_POSITIONS\.map/);
});

test('manual Swap Player uses lock-valid opposite-team candidates and preserves the selected pool', () => {
  const start = createMatchSource.indexOf('function swapPlayers(');
  const end = createMatchSource.indexOf('\n  function selectPlayerForSwap', start);
  const swapHandler = createMatchSource.slice(start, end);

  assert.match(createMatchSource, /getManualSwapCandidates\(swapSelectionId, teamA, teamB, locks, assignedRoleById\)/);
  assert.match(createMatchSource, /swapCandidate=\{swapSelectionId === null \|\| swapSelectionId === player\.id \|\| swapCandidates\.includes\(player\.id\)\}/);
  assert.match(swapHandler, /swapManualTeamMembers\(firstId, secondId, teamA, teamB, locks, assignedRoleById\)/);
  assert.match(swapHandler, /setLocks\(swapped\.locks\)/);
  assert.match(swapHandler, /setTeamA\(swapped\.teamA\)/);
  assert.match(swapHandler, /setTeamB\(swapped\.teamB\)/);
  assert.doesNotMatch(swapHandler, /setSelectedPlayerIds|setDraft|balanceMatchTeams|fillMatchTeams/);
  const manualHandler = swapHandler.slice(0, swapHandler.indexOf('    if (lockedIds.has(firstId)'));
  assert.doesNotMatch(manualHandler, /assignMatchRoles|allSelectedAssigned|isRosterValid|selectionCanContinue/);
  assert.match(manualHandler, /setBalanceResult\(null\)/);
  assert.match(manualHandler, /preserveSwappedRoles\(roleAssignments, swapped\.teamA, swapped\.teamB, selectedPlayers\)/);
  assert.match(manualHandler, /setSavedRolesInvalidated\(true\)/);
  assert.match(createMatchSource, /if \(saved && !savedRolesInvalidated/);
  assert.match(createMatchSource, /canSwap=\{mode === 'auto' \? !!roleAssignments : teamA\.length > 0 && teamB\.length > 0\}/);
  assert.match(createMatchSource, /No valid players available to swap with\./);
});

// Execute the actual manual handler so these regressions cover its state updates,
// rather than only the membership helper.
const swapStart = createMatchSource.indexOf('function swapPlayers(');
const autoSwapStart = createMatchSource.indexOf('    if (lockedIds.has(firstId)', swapStart);
const manualSwapSource = createMatchSource.slice(swapStart, autoSwapStart) + '\n}';
const clearRolesSource = createMatchSource.slice(
  createMatchSource.indexOf('function clearRoles('),
  createMatchSource.indexOf('\n  function clearTeamAssignments('),
);
const fillRolesSource = createMatchSource.slice(
  createMatchSource.indexOf('function fillManualTeams('),
  createMatchSource.indexOf('\n  const busy =', createMatchSource.indexOf('function fillManualTeams(')),
);
const manualSwapModule = await transformWithEsbuild(`
  export function makeHandler(env) {
    const { mode, teamA, teamB, locks, selectedPlayers, swapManualTeamMembers,
      validateMatchLocks, messageFor, setTeamA, setTeamB, setLocks,
      roleAssignments, assignedRoleById, profilesFingerprint, preserveSwappedRoles,
      setBalanceResult, setBalancedProfiles, setSavedRolesInvalidated, setCreateError, setSwapSelectionId } = env;
    ${manualSwapSource}
    return swapPlayers;
  }
  export function makeRoleActions(env) {
    const { locks, selectedPlayers, profilesFingerprint, fillMatchTeams, messageFor,
      setTeamA, setTeamB, setLocks, setBalanceResult, setBalancedProfiles,
      setSavedRolesInvalidated, setCreateError, setSwapSelectionId } = env;
    ${clearRolesSource}
    ${fillRolesSource}
    return { clearRoles, fillManualTeams };
  }`, 'manual-swap.ts', { loader: 'ts', format: 'esm' });
const { makeHandler, makeRoleActions } = await import(`data:text/javascript;base64,${Buffer.from(manualSwapModule.code).toString('base64')}`);

function manualSwapFixture(locks = [], selectedPlayers = pool.slice(0, 12)) {
  const state = {
    teamA: [1, 3], teamB: [2, 4, 5], locks: structuredClone(locks),
    selectedPlayers: structuredClone(selectedPlayers),
    balanceResult: null, balancedProfiles: '', savedRolesInvalidated: false, createError: '', swapSelectionId: 1,
    step: 'teams',
  };
  const before = structuredClone(state);
  const setters = Object.fromEntries(
    ['teamA', 'teamB', 'locks', 'balanceResult', 'balancedProfiles', 'savedRolesInvalidated', 'createError', 'swapSelectionId']
      .map((key) => [`set${key[0].toUpperCase()}${key.slice(1)}`, (value) => { state[key] = value; }]),
  );
  const env = () => ({
    ...state, ...setters, mode: 'manual', swapManualTeamMembers,
    roleAssignments: state.balanceResult,
    assignedRoleById: new Map(state.balanceResult
      ? [...state.balanceResult.teamAAssignments, ...state.balanceResult.teamBAssignments]
        .map((assignment) => [assignment.playerId, assignment.assignedPosition]) : []),
    profilesFingerprint: JSON.stringify(state.selectedPlayers),
    preserveSwappedRoles, fillMatchTeams, validateMatchLocks, messageFor: (error) => error.message,
  });
  return { state, before, handler: makeHandler(env()), getHandler: () => makeHandler(env()), actions: () => makeRoleActions(env()) };
}

test('manual handler swaps partial teams without assigning pending roles or changing the pool/step', () => {
  const { state, before, handler } = manualSwapFixture();
  handler(1, 2);
  assert.deepEqual(state.teamA, [2, 3]);
  assert.deepEqual(state.teamB, [1, 4, 5]);
  assert.deepEqual(state.selectedPlayers, before.selectedPlayers);
  const unassigned = (s) => s.selectedPlayers.filter((p) => ![...s.teamA, ...s.teamB].includes(p.id));
  assert.deepEqual(unassigned(state), unassigned(before));
  assert.equal(unassigned(state).length, 7);
  assert.equal(state.balanceResult, null);
  assert.equal(state.savedRolesInvalidated, true);
  assert.deepEqual(state.locks, []);
  assert.equal(state.createError, '');
  assert.equal(state.step, 'teams');
  assert.equal(state.swapSelectionId, null);
});

test('manual handler carries same-role locks without generating roles for other players', () => {
  const locks = [
    { playerId: 1, team: 'A', position: 'Setter' },
    { playerId: 2, team: 'B', position: 'Setter' },
    { playerId: 4, team: 'B', position: 'Outside Hitter' },
  ];
  const { state, before, handler } = manualSwapFixture(locks);
  handler(1, 2);
  assert.deepEqual(state.teamA, [2, 3]);
  assert.deepEqual(state.teamB, [1, 4, 5]);
  assert.deepEqual(state.locks, [
    { ...locks[0], team: 'B' }, { ...locks[1], team: 'A' }, locks[2],
  ]);
  assert.equal(state.balanceResult, null);
  assert.deepEqual(state.selectedPlayers, before.selectedPlayers);
  assert.equal(state.createError, '');
  assert.equal(state.step, 'teams');
});

test('manual handler blocks different locked roles without changing team state', () => {
  const { state, before, handler } = manualSwapFixture([
    { playerId: 1, team: 'A', position: 'Setter' },
    { playerId: 4, team: 'B', position: 'Outside Hitter' },
  ]);
  handler(1, 4);
  assert.deepEqual(state.teamA, before.teamA);
  assert.deepEqual(state.teamB, before.teamB);
  assert.deepEqual(state.locks, before.locks);
  assert.deepEqual(state.selectedPlayers, before.selectedPlayers);
  assert.equal(state.balanceResult, null);
  assert.match(state.createError, /swap is not allowed/);
});

test('Fill → same-role swap → Clear Roles → Fill preserves roles, membership and the selected pool', () => {
  const fixture = manualSwapFixture([], pool);
  const { state } = fixture;
  fixture.actions().fillManualTeams();
  assert.equal(state.createError, '');
  const filled = structuredClone(state.balanceResult);
  const allRoles = (result) => [...result.teamAAssignments, ...result.teamBAssignments]
    .sort((a, b) => a.playerId - b.playerId);
  assert.equal(allRoles(filled).length, 14);
  assert.deepEqual(state.locks, []);
  const setterA = filled.teamAAssignments.find((a) => a.assignedPosition === 'Setter').playerId;
  const setterB = filled.teamBAssignments.find((a) => a.assignedPosition === 'Setter').playerId;
  const outsideB = filled.teamBAssignments.find((a) => a.assignedPosition === 'Outside Hitter').playerId;
  const roles = new Map(allRoles(filled).map((a) => [a.playerId, a.assignedPosition]));
  assert.deepEqual(getManualSwapCandidates(setterA, state.teamA, state.teamB, [], roles), [setterB]);
  const teamsBeforeSwap = { teamA: [...state.teamA], teamB: [...state.teamB] };
  fixture.getHandler()(setterA, outsideB);
  assert.deepEqual(state.teamA, teamsBeforeSwap.teamA);
  assert.deepEqual(state.teamB, teamsBeforeSwap.teamB);
  assert.deepEqual(allRoles(state.balanceResult), allRoles(filled));
  fixture.getHandler()(setterA, setterB);
  assert.equal(state.createError, '');
  assert.deepEqual(state.teamA, teamsBeforeSwap.teamA.map((id) => id === setterA ? setterB : id));
  assert.deepEqual(state.teamB, teamsBeforeSwap.teamB.map((id) => id === setterB ? setterA : id));
  assert.deepEqual(allRoles(state.balanceResult), allRoles(filled));
  assert.deepEqual(state.selectedPlayers, fixture.before.selectedPlayers);
  const total = (ids) => state.selectedPlayers.filter((p) => ids.includes(p.id)).reduce((sum, p) => sum + p.elo, 0);
  assert.equal(state.balanceResult.totalEloGap, Math.abs(total(state.teamA) - total(state.teamB)));
  const teamsBeforeClear = { teamA: [...state.teamA], teamB: [...state.teamB] };
  fixture.actions().clearRoles();
  assert.equal(state.balanceResult, null);
  assert.equal(state.balancedProfiles, '');
  assert.equal(state.savedRolesInvalidated, true);
  assert.deepEqual(state.locks, []);
  assert.deepEqual(state.teamA, teamsBeforeClear.teamA);
  assert.deepEqual(state.teamB, teamsBeforeClear.teamB);
  assert.deepEqual(state.selectedPlayers, fixture.before.selectedPlayers);
  assert.equal(state.step, 'teams');
  fixture.actions().fillManualTeams();
  assert.equal(state.createError, '');
  assert.equal(allRoles(state.balanceResult).length, 14);
  assert.deepEqual(state.selectedPlayers, fixture.before.selectedPlayers);
});

test('Clear Roles clears explicit locks without moving players or resetting selection', () => {
  const fixture = manualSwapFixture([{ playerId: 1, team: 'A', position: 'Setter' }]);
  fixture.actions().clearRoles();
  assert.deepEqual(fixture.state.locks, []);
  assert.equal(fixture.state.balanceResult, null);
  assert.deepEqual(fixture.state.teamA, fixture.before.teamA);
  assert.deepEqual(fixture.state.teamB, fixture.before.teamB);
  assert.deepEqual(fixture.state.selectedPlayers, fixture.before.selectedPlayers);
  assert.equal(fixture.state.step, 'teams');
  assert.match(createMatchSource, /const hasAssignedRoles = locks\.length > 0 \|\| assignedRoleById\.size > 0/);
  assert.match(createMatchSource, /onClick=\{clearRoles\} disabled=\{!hasAssignedRoles\} data-testid="button-clear-roles">Clear Roles/);
  assert.doesNotMatch(createMatchSource, /Clear Locks|function clearLocks/);
});

test('moving between Create Match stages preserves the selected roster and date', () => {
  const initial = {
    ...freshSession(4, now),
    matchDate: '2026-11-14',
    selectedPlayerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    sourcePlayers: [{ id: 1, name: 'Player 01', positions: ['Setter'] }],
  };
  const players = updateMatchSessionStep(initial, 'players');
  const teams = updateMatchSessionStep(players, 'teams');
  const backToPlayers = updateMatchSessionStep(teams, 'players');

  for (const session of [players, teams, backToPlayers]) {
    assert.deepEqual(session.selectedPlayerIds, initial.selectedPlayerIds);
    assert.equal(session.matchDate, initial.matchDate);
    assert.deepEqual(session.sourcePlayers, initial.sourcePlayers);
  }
  assert.equal(players.step, 'players');
  assert.equal(teams.step, 'teams');
  assert.equal(backToPlayers.step, 'players');
});

test('deletion clears only the target saved edit, and restores failed requests without overwriting another roster', () => {
  const previous = { ...freshSession(8), editingMatchId: 17, step: 'teams', selectedPlayerIds: [1, 2], savedRoster: { teamAIds: [1], teamBIds: [2] } };
  assert.equal(clearDeletedMatchSession(previous, 18), previous);
  const cleared = clearDeletedMatchSession(previous, 17);
  assert.equal(cleared.step, 'date');
  assert.deepEqual(cleared.selectedPlayerIds, []);
  assert.equal(cleared.savedRoster, null);
  assert.equal(cleared.editingMatchId, null);
  const restored = restoreFailedDeletionSession(cleared, previous);
  assert.equal(restored.editingMatchId, 17);
  assert.deepEqual(restored.selectedPlayerIds, [1, 2]);
  const unrelated = { ...cleared, step: 'players', selectedPlayerIds: [3] };
  assert.equal(restoreFailedDeletionSession(unrelated, previous), unrelated);
});

test('draft and completed deletion confirmations have distinct warnings and lock during deletion', () => {
  const props = { pending: false, error: '', onConfirm() {}, onCancel() {} };
  const draft = renderToStaticMarkup(createElement(MatchDeleteConfirmation, { ...props, completed: false }));
  assert.ok(draft.includes('Delete this draft match?') && !draft.includes('reverse all ELO'));
  const completed = renderToStaticMarkup(createElement(MatchDeleteConfirmation, { ...props, completed: true }));
  assert.ok(completed.includes('reverse all ELO, rank, matches played and priority') && completed.includes('cannot be undone'));
  const pending = renderToStaticMarkup(createElement(MatchDeleteConfirmation, { ...props, completed: true, pending: true, error: 'Later result blocks deletion' }));
  assert.equal((pending.match(/disabled/g) ?? []).length, 2);
  assert.ok(pending.includes('Later result blocks deletion'));
});

const hm = {
  id: 5,
  teamA: [{ id: 1, name: 'Zed', assignedPosition: 'Setter' }, { id: 2, name: 'Amy', assignedPosition: 'Libero' }],
  teamB: [{ id: 3, name: 'Bo', assignedPosition: null }, { id: 4, name: 'Cy', assignedPosition: 'Opposite' }, { id: 6, name: 'Di', assignedPosition: 'Opposite' }],
  eloChanges: [
    { id: 1, playerId: 1, changeAmount: 5, action: 'result' }, { id: 2, playerId: 2, changeAmount: -12, action: 'result' },
    { id: 3, playerId: 3, changeAmount: null, action: 'result' }, { id: 4, playerId: 4, changeAmount: 0, action: 'result' },
    { id: 5, playerId: 6, changeAmount: 12, action: 'result', eloBefore: 900 },
  ],
};

test('history shows two collapsed disclosures and no forbidden actions', () => {
  const markup = renderToStaticMarkup(createElement(MatchHistoryDetails, { match: hm, showElo: true }));
  assert.equal((markup.match(/aria-expanded="false"/g) ?? []).length, 2);
  assert.ok(markup.includes('Team Detail') && markup.includes('ELO Changes'));
  assert.ok(!markup.includes('Zed') && !/Next|Start Over/.test(markup));
});

test('Team Detail lists names and played positions only, with honest unavailable label', () => {
  const markup = renderToStaticMarkup(createElement(MatchHistoryDetails, { match: hm, initialOpen: { team: true } }));
  assert.ok(markup.includes('Setter') && markup.includes('Position not recorded'));
  assert.ok(!/ELO|Rank|rank|provisional/.test(markup.replace('ELO Changes', '')));
  assert.equal((markup.match(/aria-expanded="true"/g) ?? []).length, 1);
});

test('ELO Changes sort descending, color by sign, private last, and show nothing else', () => {
  assert.deepEqual(history.sortedEloChanges(hm).map((r) => r.id), [6, 1, 4, 2, 3]);
  const markup = renderToStaticMarkup(createElement(MatchHistoryDetails, { match: hm, showElo: true, initialOpen: { elo: true } }));
  assert.ok(markup.includes('+12') && markup.includes('-12') && markup.includes('Private'));
  assert.ok(markup.includes('elo-change-positive') && markup.includes('elo-change-negative') && markup.includes('elo-change-zero') && markup.includes('elo-change-private'));
  assert.ok(!/900|Rank|Bronze|provisional|Team A/.test(markup));
});

test('ELO disclosure shows loading and error states without list data', () => {
  assert.ok(renderToStaticMarkup(createElement(MatchHistoryDetails, { match: hm, showElo: true, initialOpen: { elo: true }, eloState: 'loading' })).includes('Loading'));
  assert.ok(renderToStaticMarkup(createElement(MatchHistoryDetails, { match: hm, showElo: true, initialOpen: { elo: true }, eloState: 'error' })).includes('Try again'));
});

test('public history never renders ELO even with audit data and an initially open disclosure', () => {
  const markup = renderToStaticMarkup(createElement(MatchHistoryDetails, { match: hm, initialOpen: { team: true, elo: true } }));
  assert.ok(markup.includes('Team Detail') && markup.includes('Zed') && markup.includes('Setter'));
  assert.ok(!/ELO|elo-changes|text-elo-change|\\+12|-12|900|Rank|Bronze|Provisional/.test(markup));
  assert.equal((markup.match(/aria-expanded=/g) ?? []).length, 1);
});

test('saved roster summary requires explicit target and protects non-editable drafts', () => {
  const rosters = [{ id: 7, createdAt: 'x', teamA: [1], teamB: [2], draftEditable: true }, { id: 8, createdAt: 'x', teamA: [1], teamB: [2], draftEditable: false }];
  const none = renderToStaticMarkup(createElement(SavedRosterSummary, { rosters, targetId: null, busy: false, onSelect() {}, onContinue() {}, onReset() {} }));
  assert.equal((none.match(/disabled/g) ?? []).length, 2);
  const ok = renderToStaticMarkup(createElement(SavedRosterSummary, { rosters, targetId: 7, busy: false, onSelect() {}, onContinue() {}, onReset() {} }));
  assert.ok(ok.includes('Reset Current Match') && ok.includes('Continue to Team Assignment') && !/disabled/.test(ok));
  const prot = renderToStaticMarkup(createElement(SavedRosterSummary, { rosters, targetId: 8, busy: false, onSelect() {}, onContinue() {}, onReset() {} }));
  assert.equal((prot.match(/disabled/g) ?? []).length, 1);
  assert.equal(renderToStaticMarkup(createElement(SavedRosterSummary, { rosters: [], targetId: null, busy: false, onSelect() {}, onContinue() {}, onReset() {} })), '');
});

test('reset confirmation names the roster, warns, and locks while pending', () => {
  const m = renderToStaticMarkup(createElement(ConfirmDialog, { testId: 'd', title: 'Reset', confirmLabel: 'Go', pending: true, error: 'boom', onConfirm() {}, onCancel() {} }, 'Roster / 007 cannot be undone'));
  assert.ok(m.includes('Roster / 007') && m.includes('boom'));
  assert.equal((m.match(/disabled/g) ?? []).length, 2);
});

function mk(id, completedAt, createdAt, teamIds) {
  const half = Math.ceil(teamIds.length / 2);
  const snap = (i) => ({ ...pool[i - 1] });
  return { ...completed(), id, completedAt, createdAt, teamA: teamIds.slice(0, half).map(snap), teamB: teamIds.slice(half).map(snap) };
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('Next Game uses only the latest completed match, today, live data and no fallback', () => {
  const live = structuredClone(pool);
  const older = mk(1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', range(1, 14));
  const latest = mk(2, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', range(1, 12));
  const s = nextGameSession([older, latest, { ...latest, id: 3, status: 'upcoming' }], live, 4, now);
  assert.equal(s.step, 'players'); assert.equal(s.matchDate, '2026-10-07');
  assert.deepEqual(s.selectedPlayerIds, range(1, 12)); assert.equal(s.editingMatchId, null); assert.equal(s.savedRoster, null);
  assert.ok(s.sourcePlayers.every((p) => !('elo' in p)));
  const tooFew = mk(5, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', range(1, 11));
  assert.equal(nextGameSession([older, latest, tooFew], live, 1, now), null);
  const unconfirmed = live.map((p) => p.id === 3 ? { ...p, preferencesConfirmed: false } : p);
  assert.equal(nextGameSession([latest], unconfirmed, 1, now), null);
  assert.equal(nextGameSession([latest], live.map((p) => ({ ...p, positions: ['Opposite'] })), 1, now), null);
  assert.equal(nextGameSession([latest], live.filter((p) => p.id > 2), 1, now), null);
  assert.equal(nextGameSession([latest], live.filter((p) => p.id !== 1), 1, now), null);
});

test('latest completed ties break by createdAt then id', () => {
  const a = mk(1, '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z', range(1, 12));
  const b = mk(2, '2026-10-01T00:00:00Z', '2026-09-02T00:00:00Z', range(1, 12));
  const c = mk(3, '2026-10-01T00:00:00Z', '2026-09-02T00:00:00Z', range(1, 12));
  assert.equal(latestCompletedMatch([a, b, c]).id, 3);
});

test('Next Game removes ineligible played players if 12–14 eligible players remain', () => {
  const match = completed(14);
  const unconfirmed = pool.map((player) => player.id === 14 ? { ...player, preferencesConfirmed: false } : player);
  assert.equal(nextGameSession([match], unconfirmed, 1, now).selectedPlayerIds.length, 13);
  const invalid = pool.map((player) => player.id === 14 ? { ...player, positions: ['Setter', 'Setter'] } : player);
  assert.equal(nextGameSession([match], invalid, 1, now).selectedPlayerIds.length, 13);
  const unrated = pool.map((player) => player.id === 14 ? { ...player, elo: null } : player);
  assert.equal(nextGameSession([match], unrated, 1, now).selectedPlayerIds.length, 13);
});

test('Continue loads the saved roster for the same id with copied membership and no invented locks', () => {
  const m = { ...mk(11, null, '2026-10-01T00:00:00Z', range(1, 12)), status: 'upcoming', draftEditable: true, matchDate: '2026-11-01', scoreA: null, scoreB: null, winner: null };
  m.teamA.forEach((p) => { p.assignedPosition = 'Setter'; p.assignmentStatus = 'preferred'; });
  m.teamB.forEach((p) => { p.assignedPosition = 'Libero'; });
  const s = editSession(m, 2, now);
  assert.equal(s.editingMatchId, 11); assert.equal(s.step, 'teams'); assert.equal(s.matchDate, '2026-11-01');
  assert.deepEqual(s.savedRoster.teamAIds, m.teamA.map((p) => p.id));
  assert.equal(s.savedRoster.teamA.length, 6); assert.ok(!('locks' in s));
  m.teamA[0].name = 'Changed'; m.teamA.pop();
  assert.notEqual(s.sourcePlayers[0].name, 'Changed'); assert.equal(s.savedRoster.teamAIds.length, 6);
  assert.throws(() => editSession({ ...m, draftEditable: false }, 1), /protected/);
  assert.throws(() => editSession({ ...m, status: 'completed' }, 1), /protected/);
});

test('Start Over and edit session never share state, and fresh sessions drop the target', () => {
  const m = { ...mk(11, null, '2026-10-01T00:00:00Z', range(1, 12)), status: 'upcoming', draftEditable: true };
  const edit = editSession(m, 1, now);
  const reset = freshSession(edit.generation + 1, now);
  assert.equal(reset.editingMatchId, null); assert.equal(reset.savedRoster, null);
  assert.equal(reset.step, 'date'); assert.deepEqual(reset.selectedPlayerIds, []);
});

for (const count of [12, 13, 14]) {
  test(`Next Match carries ${count} players into Step 2 and defaults a past date to today`, () => {
    const draft = nextSession(completed(count), 1, now);
    assert.equal(draft.step, 'players');
    assert.deepEqual(draft.selectedPlayerIds, pool.slice(0, count).map((p) => p.id));
    assert.equal(draft.matchDate, '2026-10-07');
    assert.equal(draft.generation, 1);
    assert.equal(selectionCanContinue(pool.slice(0, count)), true);
    assert.ok(draft.sourcePlayers.every((p) => !('elo' in p)));
  });
}

test('failed or unsaved result cannot create a next draft', () => {
  assert.throws(() => nextSession({ ...completed(), status: 'upcoming', scoreA: null }, 1), /Save/);
});

test('Start Over returns to date selection with no selections or carried profile warnings', () => {
  const before = nextSession(completed(), 3, now);
  const reset = freshSession(before.generation + 1, now);
  assert.equal(reset.step, 'date');
  assert.deepEqual(reset.selectedPlayerIds, []);
  assert.deepEqual(reset.sourcePlayers, []);
  assert.equal(reset.matchDate, '2026-10-07');
  assert.equal(reset.generation, 4);
});

test('later reversal or snapshot mutation does not change the carried roster', () => {
  const match = completed();
  const draft = nextSession(match, 1, now);
  const copy = structuredClone(draft);
  match.status = 'upcoming';
  match.teamA[0].positions.push('Libero');
  match.teamA[0].name = 'Changed';
  match.teamB.pop();
  assert.deepEqual(draft, copy);
});

test('deleted players are omitted, existing changed players remain selected with warnings', () => {
  const draft = nextSession(completed(), 1, now);
  const remaining = structuredClone(pool.slice(0, 10));
  remaining[0].name = 'Renamed';
  remaining[1].positions.reverse();
  remaining[2].preferencesConfirmed = false;
  const reconciled = reconcileSession(draft, remaining);
  assert.deepEqual(reconciled.selectedPlayerIds, remaining.map((p) => p.id));
  assert.equal(reconciled.missing.length, 4);
  assert.deepEqual([...reconciled.changedIds], [1, 2, 3]);
  assert.equal(selectionCanContinue(remaining), false);
});

test('rating, match counters and filled-role priority updates are not profile-change warnings', () => {
  const draft = nextSession(completed(), 1, now);
  const updated = pool.map((p) => ({ ...p, elo: p.elo + 30, matchesPlayed: 10, preferredRolePriority: true }));
  assert.equal(reconcileSession(draft, updated).changedIds.size, 0);
});

test('selection validation follows removals/replacements and keeps eligibility safeguards', () => {
  assert.equal(selectionCanContinue(pool.slice(0, 11)), false);
  assert.equal(selectionCanContinue([...pool, { ...pool[0], id: 15 }]), false);
  assert.equal(selectionCanContinue(pool.map((p) => ({ ...p, positions: ['Opposite'] }))), false);
  assert.equal(selectionCanContinue(pool.map((p, i) => i === 0 ? { ...p, preferencesConfirmed: false } : p)), false);
  assert.equal(selectionCanContinue(pool.slice(0, 12)), true);
});

test('search, position filter and sorting do not remove hidden selections or mutate the pool', () => {
  const draft = nextSession(completed(), 1, now);
  const original = structuredClone(pool);
  assert.equal(visiblePool(pool, 'Player 01', '', 'name').length, 1);
  assert.equal(visiblePool(pool, '', 'Setter', 'name').length, 2);
  assert.equal(visiblePool(pool, '', '', 'elo')[0].id, 14);
  assert.equal(visiblePool(pool, '', '', 'name-desc')[0].id, 14);
  assert.equal(draft.selectedPlayerIds.length, 14);
  assert.deepEqual(pool, original);
});

test('date validation uses local calendar values and rejects impossible or blank dates', () => {
  assert.equal(localToday(now), '2026-10-07');
  assert.equal(validMatchDate('2028-02-29'), true);
  for (const value of ['', '2026-02-29', '2026-13-01', '0000-01-01', '2026-1-1']) {
    assert.equal(validMatchDate(value), false);
  }
});
