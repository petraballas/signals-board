'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./screener.js');

const M5 = 5 * 60 * 1000;

function flatBars(now, n, close, vol) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const t = now - (n - i) * M5;
    bars.push({ t, o: close, h: close, l: close, c: close, v: vol == null ? 100 : vol });
  }
  return bars;
}

test('price change uses the close at the start of the window', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const bars = flatBars(now, 60, 100);
  // bar that ends at now-5m is the second to last; set its close
  const i5 = bars.findIndex(b => b.t + M5 === now - M5);
  const i15 = bars.findIndex(b => b.t + M5 === now - 15 * 60 * 1000);
  const i1h = bars.findIndex(b => b.t + M5 === now - 60 * 60 * 1000);
  const i4h = bars.findIndex(b => b.t + M5 === now - 4 * 60 * 60 * 1000);
  assert.ok(i5 >= 0 && i4h >= 0);
  bars[i5].c = 100;
  bars[i15].c = 80;
  bars[i1h].c = 50;
  bars[i4h].c = 200;
  assert.equal(C.priceAgo(bars, M5, 5 * 60 * 1000, now), 100);
  assert.equal(C.priceAgo(bars, M5, 15 * 60 * 1000, now), 80);
  assert.equal(C.priceAgo(bars, M5, 60 * 60 * 1000, now), 50);
  assert.equal(C.priceAgo(bars, M5, 4 * 60 * 60 * 1000, now), 200);
  assert.equal(C.priceAgo(bars, M5, 24 * 60 * 60 * 1000, now), null);
});

test('aggregate builds OHLC and sums turnover', () => {
  const t0 = 0;
  const bars = [0, 1, 2].map(i => ({ t: t0 + i * M5, o: 10 + i, h: 20 + i, l: 5 - i, c: 12 + i, v: 10 }));
  const g = C.aggregate(bars, 15 * 60 * 1000);
  assert.equal(g.length, 1);
  assert.equal(g[0].o, 10);
  assert.equal(g[0].h, 22);
  assert.equal(g[0].l, 3);
  assert.equal(g[0].c, 14);
  assert.equal(g[0].v, 30);
});

test('oi change and the four interpretations', () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const series = [];
  for (let i = 48; i >= 0; i--) series.push({ t: now - i * M5, oi: 1000 });
  series[series.length - 1].oi = 1100; // +10% vs 5m ago, and vs 1h ago the point at now-1h is still 1000
  assert.ok(Math.abs(C.oiChange(series, 60 * 60 * 1000) - 10) < 1e-9);
  assert.equal(C.interpret(3, 2, '1h').id, 'strong-up');
  assert.equal(C.interpret(3, 2, '1h').text, 'Сильный тренд');
  assert.equal(C.interpret(3, -2, '1h').text, 'Слабый рост');
  assert.equal(C.interpret(-3, -2, '1h').text, 'Слабое падение');
  assert.equal(C.interpret(-3, 2, '1h').text, 'Сильный слив');
  assert.equal(C.interpret(0.1, 5, '1h').id, 'flat');
  assert.equal(C.interpret(null, 5, '1h').id, 'na');
});

