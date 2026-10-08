import assert from 'node:assert/strict';
import test from 'node:test';
import { playerEditFields, prepareRatingAdjustment } from '../src/lib/rating-adjustment.ts';

test('admin form retries reuse one key without mutating fields', () => {
  let keys = 0;
  const createKey = () => `intent-${++keys}`;
  const fields = Object.freeze({ name: 'Fixture', elo: 800, positions: ['Setter'] });
  const first = prepareRatingAdjustment(1, fields, null, createKey);
  const retry = prepareRatingAdjustment(1, { positions: ['Setter'], elo: 800, name: 'Fixture' }, first.intent, createKey);
  assert.equal(first.data.adjustmentRequestId, retry.data.adjustmentRequestId);
  assert.equal(keys, 1);
  assert.equal(fields.adjustmentRequestId, undefined);
  assert.deepEqual(first.data.positions, fields.positions);
});

test('different ratings, players and preferences create distinct edit intents', () => {
  let keys = 0;
  const createKey = () => `intent-${++keys}`;
  const first = prepareRatingAdjustment(1, { elo: 800 }, null, createKey);
  for (const [id, fields] of [[1, { elo: 900 }], [2, { elo: 800 }], [1, { elo: 800, positions: ['Setter'] }]]) {
    const next = prepareRatingAdjustment(id, fields, first.intent, createKey);
    assert.notEqual(next.data.adjustmentRequestId, first.data.adjustmentRequestId);
  }
  assert.equal(keys, 4);
});

test('a reused keyed payload does not accidentally create a new key', () => {
  const first = prepareRatingAdjustment(1, { elo: 800 }, null, () => 'one-intent');
  const retry = prepareRatingAdjustment(1, first.data, first.intent, () => assert.fail('Must not create a key'));
  assert.equal(retry.data.adjustmentRequestId, 'one-intent');
});

test('name and preference changes omit an unchanged rating so concurrent results are not overwritten', () => {
  assert.deepEqual(playerEditFields('Fixture', ['Setter'], false, 800, 800), {
    name: 'Fixture', positions: ['Setter'], eloPublic: false,
  });
  assert.equal(playerEditFields('Fixture', ['Setter'], false, 900, 800).elo, 900);
});
