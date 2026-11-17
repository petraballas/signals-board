'use strict';
/* Outcome journal for Signals-tab setups.
   Entry must trade after the signal close. Then SL vs TP1/TP2.
   A candle that contains both is walked on 5m bars; if those bars don't cover it, the stop wins.
   No bars → unresolved. Nothing is filled in. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JournalCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
  const FINE_MS = 300000;
  const EXPIRE_BARS = 24;
  const MAX_ITEMS = 2000;
  const TERMINAL = { win: 1, loss: 1 };

  function tfMs(tf) { return TF_MS[tf] || 0; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : +v; }
  function levelsOk(s) {
    const entry = num(s.entry), sl = num(s.sl), tp1 = num(s.tp1);
    if (!(entry > 0) || !(sl > 0) || !(tp1 > 0)) return false;
    if (s.dir === 'long') return sl < entry && tp1 > entry;
    if (s.dir === 'short') return sl > entry && tp1 < entry;
    return false;
  }
  function tp2ok(s) {
    const tp2 = num(s.tp2);
    if (!(tp2 > 0)) return null;
    if (s.dir === 'long') return tp2 >= num(s.tp1) ? tp2 : null;
    return tp2 <= num(s.tp1) ? tp2 : null;
  }
  function signalId(s) { return [s.base, s.tf, s.type, s.dir, s.t].join('|'); }
  function hitDown(bar, level) { return level > 0 && bar.l <= level; }
  function hitUp(bar, level) { return level > 0 && bar.h >= level; }
  function closedAfter(bars, interval, signalT, now) {
    return (bars || []).filter(b => b && b.t >= 0 && b.t + interval <= now && b.t + interval > signalT)
      .sort((a, b) => a.t - b.t);
  }
  function pack(outcome, result) { return { outcome, result }; }

  function walk(signal, bars, interval, now, onBar) {
    const expireAt = signal.t + EXPIRE_BARS * interval;
    const seq = closedAfter(bars, interval, signal.t, now).filter(b => b.t < expireAt);
    let filled = false;
    for (const bar of seq) {
      const res = onBar(bar, filled);
      if (res === 'filled') { filled = true; continue; }
      if (res) return res;
    }
    if (!seq.length) {
      if (now < signal.t + interval) return pack('notTriggered', 'waiting');
      return pack('unresolved', 'no-bars');
    }
    if (filled) return pack('open', 'open');
    if (now >= expireAt) return pack('notTriggered', 'expired');
    return pack('notTriggered', 'waiting');
  }

  function barEvents(bar, signal) {
    const tp2 = tp2ok(signal);
    const long = signal.dir === 'long';
    return {
      entry: long ? hitDown(bar, num(signal.entry)) : hitUp(bar, num(signal.entry)),
      sl: long ? hitDown(bar, num(signal.sl)) : hitUp(bar, num(signal.sl)),
      tp1: long ? hitUp(bar, num(signal.tp1)) : hitDown(bar, num(signal.tp1)),
      tp2: tp2 ? (long ? hitUp(bar, tp2) : hitDown(bar, tp2)) : false,
    };
  }
  function targetResult(ev) {
    if (ev.sl && (ev.tp1 || ev.tp2)) return null;
    if (ev.sl) return pack('loss', 'SL');
    if (ev.tp2) return pack('win', 'TP2');
    if (ev.tp1) return pack('win', 'TP1');
    return null;
  }

  function fineCovers(bar, parentMs, fineBars) {
    const fine = (fineBars || []).filter(b => b && b.t >= bar.t && b.t < bar.t + parentMs).sort((a, b) => a.t - b.t);
    if (fine.length < 2) return null;
    const step = fine[1].t - fine[0].t;
    if (!(step > 0) || step > FINE_MS) return null;
    const end = fine[fine.length - 1].t + step;
    if (end < bar.t + parentMs - step) return null;
    return fine;
  }
  function resolveAmbiguous(bar, signal, parentMs, fineBars, alreadyFilled) {
    const fine = fineCovers(bar, parentMs, fineBars);
    if (!fine) return pack('loss', 'SL');
    let filled = !!alreadyFilled;
    for (const b of fine) {
      const ev = barEvents(b, signal);
      if (!filled) {
        if (ev.entry && (ev.sl || ev.tp1 || ev.tp2)) return ev.sl ? pack('loss', 'SL') : pack('win', ev.tp2 ? 'TP2' : 'TP1');
        if (ev.entry) { filled = true; continue; }
        if (ev.sl || ev.tp1 || ev.tp2) return pack('notTriggered', 'invalid');
        continue;
      }
      if (ev.sl && (ev.tp1 || ev.tp2)) return pack('loss', 'SL');
      const hitR = targetResult(ev);
      if (hitR) return hitR;
    }
    return pack('loss', 'SL');
  }

  function resolveOutcome(signal, bars, fineBars, now) {
    if (!signal || !levelsOk(signal)) return pack('unresolved', 'bad-levels');
    const interval = tfMs(signal.tf);
    if (!interval || !(signal.t > 0)) return pack('unresolved', 'bad-levels');
    if (!bars || !bars.length) return pack('unresolved', 'no-bars');
    return walk(signal, bars, interval, now, (bar, filled) => {
      const ev = barEvents(bar, signal);
      const both = (ev.sl && (ev.tp1 || ev.tp2)) || (ev.entry && (ev.sl || ev.tp1 || ev.tp2));
      if (!filled) {
        if (ev.entry && both) return resolveAmbiguous(bar, signal, interval, fineBars, false);
        if (ev.entry) return 'filled';
        if (ev.sl || ev.tp1 || ev.tp2) return pack('notTriggered', 'invalid');
        return null;
      }
      if (ev.sl && (ev.tp1 || ev.tp2)) return resolveAmbiguous(bar, signal, interval, fineBars, true);
      return targetResult(ev);
    });
  }

  function plainSignal(s) {
    if (!s) return null;
    const base = s.base || (s.coin && s.coin.base);
    const t = +s.t;
    if (!base || !(t > 0) || (s.dir !== 'long' && s.dir !== 'short')) return null;
    return {
      id: signalId({ base, tf: s.tf, type: s.type, dir: s.dir, t }),
      base, tf: s.tf || '', type: s.type || '', dir: s.dir,
      entry: num(s.entry), sl: num(s.sl), tp1: num(s.tp1), tp2: num(s.tp2),
      t, seenAt: 0, outcome: 'unresolved', result: '',
    };
  }
  function ingest(items, signals, now) {
    const out = Array.isArray(items) ? items.slice() : [];
    const have = new Set(out.map(x => x.id));
    for (const raw of signals || []) {
      const row = plainSignal(raw);
      if (!row || have.has(row.id)) continue;
      row.seenAt = now;
      out.push(row);
      have.add(row.id);
    }
    return cap(out);
  }
  function applyResolution(entry, bars, fineBars, now) {
    if (!entry) return entry;
    if (TERMINAL[entry.outcome] || entry.outcome === 'notTriggered' && entry.result !== 'waiting') return entry;
    const res = resolveOutcome(entry, bars, fineBars, now);
    if (res.outcome === 'unresolved' && res.result === 'no-bars' && entry.outcome === 'unresolved') return entry;
    return Object.assign({}, entry, { outcome: res.outcome, result: res.result, checkedAt: now });
  }
  function cap(items) {
    if (!items || items.length <= MAX_ITEMS) return items || [];
    return items.slice().sort((a, b) => (a.seenAt || 0) - (b.seenAt || 0) || String(a.id).localeCompare(String(b.id))).slice(-MAX_ITEMS);
  }
  function needsCheck(entry) {
    if (!entry) return false;
    if (entry.outcome === 'win' || entry.outcome === 'loss') return false;
    if (entry.outcome === 'notTriggered' && entry.result !== 'waiting') return false;
    return true;
  }

  return { tfMs, levelsOk, signalId, resolveOutcome, plainSignal, ingest, applyResolution, cap, needsCheck, EXPIRE_BARS, FINE_MS };
});

(function () {
  if (typeof document === 'undefined') return;
  const C = globalThis.JournalCore;
  const KEY = 'sb_journal_v1';
  let items = [];
  let ready = false;
  let busy = false;
  let status = '';

  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (j && Array.isArray(j.items)) { items = j.items; ready = items.length > 0; }
    } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ v: 1, items })); } catch (e) {}
  }
  function touchStats() { try { if (window.Stats && window.Stats.refresh) window.Stats.refresh(false); } catch (e) {} }
  function ingest(signals) {
    const now = Date.now();
    const next = C.ingest(items, signals, now);
    if (next.length !== items.length) { items = next; ready = true; save(); touchStats(); }
    resolveSoon();
  }
  let historyDone = false;
  function ingestHistory() {
    if (historyDone || !window.SBStats || !window.SBStats.historySignals) return;
    historyDone = true;
    setTimeout(() => {
      let extra = [];
      try { extra = window.SBStats.historySignals() || []; } catch (e) { extra = []; }
      ingest(extra);
    }, 30);
  }
  let soon = null;
  function resolveSoon() { clearTimeout(soon); soon = setTimeout(() => { resolveAll(); }, 400); }

  async function klines(base, tf) {
    if (!window.SBStats || !window.SBStats.klines) return null;
    try { return await window.SBStats.klines(base, tf); } catch (e) { return null; }
  }
  async function resolveAll() {
    if (busy || !window.SBStats || !window.SBStats.klines) return;
    const todo = items.filter(C.needsCheck);
    if (!todo.length) { status = ''; return; }
    busy = true;
    const bases = [...new Set(todo.map(x => x.base))];
    let n = 0;
    for (const base of bases) {
      n++;
      status = 'Сверяю исходы доски: ' + n + ' из ' + bases.length;
      touchStats();
      const mine = items.filter(x => x.base === base && C.needsCheck(x));
      const tfs = [...new Set(mine.map(x => x.tf))];
      const cache = {};
      for (const tf of tfs) {
        let bars = null;
        try { bars = window.SBStats.bars && window.SBStats.bars(base, tf); } catch (e) {}
        if (!bars) bars = await klines(base, tf);
        cache[tf] = bars;
      }
      const fine = await klines(base, '5m');
      const now = Date.now();
      items = items.map(entry => {
        if (entry.base !== base || !C.needsCheck(entry)) return entry;
        const bars = cache[entry.tf];
        if (!bars || !bars.length) return entry;
        return C.applyResolution(entry, bars, fine, now);
      });
      items = C.cap(items);
      save();
    }
    status = '';
    busy = false;
    ready = true;
    touchStats();
  }

  load();
  window.Journal = {
    ingest,
    ingestHistory,
    items: () => ready ? items.slice() : null,
    status: () => status,
    resolve: resolveAll,
  };
  setInterval(() => { if (!document.hidden) resolveAll(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resolveAll(); });
})();