test('pump, dump, volume spike and wick on one symbol', () => {
  const now = Date.UTC(2026, 0, 3, 12, 0, 0);
  const cfg = C.clampCfg(null);
  const bars = flatBars(now, 80, 100, 100);
  // reference closes
  const setClose = (ago, px) => { const b = bars.find(x => x.t + M5 === now - ago); assert.ok(b); b.c = px; };
  setClose(5 * 60 * 1000, 100);
  setClose(15 * 60 * 1000, 90); // +11.1% over 15m if last is 100? wait last ticker is separate
  setClose(60 * 60 * 1000, 80);
  setClose(4 * 60 * 60 * 1000, 70);
  // volume: last CLOSED 15m bucket. now is aligned, so the bucket ending at `now` is closed.
  // Make the three 5m bars of the last 15m very large.
  bars.slice(-3).forEach(b => { b.v = 1000; });
  // lower wick on the last closed 15m: rewrite the three 5m bars into a sweep
  // Easier to pass pre-shaped 15m by making 5m bars that aggregate into a hammer.
  // Prior 15m buckets stay flat at 100. Last 15m: low sweep.
  const lastStart = now - 15 * 60 * 1000;
  bars.filter(b => b.t >= lastStart).forEach((b, i) => {
    if (i === 0) { b.o = 100; b.h = 101; b.l = 80; b.c = 99; }
    else { b.o = 99; b.h = 101; b.l = 98; b.c = 100.5; }
  });

  const oi = [];
  for (let i = 60; i >= 0; i--) oi.push({ t: now - i * M5, oi: i === 0 ? 800 : 1000 }); // last point -20%
  const row = C.analyzeSymbol({
    symbol: 'SOLUSDT', base: 'SOL', last: 100, chg24: 12, turnover: 20e6, funding: 0.0001, oiUsd: 5e6,
  }, bars, oi, cfg, now);

  assert.ok(row.px['15m'] > cfg.pump['15m'], '15m pump ' + row.px['15m']);
  assert.ok(row.flags.some(f => f.kind === 'pump' && f.window === '15m'));
  assert.ok(row.vol && row.vol.ratio >= cfg.volMult, 'vol ' + (row.vol && row.vol.ratio));
  assert.ok(row.flags.some(f => f.kind === 'volume'));
  assert.equal(row.label.id, 'weak-up');
  assert.equal(row.wick && row.wick.dir, 'down');
  const alerts = C.collectAlerts(row, cfg);
  assert.ok(alerts.length >= 2);
  for (const a of alerts) {
    assert.match(a.text, /для проверки/);
    assert.match(a.text, /не торговая рекомендация/);
    assert.doesNotMatch(a.text, /купи|продай|вход в/i);
  }
});

test('wick must sweep and close back inside', () => {
  const now = Date.UTC(2026, 0, 4, 12, 0, 0);
  const bars = [];
  for (let i = 0; i < 12; i++) {
    const t = now - (12 - i) * 15 * 60 * 1000;
    bars.push({ t, o: 100, h: 102, l: 98, c: 100, v: 10 });
  }
  // long upper wick but close stays above the prior high → not a прострел
  const bad = bars[bars.length - 1];
  bad.o = 103; bad.h = 120; bad.l = 102; bad.c = 104;
  assert.equal(C.detectWick(bars, 15 * 60 * 1000, { wickRatio: 0.6 }, now), null);
  // same wick, close back under the prior high (102)
  bad.o = 101; bad.h = 120; bad.l = 100; bad.c = 101;
  const hit = C.detectWick(bars, 15 * 60 * 1000, { wickRatio: 0.6 }, now);
  assert.equal(hit && hit.dir, 'up');
});

test('ranking keeps liquid top movers and skips stables', () => {
  const cfg = C.clampCfg({ minTurnover: 5e6, maxSymbols: 8 });
  assert.equal(C.clampCfg({ maxSymbols: 2 }).maxSymbols, C.DEFAULTS.maxSymbols);
  const tickers = [
    { symbol: 'AAAUSDT', base: 'AAA', last: 1, chg24: 30, turnover: 9e6 },
    { symbol: 'BBBUSDT', base: 'BBB', last: 1, chg24: -20, turnover: 8e6 },
    { symbol: 'CCCUSDT', base: 'CCC', last: 1, chg24: 50, turnover: 1e6 },
    { symbol: 'USDCUSDT', base: 'USDC', last: 1, chg24: 80, turnover: 50e6 },
    { symbol: 'DDDUSDT', base: 'DDD', last: 1, chg24: 5, turnover: 40e6 },
  ];
  const crypto = new Set(['AAA', 'BBB', 'CCC', 'USDC', 'DDD']);
  const r = C.rankCandidates(tickers, cfg, crypto);
  assert.deepEqual(r.picked.map(t => t.base), ['AAA', 'BBB', 'DDD']);
  assert.equal(r.eligible, 3);
  const noStock = C.rankCandidates(tickers, cfg, new Set(['BBB']));
  assert.deepEqual(noStock.picked.map(t => t.base), ['BBB']);
});

