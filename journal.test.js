'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('./journal.js');

const M15 = 15 * 60 * 1000;
const M5 = 5 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

function sig(over) {
  return Object.assign({ base: 'SOL', tf: '15m', type: 'breakout', dir: 'long', entry: 100, sl: 90, tp1: 110, tp2: 120, t: T0 }, over);
}
function bar(t, o, h, l, c) { return { t, o, h, l, c }; }

test('TP1 after a filled entry is a win, SL is a loss', () => {
  const now = T0 + 4 * M15;
  const win = J.resolveOutcome(sig(), [
    bar(T0, 101, 102, 100, 101),
    bar(T0 + M15, 101, 112, 99, 111),
  ], null, now);
  assert.deepEqual(win, { outcome: 'win', result: 'TP1' });
  const loss = J.resolveOutcome(sig(), [
    bar(T0, 101, 102, 100, 101),
    bar(T0 + M15, 100, 101, 89, 90),
  ], null, now);
  assert.deepEqual(loss, { outcome: 'loss', result: 'SL' });
});

test('same candle with stop and target is a loss unless 5m shows the target first', () => {
  const now = T0 + 2 * M15;
  const parent = bar(T0, 100, 115, 85, 100);
  const conservative = J.resolveOutcome(sig(), [parent], null, now);
  assert.deepEqual(conservative, { outcome: 'loss', result: 'SL' });
  const tpFirst = [
    bar(T0, 100, 112, 99, 111),
    bar(T0 + M5, 111, 112, 100, 101),
    bar(T0 + 2 * M5, 101, 102, 85, 90),
  ];
  assert.deepEqual(J.resolveOutcome(sig(), [parent], tpFirst, now), { outcome: 'win', result: 'TP1' });
  const slFirst = [
    bar(T0, 100, 101, 85, 90),
    bar(T0 + M5, 90, 115, 89, 110),
    bar(T0 + 2 * M5, 110, 112, 100, 101),
  ];
  assert.deepEqual(J.resolveOutcome(sig(), [parent], slFirst, now), { outcome: 'loss', result: 'SL' });
});

test('no entry before the target is not a win, and expiry is not a loss', () => {
  const now = T0 + 30 * M15;
  const ranAway = J.resolveOutcome(sig(), [
    bar(T0, 105, 112, 104, 111),
  ], null, now);
  assert.deepEqual(ranAway, { outcome: 'notTriggered', result: 'invalid' });
  const quiet = [];
  for (let i = 0; i < 24; i++) quiet.push(bar(T0 + i * M15, 105, 106, 104, 105));
  const expired = J.resolveOutcome(sig(), quiet, null, now);
  assert.deepEqual(expired, { outcome: 'notTriggered', result: 'expired' });
  const waiting = J.resolveOutcome(sig(), [bar(T0, 105, 106, 104, 105)], null, T0 + 2 * M15);
  assert.deepEqual(waiting, { outcome: 'notTriggered', result: 'waiting' });
});

test('filled and unresolved path stays open; empty candles stay unresolved', () => {
  const now = T0 + 2 * M15;
  const open = J.resolveOutcome(sig(), [bar(T0, 101, 103, 100, 102)], null, now);
  assert.deepEqual(open, { outcome: 'open', result: 'open' });
  assert.deepEqual(J.resolveOutcome(sig(), [], null, now), { outcome: 'unresolved', result: 'no-bars' });
  assert.equal(J.resolveOutcome(sig({ sl: 120 }), [bar(T0, 1, 2, 0.5, 1)], null, now).outcome, 'unresolved');
});

test('journal keeps a resolved signal after it leaves the board', () => {
  const now = T0 + M15;
  let items = J.ingest([], [sig()], now);
  assert.equal(items.length, 1);
  assert.equal(items[0].outcome, 'unresolved');
  items[0] = J.applyResolution(items[0], [bar(T0, 101, 102, 100, 101), bar(T0 + M15, 101, 112, 99, 111)], null, now + M15);
  assert.equal(items[0].outcome, 'win');
  const again = J.ingest(items, [], now + 10);
  assert.equal(again.length, 1);
  assert.equal(again[0].result, 'TP1');
  const dup = J.ingest(again, [sig()], now + 20);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].outcome, 'win');
});

test('a short that reaches TP2 before the stop is a win', () => {
  const s = sig({ dir: 'short', entry: 100, sl: 110, tp1: 90, tp2: 80 });
  const now = T0 + 3 * M15;
  const res = J.resolveOutcome(s, [
    bar(T0, 99, 100, 98, 99),
    bar(T0 + M15, 99, 101, 79, 85),
  ], null, now);
  assert.deepEqual(res, { outcome: 'win', result: 'TP2' });
});
