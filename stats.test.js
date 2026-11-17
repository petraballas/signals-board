'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./stats.js');

function paper() {
  return {
    balance: 1000, source: 'OKX', lastRun: 100, lastSignals: [{ base: 'X' }, { base: 'Y' }],
    closed: [
      { base: 'BTC', dir: 'long', type: 'breakout', result: 'TP2', pnl: 30 },
      { base: 'ETH', dir: 'short', type: 'bounce', result: 'SL', pnl: -20 },
      { base: 'SUI', dir: 'short', type: 'bounce', result: 'TP1+BE', pnl: 10 },
      { base: 'ZEC', dir: 'long', type: 'pullback', result: 'BE', pnl: -1 },
      { base: 'AAA', dir: 'long', type: 'smc', result: 'LIQ', pnl: -50 },
      { base: 'BBB', dir: 'short', type: 'breakout' },
    ],
    positions: [
      { base: 'DOGE', dir: 'short', type: 'bounce', status: 'open', tp1Hit: false },
      { base: 'SOL', dir: 'long', type: 'pullback', status: 'open', tp1Hit: true },
    ],
    pending: [{ base: 'OP', dir: 'long', type: 'breakout', status: 'pending' }],
    cancelled: [{ base: 'TIA', dir: 'short', type: 'smc', status: 'cancelled', why: 'invalid' }],
  };
}

test('closed results map to win, loss, flat, or unresolved — never a guess', () => {
  const rows = S.fromPaper(paper());
  const by = Object.fromEntries(rows.filter(r => r.source === 'Демо-счёт').map(r => [r.base, r.outcome]));
  assert.equal(by.BTC, 'win');
  assert.equal(by.SUI, 'win');
  assert.equal(by.ETH, 'loss');
  assert.equal(by.AAA, 'loss');
  assert.equal(by.ZEC, 'flat');
  assert.equal(by.BBB, 'unresolved');
  assert.equal(by.DOGE, 'open');
  assert.equal(by.SOL, 'open');
  assert.equal(by.OP, 'unresolved');
  assert.equal(by.TIA, 'unresolved');
});

test('favorites use only the stored status', () => {
  const rows = S.fromFav([
    { base: 'SOL', dir: 'long', type: 'smc', status: 'tp2' },
    { base: 'WIF', dir: 'short', type: 'bounce', status: 'stop' },
    { base: 'PEPE', dir: 'long', type: 'breakout', status: 'tp1stop' },
    { base: 'BTC', dir: 'long', type: 'pullback', status: 'tp1' },
    { base: 'ETH', dir: 'short', type: 'bounce', status: 'active' },
    { base: 'X', dir: 'long', status: 'weird' },
  ]);
  assert.deepEqual(rows.map(r => r.outcome), ['win', 'loss', 'mixed', 'open', 'open', 'unresolved']);
});

test('winrate ignores open, flat, mixed, unresolved and an empty book', () => {
  const s = S.summarize({ paper: paper(), favs: [{ base: 'SOL', dir: 'long', type: 'smc', status: 'tp2' }, { base: 'WIF', dir: 'short', type: 'bounce', status: 'stop' }, { base: 'PEPE', dir: 'long', type: 'breakout', status: 'tp1stop' }], board: [{ base: 'RNDR', dir: 'long', type: 'breakout' }] });
  // wins: TP2, TP1+BE, fav tp2 = 3; losses: SL, LIQ, fav stop = 3
  assert.equal(s.counts.win, 3);
  assert.equal(s.counts.loss, 3);
  assert.equal(s.counts.flat, 1);
  assert.equal(s.counts.mixed, 1);
  assert.equal(s.counts.open, 2);
  assert.ok(s.counts.unresolved >= 4);
  assert.equal(s.winrate, 0.5);
  assert.equal(s.openTp1, 1);
  assert.equal(S.summarize({ paper: { balance: 1, closed: [], positions: [], pending: [] }, favs: [], board: null }).winrate, null);
  const demo = s.bySource.find(r => r.key === 'Демо-счёт');
  const board = s.bySource.find(r => r.key === 'Доска');
  assert.equal(demo.win, 2);
  assert.equal(board.unresolved, 1);
  assert.equal(board.win, 0);
  const shorts = s.byDir.find(r => r.key === 'short');
  assert.ok(shorts.win >= 1 && shorts.loss >= 1);
  assert.equal(s.byCoin.some(r => r.key === 'RNDR'), false);
  assert.equal(s.seenSignals, 2);
});

test('a missing paper account is not reported as zero trades', () => {
  const s = S.summarize({ paper: null, favs: [], board: [] });
  assert.equal(s.paperMissing, true);
  assert.equal(s.bySource.some(r => r.key === 'Демо-счёт'), false);
  assert.equal(s.counts.win, 0);
  assert.equal(s.winrate, null);
});

test('pickPaper keeps the newer public state', () => {
  const a = { balance: 1, lastRun: 10 };
  const b = { balance: 2, lastRun: 20 };
  assert.equal(S.pickPaper([a, { balance: NaN }, b]).lastRun, 20);
  assert.equal(S.pickPaper([null, {}]), null);
});
