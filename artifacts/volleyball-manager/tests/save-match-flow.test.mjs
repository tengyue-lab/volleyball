import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { freshSession } from '../src/match-session.ts';

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const saveHandlers = app.slice(app.indexOf('function matchSaved('), app.indexOf('\n  return <Shell><main', app.indexOf('function matchSaved(')));
const clearTeams = app.slice(app.indexOf('function clearTeamAssignments('), app.indexOf('\n  function clearPlayerSelection('));
const compiled = await transformWithEsbuild(`
  export function handlers(env) {
    const { queryClient, getGetMatchQueryKey, getListMatchesQueryKey,
      setTargetId, setCreatedMatchId, setTeamA, setTeamB, setLocks,
      setBalanceResult, setBalancedProfiles, setSwapSelectionId,
      setCreateError, setSavedRolesInvalidated, setDraft, setMode,
      setShowTeamModeSelection, saveInFlight,
      messageFor, isRosterValid, roleAssignments, canContinue, draft,
      busy, apiPositionByRole, teamA, teamB, updateDraft, createMatch } = env;
    ${clearTeams}
    ${saveHandlers}
    return { saveMatch, dismissMatchCreated };
  }`, 'save-handlers.ts', { loader: 'ts', format: 'esm' });
const { handlers } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);

function fixture(count = 12, editingMatchId = null) {
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  const assignments = ids.map((playerId) => ({
    playerId, assignedPosition: 'Outside Hitter', assignmentStatus: 'Preferred', preferenceRank: 1,
  }));
  const state = {
    draft: { ...freshSession(3), step: 'teams', matchDate: '2026-10-07',
      selectedPlayerIds: ids, editingMatchId, savedRoster: editingMatchId === null ? null : { teamAIds: ids.slice(0, 6) } },
    teamA: ids.slice(0, 6), teamB: ids.slice(6),
    locks: [{ playerId: 1, team: 'A', position: 'Outside Hitter' }],
    balanceResult: { teamAAssignments: assignments.slice(0, 6), teamBAssignments: assignments.slice(6) },
    balancedProfiles: 'profile-fingerprint', swapSelectionId: 1,
    savedRolesInvalidated: false, createdMatchId: null, targetId: null, createError: '',
    mode: 'auto', showTeamModeSelection: false,
  };
  const setters = Object.fromEntries(['TeamA', 'TeamB', 'Locks', 'BalanceResult', 'BalancedProfiles',
    'SwapSelectionId', 'CreateError', 'SavedRolesInvalidated', 'CreatedMatchId', 'TargetId', 'Draft',
    'Mode', 'ShowTeamModeSelection'].map((name) => {
    const key = name[0].toLowerCase() + name.slice(1);
    return [`set${name}`, (value) => { state[key] = typeof value === 'function' ? value(state[key]) : value; }];
  }));
  const saves = [], cache = new Map([['["matches"]', [{ id: 50, status: 'upcoming' }]]]), invalidations = [];
  const saveInFlight = { current: false };
  const mutation = (kind) => ({ mutate: (input, callbacks) => saves.push({ kind, input: structuredClone(input), callbacks }) });
  const env = () => ({
    ...state, ...setters, saveInFlight, isRosterValid: !!state.balanceResult, canContinue: true,
    roleAssignments: state.balanceResult, busy: state.createdMatchId !== null,
    apiPositionByRole: { 'Outside Hitter': 'Outside Hitter' }, messageFor: (error) => error.message,
    getGetMatchQueryKey: (id) => ['match', id], getListMatchesQueryKey: () => ['matches'],
    queryClient: {
      setQueryData: (key, value) => {
        const name = JSON.stringify(key);
        const next = typeof value === 'function' ? value(cache.get(name)) : value;
        if (next !== undefined) cache.set(name, next);
      },
      invalidateQueries: (key) => { invalidations.push(key); return Promise.resolve(); },
    },
    createMatch: mutation('create'), updateDraft: mutation('update'),
  });
  return { state, saves, cache, invalidations, saveInFlight, actions: () => handlers(env()) };
}

