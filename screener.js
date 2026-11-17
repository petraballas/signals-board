'use strict';
/* Screener for Bybit USDT perpetuals. Public v5 only, no keys.
   Pure math is exported for tests; the UI boots only in the browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ScreenerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MIN = 60 * 1000;
  const WINS = [
    { id: '5m', ms: 5 * MIN, label: '5м' },
    { id: '15m', ms: 15 * MIN, label: '15м' },
    { id: '1h', ms: 60 * MIN, label: '1ч' },
    { id: '4h', ms: 4 * 60 * MIN, label: '4ч' },
  ];
  const WIN_LABEL = { '5m': '5м', '15m': '15м', '1h': '1ч', '4h': '4ч' };
  const WIN_RANK = { '4h': 4, '1h': 3, '15m': 2, '5m': 1 };
  const FLAT_PX = { '5m': 0.3, '15m': 0.45, '1h': 0.7, '4h': 1.2 };
  const FLAT_OI = { '5m': 0.4, '15m': 0.5, '1h': 0.6, '4h': 1 };
  const STABLE = /^(USDC|USDE|FDUSD|TUSD|DAI|BUSD|USDD|PYUSD|USD1|EUR|XAUT|PAXG)$/;
  const DEFAULTS = {
    pump: { '5m': 1.5, '15m': 2.5, '1h': 4, '4h': 8 },
    dump: { '5m': 1.5, '15m': 2.5, '1h': 4, '4h': 8 },
    volMult: 2.5,
    wickRatio: 0.6,
    minTurnover: 5e6,
    refreshSec: 45,
    maxSymbols: 20,
    oiWindow: '1h',
    sound: true,
    sort: 'heat',
    filter: 'all',
    query: '',
  };
  const SORTS = ['heat', '5m', '15m', '1h', '4h', 'vol', 'oi', 'oi5', 'oi15', 'oi1', 'oi4', 'funding', 'turn', '24h'];
  const FILTERS = ['anomaly', 'pump', 'dump', 'wick', 'volume', 'all'];

  function isNum(v, lo, hi) { return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi; }
  function cloneCfg(c) {
    return {
      pump: Object.assign({}, c.pump), dump: Object.assign({}, c.dump),
      volMult: c.volMult, wickRatio: c.wickRatio, minTurnover: c.minTurnover,
      refreshSec: c.refreshSec, maxSymbols: c.maxSymbols, oiWindow: c.oiWindow,
      sound: c.sound, sort: c.sort, filter: c.filter, query: c.query || '',
    };
  }
  function clampCfg(raw, base) {
    const cfg = cloneCfg(base || DEFAULTS);
    if (!raw || typeof raw !== 'object') return cfg;
    for (const w of WINS) {
      const p = raw.pump && +raw.pump[w.id], d = raw.dump && +raw.dump[w.id];
      if (isNum(p, 0.1, 80)) cfg.pump[w.id] = p;
      if (isNum(d, 0.1, 80)) cfg.dump[w.id] = d;
    }
    if (isNum(+raw.volMult, 1.2, 30)) cfg.volMult = +raw.volMult;
    if (isNum(+raw.wickRatio, 0.4, 0.9)) cfg.wickRatio = +raw.wickRatio;
    if (isNum(+raw.minTurnover, 0, 1e12)) cfg.minTurnover = +raw.minTurnover;
    if ([30, 45, 60].includes(+raw.refreshSec)) cfg.refreshSec = +raw.refreshSec;
    if (isNum(+raw.maxSymbols, 8, 30)) cfg.maxSymbols = Math.round(+raw.maxSymbols);
    if (WINS.some(w => w.id === raw.oiWindow)) cfg.oiWindow = raw.oiWindow;
    if (typeof raw.sound === 'boolean') cfg.sound = raw.sound;
    if (SORTS.includes(raw.sort)) cfg.sort = raw.sort;
    if (FILTERS.includes(raw.filter)) cfg.filter = raw.filter;
    if (typeof raw.query === 'string') cfg.query = raw.query.slice(0, 32);
    return cfg;
  }

  function aggregate(bars, bucketMs) {
    const src = (bars || []).slice().sort((a, b) => a.t - b.t);
    const out = [];
    const map = new Map();
    for (const b of src) {
      if (!(b.t >= 0) || !(b.c > 0)) continue;
      const t = Math.floor(b.t / bucketMs) * bucketMs;
      let g = map.get(t);
      if (!g) { g = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: +b.v || 0 }; map.set(t, g); out.push(g); }
      else { g.h = Math.max(g.h, b.h); g.l = Math.min(g.l, b.l); g.c = b.c; g.v += +b.v || 0; }
    }
    return out;
  }

  function priceAgo(bars, intervalMs, agoMs, now) {
    if (!bars || !bars.length) return null;
    const target = now - agoMs;
    let ref = null;
    for (const b of bars) {
      if (b.t + intervalMs <= target) ref = b.c;
      else break;
    }
    return ref > 0 ? ref : null;
  }

  function oiChange(series, windowMs) {
    if (!series || series.length < 2) return null;
    const nowP = series[series.length - 1];
    const target = nowP.t - windowMs;
    let ref = null;
    for (const p of series) {
      if (p.t <= target) ref = p;
      else break;
    }
    if (!ref || !(ref.oi > 0) || target - ref.t > 15 * MIN) return null;
    return (nowP.oi / ref.oi - 1) * 100;
  }

  function volumeRatio(bars, intervalMs, bucketMs, lookback, now) {
    if (!bars || !bars.length || lookback < 2) return null;
    const agg = bucketMs === intervalMs ? bars.slice().sort((a, b) => a.t - b.t) : aggregate(bars, bucketMs);
    const closed = agg.filter(b => b.t + bucketMs <= now);
    if (closed.length < lookback + 1) return null;
    const last = closed[closed.length - 1];
    const prev = closed.slice(-lookback - 1, -1);
    const avg = prev.reduce((s, b) => s + b.v, 0) / prev.length;
    if (!(avg > 0)) return null;
    const window = bucketMs === 15 * MIN ? '15m' : bucketMs === 60 * MIN ? '1h' : '5m';
    return { ratio: last.v / avg, t: last.t, window };
  }

  function detectWick(bars, intervalMs, opts, now) {
    const agg = aggregate(bars, intervalMs);
    const closed = agg.filter(b => b.t + intervalMs <= now);
    if (closed.length < 8) return null;
    const ratioMin = (opts && opts.wickRatio) || 0.6;
    const window = intervalMs === 60 * MIN ? '1h' : '15m';
    let best = null;
    for (let i = Math.max(6, closed.length - 2); i < closed.length; i++) {
      const x = closed[i];
      const range = x.h - x.l;
      if (!(range > 0)) continue;
      const bodyTop = Math.max(x.o, x.c), bodyBot = Math.min(x.o, x.c);
      const upper = (x.h - bodyTop) / range, lower = (bodyBot - x.l) / range;
      const closePos = (x.c - x.l) / range;
      const prior = closed.slice(Math.max(0, i - 8), i);
      if (prior.length < 5) continue;
      const priorHigh = Math.max.apply(null, prior.map(b => b.h));
      const priorLow = Math.min.apply(null, prior.map(b => b.l));
      const sweptUp = priorHigh > 0 && x.h > priorHigh && (x.h - priorHigh) / priorHigh >= 0.002;
      const sweptDn = priorLow > 0 && x.l < priorLow && (priorLow - x.l) / priorLow >= 0.002;
      if (upper >= ratioMin && closePos <= 0.4 && sweptUp && x.c < priorHigh) {
        const score = upper + (x.h - priorHigh) / range;
        if (!best || score > best.score) best = { dir: 'up', ratio: upper, t: x.t, window, score };
      }
      if (lower >= ratioMin && closePos >= 0.6 && sweptDn && x.c > priorLow) {
        const score = lower + (priorLow - x.l) / range;
        if (!best || score > best.score) best = { dir: 'down', ratio: lower, t: x.t, window, score };
      }
    }
    return best;
  }

  function interpret(pricePct, oiPct, windowId) {
    if (pricePct == null || oiPct == null || !isFinite(pricePct) || !isFinite(oiPct)) {
      return { id: 'na', text: 'нет данных', hint: 'Не хватает цены или истории открытого интереса в этом окне.' };
    }
    const pEps = FLAT_PX[windowId] || 0.5, oEps = FLAT_OI[windowId] || 0.5;
    const up = pricePct >= pEps, down = pricePct <= -pEps;
    const oiUp = oiPct >= oEps, oiDown = oiPct <= -oEps;
    if (up && oiUp) return { id: 'strong-up', text: 'Сильный тренд', hint: 'Цена и открытый интерес растут — набор позиций по направлению движения.' };
    if (up && oiDown) return { id: 'weak-up', text: 'Слабый рост', hint: 'Цена вверх, открытый интерес вниз — похоже на закрытие шортов, а не на новый набор лонгов.' };
    if (down && oiDown) return { id: 'weak-down', text: 'Слабое падение', hint: 'Цена и открытый интерес падают — похоже на закрытие лонгов, а не на новый набор шортов.' };
    if (down && oiUp) return { id: 'strong-down', text: 'Сильный слив', hint: 'Цена вниз, открытый интерес вверх — набор шортов.' };
    if (!up && !down) return { id: 'flat', text: 'Флэт', hint: 'Цена в этом окне почти не изменилась — метку тренда не ставим.' };
    if (up) return { id: 'up-flat-oi', text: 'Рост без OI', hint: 'Цена выросла, открытый интерес почти не изменился.' };
    return { id: 'down-flat-oi', text: 'Падение без OI', hint: 'Цена снизилась, открытый интерес почти не изменился.' };
  }

  function pickVolume(v15, v1h, cfg) {
    const all = [v15, v1h].filter(Boolean);
    if (!all.length) return null;
    const hot = all.filter(v => v.ratio >= cfg.volMult);
    const pool = (hot.length ? hot : all).slice().sort((a, b) => b.ratio - a.ratio);
    return pool[0];
  }

  function analyzeSymbol(ticker, bars, oiSeries, cfg, now) {
    const interval = 5 * MIN;
    const sorted = (bars || []).slice().sort((a, b) => a.t - b.t);
    const oiSer = (oiSeries || []).slice().sort((a, b) => a.t - b.t);
    const px = {}, oi = {};
    for (const w of WINS) {
      const ref = sorted.length ? priceAgo(sorted, interval, w.ms, now) : null;
      px[w.id] = ref > 0 && ticker.last > 0 ? (ticker.last / ref - 1) * 100 : null;
      oi[w.id] = oiChange(oiSer, w.ms);
    }
    const vol = pickVolume(
      volumeRatio(sorted, interval, 15 * MIN, 12, now),
      volumeRatio(sorted, interval, 60 * MIN, 6, now),
      cfg);
    const wick15 = detectWick(sorted, 15 * MIN, cfg, now);
    const wick1h = detectWick(sorted, 60 * MIN, cfg, now);
    const wick = wick1h || wick15 || null;
    const flags = [];
    for (const w of WINS) {
      const p = px[w.id];
      if (p == null) continue;
      if (p >= cfg.pump[w.id]) flags.push({ kind: 'pump', window: w.id, pct: p });
      else if (p <= -cfg.dump[w.id]) flags.push({ kind: 'dump', window: w.id, pct: p });
    }
    if (vol && vol.ratio >= cfg.volMult) flags.push({ kind: 'volume', window: vol.window, ratio: vol.ratio });
    if (wick) flags.push({ kind: 'wick', window: wick.window, dir: wick.dir, ratio: wick.ratio });
    const win = cfg.oiWindow || '1h';
    return {
      symbol: ticker.symbol, base: ticker.base, last: ticker.last, chg24: ticker.chg24,
      turnover: ticker.turnover, funding: ticker.funding, oiUsd: ticker.oiUsd,
      px, oi, vol, wick, wick15, wick1h, flags,
      label: interpret(px[win], oi[win], win),
      partial: !sorted.length,
      spark: sorted.slice(-48).map(b => b.c),
    };
  }

  function rankCandidates(tickers, cfg, cryptoBases) {
    let list = (tickers || []).filter(t => t && typeof t.symbol === 'string' && t.symbol.endsWith('USDT') &&
      t.last > 0 && t.turnover >= cfg.minTurnover && !STABLE.test(t.base));
    if (cryptoBases) list = list.filter(t => cryptoBases.has(t.base));
    list.sort((a, b) => Math.abs(b.chg24) - Math.abs(a.chg24) || (b.turnover - a.turnover));
    return { picked: list.slice(0, cfg.maxSymbols), eligible: list.length };
  }

  function heat(row) {
    let h = 0;
    for (const f of row.flags) {
      if (f.kind === 'pump' || f.kind === 'dump') h += 100 + Math.abs(f.pct);
      else if (f.kind === 'wick') h += 50 + f.ratio * 10;
      else if (f.kind === 'volume') h += 30 + f.ratio * 5;
    }
    let mv = 0;
    for (const w of WINS) if (row.px[w.id] != null) mv = Math.max(mv, Math.abs(row.px[w.id]));
    return h + mv;
  }
  function sortValue(row, key, oiWindow) {
    if (key === 'heat') return heat(row);
    if (key === '5m' || key === '15m' || key === '1h' || key === '4h') return row.px[key] == null ? null : Math.abs(row.px[key]);
    if (key === '24h') return row.chg24 == null || !isFinite(row.chg24) ? null : Math.abs(row.chg24);
    if (key === 'vol') return row.vol ? row.vol.ratio : null;
    if (key === 'funding') return row.funding == null ? null : Math.abs(row.funding);
    if (key === 'turn') return row.turnover;
    if (key === 'oi') { const v = row.oi[oiWindow || '1h']; return v == null ? null : Math.abs(v); }
    const oiKey = { oi5: '5m', oi15: '15m', oi1: '1h', oi4: '4h' }[key];
    if (oiKey) return row.oi[oiKey] == null ? null : Math.abs(row.oi[oiKey]);
    return heat(row);
  }
  function sortRows(rows, key, dir, oiWindow) {
    const d = dir < 0 ? -1 : 1;
    const k = key || 'heat';
    return (rows || []).slice().sort((a, b) => {
      const va = sortValue(a, k, oiWindow), vb = sortValue(b, k, oiWindow);
      if (va == null && vb == null) return a.base < b.base ? -1 : 1;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va === vb) return a.base < b.base ? -1 : 1;
      return (va - vb) * d;
    });
  }
  function sortRowsBy(rows, key, dir, oiWindow) { return sortRows(rows, key, dir, oiWindow); }

  function filterRows(rows, cfg) {
    const q = (cfg.query || '').trim().toUpperCase();
    return (rows || []).filter(row => {
      if (q && row.base.toUpperCase().indexOf(q) < 0 && row.symbol.toUpperCase().indexOf(q) < 0) return false;
      if (cfg.filter === 'all') return true;
      if (cfg.filter === 'pump') return row.flags.some(f => f.kind === 'pump');
      if (cfg.filter === 'dump') return row.flags.some(f => f.kind === 'dump');
      if (cfg.filter === 'wick') return row.flags.some(f => f.kind === 'wick');
      if (cfg.filter === 'volume') return row.flags.some(f => f.kind === 'volume');
      return row.flags.length > 0;
    });
  }

  function alertKey(row, flag) { return [row.symbol, flag.kind, flag.window, flag.dir || ''].join('|'); }
  function shouldAlert(seen, key, now, coolMs, magnitude) {
    const mag = Math.abs(magnitude) || 0;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, { t: now, mag }); return true; }
    const bigger = mag >= prev.mag * 1.3 && mag - prev.mag >= 0.8;
    if (now - prev.t >= coolMs || bigger) { seen.set(key, { t: now, mag: Math.max(mag, prev.mag) }); return true; }
    if (mag > prev.mag) prev.mag = mag;
    return false;
  }
  function primaryAlerts(flags) {
    const best = new Map();
    for (const f of flags || []) {
      const k = f.kind + '|' + (f.dir || '');
      const score = (WIN_RANK[f.window] || 0) * 100 + Math.abs(f.pct || 0) + (f.ratio || 0);
      const prev = best.get(k);
      if (!prev || score > prev.score) best.set(k, { f, score });
    }
    return Array.from(best.values()).map(x => x.f);
  }
  function alertableFlags(row, cfg) {
    return row.flags.filter(f => {
      if (f.kind === 'pump' || f.kind === 'dump' || f.kind === 'wick') return true;
      if (f.kind === 'volume') {
        const m15 = Math.abs(row.px['15m'] || 0), m5 = Math.abs(row.px['5m'] || 0);
        return m15 >= cfg.pump['15m'] * 0.5 || m5 >= cfg.pump['5m'] * 0.5 || f.ratio >= cfg.volMult * 1.6;
      }
      return false;
    });
  }
  function fmtPct(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) + '%';
  }
  function formatAlert(row, flag) {
    const name = row.base;
    let what;
    if (flag.kind === 'pump') what = 'ПАМП ' + name + ': ' + fmtPct(flag.pct) + ' за ' + WIN_LABEL[flag.window];
    else if (flag.kind === 'dump') what = 'ДАМП ' + name + ': ' + fmtPct(flag.pct) + ' за ' + WIN_LABEL[flag.window];
    else if (flag.kind === 'volume') what = 'ОБЪЁМ ' + name + ': ×' + flag.ratio.toFixed(1) + ' к среднему за ' + WIN_LABEL[flag.window];
    else what = 'ПРОСТРЕЛ ' + name + ': фитиль ' + (flag.dir === 'down' ? 'вниз' : 'вверх') + ' · ' + WIN_LABEL[flag.window];
    const tag = row.label && row.label.id !== 'na' && row.label.id !== 'flat' ? ' Метка OI: ' + row.label.text + '.' : '';
    return what + '.' + tag + ' Сигнал для проверки, не торговая рекомендация.';
  }
  function collectAlerts(row, cfg) {
    return primaryAlerts(alertableFlags(row, cfg)).map(flag => ({ key: alertKey(row, flag), text: formatAlert(row, flag), flag }));
  }

  function parseTickers(list) {
    return (list || []).filter(x => x && typeof x.symbol === 'string' && x.symbol.endsWith('USDT')).map(x => ({
      symbol: x.symbol,
      base: x.symbol.replace(/USDT$/, ''),
      last: +x.lastPrice,
      chg24: +x.price24hPcnt * 100,
      turnover: +x.turnover24h,
      funding: x.fundingRate === '' || x.fundingRate == null ? null : +x.fundingRate,
      oiUsd: +x.openInterestValue || null,
    })).filter(t => t.last > 0 && isFinite(t.last));
  }
  function parseKlines(list) {
    return (list || []).map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] }))
      .filter(b => b.t && b.c > 0).sort((a, b) => a.t - b.t);
  }
  function parseOi(list) {
    return (list || []).map(r => ({ t: +r.timestamp, oi: +r.openInterest })).filter(p => p.t && p.oi > 0).sort((a, b) => a.t - b.t);
  }
  function explainError(e) {
    const msg = (e && e.message) || '';
    if (e && (e.status === 429 || e.retCode === 10006)) return 'Лимит запросов Bybit. Пауза, затем повтор.';
    if (e && e.status === 403) return 'Bybit отклонил запрос (HTTP 403). Часто это блокировка региона или сети. Данные другой биржи не подставляются.';
    if (e && e.status) return 'Bybit ответил HTTP ' + e.status + '. Повтор автоматически.';
    if (/abort|timeout/i.test(msg)) return 'Bybit не ответил вовремя. Повтор автоматически.';
    if (/failed to fetch|network|cors|load failed/i.test(msg)) return 'Нет ответа от Bybit (сеть или CORS). Повтор автоматически.';
    if (e && e.retCode) return 'Bybit: ' + (msg || ('код ' + e.retCode));
    return 'Не удалось обновить скринер. Повтор автоматически.';
  }

  return {
    WINS, WIN_LABEL, FLAT_PX, FLAT_OI, DEFAULTS, STABLE,
    clampCfg, aggregate, priceAgo, oiChange, volumeRatio, detectWick, interpret,
    analyzeSymbol, rankCandidates, heat, sortRows, sortRowsBy, filterRows,
    alertKey, shouldAlert, primaryAlerts, alertableFlags, formatAlert, collectAlerts,
    parseTickers, parseKlines, parseOi, explainError, fmtPct,
  };
});

(function () {
  if (typeof document === 'undefined') return;
  const C = globalThis.ScreenerCore;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : 'mut';
  const LS = 'sb_screener_v1';
  const FIELD_IDS = ['scP5', 'scP15', 'scP1', 'scP4', 'scD5', 'scD15', 'scD1', 'scD4', 'scVol', 'scWick', 'scTurn', 'scMax'];
  const PUMP_IDS = { '5m': 'scP5', '15m': 'scP15', '1h': 'scP1', '4h': 'scP4' };
  const DUMP_IDS = { '5m': 'scD5', '15m': 'scD15', '1h': 'scD1', '4h': 'scD4' };

  let cfg = loadCfg();
  let sortDir = -1;
  let running = false;
  let scanning = false;
  let again = false;
  let timer = null;
  let audioCtx = null;
  const seen = loadSeen();
  const state = { rows: [], raw: [], scannedAt: 0, asOf: 0, eligible: 0, errors: 0, errorText: '', busy: false, cryptoNote: '' };

  function loadCfg() {
    try { return C.clampCfg(JSON.parse(localStorage.getItem(LS) || 'null')); }
    catch (e) { return C.clampCfg(null); }
  }
  function saveCfg() { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) {} }
  function loadSeen() {
    const m = new Map();
    try {
      const a = JSON.parse(sessionStorage.getItem('sb_sc_seen') || '[]');
      const now = Date.now();
      for (const x of a) if (x && x.k && now - x.t < 6 * 3600e3) m.set(x.k, { t: x.t, mag: x.m || 0 });
    } catch (e) {}
    return m;
  }
  function saveSeen() {
    const a = Array.from(seen.entries()).slice(-200).map(([k, v]) => ({ k, t: v.t, m: v.mag }));
    try { sessionStorage.setItem('sb_sc_seen', JSON.stringify(a)); } catch (e) {}
  }
  function num(id) {
    const el = $(id); if (!el) return NaN;
    const v = parseFloat(String(el.value).replace(',', '.').replace(/\s/g, ''));
    return isFinite(v) ? v : NaN;
  }
  function fmtPx(p) {
    if (p == null || !isFinite(p)) return '—';
    const a = Math.abs(p);
    const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a >= 0.001 ? 6 : 8;
    return p.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    const n = a >= 1e9 ? (v / 1e9).toFixed(2) + ' млрд' : a >= 1e6 ? (v / 1e6).toFixed(1) + ' млн' : a >= 1e3 ? (v / 1e3).toFixed(1) + ' тыс' : v.toFixed(0);
    return n + ' $';
  }
  function timeStr(d) { return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function apiBase() {
    try {
      const host = location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        const o = new URLSearchParams(location.search).get('scrapi');
        if (o && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) return o.replace(/\/$/, '');
      }
    } catch (e) {}
    return 'https://api.bybit.com';
  }
  function createLimiter(concurrency, gapMs) {
    let active = 0, nextAt = 0;
    const q = [];
    function pump() {
      while (active < concurrency && q.length) {
        const job = q.shift();
        const now = Date.now();
        const wait = Math.max(0, nextAt - now);
        nextAt = Math.max(now, nextAt) + gapMs;
        active++;
        setTimeout(() => {
          Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
        }, wait);
      }
    }
    return fn => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); pump(); });
  }
  const limit = createLimiter(3, 140);
  async function rawGet(url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 9000);
    try {
      const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; throw err; }
      const j = await r.json();
      if (!j || j.retCode !== 0) { const err = new Error((j && j.retMsg) || 'ret ' + (j && j.retCode)); err.retCode = j && j.retCode; throw err; }
      return j;
    } catch (e) {
      if (e && e.name === 'AbortError') { const err = new Error('timeout'); err.timeout = true; throw err; }
      throw e;
    } finally { clearTimeout(t); }
  }
  async function fetchJSON(path) {
    const url = apiBase() + path;
    try { return await limit(() => rawGet(url)); }
    catch (e) {
      if (e && (e.status === 429 || e.retCode === 10006)) { await sleep(1600); return limit(() => rawGet(url)); }
      throw e;
    }
  }

  let basesMem = null, basesAt = 0;
  async function loadBases() {
    if (basesMem && Date.now() - basesAt < 864e5) return basesMem;
    try {
      const c = JSON.parse(localStorage.getItem('sb_sc_bases') || 'null');
      if (c && Date.now() - c.t < 864e5 && Array.isArray(c.b) && c.b.length > 100) {
        basesMem = new Set(c.b); basesAt = c.t; return basesMem;
      }
    } catch (e) {}
    try {
      const bases = [];
      let cursor = '';
      for (let i = 0; i < 6; i++) {
        const path = '/v5/market/instruments-info?category=linear&limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const j = await fetchJSON(path);
        const list = (j.result && j.result.list) || [];
        for (const x of list) if (['', 'innovation', 'adventure'].includes(x.symbolType || '')) bases.push(x.baseCoin);
        cursor = j.result && j.result.nextPageCursor;
        if (!cursor) break;
      }
      if (bases.length > 100) {
        basesMem = new Set(bases); basesAt = Date.now();
        try { localStorage.setItem('sb_sc_bases', JSON.stringify({ t: basesAt, b: bases })); } catch (e) {}
        return basesMem;
      }
    } catch (e) {}
    return null;
  }

  function draftFromForm() {
    const pump = {}, dump = {};
    for (const w of C.WINS) { pump[w.id] = num(PUMP_IDS[w.id]); dump[w.id] = num(DUMP_IDS[w.id]); }
    return {
      pump, dump,
      volMult: num('scVol'),
      wickRatio: num('scWick'),
      minTurnover: num('scTurn') * 1e6,
      maxSymbols: num('scMax'),
      refreshSec: cfg.refreshSec,
      oiWindow: cfg.oiWindow,
      sound: cfg.sound,
      sort: cfg.sort,
      filter: cfg.filter,
      query: ($('scQ') && $('scQ').value) || '',
    };
  }
  let fieldT = null;
  function applyFields() {
    const prevTurn = cfg.minTurnover, prevMax = cfg.maxSymbols;
    cfg = C.clampCfg(draftFromForm(), cfg);
    saveCfg();
    if (running && (cfg.minTurnover !== prevTurn || cfg.maxSymbols !== prevMax)) scan(true);
    else recompute();
  }

  function fillForm() {
    for (const w of C.WINS) {
      $(PUMP_IDS[w.id]).value = String(cfg.pump[w.id]);
      $(DUMP_IDS[w.id]).value = String(cfg.dump[w.id]);
    }
    $('scVol').value = String(cfg.volMult);
    $('scWick').value = String(cfg.wickRatio);
    $('scTurn').value = String(+(cfg.minTurnover / 1e6).toFixed(4));
    $('scMax').value = String(cfg.maxSymbols);
    $('scQ').value = cfg.query || '';
    const sel = $('scSort');
    if ([...sel.options].some(o => o.value === cfg.sort)) sel.value = cfg.sort;
    document.querySelectorAll('#scEvery button').forEach(b => b.classList.toggle('on', +b.dataset.v === cfg.refreshSec));
    document.querySelectorAll('#scOiWin button').forEach(b => b.classList.toggle('on', b.dataset.v === cfg.oiWindow));
    paintSound();
    paintNotify();
    syncChips();
  }
  function paintSound() {
    const b = $('scSound'); if (!b) return;
    b.textContent = cfg.sound ? '🔊' : '🔇';
    b.title = cfg.sound ? 'Звук включён' : 'Звук выключен';
    b.classList.toggle('sc-on', !!cfg.sound);
    b.setAttribute('aria-pressed', cfg.sound ? 'true' : 'false');
  }
  function paintNotify() {
    const b = $('scNotify'); if (!b) return;
    let p = 'default';
    try { p = (typeof Notification !== 'undefined' && Notification.permission) || 'denied'; } catch (e) { p = 'denied'; }
    if (p === 'granted') { b.textContent = '🔔 Уведомления включены'; b.classList.add('sc-on'); }
    else if (p === 'denied') { b.textContent = '🔔 Уведомления запрещены'; b.classList.remove('sc-on'); }
    else { b.textContent = '🔔 Уведомления'; b.classList.remove('sc-on'); }
  }
  function syncChips() {
    document.querySelectorAll('#scFilters button').forEach(b => b.classList.toggle('on', b.dataset.f === cfg.filter));
  }
  function ping(text) {
    const el = $('toast'); if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(ping._t);
    ping._t = setTimeout(() => el.classList.remove('on'), 2800);
  }
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }
  function beep(flag) {
    try {
      const ctx = unlockAudio(); if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      const low = flag && (flag.kind === 'dump' || (flag.kind === 'wick' && flag.dir === 'up'));
      o.type = 'sine';
      o.frequency.value = flag && flag.kind === 'wick' ? 520 : low ? 320 : 680;
      const t0 = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.3);
    } catch (e) {}
  }
  function notify(tag, text) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const n = new Notification('Скринер · сигнал на проверку', { body: text, tag });
      setTimeout(() => { try { n.close(); } catch (e) {} }, 12000);
    } catch (e) {}
  }
  function considerAlerts(rows) {
    let primed = false;
    try { primed = sessionStorage.getItem('sb_sc_primed') === '1'; } catch (e) {}
    const fresh = [];
    const now = Date.now();
    for (const row of rows) {
      for (const flag of C.primaryAlerts(C.alertableFlags(row, cfg))) {
        const key = C.alertKey(row, flag);
        const mag = flag.pct != null ? Math.abs(flag.pct) : (flag.ratio || 0);
        if (C.shouldAlert(seen, key, now, 30 * 60 * 1000, mag) && primed) fresh.push({ row, flag, key });
      }
    }
    saveSeen();
    if (!primed) { try { sessionStorage.setItem('sb_sc_primed', '1'); } catch (e) {} return; }
    if (!fresh.length) return;
    if (cfg.sound && !document.hidden) beep(fresh[0].flag);
    fresh.slice(0, 3).forEach(a => {
      const text = C.formatAlert(a.row, a.flag);
      if (!document.hidden) ping(text);
      notify(a.key, text);
    });
    if (fresh.length > 3 && !document.hidden) ping('Ещё сигналов: ' + (fresh.length - 3) + '. Смотри таблицу — это не команды на вход.');
  }

  function recompute() {
    const now = state.asOf || Date.now();
    state.rows = state.raw.map(r => C.analyzeSymbol(r.ticker, r.bars, r.oi, cfg, now));
    render();
  }

  async function pool(items, fn) {
    let i = 0;
    const n = Math.min(4, items.length);
    const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
    if (n) await Promise.all(Array.from({ length: n }, run));
  }
  async function scan(manual) {
    if (!running && !manual) return;
    if (scanning) { if (manual) again = true; return; }
    scanning = true;
    running = true;
    state.busy = true;
    state.errors = 0;
    renderStatus();
    const btn = $('scRefresh'); if (btn) btn.classList.add('spin');
    try {
      const tj = await fetchJSON('/v5/market/tickers?category=linear');
      const tickers = C.parseTickers(tj.result && tj.result.list);
      const bases = await loadBases();
      state.cryptoNote = bases ? '' : 'Список крипто-контрактов Bybit недоступен — в скане все USDT-перпы, прошедшие оборот.';
      const ranked = C.rankCandidates(tickers, cfg, bases);
      state.eligible = ranked.eligible;
      const raw = [];
      let done = 0;
      const prog = $('scProg');
      await pool(ranked.picked, async t => {
        let bars = [], oi = [];
        try {
          const [kj, oj] = await Promise.all([
            fetchJSON('/v5/market/kline?category=linear&symbol=' + encodeURIComponent(t.symbol) + '&interval=5&limit=120'),
            fetchJSON('/v5/market/open-interest?category=linear&symbol=' + encodeURIComponent(t.symbol) + '&intervalTime=5min&limit=100'),
          ]);
          bars = C.parseKlines(kj.result && kj.result.list);
          oi = C.parseOi(oj.result && oj.result.list);
        } catch (e) {
          state.errors++;
          if (e && (e.status === 429 || e.retCode === 10006)) await sleep(2000);
        }
        raw.push({ ticker: t, bars, oi });
        done++;
        if (prog) prog.style.width = (done / Math.max(1, ranked.picked.length) * 100) + '%';
      });
      state.raw = raw;
      state.asOf = Date.now();
      state.scannedAt = state.asOf;
      state.errorText = state.errors && !raw.some(r => r.bars.length) ? 'Свечи и открытый интерес не загрузились. В таблице только тикеры.' : '';
      state.rows = raw.map(r => C.analyzeSymbol(r.ticker, r.bars, r.oi, cfg, state.asOf));
      considerAlerts(state.rows);
      render();
    } catch (e) {
      state.errorText = C.explainError(e);
      render();
    } finally {
      scanning = false;
      state.busy = false;
      if (btn) btn.classList.remove('spin');
      const prog = $('scProg');
      if (prog) setTimeout(() => { prog.style.width = '0'; }, 600);
      renderStatus();
      if (again) { again = false; scan(true); }
      else schedule();
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    timer = setTimeout(() => {
      if (document.hidden) schedule();
      else scan(false);
    }, cfg.refreshSec * 1000);
  }

  function volText(row) {
    if (!row.vol) return '—';
    return '×' + row.vol.ratio.toFixed(1) + ' · ' + C.WIN_LABEL[row.vol.window];
  }
  function wickText(row) {
    if (!row.wick) return '<span class="dim">—</span>';
    const dir = row.wick.dir === 'down' ? 'вниз' : 'вверх';
    return '<span class="sc-amber">' + dir + ' · ' + C.WIN_LABEL[row.wick.window] + '</span>';
  }
  function badgesHtml(row) {
    const bits = [];
    if (row.flags.some(f => f.kind === 'pump')) bits.push('<span class="sc-badge pump">ПАМП</span>');
    if (row.flags.some(f => f.kind === 'dump')) bits.push('<span class="sc-badge dump">ДАМП</span>');
    if (row.flags.some(f => f.kind === 'volume')) bits.push('<span class="sc-badge vol">ОБЪЁМ</span>');
    if (row.flags.some(f => f.kind === 'wick')) bits.push('<span class="sc-badge wick">ПРОСТРЕЛ</span>');
    return bits.join('');
  }
  function labelClass(label) {
    if (!label) return 'dim';
    if (label.id === 'strong-up') return 'up';
    if (label.id === 'strong-down') return 'down';
    if (label.id === 'weak-up' || label.id === 'weak-down' || label.id === 'up-flat-oi' || label.id === 'down-flat-oi') return 'sc-amber';
    return 'mut';
  }
  function tone(row) {
    if (row.flags.some(f => f.kind === 'pump') && !row.flags.some(f => f.kind === 'dump')) return 'pump';
    if (row.flags.some(f => f.kind === 'dump') && !row.flags.some(f => f.kind === 'pump')) return 'dump';
    if (row.flags.some(f => f.kind === 'wick')) return 'wick';
    if (row.flags.some(f => f.kind === 'pump')) return 'pump';
    return '';
  }
  function rowHtml(row) {
    return '<tr class="sc-row ' + tone(row) + '" data-sym="' + esc(row.symbol) + '">' +
      '<td class="sticky"><div class="sc-sym">' + esc(row.base) + '</div><div>' + badgesHtml(row) + '</div></td>' +
      '<td>' + fmtPx(row.last) + '</td>' +
      '<td class="' + cls(row.chg24) + '">' + C.fmtPct(row.chg24) + '</td>' +
      C.WINS.map(w => '<td class="' + cls(row.px[w.id]) + '">' + C.fmtPct(row.px[w.id]) + '</td>').join('') +
      '<td class="' + (row.vol && row.vol.ratio >= cfg.volMult ? 'up' : 'mut') + '">' + volText(row) + '</td>' +
      ['5m', '15m', '1h', '4h'].map(id => '<td class="' + cls(row.oi[id]) + '">' + C.fmtPct(row.oi[id]) + '</td>').join('') +
      '<td class="' + labelClass(row.label) + '" title="' + esc(row.label.hint) + '">' + esc(row.label.text) + '</td>' +
      '<td class="' + (row.funding == null ? 'dim' : cls(row.funding)) + '">' + (row.funding == null ? '—' : C.fmtPct(row.funding * 100, 4)) + '</td>' +
      '<td>' + wickText(row) + '</td></tr>';
  }
  function cardHtml(row) {
    return '<article class="sc-card glass ' + tone(row) + '" data-sym="' + esc(row.symbol) + '">' +
      '<div class="top"><div class="sc-sym">' + esc(row.base) + '<span class="dim">/USDT</span></div>' +
      '<div class="sc-badges">' + badgesHtml(row) + '</div>' +
      '<span style="margin-left:auto;font-weight:700">' + fmtPx(row.last) + '</span></div>' +
      '<div class="sc-metrics">' + C.WINS.map(w => '<div><small>' + w.label + '</small><b class="' + cls(row.px[w.id]) + '">' + C.fmtPct(row.px[w.id]) + '</b></div>').join('') + '</div>' +
      '<div class="meta"><span class="' + labelClass(row.label) + '">' + esc(row.label.text) + '</span><span>OI ' + C.WIN_LABEL[cfg.oiWindow] + ' ' + C.fmtPct(row.oi[cfg.oiWindow]) + '</span></div>' +
      '<div class="meta"><span>' + (row.vol ? 'объём ' + volText(row) : 'объём —') + '</span><span>funding ' + (row.funding == null ? '—' : C.fmtPct(row.funding * 100, 4)) + '</span><span>' + (row.wick ? wickText(row) : '<span class="dim">прострела нет</span>') + '</span></div>' +
      '</article>';
  }
  function visibleRows() {
    return C.filterRows(C.sortRowsBy(state.rows, cfg.sort, sortDir, cfg.oiWindow), cfg);
  }
  function renderStatus() {
    const live = $('scLive'), upd = $('scUpd'), cnt = $('scCnt'), src = $('scSrc');
    if (!live) return;
    const base = apiBase();
    if (src) src.textContent = base.indexOf('bybit.com') >= 0 ? 'Источник: Bybit v5' : 'Источник: локальная проверка';
    if (state.busy) { live.className = 'pill live'; live.textContent = '○ обновление…'; }
    else if (state.errorText && !state.rows.length) { live.className = 'pill live'; live.textContent = '○ нет связи'; }
    else if (state.scannedAt) { live.className = 'pill live on'; live.textContent = '● ' + timeStr(new Date(state.scannedAt)); }
    else { live.className = 'pill live'; live.textContent = '○ ожидание'; }
    const bits = [];
    if (state.errorText) bits.push(state.errorText);
    if (state.scannedAt) {
      bits.push('авто каждые ' + cfg.refreshSec + ' с');
      if (state.errors) bits.push('без свечей или OI: ' + state.errors);
      if (state.cryptoNote) bits.push(state.cryptoNote);
    } else if (!state.errorText) bits.push('Вкладка запрашивает публичные данные Bybit без ключей.');
    upd.textContent = bits.join(' · ');
    const shown = state.rows.length ? visibleRows().length : 0;
    cnt.textContent = state.rows.length ? ('В таблице: ' + shown + ' из ' + state.rows.length + ' · монет с оборотом от ' + fmtUsd(cfg.minTurnover) + ': ' + state.eligible) : '';
    const btn = $('scRefresh');
    if (btn) btn.classList.toggle('spin', !!state.busy);
  }
  function render() {
    renderStatus();
    syncChips();
    const body = $('scBody'), cards = $('scCards');
    if (!body || !cards) return;
    const view = state.rows.length ? visibleRows() : [];
    if (!state.scannedAt && !state.rows.length) {
      const msg = state.errorText || 'Жду первое обновление с Bybit…';
      body.innerHTML = '<tr><td class="sc-empty" colspan="15">' + esc(msg) + '</td></tr>';
      cards.innerHTML = '<div class="empty glass">' + esc(msg) + '</div>';
    } else if (!view.length) {
      const msg = state.rows.length
        ? 'Под этот фильтр ничего нет. Открой «Все сканированные» или сдвинь пороги.'
        : (state.errorText || 'Ни одна монета не прошла фильтр оборота. Снизь «Мин. оборот 24ч».');
      body.innerHTML = '<tr><td class="sc-empty" colspan="15">' + esc(msg) + '</td></tr>';
      cards.innerHTML = '<div class="empty glass">' + esc(msg) + '</div>';
    } else {
      body.innerHTML = view.map(rowHtml).join('');
      cards.innerHTML = view.map(cardHtml).join('');
    }
    document.querySelectorAll('.sc th').forEach(th => th.classList.toggle('sorted', th.dataset.k === cfg.sort));
  }

  function whyHtml(row) {
    const parts = ['<b>' + esc(row.label.text) + '.</b> ' + esc(row.label.hint)];
    const pumps = row.flags.filter(f => f.kind === 'pump');
    const dumps = row.flags.filter(f => f.kind === 'dump');
    if (pumps.length) parts.push('Рост выше порога: ' + pumps.map(f => C.WIN_LABEL[f.window] + ' ' + C.fmtPct(f.pct)).join(', ') + '.');
    if (dumps.length) parts.push('Падение сильнее порога: ' + dumps.map(f => C.WIN_LABEL[f.window] + ' ' + C.fmtPct(f.pct)).join(', ') + '.');
    if (row.vol && row.vol.ratio >= cfg.volMult) parts.push('Оборот свечи ' + C.WIN_LABEL[row.vol.window] + ' в ' + row.vol.ratio.toFixed(1) + ' раза выше среднего предыдущих свечей.');
    [row.wick1h, row.wick15].filter(Boolean).forEach(w => {
      const side = w.dir === 'down' ? 'Нижний фитиль снял минимум и закрылся обратно' : 'Верхний фитиль снял максимум и закрылся обратно';
      parts.push(side + ' на ' + C.WIN_LABEL[w.window] + ' (фитиль ' + (w.ratio * 100).toFixed(0) + '% диапазона). Кандидат на возврат к среднему — смотри график.');
    });
    if (row.funding != null) {
      const f = row.funding * 100;
      if (f >= 0.03) parts.push('Funding ' + C.fmtPct(f, 4) + ': лонги платят шортам.');
      else if (f <= -0.01) parts.push('Funding ' + C.fmtPct(f, 4) + ': шорты платят лонгам.');
      else parts.push('Funding ' + C.fmtPct(f, 4) + ' — без крайности.');
    }
    parts.push('Оборот 24ч ' + fmtUsd(row.turnover) + (row.oiUsd ? ', открытый интерес ' + fmtUsd(row.oiUsd) : '') + '.');
    if (row.partial) parts.push('Свечи в этот проход не загрузились — в строке только тикер.');
    parts.push('Сигнал для проверки, не торговая рекомендация.');
    return parts.join(' ');
  }
  function drawSpark(series) {
    const cv = $('scSpark');
    if (!cv) return;
    if (!series || series.length < 2) { cv.style.display = 'none'; return; }
    cv.style.display = 'block';
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth || 640, h = 120;
      cv.width = Math.max(10, w) * dpr; cv.height = h * dpr;
      const x = cv.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      const mn = Math.min.apply(null, series), mx = Math.max.apply(null, series);
      const up = series[series.length - 1] >= series[0];
      x.strokeStyle = up ? '#3ddc97' : '#ff5e7a';
      x.lineWidth = 1.6;
      x.beginPath();
      series.forEach((v, i) => {
        const px = (series.length === 1 ? 0 : i / (series.length - 1)) * (w - 8) + 4;
        const py = h - 8 - (v - mn) / (mx - mn || 1) * (h - 16);
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      });
      x.stroke();
    };
    requestAnimationFrame(paint);
  }
  function openDetail(symbol) {
    const row = state.rows.find(r => r.symbol === symbol);
    if (!row) return;
    $('scTitle').textContent = row.base + '/USDT';
    $('scSub').textContent = 'Бессрочный Bybit · повод открыть график, не команда на сделку';
    $('scBadges').innerHTML = badgesHtml(row) || '<span class="dim">Пороги не пробиты</span>';
    $('scBybit').href = 'https://www.bybit.com/trade/usdt/' + row.symbol;
    $('scTv').href = 'https://www.tradingview.com/chart/?symbol=BYBIT:' + row.symbol + '.P';
    const kv = [['Цена', fmtPx(row.last)], ['24ч', '<span class="' + cls(row.chg24) + '">' + C.fmtPct(row.chg24) + '</span>']];
    C.WINS.forEach(w => kv.push(['Цена ' + w.label, '<span class="' + cls(row.px[w.id]) + '">' + C.fmtPct(row.px[w.id]) + '</span>']));
    ['5m', '15m', '1h', '4h'].forEach(id => kv.push(['OI ' + C.WIN_LABEL[id], '<span class="' + cls(row.oi[id]) + '">' + C.fmtPct(row.oi[id]) + '</span>']));
    kv.push(['Объём', volText(row)], ['Оборот 24ч', fmtUsd(row.turnover)], ['OI сейчас', row.oiUsd ? fmtUsd(row.oiUsd) : '—']);
    $('scKv').innerHTML = kv.map(([k, v]) => '<div><small>' + esc(k) + '</small>' + v + '</div>').join('');
    $('scWhy').innerHTML = whyHtml(row);
    drawSpark(row.spark);
    $('scModal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeSc() {
    const m = $('scModal'); if (!m) return;
    m.classList.remove('open');
    if (!$('modal') || !$('modal').classList.contains('open')) document.body.style.overflow = '';
  }
  function onRowClick(e) {
    if (e.target.closest('a')) return;
    const el = e.target.closest('[data-sym]');
    if (el) openDetail(el.dataset.sym);
  }

  function boot() {
    if (!$('v-screener') || !$('scBody')) return;
    fillForm();
    FIELD_IDS.forEach(id => {
      const el = $(id); if (!el) return;
      el.addEventListener('input', () => { clearTimeout(fieldT); fieldT = setTimeout(applyFields, 350); });
      el.addEventListener('change', () => { clearTimeout(fieldT); applyFields(); fillForm(); });
    });
    $('scQ').addEventListener('input', e => { cfg.query = e.target.value.slice(0, 32); saveCfg(); render(); });
    $('scSort').addEventListener('change', e => { cfg.sort = e.target.value; sortDir = -1; saveCfg(); render(); });
    $('scFilters').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      cfg.filter = b.dataset.f; saveCfg(); render();
    });
    $('scEvery').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      cfg.refreshSec = +b.dataset.v; saveCfg();
      document.querySelectorAll('#scEvery button').forEach(x => x.classList.toggle('on', x === b));
      if (running) schedule();
    });
    $('scOiWin').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      cfg.oiWindow = b.dataset.v; saveCfg();
      document.querySelectorAll('#scOiWin button').forEach(x => x.classList.toggle('on', x === b));
      recompute();
    });
    const thead = document.querySelector('.sc thead');
    if (thead) thead.addEventListener('click', e => {
      const th = e.target.closest('th'); if (!th || !th.dataset.k) return;
      if (cfg.sort === th.dataset.k) sortDir *= -1; else { cfg.sort = th.dataset.k; sortDir = -1; }
      saveCfg();
      const sel = $('scSort');
      if ([...sel.options].some(o => o.value === cfg.sort)) sel.value = cfg.sort;
      render();
    });
    $('scReset').addEventListener('click', e => {
      e.stopPropagation();
      const sound = cfg.sound;
      cfg = C.clampCfg(C.DEFAULTS);
      cfg.sound = sound;
      sortDir = -1;
      saveCfg();
      fillForm();
      if (running) scan(true); else render();
    });
    const SET_KEY = 'sb_screener_set_open';
    const setPanel = on => {
      const box = $('scSet'); if (!box) return;
      box.classList.toggle('collapsed', !on);
      const btn = $('scFold');
      if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      const lbl = $('scFoldLbl');
      if (lbl) lbl.textContent = on ? 'Свернуть' : 'Развернуть';
    };
    let setOpen = true;
    try { if (localStorage.getItem(SET_KEY) === '0') setOpen = false; } catch (e) {}
    setPanel(setOpen);
    $('scFold').addEventListener('click', () => {
      setOpen = $('scSet').classList.contains('collapsed');
      setPanel(setOpen);
      try { localStorage.setItem(SET_KEY, setOpen ? '1' : '0'); } catch (e) {}
    });
    $('scRefresh').addEventListener('click', () => { unlockAudio(); running = true; scan(true); });
    $('scSound').addEventListener('click', () => {
      cfg.sound = !cfg.sound; saveCfg(); paintSound();
      if (cfg.sound) { unlockAudio(); beep({ kind: 'pump' }); }
    });
    $('scNotify').addEventListener('click', async () => {
      unlockAudio();
      if (typeof Notification === 'undefined') { ping('Этот браузер не умеет системные уведомления'); return; }
      try {
        const p = await Notification.requestPermission();
        paintNotify();
        if (p === 'granted') ping('Уведомления включены. Это сигналы для проверки, не команды на вход.');
        else ping('Браузер не дал разрешение на уведомления');
      } catch (e) { ping('Не удалось запросить уведомления'); }
    });
    $('scBody').addEventListener('click', onRowClick);
    $('scCards').addEventListener('click', onRowClick);
    $('scClose').addEventListener('click', closeSc);
    $('scModal').addEventListener('click', e => { if (e.target.id === 'scModal') closeSc(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('scModal').classList.contains('open')) closeSc(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !running) return;
      if (!state.scannedAt || Date.now() - state.scannedAt >= cfg.refreshSec * 1000) scan(false);
    });
    document.addEventListener('pointerdown', () => { if (cfg.sound) unlockAudio(); }, { once: true });

    window.Screener = {
      setActive(on) {
        if (!on) return;
        running = true;
        if (!state.busy && (!state.scannedAt || Date.now() - state.scannedAt >= cfg.refreshSec * 1000)) scan(false);
        else render();
      },
      refresh() { running = true; scan(true); },
    };
    if (location.hash === '#screener') {
      const narrow = matchMedia('(max-width:820px)').matches;
      const btn = document.querySelector(narrow ? '.tabbar [data-tab="screener"]' : '[data-dtab="screener"]');
      if (btn) btn.click();
    }
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
