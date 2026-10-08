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

test('public leaderboard uses the 2–1–3 podium and compact fourth/fifth rows', async () => {
  const tableSource = await readFile(new URL('../src/components/LeaderboardTable.tsx', import.meta.url), 'utf8');
  const transformedTable = await transformWithEsbuild(tableSource, 'LeaderboardTable.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
  const tableCode = transformedTable.code.replaceAll(
    '"react/jsx-runtime"',
    JSON.stringify(import.meta.resolve('react/jsx-runtime')),
  );
  const { default: Table } = await import(`data:text/javascript;base64,${Buffer.from(tableCode).toString('base64')}`);
  const markup = render(Table, { players: [
    { id: 1, placement: 1, name: 'Amy', mostPlayedPosition: 'Outside Hitter', tier: 'Masters' },
    { id: 2, placement: 2, name: 'Zed', mostPlayedPosition: 'Setter', tier: 'Diamond' },
    { id: 3, placement: 3, name: 'Mina', mostPlayedPosition: 'Libero', tier: 'Platinum' },
    { id: 4, placement: 4, name: 'Theo', mostPlayedPosition: 'Middle Blocker', tier: 'Gold' },
    { id: 5, placement: 5, name: 'John', mostPlayedPosition: null, tier: 'Silver' },
  ] });
  assert.ok(markup.indexOf('data-testid="leaderboard-place-2"') < markup.indexOf('data-testid="leaderboard-place-1"'));
  assert.ok(markup.indexOf('data-testid="leaderboard-place-1"') < markup.indexOf('data-testid="leaderboard-place-3"'));
  assert.ok(markup.includes('data-testid="leaderboard-place-4"'));
  assert.ok(markup.includes('data-testid="leaderboard-place-5"'));
  assert.ok(markup.includes('Outside Hitter') && markup.includes('Masters'));
  assert.ok(markup.includes('Middle Blocker') && markup.includes('Gold'));
  assert.ok(markup.includes('>—</span>'));
  assert.equal((markup.match(/podium-place-number/g) ?? []).length, 3);
  assert.ok(!/ELO|rating|elo-meter|preference|Provisional|avatar|medal|crown|win rate/i.test(markup));

  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.leaderboard-podium{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'));
  assert.ok(css.includes('@media(max-width:420px)'));
  assert.ok(css.includes('.podium-player-name{max-width:100%'));
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