test('dedupe blocks the same signal and lets a much larger move through', () => {
  const seen = new Map();
  const now = 1_000_000;
  assert.equal(C.shouldAlert(seen, 'SOL|pump|1h|', now, 1000, 4), true);
  assert.equal(C.shouldAlert(seen, 'SOL|pump|1h|', now + 10, 1000, 4.2), false);
  assert.equal(C.shouldAlert(seen, 'SOL|pump|1h|', now + 10, 1000, 6), true);
  assert.equal(C.shouldAlert(seen, 'SOL|dump|1h|', now + 10, 1000, 4), true);
});

test('parsers accept Bybit shapes and newest-first lists', () => {
  const tickers = C.parseTickers([
    { symbol: 'BTCUSDT', lastPrice: '100', price24hPcnt: '0.015', turnover24h: '1000000', fundingRate: '0.0001', openInterestValue: '50' },
    { symbol: 'BTCUSD', lastPrice: '1', price24hPcnt: '0', turnover24h: '1', fundingRate: '', openInterestValue: '' },
    { symbol: 'ETHUSDT', lastPrice: '0', price24hPcnt: '0', turnover24h: '1', fundingRate: '', openInterestValue: '' },
  ]);
  assert.equal(tickers.length, 1);
  assert.equal(tickers[0].chg24, 1.5);
  assert.equal(tickers[0].funding, 0.0001);
  const kl = C.parseKlines([['3000', '2', '4', '1', '3', '9', '8'], ['1000', '1', '2', '0.5', '1.5', '4', '3']]);
  assert.deepEqual(kl.map(b => b.t), [1000, 3000]);
  assert.equal(kl[0].v, 3);
  const oi = C.parseOi([{ openInterest: '5', timestamp: '2000' }, { openInterest: '4', timestamp: '1000' }]);
  assert.equal(oi[0].oi, 4);
  assert.equal(oi[1].t, 2000);
});

test('settings clamp and error text', () => {
  const cfg = C.clampCfg({ pump: { '5m': 3 }, refreshSec: 10, maxSymbols: 100, wickRatio: 0.2, minTurnover: -5 }, null);
  assert.equal(cfg.pump['5m'], 3);
  assert.equal(cfg.pump['1h'], C.DEFAULTS.pump['1h']);
  assert.equal(cfg.refreshSec, C.DEFAULTS.refreshSec);
  assert.equal(cfg.maxSymbols, C.DEFAULTS.maxSymbols);
  assert.equal(cfg.wickRatio, C.DEFAULTS.wickRatio);
  const kept = C.clampCfg({ pump: { '5m': 0 } }, cfg);
  assert.equal(kept.pump['5m'], 3);
  assert.match(C.explainError({ status: 403 }), /403/);
  assert.match(C.explainError({ status: 429 }), /Лимит/);
  assert.match(C.explainError(new TypeError('Failed to fetch')), /CORS|сеть/);
});

test('primary alert prefers the higher timeframe of the same kind', () => {
  const flags = [
    { kind: 'pump', window: '5m', pct: 9 },
    { kind: 'pump', window: '1h', pct: 5 },
    { kind: 'dump', window: '15m', pct: -3 },
  ];
  const top = C.primaryAlerts(flags);
  assert.equal(top.filter(f => f.kind === 'pump').length, 1);
  assert.equal(top.find(f => f.kind === 'pump').window, '1h');
  assert.equal(top.find(f => f.kind === 'dump').window, '15m');
});

test('filter and sort', () => {
  const rows = [
    { symbol: 'AAAUSDT', base: 'AAA', chg24: 1, turnover: 10, funding: 0.01, px: { '5m': 0.2, '15m': 0.2, '1h': 0.2, '4h': 0.2 }, oi: { '1h': 1 }, vol: { ratio: 1.1 }, flags: [] },
    { symbol: 'SOLUSDT', base: 'SOL', chg24: -8, turnover: 5, funding: -0.02, px: { '5m': -1, '15m': -6, '1h': -2, '4h': 0 }, oi: { '1h': -3 }, vol: { ratio: 4 }, flags: [{ kind: 'dump', window: '15m', pct: -6 }, { kind: 'volume', window: '15m', ratio: 4 }] },
  ];
  const cfg = C.clampCfg({ filter: 'dump', query: 'sol' });
  assert.equal(C.filterRows(rows, cfg).length, 1);
  const sorted = C.sortRows(rows, '15m', -1);
  assert.equal(sorted[0].base, 'SOL');
});
