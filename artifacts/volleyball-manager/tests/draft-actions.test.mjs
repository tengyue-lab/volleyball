import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('History row and post-save result carry no continuation actions', () => {
  assert.ok(!app.includes('PostMatchActions'));
  assert.ok(!app.includes('button-next-match'));
  assert.ok(app.includes('button-dismiss-result'));
});

test('draft actions use the guarded hooks and clean caches on reset success only', () => {
  assert.ok(app.includes('useDeleteMatchDraft'));
  const onSuccess = app.slice(app.indexOf('function useMatchDeletion'));
  assert.ok(onSuccess.indexOf('removeQueries') < onSuccess.indexOf('callbacks.onError'));
  assert.ok(onSuccess.includes('expectedStatus: match.status'));
  assert.ok(onSuccess.includes('await refreshEverything(client)'));
  assert.ok(app.includes('if (!isAdmin) return null'));
  assert.ok(app.includes('mutation.mutateAsync'));
  assert.ok(app.includes('flushSync'));
  assert.ok(app.indexOf('callbacks.beforeDelete?.()') < app.indexOf('mutation.mutateAsync'));
});

test('Create Match creates separate rosters unless explicitly editing an unplayed draft', () => {
  assert.ok(!app.includes('SavedRosterSummary'));
  assert.ok(!app.includes('button-continue-team-assignment'));
  assert.ok(!app.includes('button-reset-current-match'));
  assert.ok(app.includes('createMatch.mutate({ data }'));
  assert.match(app, /if \(draft\.editingMatchId !== null\) \{\s*updateDraft\.mutate/);
});

test('Players navigation and route are admin guarded without guarding the normal Profile', () => {
  assert.ok(app.includes("access.status === 'ready' && access.isAdmin ? [{ href: '/players'"));
  assert.ok(app.includes('<Route path="/players" component={AdminPlayersRoute} />'));
  assert.ok(app.includes("access.status === 'ready' && access.isAdmin ? <PlayersPage /> : <Redirect to=\"/current-match\" />"));
  assert.ok(app.includes('<SignedInOnly><UserPortalPage /></SignedInOnly>'));
});

test('public leaderboard uses exact text and the minimal DTO without numeric-rating filtering', () => {
  const page = app.slice(app.indexOf('function LeaderboardPage'), app.indexOf('function RoleBadge'));
  assert.ok(page.includes('title="Leaderboard" description="Saturday Social Leaderboard"'));
  assert.ok(page.includes('<LeaderboardTable players={ranked} />'));
  assert.ok(!/\\.elo|positions|isRatedPlayer|Highest rating|Public average|ELO leaderboard/.test(page));
});

test('history lazy audit fetch and direct result ELO display are admin-only', () => {
  const history = app.slice(app.indexOf('function HistoryDetails'), app.indexOf('function useMatchDeletion'));
  assert.ok(history.includes('enabled: isAdmin && opened'));
  assert.ok(history.includes('showElo={isAdmin}'));
  assert.ok(app.includes('{isAdmin && (match.eloChanges.length ?'));
});
