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
  assert.ok(app.includes('useUpdateMatchDraft') && app.includes('useDeleteMatchDraft'));
  const onSuccess = app.slice(app.indexOf('function useMatchDeletion'));
  assert.ok(onSuccess.indexOf('removeQueries') < onSuccess.indexOf('callbacks.onError'));
  assert.ok(onSuccess.includes('expectedStatus: match.status'));
  assert.ok(onSuccess.includes('await refreshEverything(client)'));
  assert.ok(app.includes('if (!isAdmin) return null'));
  assert.ok(app.includes('mutation.mutateAsync'));
  assert.ok(app.includes('flushSync'));
  assert.ok(app.indexOf('callbacks.beforeDelete?.()') < app.indexOf('mutation.mutateAsync'));
});

test('continuing a saved edit retains its explicit reset target across the session remount', () => {
  assert.ok(app.includes('const [targetId, setTargetId] = useState<number | null>(draft.editingMatchId)'));
});