for (const count of [12, 13, 14]) {
  test(`saving ${count} players confirms once and preserves date/roster/Teams for a separate second match`, () => {
    const f = fixture(count), before = structuredClone(f.state);
    const initialActions = f.actions();
    initialActions.saveMatch();
    initialActions.saveMatch(); // Rapid repeat before React rerenders.
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].kind, 'create');
    assert.deepEqual(f.saves[0].input.data.teamAPlayerIds, before.teamA);
    assert.deepEqual(f.saves[0].input.data.teamBPlayerIds, before.teamB);
    assert.equal(f.state.createdMatchId, null);
    assert.deepEqual(f.state, before); // No clearing while request is outstanding.
    const saved = { id: 101, status: 'upcoming', ...f.saves[0].input.data };
    f.saves[0].callbacks.onSuccess(saved);
    assert.equal(f.state.createdMatchId, 101);
    assert.deepEqual(f.state.teamA, before.teamA); // Teams stay until acknowledgement.
    assert.deepEqual(f.state.draft, before.draft);
    assert.deepEqual(f.cache.get('["match",101]'), saved);
    assert.deepEqual(f.cache.get('["matches"]').map((match) => match.id), [101, 50]);
    assert.equal(f.state.targetId, 101);
    assert.equal(f.invalidations.length, 1);
    f.actions().saveMatch();
    assert.equal(f.saves.length, 1); // Modal never submits another request.
    f.actions().dismissMatchCreated();
    assert.equal(f.state.createdMatchId, null);
    assert.equal(f.state.draft.step, 'teams');
    assert.equal(f.state.showTeamModeSelection, true);
    assert.equal(f.state.mode, null);
    assert.equal(f.state.draft.matchDate, before.draft.matchDate);
    assert.equal(f.state.draft.generation, before.draft.generation);
    assert.deepEqual(f.state.draft.selectedPlayerIds, before.draft.selectedPlayerIds);
    for (const key of ['teamA', 'teamB', 'locks']) assert.deepEqual(f.state[key], []);
    assert.equal(f.state.balanceResult, null);
    assert.equal(f.state.balancedProfiles, '');
    assert.equal(f.state.swapSelectionId, null);
    assert.equal(f.state.savedRolesInvalidated, true);
    assert.equal(f.saveInFlight.current, false);
    // Stand in for the unchanged team builder producing another setup.
    f.state.teamA = [...before.teamB]; f.state.teamB = [...before.teamA];
    f.state.balanceResult = { ...before.balanceResult,
      teamAAssignments: before.balanceResult.teamBAssignments,
      teamBAssignments: before.balanceResult.teamAAssignments };
    f.actions().saveMatch();
    assert.equal(f.saves.length, 2);
    assert.equal(f.saves[1].kind, 'create');
    f.saves[1].callbacks.onSuccess({ id: 102, status: 'upcoming', ...f.saves[1].input.data });
    assert.deepEqual(f.cache.get('["matches"]').map((match) => match.id), [102, 101, 50]);
    assert.equal(f.state.createdMatchId, 102);
  });
}

test('failed create or update preserves all teams, locks, roles and session and allows retry', () => {
  for (const editingId of [null, 50]) {
    const f = fixture(12, editingId), before = structuredClone(f.state);
    f.actions().saveMatch();
    f.saves[0].callbacks.onError(new Error('Save failed'));
    assert.deepEqual(f.state, { ...before, createError: 'Save failed' });
    assert.equal(f.saveInFlight.current, false);
    assert.equal(f.invalidations.length, 0);
    f.actions().saveMatch();
    assert.equal(f.saves.length, 2);
    assert.equal(f.state.createError, '');
  }
});

test('saving an edited roster updates once then detaches the edit target for the next match', () => {
  const f = fixture(14, 50);
  f.actions().saveMatch();
  assert.equal(f.saves[0].kind, 'update');
  assert.equal(f.saves[0].input.matchId, 50);
  f.saves[0].callbacks.onSuccess({ id: 50, status: 'upcoming' });
  assert.equal(f.cache.get('["matches"]').length, 1); // Replaces, never duplicates.
  f.actions().dismissMatchCreated();
  assert.equal(f.state.draft.editingMatchId, null);
  assert.equal(f.state.draft.savedRoster, null);
  assert.equal(f.state.draft.selectedPlayerIds.length, 14);
  assert.equal(f.state.draft.step, 'teams');
  assert.equal(f.state.showTeamModeSelection, true);
  assert.equal(f.state.mode, null);
});

test('Start Over remains the explicit full session reset and never runs on save success', async () => {
  assert.doesNotMatch(saveHandlers, /startOver|freshSession|setSelectedPlayerIds|navigate/);
  assert.equal((app.match(/data-testid="button-start-over"/g) ?? []).length, 1);
  assert.match(app, /setConfirmStartOver\(false\); startOver\(\)/);
  const provider = await readFile(new URL('../src/match-session-context.tsx', import.meta.url), 'utf8');
  assert.match(provider, /startOver: \(\) => setDraft\(\(current\) => freshSession\(current\.generation \+ 1\)\)/);
  const reset = freshSession(4);
  assert.equal(reset.step, 'date');
  assert.deepEqual(reset.selectedPlayerIds, []);
  assert.equal(reset.savedRoster, null);
  assert.equal(reset.editingMatchId, null);
});

test('success dialog uses existing styling, exact message and one OK action', async () => {
  assert.match(app, /createdMatchId !== null && <ConfirmDialog[^>]+title="Match Created"[^>]+confirmLabel="OK" hideCancel[^>]+onCancel=\{dismissMatchCreated\} onConfirm=\{dismissMatchCreated\}/);
  assert.match(app, /The match has been created successfully\./);
  const source = await readFile(new URL('../src/components/ConfirmDialog.tsx', import.meta.url), 'utf8');
  const compiled = await transformWithEsbuild(source, 'ConfirmDialog.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
  const code = compiled.code.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    .replaceAll('from "react"', `from ${JSON.stringify(import.meta.resolve('react'))}`);
  const { default: Dialog } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const props = { title: 'Match Created', confirmLabel: 'OK', tone: 'warning', testId: 'dialog-match-created', onCancel: () => {}, onConfirm: () => {} };
  const markup = renderToStaticMarkup(createElement(Dialog, { ...props, hideCancel: true }, 'The match has been created successfully.'));
  assert.match(markup, /Match Created/);
  assert.match(markup, /button-primary/);
  assert.equal((markup.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /Cancel/);
  assert.match(renderToStaticMarkup(createElement(Dialog, props)), /Cancel/); // Existing dialogs unchanged.
});
