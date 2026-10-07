import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  freshSession, localToday, nextSession, reconcileSession,
  resultActionsReady, selectionCanContinue, validMatchDate, visiblePool,
} from '../src/match-session.ts';

const now = new Date(2026, 9, 7, 0, 15);
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
const source = await readFile(new URL('../src/components/PostMatchActions.tsx', import.meta.url), 'utf8');
const transformed = await transformWithEsbuild(source, 'PostMatchActions.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
const code = transformed.code.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')));
const { default: PostMatchActions } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('saved result shows both actions and pending or incomplete results disable them', () => {
  const match = completed();
  const ready = resultActionsReady(match);
  const markup = renderToStaticMarkup(createElement(PostMatchActions, { ready, onNext() {}, onStartOver() {} }));
  assert.ok(markup.includes('Next Match') && markup.includes('Start Over'));
  assert.equal((markup.match(/disabled/g) ?? []).length, 0);
  for (const args of [[match, true, false], [match, false, true],
    [{ ...match, status: 'upcoming' }], [{ ...match, scoreA: null }], [{ ...match, winner: null }]]) {
    const gated = renderToStaticMarkup(createElement(PostMatchActions, { ready: resultActionsReady(...args), onNext() {}, onStartOver() {} }));
    assert.equal((gated.match(/disabled/g) ?? []).length, 2);
  }
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
