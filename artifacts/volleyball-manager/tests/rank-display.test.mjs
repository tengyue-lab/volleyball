import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Exercise the actual TSX, using Vite's existing transformer, without installing
// another test framework or copying the presentation logic into test fixtures.
const source = await readFile(new URL('../src/components/RankBadge.tsx', import.meta.url), 'utf8');
const transformed = await transformWithEsbuild(source, 'RankBadge.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
const code = transformed.code.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')));
const { RankBadge, RankTransition } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

test('provisional presentation appears at zero and matches 1–9, disappears at ten', () => {
  for (let count = 0; count <= 11; count++) {
    const markup = render(RankBadge, { rank: 'Bronze 3', provisional: count < 10 });
    assert.equal(markup.includes('Provisional'), count < 10);
    assert.ok(markup.includes('Bronze 3'));
  }
});

test('all tier badges use readable rank labels; Masters has no division', () => {
  for (const tier of ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']) {
    for (const division of [3, 2, 1]) {
      assert.ok(render(RankBadge, { rank: `${tier} ${division}` }).includes(`${tier} ${division}`));
    }
  }
  const masters = render(RankBadge, { rank: 'Masters' });
  assert.ok(masters.includes('>Masters<'));
  assert.ok(!masters.includes('Masters 1'));
});

test('admin/profile badge retains optional numeric rating without duplicate labels', () => {
  const markup = render(RankBadge, { rank: 'Gold 1', rating: 1620, provisional: true });
  assert.equal((markup.match(/Gold 1/g) ?? []).length, 1);
  assert.ok(markup.includes('rank-label-and-rating'));
  assert.ok(markup.includes('1,620'));
  assert.ok(markup.includes('Provisional'));
  assert.ok(!render(RankBadge, { rank: null, rating: 1620 }).includes('1,620'));
});

test('public leaderboard renders only tiers, names and provisional status in server order', async () => {
  const tableSource = await readFile(new URL('../src/components/LeaderboardTable.tsx', import.meta.url), 'utf8');
  const transformedTable = await transformWithEsbuild(tableSource, 'LeaderboardTable.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
  const tableCode = transformedTable.code
    .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    .replace('"./RankBadge"', JSON.stringify(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`));
  const { default: Table } = await import(`data:text/javascript;base64,${Buffer.from(tableCode).toString('base64')}`);
  const markup = render(Table, { players: [
    { id: 2, name: 'Zed', rank: 'Masters', provisional: false },
    { id: 1, name: 'Amy', rank: 'Bronze 3', provisional: true },
  ] });
  assert.ok(markup.includes('Masters') && markup.includes('Bronze 3'));
  assert.equal((markup.match(/>Provisional</g) ?? []).length, 1);
  assert.ok(markup.indexOf('Zed') < markup.indexOf('Amy'));
  assert.equal((markup.match(/role="columnheader"/g) ?? []).length, 3);
  assert.ok(!/ELO|rating|elo-meter|Top preference|rank-top|>1<|>2</.test(markup.replaceAll('rank-label-and-rating', '')));
});

test('result promotions and demotions expose transition text and distinct styling', () => {
  const promotion = render(RankTransition, { before: 'Silver 3', after: 'Silver 2', movement: 'promotion', provisional: true });
  assert.ok(promotion.includes('Silver 3 to Silver 2'));
  assert.ok(promotion.includes('rank-promotion'));
  assert.ok(promotion.includes('Promotion'));
  assert.ok(!promotion.includes('Demotion'));
  assert.equal((promotion.match(/Provisional/g) ?? []).length, 1);
  const demotion = render(RankTransition, { before: 'Gold 2', after: 'Gold 3', movement: 'demotion' });
  assert.ok(demotion.includes('Gold 2 to Gold 3'));
  assert.ok(demotion.includes('rank-demotion'));
  assert.ok(demotion.includes('Demotion'));
  assert.ok(!demotion.includes('Promotion'));
});

test('same-rank changes and unknown legacy metadata do not invent rank movement or placement', () => {
  const unchanged = render(RankTransition, { before: 'Masters', after: 'Masters', movement: 'unchanged' });
  assert.ok(!unchanged.includes('Promotion') && !unchanged.includes('Demotion'));
  const legacy = render(RankTransition, { before: null, after: null, movement: null });
  assert.ok(legacy.includes('Not recorded'));
  assert.ok(!legacy.includes('Provisional') && !legacy.includes('Promotion') && !legacy.includes('Demotion'));
});
