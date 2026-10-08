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

test('public leaderboard renders up to five uniform rows in placement order', async () => {
  const tableSource = await readFile(new URL('../src/components/LeaderboardTable.tsx', import.meta.url), 'utf8');
  const transformedTable = await transformWithEsbuild(tableSource, 'LeaderboardTable.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
  const tableCode = transformedTable.code.replaceAll(
    '"react/jsx-runtime"',
    JSON.stringify(import.meta.resolve('react/jsx-runtime')),
  );
  const { default: Table } = await import(`data:text/javascript;base64,${Buffer.from(tableCode).toString('base64')}`);
  const markup = render(Table, { players: [
    { id: 5, placement: 5, name: 'John', mostPlayedPosition: null, tier: 'Silver' },
    { id: 2, placement: 2, name: 'Zed', mostPlayedPosition: 'Setter', tier: 'Diamond' },
    { id: 1, placement: 1, name: 'Amy', mostPlayedPosition: 'Outside Hitter', tier: 'Masters' },
    { id: 3, placement: 3, name: 'Mina', mostPlayedPosition: 'Libero', tier: 'Platinum' },
    { id: 4, placement: 4, name: 'Theo', mostPlayedPosition: 'Middle Blocker', tier: 'Gold' },
    { id: 6, placement: 6, name: 'Outside Top Five', mostPlayedPosition: 'Opposite', tier: 'Bronze' },
  ] });
  for (let place = 1; place < 5; place++) {
    assert.ok(markup.indexOf(`data-testid="leaderboard-place-${place}"`) < markup.indexOf(`data-testid="leaderboard-place-${place + 1}"`));
  }
  assert.equal((markup.match(/class="leaderboard-row leaderboard-place-/g) ?? []).length, 5);
  assert.ok(markup.includes('leaderboard-place-1') && markup.includes('leaderboard-place-2') && markup.includes('leaderboard-place-3'));
  assert.ok(markup.includes('Outside Hitter') && markup.includes('Masters'));
  assert.ok(markup.includes('Middle Blocker') && markup.includes('Gold'));
  assert.ok(markup.includes('>—</span>'));
  assert.ok(markup.includes('leaderboard-tier-masters'));
  assert.ok(markup.includes('leaderboard-tier-silver'));
  assert.ok(!markup.includes('Outside Top Five'));
  assert.ok(!/ELO|rating|elo-meter|preference|Provisional|avatar|medal|crown|win rate|podium/i.test(markup));

  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.leaderboard-list{display:grid;gap:12px'));
  assert.ok(css.includes('@media(max-width:420px)'));
  assert.ok(css.includes('.leaderboard-player-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'));
  assert.ok(css.includes('.leaderboard-place-1{background:#fcf8e9'));
  assert.ok(css.includes('.leaderboard-place-2{background:#f6f7f7'));
  assert.ok(css.includes('.leaderboard-place-3{background:#fbf2ed'));
});

test('shared competitive-rank dialog uses server ranges and profile metrics have spacing', async () => {
  const dialog = await readFile(new URL('../src/components/CompetitiveRanksDialog.tsx', import.meta.url), 'utf8');
  assert.ok(dialog.includes('useGetRankTiers'));
  assert.ok(dialog.includes('<Dialog open={open} onOpenChange={setOpen}>'));
  assert.ok(dialog.includes('<DialogTrigger asChild>'));
  assert.ok(dialog.includes('<DialogTitle>Competitive Ranks</DialogTitle>'));
  assert.ok(dialog.includes('<th scope="col">Rank</th><th scope="col">ELO Range</th>'));
  assert.ok(dialog.includes('maxElo === null'));
  assert.ok(dialog.includes('${minElo.toLocaleString()}+'));
  assert.ok(dialog.includes('rank-info-trigger'));

  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('button-rank-info-leaderboard'));
  assert.ok(app.includes('button-rank-info-profile'));
  assert.ok(app.includes('profile-rank-elo'));
  assert.ok(app.includes('data-testid="text-my-elo"'));
  assert.ok(app.includes('Matches Played'));
  assert.ok(app.includes('card-leaderboard-visibility'));

  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.profile-rank-elo{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))'));
  assert.ok(css.includes('.profile-metric{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:8px}'));
  assert.ok(css.includes('.rank-info-dialog>button{right:8px;top:8px;min-width:44px;min-height:44px'));
});

test('Profile uses an auto-saving accessible leaderboard visibility switch without the old popup', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('function LeaderboardVisibilitySetting'));
  assert.ok(app.includes('Leaderboard Visibility'));
  assert.ok(app.includes('Allow your name to appear on the public Top 5 leaderboard.'));
  assert.ok(app.includes('role="switch"'));
  assert.ok(app.includes('aria-checked={enabled}'));
  assert.ok(app.includes('aria-busy={updatePlayer.isPending}'));
  assert.ok(app.includes('data: { eloPublic: nextValue }'));
  assert.ok(app.includes('setEnabled(previousValue)'));
  assert.ok(app.includes('queryClient.setQueryData(getGetPlayerQueryKey(player.id), updated)'));
  assert.ok(app.includes('queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() })'));
  assert.ok(app.includes('card-leaderboard-visibility'));
  assert.ok(!app.includes('button-edit-visibility'));
  assert.ok(!app.includes('ELO visibility'));
  assert.ok(!app.includes('text-my-visibility'));
  assert.ok(app.includes('button-rank-info-profile'));
  assert.ok(app.includes('button-save-player'));

  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.leaderboard-visibility-row'));
  assert.ok(css.includes('.leaderboard-visibility-switch[aria-checked="true"]'));
  assert.ok(css.includes('.leaderboard-visibility-switch:focus-visible'));
  assert.ok(css.includes('.leaderboard-visibility-saving'));
  assert.ok(css.includes('.leaderboard-visibility-error'));
  assert.ok(css.includes('.leaderboard-visibility-row{align-items:flex-start;gap:12px;padding:16px 14px}'));
});

test('ranked position input supports minimum selection, ordered labels, and mobile-friendly reordering', async () => {
  const inputSource = await readFile(new URL('../src/components/RankedPositionInput.tsx', import.meta.url), 'utf8');
  const transformedInput = await transformWithEsbuild(inputSource, 'RankedPositionInput.tsx', { loader: 'tsx', jsx: 'automatic', format: 'esm' });
  const inputCode = transformedInput.code
    .replace('import "./ranked-position-input.css";', '')
    .replaceAll('"react"', JSON.stringify(import.meta.resolve('react')))
    .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')));
  const { default: RankedPositionInput } = await import(`data:text/javascript;base64,${Buffer.from(inputCode).toString('base64')}`);
  const markup = render(RankedPositionInput, {
    value: ['Setter', 'Outside Hitter', 'Libero'],
    onChange: () => {},
    minSelected: 3,
    showHelp: false,
  });
  assert.ok(markup.includes('data-testid="ranked-position-input"'));
  assert.ok(markup.includes('>1</span>') && markup.includes('>2</span>') && markup.includes('>3</span>'));
  assert.ok(markup.includes('aria-label="Move Setter up"'));
  assert.ok(markup.includes('aria-label="Move Setter down"'));
  assert.match(markup, /<input\b(?=[^>]*\btype="checkbox")(?=[^>]*\bchecked="")(?=[^>]*\bdisabled="")[^>]*>/);
  assert.ok(markup.includes('data-testid="checkbox-position-opposite"'));
  assert.ok(!markup.includes('Choose 1–5 unique roles'));

  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('function PreferredPositionsSection'));
  assert.ok(app.includes("Select your preferred positions in order, from most to least preferred. You may occasionally be assigned a position you haven't selected if needed to balance the teams."));
  assert.ok(app.includes('updatePlayer.mutate({ playerId: player.id, data: { positions: selectedPositions } }'));
  assert.ok(app.includes('queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() })'));
  assert.ok(app.includes('{!access.isAdmin && <PreferredPositionsSection'));
  assert.ok(app.includes('Choose at least three preferred positions before saving.'));
  assert.ok(app.includes('title="Linking needed"'));

  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.preferred-position-description'));
  assert.ok(css.includes('.preferred-position-body'));
  assert.ok(css.includes('.preferred-position-actions>.button{width:100%}'));
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
