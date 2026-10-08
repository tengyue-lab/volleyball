import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const detailStart = app.indexOf('function MatchDetail(');
const saveStart = app.indexOf('  function saveResult(', detailStart);
const saveEnd = app.indexOf('\n  function editResult()', saveStart);
const saveResultSource = app.slice(saveStart, saveEnd);
const handlerModule = await transformWithEsbuild(`
  export function makeHandler(env) {
    const { scoreA, scoreB, matchId, setResultError, submitResult, reopenResult,
      submitGuard, messageFor, onMatchUpdated, onMatchCompleted } = env;
    ${saveResultSource}
    return saveResult;
  }`, 'match-completion-handler.ts', { loader: 'ts', format: 'esm' });
const { makeHandler } = await import(`data:text/javascript;base64,${Buffer.from(handlerModule.code).toString('base64')}`);

function completionFixture() {
  const state = { scoreA: '25', scoreB: '21', resultError: '', submitGuard: { current: false }, calls: [], events: [] };
  const env = {
    scoreA: state.scoreA,
    scoreB: state.scoreB,
    matchId: 45,
    submitGuard: state.submitGuard,
    setResultError: (value) => { state.resultError = value; },
    submitResult: {
      isPending: false,
      mutate: (input, callbacks) => state.calls.push({ input, callbacks }),
    },
    reopenResult: { isPending: false },
    messageFor: (error) => error.message,
    onMatchUpdated: async (updated) => { state.events.push(['refresh', updated.id]); },
    onMatchCompleted: (updated) => { state.events.push(['completed', updated]); },
  };
  return { state, handler: makeHandler(env) };
}

test('Current Match completion uses the existing endpoint once, refreshes data then opens the success state without navigation', async () => {
  const { state, handler } = completionFixture();
  const event = { preventDefault() {} };
  handler(event);
  handler(event); // A rapid second submit before React can rerender must be ignored.
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0].input, { matchId: 45, data: { scoreA: 25, scoreB: 21 } });
  assert.equal(state.submitGuard.current, true);
  assert.equal(state.events.length, 0);

  const completed = { id: 45, status: 'completed', scoreA: 25, scoreB: 21, winner: 'Team A', eloChanges: [{ changeAmount: 24 }] };
  await state.calls[0].callbacks.onSuccess(completed);
  assert.deepEqual(state.events, [['refresh', 45], ['completed', completed]]);
  assert.equal(state.submitGuard.current, true);
  const refresh = app.slice(app.indexOf('async function refreshAfterMatchUpdate'), app.indexOf('\nfunction EditResultButton'));
  for (const query of ['getGetMatchQueryKey', 'getListMatchesQueryKey', 'getListPlayersQueryKey', 'getGetLeaderboardQueryKey', 'getGetPlayerEloHistoryQueryKey']) {
    assert.ok(refresh.includes(query), `result refresh must include ${query}`);
  }
  assert.doesNotMatch(saveResultSource, /navigate\(/);
  assert.match(saveResultSource, /await onMatchUpdated\(updated\)[\s\S]*onMatchCompleted\?\.\(updated\)/);
});

test('a failed completion shows only the existing error and unlocks retry with the entered score intact', () => {
  const { state, handler } = completionFixture();
  handler({ preventDefault() {} });
  state.calls[0].callbacks.onError(new Error('Result save failed.'));
  assert.equal(state.resultError, 'Result save failed.');
  assert.equal(state.submitGuard.current, false);
  assert.deepEqual(state.events, []);
  assert.equal(state.scoreA, '25');
  assert.equal(state.scoreB, '21');
  handler({ preventDefault() {} });
  assert.equal(state.calls.length, 2);
});

test('Current Match owns the completion popup and continues to render remaining upcoming matches or its existing empty state', () => {
  const collection = app.slice(app.indexOf('function MatchCollectionPage'), app.indexOf('\nfunction CurrentMatchPage'));
  const card = app.slice(app.indexOf('function MatchCard('), app.indexOf('\nfunction AdminMatchesPage'));
  const currentRoute = app.slice(app.indexOf('function CurrentMatchPage'), app.indexOf('\nfunction MatchHistoryPage'));
  assert.match(collection, /const \[completedMatchId, setCompletedMatchId\] = useState<number \| null>\(null\)/);
  assert.match(collection, /onMatchCompleted=\{\(updated\) => setCompletedMatchId\(updated\.id\)\}/);
  assert.match(collection, /isCurrent && completedMatchId !== null && <ConfirmDialog/);
  assert.match(collection, /title="Match Complete"/);
  assert.match(collection, /confirmLabel="OK"[\s\S]*?hideCancel/);
  assert.match(collection, /The match result has been saved successfully\./);
  assert.match(collection, /setCompletedMatchId\(null\)/);
  assert.match(collection, /\.filter\(\(match\) => match\.status === \(isCurrent \? 'upcoming' : 'completed'\)\)/);
  assert.match(collection, /title="No upcoming matches yet"/);
  assert.match(collection, /groupCompletedMatchesByGameDate\(matches\)/);
  assert.match(collection, /<MatchHistoryDateGroups/);
  assert.match(collection, /<p>No completed matches yet\.<\/p>/);
  assert.doesNotMatch(collection, /No completed matches yet'\s*:/);
  assert.match(card, /onMatchCompleted\?: \(match: Match\) => void/);
  assert.match(card, /<MatchDetail matchId=\{match\.id\} onMatchCompleted=\{onMatchCompleted\} \/>/);
  assert.match(currentRoute, /<MatchCollectionPage type="current" \/>/);
  assert.ok(!currentRoute.includes('navigate'));
});

test('Match Complete uses the shared modal style with the requested single OK action', async () => {
  const source = await readFile(new URL('../src/components/ConfirmDialog.tsx', import.meta.url), 'utf8');
  const compiled = await transformWithEsbuild(source, 'ConfirmDialog.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
  const code = compiled.code.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    .replaceAll('from "react"', `from ${JSON.stringify(import.meta.resolve('react'))}`);
  const { default: Dialog } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const props = { title: 'Match Complete', confirmLabel: 'OK', tone: 'warning', hideCancel: true, testId: 'dialog-match-complete', onCancel: () => {}, onConfirm: () => {} };
  const markup = renderToStaticMarkup(createElement(Dialog, props, 'The match result has been saved successfully.'));
  assert.match(markup, /Match Complete/);
  assert.match(markup, /The match result has been saved successfully\./);
  assert.equal((markup.match(/<button/g) ?? []).length, 1);
  assert.match(markup, />OK<\/button>/);
  assert.match(markup, /role="alertdialog" aria-modal="true"/);
});
