'use strict';
/* ===== Signals board — client-side only. Data: Bybit v5 public → OKX → Gate. No keys, no trading. ===== */
const CFG = { TOP: 30, TFS: ['15m', '1h', '4h'], CONC: 6, TIMEOUT: 9000, REFRESH_MARKET: 60e3, REFRESH_SIGNALS: 180e3 };
const STABLE = /^(USDC|USDE|FDUSD|TUSD|DAI|BUSD|USDD|PYUSD|USD1|EUR|XAUT|PAXG)$/;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const FORCE = new URLSearchParams(location.search).get('src'); // ?src=okx|gate for testing

/* ---------- utils ---------- */
async function getJSON(url, ms = CFG.TIMEOUT) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function pool(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) { /* skip */ } } }; await Promise.all(Array.from({ length: n }, run)); }
function fmtP(p) { if (p == null || !isFinite(p)) return '—'; const a = Math.abs(p); const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a >= 0.001 ? 6 : 8; return p.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtBig(v) { if (v == null || !isFinite(v)) return '—'; const a = Math.abs(v); return a >= 1e9 ? (v / 1e9).toFixed(2) + ' B' : a >= 1e6 ? (v / 1e6).toFixed(1) + ' M' : a >= 1e3 ? (v / 1e3).toFixed(1) + ' K' : v.toFixed(0); }
function pct(v, d = 2) { if (v == null || !isFinite(v)) return '—'; return (v > 0 ? '+' : '') + v.toFixed(d) + '%'; }
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : 'mut';
const timeStr = d => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'только что'; if (m < 60) return m + ' мин назад'; const h = Math.floor(m / 60); return h + ' ч ' + (m % 60) + ' мин назад'; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- providers ---------- */
const P = {
  bybit: {
    name: 'Bybit', base: 'https://api.bybit.com',
    async tickers() {
      const j = await getJSON(this.base + '/v5/market/tickers?category=linear', 7000);
      if (j.retCode !== 0) throw new Error(j.retMsg);
      return j.result.list.filter(x => x.symbol.endsWith('USDT')).map(x => ({
        id: x.symbol, base: x.symbol.replace(/USDT$/, ''), last: +x.lastPrice, chg: +x.price24hPcnt * 100,
        turnover: +x.turnover24h, funding: x.fundingRate === '' ? null : +x.fundingRate, oiUsd: +x.openInterestValue || null,
        nextFunding: +x.nextFundingTime || null }));
    },
    async klines(id, tf, limit = 300) {
      const iv = { '15m': '15', '1h': '60', '4h': '240' }[tf];
      const j = await getJSON(`${this.base}/v5/market/kline?category=linear&symbol=${id}&interval=${iv}&limit=${limit}`);
      if (j.retCode !== 0) throw new Error(j.retMsg);
      return j.result.list.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] })).reverse();
    },
    async oiHist(id) {
      const j = await getJSON(`${this.base}/v5/market/open-interest?category=linear&symbol=${id}&intervalTime=1h&limit=48`);
      return j.result.list.map(r => ({ t: +r.timestamp, oi: +r.openInterest })).reverse(); // contracts (coin)
    },
    link: b => `https://www.bybit.com/trade/usdt/${b}USDT`,
  },
  okx: {
    name: 'OKX', base: 'https://www.okx.com',
    async tickers() {
      const j = await getJSON(this.base + '/api/v5/market/tickers?instType=SWAP', 8000);
      return j.data.filter(x => x.instId.endsWith('-USDT-SWAP')).map(x => ({
        id: x.instId, base: x.instId.split('-')[0], last: +x.last, chg: (+x.last / +x.open24h - 1) * 100,
        turnover: +x.volCcy24h * +x.last, funding: null, oiUsd: null }));
    },
    async klines(id, tf, limit = 300) {
      const bar = { '15m': '15m', '1h': '1H', '4h': '4H' }[tf];
      const j = await getJSON(`${this.base}/api/v5/market/candles?instId=${id}&bar=${bar}&limit=${limit}`);
      return j.data.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] })).reverse();
    },
    async funding(id) { const j = await getJSON(`${this.base}/api/v5/public/funding-rate?instId=${id}`); const d = j.data[0]; return { rate: +d.fundingRate, next: +d.fundingTime }; },
    async oiNow(id) { const j = await getJSON(`${this.base}/api/v5/public/open-interest?instType=SWAP&instId=${id}`); return +j.data[0].oiUsd; },
  },
  gate: {
    name: 'Gate', base: 'https://api.gateio.ws/api/v4',
    async tickers() {
      const j = await getJSON(this.base + '/futures/usdt/tickers', 9000);
      return j.map(x => ({ id: x.contract, base: x.contract.replace(/_USDT$/, ''), last: +x.last, chg: +x.change_percentage,
        turnover: +x.volume_24h_quote, funding: x.funding_rate === undefined ? null : +x.funding_rate, oiUsd: null }));
    },
    async klines(id, tf, limit = 300) {
      const j = await getJSON(`${this.base}/futures/usdt/candlestick?contract=${id}&interval=${tf}&limit=${limit}`);
      return j.map(r => ({ t: r.t * 1000, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.sum }));
    },
    async oiHist(id) {
      const j = await getJSON(`${this.base}/futures/usdt/contract_stats?contract=${id}&interval=1h&limit=48`);
      return j.map(r => ({ t: r.time * 1000, oi: +r.open_interest, usd: +r.open_interest_usd }));
    },
  },
};
const ORDER = FORCE && P[FORCE] ? [FORCE, ...['bybit', 'okx', 'gate'].filter(x => x !== FORCE)] : ['bybit', 'okx', 'gate'];
let PROV = null; // active provider key

/* ---------- indicators ---------- */
function ema(a, n) { const k = 2 / (n + 1), o = []; let e = null; for (let i = 0; i < a.length; i++) { e = e === null ? a[i] : a[i] * k + e * (1 - k); o.push(i < n - 1 ? null : e); } return o; }
function rsi(c, n = 14) { const o = Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + g / (l || 1e-12)); } } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-12)); } } return o; }
function atr(b, n = 14) { const o = Array(b.length).fill(null); let a = null; for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); a = a === null ? tr : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }
function vwapRolling(b, n) { const o = Array(b.length).fill(null); let pv = 0, vv = 0; for (let i = 0; i < b.length; i++) { const tp = (b[i].h + b[i].l + b[i].c) / 3; pv += tp * b[i].v; vv += b[i].v; if (i >= n) { const x = b[i - n], tq = (x.h + x.l + x.c) / 3; pv -= tq * x.v; vv -= x.v; } if (i >= n - 1 && vv > 0) o[i] = pv / vv; } return o; }
function volProfile(b, bins = 48) {
  let lo = Infinity, hi = -Infinity; b.forEach(x => { lo = Math.min(lo, x.l); hi = Math.max(hi, x.h); });
  const st = (hi - lo) / bins || 1e-12, vol = Array(bins).fill(0);
  b.forEach(x => { const a = Math.max(0, Math.floor((x.l - lo) / st)), z = Math.min(bins - 1, Math.floor((x.h - lo) / st)); const per = x.v / (z - a + 1); for (let k = a; k <= z; k++) vol[k] += per; });
  let poc = 0; vol.forEach((v, i) => { if (v > vol[poc]) poc = i; });
  const tot = vol.reduce((s, v) => s + v, 0); let acc = vol[poc], L = poc, H = poc;
  while (acc < tot * 0.7 && (L > 0 || H < bins - 1)) { const dn = L > 0 ? vol[L - 1] : -1, up = H < bins - 1 ? vol[H + 1] : -1; if (up >= dn) { H++; acc += vol[H]; } else { L--; acc += vol[L]; } }
  return { poc: lo + (poc + 0.5) * st, vah: lo + (H + 1) * st, val: lo + L * st };
}
function levels(b, A, k = 3) { // swing clusters
  const pts = []; for (let i = k; i < b.length - k; i++) { let hi = true, lo = true; for (let j = 1; j <= k; j++) { if (b[i].h < b[i - j].h || b[i].h < b[i + j].h) hi = false; if (b[i].l > b[i - j].l || b[i].l > b[i + j].l) lo = false; } if (hi) pts.push(b[i].h); if (lo) pts.push(b[i].l); }
  pts.sort((a, c) => a - c); const cl = [];
  pts.forEach(p => { const last = cl[cl.length - 1]; if (last && p - last.max <= A * 0.35) { last.max = p; last.sum += p; last.n++; } else cl.push({ min: p, max: p, sum: p, n: 1 }); });
  return cl.map(c => ({ p: c.sum / c.n, n: c.n }));
}
function trendOf(c, e20, e50, i) { const a = e20[i], b = e50[i]; if (a == null || b == null) return 0; if (a > b && c[i] > b) return 1; if (a < b && c[i] < b) return -1; return 0; }

/* ---------- signal engine ---------- */
const VWAPN = { '15m': 96, '1h': 24, '4h': 42 };
const HTF = { '15m': '1h', '1h': '4h', '4h': '4h' };
function analyze(bars, tf) {
  if (!bars || bars.length < 80) return null;
  const closed = bars.slice(0, -1); // last bar is still forming
  const c = closed.map(x => x.c), e20 = ema(c, 20), e50 = ema(c, 50), r = rsi(c), A = atr(closed), vw = vwapRolling(closed, VWAPN[tf]);
  const vp = volProfile(closed.slice(-200)); const lv = levels(closed.slice(-200), A[A.length - 1] || 0);
  const n = closed.length - 1;
  return { bars, closed, c, e20, e50, r, A, vw, vp, lv, n, trend: trendOf(c, e20, e50, n), rsiNow: r[n], last: bars[bars.length - 1].c };
}
function detect(an, tf, coin, htfTrend) {
  const { closed: b, c, e20, e50, r, A, vw, vp, lv, n } = an; const out = [];
  for (let i = n; i >= n - 2; i--) {
    const x = b[i], a = A[i]; if (!a) continue;
    const vavg = b.slice(i - 20, i).reduce((s, y) => s + y.v, 0) / 20, vr = x.v / (vavg || 1);
    const hh = Math.max(...b.slice(i - 30, i).map(y => y.h)), ll = Math.min(...b.slice(i - 30, i).map(y => y.l));
    const range = x.h - x.l || 1e-12, pos = (x.c - x.l) / range, lw = (Math.min(x.o, x.c) - x.l) / range, uw = (x.h - Math.max(x.o, x.c)) / range, recent = i >= n - 1;
    const strong = l => l.n >= 3 || [vp.poc, vp.val, vp.vah].some(v => Math.abs(v - l.p) < 0.5 * a);
    const cands = [];
    // breakout
    if (x.c > hh && b[i - 1].c <= hh && vr >= 1.3 && pos > 0.55) cands.push({ type: 'breakout', dir: 'long', lvl: hh, sl: Math.min(hh - 0.6 * a, x.l), why: `Закрытие выше максимума 30 свечей ${fmtP(hh)} на объёме ×${vr.toFixed(1)}` });
    if (x.c < ll && b[i - 1].c >= ll && vr >= 1.3 && pos < 0.45) cands.push({ type: 'breakout', dir: 'short', lvl: ll, sl: Math.max(ll + 0.6 * a, x.h), why: `Закрытие ниже минимума 30 свечей ${fmtP(ll)} на объёме ×${vr.toFixed(1)}` });
    // bounce
    const sup = !recent ? null : lv.filter(l => strong(l) && l.p < x.c && x.l <= l.p + 0.25 * a && x.c - l.p < 1.2 * a).sort((p, q) => q.p - p.p)[0];
    if (sup && pos > 0.6 && lw >= 0.35 && r[i] < 55) cands.push({ type: 'bounce', dir: 'long', lvl: sup.p, sl: Math.min(sup.p - 0.6 * a, x.l - 0.2 * a), why: `Отбой от поддержки ${fmtP(sup.p)} (${sup.n} касания), закрытие в верхней части свечи` });
    const res = !recent ? null : lv.filter(l => strong(l) && l.p > x.c && x.h >= l.p - 0.25 * a && l.p - x.c < 1.2 * a).sort((p, q) => p.p - q.p)[0];
    if (res && pos < 0.4 && uw >= 0.35 && r[i] > 45) cands.push({ type: 'bounce', dir: 'short', lvl: res.p, sl: Math.max(res.p + 0.6 * a, x.h + 0.2 * a), why: `Отбой от сопротивления ${fmtP(res.p)} (${res.n} касания), закрытие в нижней части свечи` });
    // pullback
    const away = dirn => b.slice(i - 6, i - 1).some((y, j) => dirn > 0 ? y.l > e20[i - 6 + j] + 0.3 * a : y.h < e20[i - 6 + j] - 0.3 * a);
    if (recent && e20[i] && e50[i] && e50[i - 10]) {
      if (e20[i] > e50[i] && e50[i] > e50[i - 10] && away(1) && x.l <= e20[i] + 0.2 * a && x.c > e20[i] && x.c > e50[i] && r[i] > 40 && r[i] < 66)
        cands.push({ type: 'pullback', dir: 'long', lvl: e20[i], sl: Math.min(Math.min(...b.slice(i - 2, i + 1).map(y => y.l)), e50[i]) - 0.3 * a, why: `Восходящий тренд (EMA20 > EMA50), откат к EMA20 ${fmtP(e20[i])} и закрытие выше` });
      if (e20[i] < e50[i] && e50[i] < e50[i - 10] && away(-1) && x.h >= e20[i] - 0.2 * a && x.c < e20[i] && x.c < e50[i] && r[i] < 60 && r[i] > 34)
        cands.push({ type: 'pullback', dir: 'short', lvl: e20[i], sl: Math.max(Math.max(...b.slice(i - 2, i + 1).map(y => y.h)), e50[i]) + 0.3 * a, why: `Нисходящий тренд (EMA20 < EMA50), откат к EMA20 ${fmtP(e20[i])} и закрытие ниже` });
    }
    for (const s of cands) {
      const L = s.dir === 'long', entry = x.c; let risk = L ? entry - s.sl : s.sl - entry;
      if (risk < 0.5 * a) { risk = 0.5 * a; s.sl = L ? entry - risk : entry + risk; }
      if (risk > 3 * a) continue;
      const tp1 = L ? entry + 1.5 * risk : entry - 1.5 * risk;
      // TP2: next opposite level beyond TP1, else 3R
      const nxt = lv.filter(l => L ? l.p > tp1 : l.p < tp1).sort((p, q) => L ? p.p - q.p : q.p - p.p)[0];
      let tp2 = nxt && Math.abs(nxt.p - entry) / risk <= 5 ? nxt.p : (L ? entry + 3 * risk : entry - 3 * risk);
      if (Math.abs(tp2 - entry) / risk < 2) tp2 = L ? entry + 2 * risk : entry - 2 * risk;
      // still valid? (no SL or TP1 touched after signal bar, incl. forming bar)
      const after = an.bars.slice(i + 1); let dead = false;
      for (const y of after) { if (L ? (y.l <= s.sl || y.h >= tp1) : (y.h >= s.sl || y.l <= tp1)) { dead = true; break; } }
      if (dead) continue;
      // strength
      let sc = 0.5, tags = [];
      const dirN = L ? 1 : -1;
      if (htfTrend === dirN) { sc += 1; tags.push('тренд ст. ТФ ✓'); } else if (htfTrend === -dirN) { sc -= 0.5; tags.push('против ст. ТФ'); }
      if (vr >= 1.5) { sc += 1; tags.push('объём ×' + vr.toFixed(1)); }
      if (vw[i] && (L ? x.c > vw[i] : x.c < vw[i])) { sc += 0.5; tags.push(L ? 'выше VWAP' : 'ниже VWAP'); }
      const vpz = L ? Math.abs(s.lvl - vp.val) < a || Math.abs(s.lvl - vp.poc) < a : Math.abs(s.lvl - vp.vah) < a || Math.abs(s.lvl - vp.poc) < a;
      if (s.type !== 'breakout' && vpz) { sc += 1; tags.push('у POC/VA'); }
      if (s.type === 'breakout' && (L ? x.c > vp.vah : x.c < vp.val)) { sc += 0.5; tags.push(L ? 'выше VAH' : 'ниже VAL'); }
      if (L ? r[i] >= 45 && r[i] <= 68 : r[i] <= 55 && r[i] >= 32) sc += 0.5;
      if ((L && r[i] > 75) || (!L && r[i] < 25)) { sc -= 1; tags.push('RSI перегрет'); }
      if (coin.funding != null) { if (L && coin.funding < 0 || !L && coin.funding > 0.0003) { sc += 0.5; tags.push('funding в пользу'); } else if (L && coin.funding > 0.0005 || !L && coin.funding < -0.0003) sc -= 0.5; }
      const rr = Math.abs(tp2 - entry) / risk; if (rr >= 2.5) sc += 0.5;
      if (Math.round(sc) < 2) continue;
      out.push({ key: coin.base + tf + s.type + s.dir, coin, tf, type: s.type, dir: s.dir, entry, sl: s.sl, tp1, tp2, lvl: s.lvl, rr, rr1: 1.5,
        strength: Math.max(1, Math.min(5, Math.round(sc))), t: x.t + tfMs(tf), barIdx: i, fresh: i === n, rsi: r[i], vr, atr: a, vwap: vw[i], vp, ema20: e20[i], ema50: e50[i], why: s.why, tags });
    }
    if (out.length) break; // most recent bar with a signal
  }
  return out;
}
const tfMs = tf => ({ '15m': 9e5, '1h': 36e5, '4h': 144e5 }[tf]);
const TYPE_RU = { breakout: 'Пробой', bounce: 'Отскок', pullback: 'Откат' };
const TF_RU = { '15m': '15м', '1h': '1ч', '4h': '4ч' };

/* ---------- state ---------- */
const CONC = () => PROV === 'okx' ? 4 : CFG.CONC;
const S = { coins: [], signals: [], an: {}, f: { setups: new Set(), dir: null, tf: 'all', str: 1, q: '', tradfi: false }, sort: 'new', loading: false, fng: null, btcOi: null };
try { const saved = JSON.parse(localStorage.getItem('sb_f') || '{}'); if (saved.setups) S.f.setups = new Set(saved.setups); Object.assign(S.f, { tradfi: !!saved.tradfi, dir: saved.dir ?? null, tf: saved.tf || 'all', str: saved.str || 1 }); S.sort = saved.sort || 'new'; } catch (e) { }
const saveF = () => localStorage.setItem('sb_f', JSON.stringify({ setups: [...S.f.setups], tradfi: S.f.tradfi, dir: S.f.dir, tf: S.f.tf, str: S.f.str, sort: S.sort }));

/* ---------- loading ---------- */
async function loadTickers() {
  let lastErr;
  for (const k of ORDER) {
    try { const t = await P[k].tickers(); if (!t.length) throw new Error('empty'); PROV = k; return t; } catch (e) { lastErr = e; console.warn('tickers fail', k, e.message); }
  }
  throw lastErr;
}
async function klines(coin, tf) {
  // Gate candles have no CORS headers in browsers → use Bybit/OKX candles first when Gate is the ticker source
  const idFor = k => k === PROV ? coin.id : k === 'bybit' ? coin.base + 'USDT' : k === 'okx' ? coin.base + '-USDT-SWAP' : coin.base + '_USDT';
  const order = PROV === 'gate' ? ['bybit', 'okx', 'gate'] : [PROV, ...ORDER.filter(k => k !== PROV)];
  let err; for (const k of order) { try { return await retry(() => P[k].klines(idFor(k), tf)); } catch (e) { err = e; } }
  throw err;
}
async function retry(fn) { for (let a = 0; ; a++) { try { return await fn(); } catch (e) { if (a < 2 && /429/.test(e.message)) { await new Promise(r => setTimeout(r, 900 * (a + 1))); continue; } throw e; } } }
async function _unused(coin, tf) {
  try { return await P[PROV].klines(coin.id, tf); }
  catch (e) {
    for (const k of ORDER) { if (k === PROV) continue; const id = k === 'bybit' ? coin.base + 'USDT' : k === 'okx' ? coin.base + '-USDT-SWAP' : coin.base + '_USDT'; try { return await P[k].klines(id, tf); } catch (e2) { } }
    throw e;
  }
}
// crypto-only universe: Bybit marks stocks/ETF/commodity/forex via symbolType; OKX via instCategory (1 = crypto)
async function cryptoSet() {
  try { const c = JSON.parse(localStorage.getItem('sb_cs') || 'null'); if (c && Date.now() - c.t < 864e5 && c.b.length > 100) return new Set(c.b); } catch (e) { }
  let b = null;
  try { const j = await getJSON('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000', 9000); b = j.result.list.filter(x => ['', 'innovation', 'adventure'].includes(x.symbolType || '')).map(x => x.baseCoin); } catch (e) { }
  if (!b) try { const j = await getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP', 9000); b = j.data.filter(x => x.instCategory === '1').map(x => x.instId.split('-')[0]); } catch (e) { }
  if (!b) return null; localStorage.setItem('sb_cs', JSON.stringify({ t: Date.now(), b })); return new Set(b);
}
async function refreshMarket() {
  try {
    const [all, cs] = await Promise.all([loadTickers(), S.f.tradfi ? null : cryptoSet()]);
    const top = all.filter(x => !STABLE.test(x.base) && x.turnover > 0 && x.last > 0 && (!cs || cs.has(x.base))).sort((a, b) => b.turnover - a.turnover).slice(0, CFG.TOP);
    const prev = Object.fromEntries(S.coins.map(c => [c.base, c]));
    S.coins = top.map(c => Object.assign(prev[c.base] || {}, c));
    $('#src').textContent = 'Источник: ' + P[PROV].name + (PROV !== 'bybit' ? ' (резерв)' : '');
    renderHeader(); renderMarkets();
  } catch (e) { $('#upd').textContent = 'Нет связи с биржами — повторю через минуту'; }
  loadFng(); loadBtcExtras();
}
async function loadFng() { try { const j = await getJSON('https://api.alternative.me/fng/?limit=1', 7000); S.fng = { v: +j.data[0].value, cls: j.data[0].value_classification }; renderHeader(); } catch (e) { } }
async function loadBtcExtras() {
  const btc = S.coins.find(c => c.base === 'BTC'); if (!btc) return;
  try { if (PROV === 'okx') { const f = await P.okx.funding(btc.id); btc.funding = f.rate; btc.nextFunding = f.next; const e = S.coins.find(c => c.base === 'ETH'); if (e) { const g = await P.okx.funding(e.id); e.funding = g.rate; } } } catch (e) { }
  try { if (PROV === 'okx') { btc.oiUsd = await P.okx.oiNow(btc.id); S.btcOi = { now: btc.oiUsd, ser: null, chg: null }; renderHeader(); return; } } catch (e) { }
  try {
    const h = await P[PROV].oiHist(btc.id); if (h && h.length > 1) {
      const lastP = btc.last; const ser = h.map(x => x.usd || x.oi * lastP);
      S.btcOi = { now: btc.oiUsd || ser[ser.length - 1], ser, chg: (h[h.length - 1].oi / h[Math.max(0, h.length - 25)].oi - 1) * 100 };
    }
  } catch (e) { if (btc.oiUsd) S.btcOi = { now: btc.oiUsd, ser: null, chg: null }; }
  renderHeader();
}
async function refreshSignals() {
  if (S.loading) return; S.loading = true; $('#refresh').classList.add('spin');
  if (!S.coins.length) await refreshMarket();
  if (!S.coins.length) { S.loading = false; $('#refresh').classList.remove('spin'); return; }
  const jobs = []; S.coins.forEach(c => CFG.TFS.slice().reverse().forEach(tf => jobs.push([c, tf]))); // 4h first (HTF)
  let done = 0; const found = []; const prog = $('#prog');
  const htfWait = {}; // ensure HTF analyzed before LTF when possible
  await pool(jobs, CONC(), async ([c, tf]) => {
    try {
      const bars = await klines(c, tf); const an = analyze(bars, tf); if (!an) return;
      S.an[c.base + tf] = an;
      if (tf === '1h') c.tr1h = an.trend, c.rsi1h = an.rsiNow; if (tf === '4h') c.tr4h = an.trend;
      const h = S.an[c.base + HTF[tf]]; const htfTrend = tf === '4h' ? (an.e50[an.n] > an.e50[an.n - 10] ? 1 : -1) * (an.trend !== 0 ? 1 : 0) : h ? h.trend : 0;
      const d = detect(an, tf, c, htfTrend).sort((p, q) => q.strength - p.strength || q.rr - p.rr); if (d.length) found.push(d[0]);
    } finally { done++; prog.style.width = (done / jobs.length * 100) + '%'; if (done % 8 === 0) { S.signals = found.slice(); renderSignals(); renderMarkets(); } }
  });
  S.signals = found; S.lastScan = new Date();
  renderSignals(); renderMarkets(); renderHeader();
  $('#upd').textContent = 'Обновлено ' + timeStr(S.lastScan) + ' · авто каждые 3 мин';
  setTimeout(() => prog.style.width = '0', 600);
  S.loading = false; $('#refresh').classList.remove('spin');
}

/* ---------- render: header ---------- */
function renderHeader() {
  const btc = S.coins.find(c => c.base === 'BTC'), eth = S.coins.find(c => c.base === 'ETH');
  const set = (id, html, c) => { const el = $(id); if (!el) return; el.innerHTML = html; if (c !== undefined) el.className = el.className.replace(/\b(up|down|mut)\b/g, '').trim() + ' ' + c; };
  if (btc) { set('#tbBtcP', fmtP(btc.last)); set('#tbBtcC', (btc.chg >= 0 ? '↑ ' : '↓ ') + pct(btc.chg), cls(btc.chg)); set('#mBtcP', fmtP(btc.last)); set('#mBtcC', pct(btc.chg) + (btc.chg >= 0 ? ' ↑' : ' ↓'), cls(btc.chg));
    if (btc.funding != null) { const f = btc.funding * 100; set('#tbFund', (f > 0 ? '+' : '') + f.toFixed(4) + '%', cls(f)); set('#mFund', (f > 0 ? '+' : '') + f.toFixed(4) + '%', cls(f));
      set('#tbFundN', btc.nextFunding ? 'след. через ' + untilStr(btc.nextFunding) : (f > 0.01 ? 'лонги платят шортам' : f < 0 ? 'шорты платят лонгам' : 'нейтрально')); }
    else { set('#tbFund', '—', 'mut'); set('#mFund', '—', 'mut'); set('#tbFundN', 'нет данных у ' + (PROV ? P[PROV].name : '')); }
    const t = btc.tr4h; if (t !== undefined) set('#mTrend', t > 0 ? '▲ Вверх' : t < 0 ? '▼ Вниз' : '◆ Флэт', t > 0 ? 'up' : t < 0 ? 'down' : 'mut');
  }
  if (eth) { set('#tbEthP', fmtP(eth.last)); set('#tbEthC', (eth.chg >= 0 ? '↑ ' : '↓ ') + pct(eth.chg), cls(eth.chg)); }
  if (S.fng) { const v = S.fng.v, ru = fngRu(v), c = v < 45 ? 'down' : v > 55 ? 'up' : 'mut'; set('#tbFngT', ru, c); set('#mFng', `${v} <span class="fng-cls" style="font-size:13px;font-weight:500">${ru}</span>`, c); drawGauge(v); }
  if (S.btcOi) { set('#tbOi', fmtBig(S.btcOi.now) + ' USDT'); set('#tbOiC', S.btcOi.chg != null ? pct(S.btcOi.chg) + ' за 24ч' : '', cls(S.btcOi.chg)); if (S.btcOi.ser) drawSpark($('#oiSpark'), S.btcOi.ser); }
  else if (btc && btc.oiUsd) set('#tbOi', fmtBig(btc.oiUsd) + ' USDT');
  else set('#tbOi', '—');
}
const fngRu = v => v < 25 ? 'Сильный страх' : v < 45 ? 'Страх' : v <= 55 ? 'Нейтрально' : v < 75 ? 'Жадность' : 'Сильная жадность';
function untilStr(ts) { const m = Math.max(0, Math.round((ts - Date.now()) / 60000)); return Math.floor(m / 60) + 'ч ' + (m % 60) + 'м'; }
function hidpi(cv) { const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1; const w = Math.max(10, r.width), h = Math.max(10, r.height); cv.width = w * d; cv.height = h * d; const x = cv.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0); return [x, w, h]; }
function drawGauge(v) {
  const cv = $('#gauge'); if (!cv || !cv.offsetParent) return; const [x, w, h] = hidpi(cv); x.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h - 4, R = Math.min(w / 2 - 6, h - 10);
  const g = x.createLinearGradient(cx - R, 0, cx + R, 0); g.addColorStop(0, '#ff5e7a'); g.addColorStop(.5, '#ffc65c'); g.addColorStop(1, '#3ddc97');
  x.lineWidth = 7; x.lineCap = 'round'; x.strokeStyle = 'rgba(255,255,255,.08)'; x.beginPath(); x.arc(cx, cy, R, Math.PI, 0); x.stroke();
  x.strokeStyle = g; x.beginPath(); x.arc(cx, cy, R, Math.PI, Math.PI + Math.PI * v / 100); x.stroke();
  x.fillStyle = '#eef1ff'; x.font = '700 18px -apple-system,Inter,sans-serif'; x.textAlign = 'center'; x.fillText(v, cx, cy - 3);
}
function drawSpark(cv, ser) {
  if (!cv || !cv.offsetParent) return; const [x, w, h] = hidpi(cv); x.clearRect(0, 0, w, h);
  const mn = Math.min(...ser), mx = Math.max(...ser), up = ser[ser.length - 1] >= ser[0];
  x.strokeStyle = up ? '#3ddc97' : '#ff5e7a'; x.lineWidth = 1.6; x.beginPath();
  ser.forEach((v, i) => { const px = i / (ser.length - 1) * (w - 2) + 1, py = h - 3 - (v - mn) / (mx - mn || 1) * (h - 6); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
}

/* ---------- render: signals ---------- */
function filtered() {
  const f = S.f, q = f.q.trim().toUpperCase();
  let a = S.signals.filter(s => (!f.setups.size || f.setups.has(s.type)) && (!f.dir || s.dir === f.dir) && (f.tf === 'all' || s.tf === f.tf) && s.strength >= f.str && (!q || s.coin.base.includes(q)));
  const so = S.sort; a.sort((p, q2) => so === 'str' ? q2.strength - p.strength || q2.t - p.t : so === 'rr' ? q2.rr - p.rr : q2.t - p.t || q2.strength - p.strength);
  return a;
}
function renderSignals() {
  const a = filtered(), g = $('#grid');
  $('#cnt').textContent = S.signals.length ? `Сигналов: ${a.length}${a.length !== S.signals.length ? ' из ' + S.signals.length : ''}` : '';
  if (!a.length) { g.innerHTML = `<div class="empty glass" style="grid-column:1/-1">${S.loading ? 'Сканирую рынок…' : S.signals.length ? 'Под фильтры ничего не подходит. Попробуй сбросить фильтры.' : 'Сейчас нет свежих сетапов на закрытых свечах. Обновится автоматически.'}</div>`; return; }
  g.innerHTML = a.map((s, i) => {
    const L = s.dir === 'long', c = L ? 'up' : 'down';
    return `<div class="card glass ${s.dir}" data-i="${i}">
      <div class="top"><div><div class="sym">${esc(s.coin.base)}/USDT</div><div class="stype"><span class="dot" style="margin:0;background:var(--${L ? 'green' : 'red'})"></span>${TYPE_RU[s.type].toUpperCase()} · <span class="tf">${TF_RU[s.tf]}</span></div></div>
      <span class="badge ${s.dir}">${L ? 'ЛОНГ' : 'ШОРТ'}</span></div>
      <div class="cardbody"><div class="lv">
        <span>Вход</span><span>${fmtP(s.entry)}</span>
        <span>Стоп</span><span class="down">${fmtP(s.sl)}</span>
        <span>Тейк 1</span><span>${fmtP(s.tp1)}</span>
        <span>Тейк 2</span><span class="up">${fmtP(s.tp2)}</span>
        <span>R:R</span><span class="up">1:${s.rr.toFixed(1)}</span>
      </div><canvas class="mini" data-k="${s.coin.base + s.tf}" data-i="${i}"></canvas></div>
      <div class="reason">${esc(s.why)}</div>
      <div class="meta"><span>🕒 ${ago(s.t)}${s.fresh ? '' : ' · ждать ретест'}</span><span class="stars" title="Сила сигнала">${'★'.repeat(s.strength)}<span style="opacity:.25">${'★'.repeat(5 - s.strength)}</span></span></div>
      <div class="meta"><span>Сейчас ${fmtP(s.coin.last)} <span class="${cls((s.coin.last / s.entry - 1) * (L ? 1 : -1))}">(${pct((s.coin.last / s.entry - 1) * 100)})</span></span><span>RSI ${s.rsi.toFixed(0)}</span></div>
    </div>`; }).join('');
  S.view = a;
  requestAnimationFrame(() => $$('#grid canvas.mini').forEach(cv => drawMini(cv, a[+cv.dataset.i])));
}
function drawMini(cv, s) {
  const an = S.an[s.coin.base + s.tf]; if (!an) return; const [x, w, h] = hidpi(cv); x.clearRect(0, 0, w, h);
  const bars = an.bars.slice(-40), lines = [[s.tp2, '#3ddc97', 'Т2'], [s.tp1, '#3ddc97', 'Т1'], [s.entry, '#e8eaff', 'Вход'], [s.sl, '#ff5e7a', 'Стоп']];
  let mn = Math.min(...bars.map(b => b.l), ...lines.map(l => l[0])), mx = Math.max(...bars.map(b => b.h), ...lines.map(l => l[0])); const pad = (mx - mn) * 0.06; mn -= pad; mx += pad;
  const lblW = w < 230 ? 0 : 0, cw = w - lblW, Y = p => 4 + (mx - p) / (mx - mn) * (h - 8);
  const bw = cw / bars.length;
  // EMA20
  const e = an.e20.slice(-41, -1); x.strokeStyle = 'rgba(139,124,255,.6)'; x.lineWidth = 1.2; x.beginPath(); let st = false;
  e.forEach((v, i) => { if (v == null) return; const px = i * bw + bw / 2; st ? x.lineTo(px, Y(v)) : (x.moveTo(px, Y(v)), st = true); }); x.stroke();
  bars.forEach((b, i) => { const up = b.c >= b.o, px = i * bw + bw / 2; x.strokeStyle = x.fillStyle = up ? '#3ddc97' : '#ff5e7a'; x.globalAlpha = i === bars.length - 1 ? .55 : .95;
    x.beginPath(); x.moveTo(px, Y(b.h)); x.lineTo(px, Y(b.l)); x.lineWidth = 1; x.stroke(); const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c)); x.fillRect(px - bw * .32, y1, bw * .64, Math.max(1, y2 - y1)); });
  x.globalAlpha = 1; x.setLineDash([4, 4]); x.font = '600 10px -apple-system,Inter,sans-serif'; x.textAlign = 'left';
  lines.forEach(([p, c, t]) => { const y = Y(p); x.strokeStyle = c; x.globalAlpha = .8; x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); x.globalAlpha = 1;
    const label = t + ' ' + fmtP(p), tw = x.measureText(label).width; x.fillStyle = 'rgba(8,9,20,.75)'; x.fillRect(2, y - 13, tw + 6, 12); x.fillStyle = c; x.fillText(label, 5, y - 3); });
  x.setLineDash([]);
  // signal bar marker
  const si = s.barIdx - (an.closed.length - 40) + 1; if (si >= 0 && si < bars.length) { x.fillStyle = s.dir === 'long' ? '#3ddc97' : '#ff5e7a'; const px = si * bw + bw / 2, b = bars[si]; x.beginPath(); if (s.dir === 'long') { const y = Y(b.l) + 8; x.moveTo(px, y - 5); x.lineTo(px - 4, y + 2); x.lineTo(px + 4, y + 2); } else { const y = Y(b.h) - 8; x.moveTo(px, y + 5); x.lineTo(px - 4, y - 2); x.lineTo(px + 4, y - 2); } x.fill(); }
}

/* ---------- render: markets ---------- */
function renderMarkets() {
  const tr = t => t === undefined ? '<span class="dim">…</span>' : t > 0 ? '<span class="tr-up">▲</span>' : t < 0 ? '<span class="tr-dn">▼</span>' : '<span class="tr-fl">◆</span>';
  $('#mk').innerHTML = S.coins.map(c => `<tr data-b="${esc(c.base)}"><td><b>${esc(c.base)}</b></td><td>${fmtP(c.last)}</td><td class="${cls(c.chg)}">${pct(c.chg)}</td><td class="hide-m mut">${fmtBig(c.turnover)}</td><td class="${c.funding == null ? 'dim' : cls(c.funding)}">${c.funding == null ? '—' : (c.funding * 100).toFixed(4) + '%'}</td><td>${tr(c.tr1h)} ${tr(c.tr4h)}</td><td class="hide-m ${c.rsi1h > 70 ? 'down' : c.rsi1h < 30 ? 'up' : ''}">${c.rsi1h ? c.rsi1h.toFixed(0) : '—'}</td></tr>`).join('');
}

/* ---------- modal + chart ---------- */
let chart = null, curSig = null;
async function openCoin(coin, tf, sig) {
  curSig = sig || null; $('#modal').classList.add('open'); document.body.style.overflow = 'hidden';
  $('#mTitle').textContent = coin.base + '/USDT · ' + TF_RU[tf]; $('#mSub').innerHTML = sig ? `<span class="${sig.dir === 'long' ? 'up' : 'down'}">${sig.dir === 'long' ? 'ЛОНГ' : 'ШОРТ'}</span> · ${TYPE_RU[sig.type]} · ${'★'.repeat(sig.strength)}` : 'Цена ' + fmtP(coin.last) + ' · ' + pct(coin.chg);
  $$('#mTf button').forEach(b => { b.classList.toggle('on', b.dataset.v === tf); b.onclick = () => openCoin(coin, b.dataset.v, sig && sig.tf === b.dataset.v ? sig : null); });
  $('#mBybit').href = `https://www.bybit.com/trade/usdt/${coin.base}USDT`; $('#mTv').href = `https://www.tradingview.com/chart/?symbol=BYBIT:${coin.base}USDT.P`;
  $('#mCalc').style.display = sig ? '' : 'none';
  let an = S.an[coin.base + tf]; if (!an) { try { an = analyze(await klines(coin, tf), tf); if (an) S.an[coin.base + tf] = an; } catch (e) { } }
  const kv = []; if (sig) kv.push(['Вход', fmtP(sig.entry)], ['Стоп', `<span class="down">${fmtP(sig.sl)}</span>`], ['Тейк 1 (1.5R)', fmtP(sig.tp1)], ['Тейк 2', `<span class="up">${fmtP(sig.tp2)}</span>`], ['R:R', '1:' + sig.rr.toFixed(2)], ['Стоп в ATR', (Math.abs(sig.entry - sig.sl) / sig.atr).toFixed(2)]);
  if (an) { const n = an.n; kv.push(['RSI(14)', an.r[n].toFixed(1)], ['ATR(14)', fmtP(an.A[n]) + ` (${(an.A[n] / an.c[n] * 100).toFixed(2)}%)`], ['EMA20 / EMA50', fmtP(an.e20[n]) + ' / ' + fmtP(an.e50[n])], ['VWAP', fmtP(an.vw[n])], ['POC', fmtP(an.vp.poc)], ['VAH / VAL', fmtP(an.vp.vah) + ' / ' + fmtP(an.vp.val)], ['Тренд', an.trend > 0 ? '<span class="up">▲ вверх</span>' : an.trend < 0 ? '<span class="down">▼ вниз</span>' : 'флэт']); }
  kv.push(['Funding', coin.funding == null ? '—' : (coin.funding * 100).toFixed(4) + '%'], ['OI', coin.oiUsd ? fmtBig(coin.oiUsd) + ' $' : '—'], ['Оборот 24ч', fmtBig(coin.turnover) + ' $']);
  $('#mKv').innerHTML = kv.map(([k, v]) => `<div><small>${k}</small>${v}</div>`).join('');
  $('#mReason').innerHTML = sig ? `<b>Почему:</b> ${esc(sig.why)}${sig.tags.length ? '. Плюс: ' + esc(sig.tags.join(', ')) : ''}.${sig.fresh ? '' : ' Сигнал на одну-две свечи раньше — цена могла уйти от входа.'}` : '';
  drawBig(an, sig);
}
function drawBig(an, sig) {
  const el = $('#chart'); el.innerHTML = '';
  if (chart) { chart.remove(); chart = null; }
  if (!an) { el.innerHTML = '<div class="empty">Не удалось загрузить свечи</div>'; return; }
  if (!window.LightweightCharts) { el.innerHTML = '<canvas style="width:100%;height:100%"></canvas>'; if (sig) drawMini(el.firstChild, sig); return; }
  const off = -new Date().getTimezoneOffset() * 60, T = t => Math.floor(t / 1000) + off;
  chart = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: 'rgba(0,0,0,0)' }, textColor: '#9aa3c7', fontFamily: '-apple-system,Inter,sans-serif' },
    grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } }, rightPriceScale: { borderColor: 'rgba(255,255,255,.1)' },
    timeScale: { borderColor: 'rgba(255,255,255,.1)', timeVisible: true }, crosshair: { mode: 0 } });
  const cs = chart.addCandlestickSeries({ upColor: '#3ddc97', downColor: '#ff5e7a', borderVisible: false, wickUpColor: '#3ddc97', wickDownColor: '#ff5e7a', priceFormat: { type: 'price', precision: dec(an.last), minMove: Math.pow(10, -dec(an.last)) } });
  cs.setData(an.bars.map(b => ({ time: T(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
  const line = (arr, color, w = 1.5) => { const s = chart.addLineSeries({ color, lineWidth: w, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); s.setData(arr.map((v, i) => v == null ? null : { time: T(an.closed[i].t), value: v }).filter(Boolean)); };
  line(an.e20, 'rgba(139,124,255,.9)'); line(an.e50, 'rgba(255,198,92,.85)'); line(an.vw, 'rgba(90,200,250,.7)', 1);
  const pl = (p, color, title, style = 2) => cs.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
  pl(an.vp.poc, 'rgba(255,255,255,.45)', 'POC', 1); pl(an.vp.vah, 'rgba(255,255,255,.25)', 'VAH', 3); pl(an.vp.val, 'rgba(255,255,255,.25)', 'VAL', 3);
  if (sig) { pl(sig.entry, '#e8eaff', 'Вход'); pl(sig.sl, '#ff5e7a', 'Стоп'); pl(sig.tp1, '#3ddc97', 'Тейк 1'); pl(sig.tp2, '#3ddc97', 'Тейк 2');
    cs.setMarkers([{ time: T(an.closed[sig.barIdx].t), position: sig.dir === 'long' ? 'belowBar' : 'aboveBar', color: sig.dir === 'long' ? '#3ddc97' : '#ff5e7a', shape: sig.dir === 'long' ? 'arrowUp' : 'arrowDown', text: TYPE_RU[sig.type] }]); }
  chart.timeScale().setVisibleLogicalRange({ from: an.bars.length - 90, to: an.bars.length + 3 });
}
const dec = p => { const a = Math.abs(p); return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a >= 0.001 ? 6 : 8; };
function closeModal() { $('#modal').classList.remove('open'); document.body.style.overflow = ''; if (chart) { chart.remove(); chart = null; } }

/* ---------- calculator ---------- */
const C = { dir: 'long' };
function num(id) { const v = parseFloat(String($(id).value).replace(',', '.').replace(/\s/g, '')); return isFinite(v) ? v : NaN; }
function calc() {
  const dep = num('#cDep'), risk = num('#cRisk'), lev = num('#cLev'), e = num('#cEntry'), sl = num('#cSl'), tp = num('#cTp'), L = C.dir === 'long';
  localStorage.setItem('sb_c', JSON.stringify({ dep: $('#cDep').value, risk: $('#cRisk').value, lev: $('#cLev').value }));
  const out = $('#cRes'), w = $('#cWarn'); w.innerHTML = '';
  if (!(dep > 0 && risk > 0 && lev >= 1 && e > 0 && sl > 0)) { out.innerHTML = '<div class="mut">Введи вход и стоп — расчёт появится здесь.</div>'; return; }
  if (L ? sl >= e : sl <= e) { out.innerHTML = ''; w.innerHTML = `<div class="warn bad">Стоп должен быть ${L ? 'ниже' : 'выше'} цены входа для ${L ? 'лонга' : 'шорта'}.</div>`; return; }
  const riskUsd = dep * risk / 100, dist = Math.abs(e - sl), qty = riskUsd / dist, notional = qty * e, margin = notional / lev;
  const mm = 0.005, liq = L ? e * (1 - 1 / lev + mm) : e * (1 + 1 / lev - mm);
  const rr = tp > 0 ? Math.abs(tp - e) / dist : null, profit = tp > 0 ? qty * Math.abs(tp - e) : null;
  out.innerHTML = `<div><span class="mut">Риск</span><b class="down">${riskUsd.toFixed(2)} USDT</b></div>
    <div><span class="mut">Стоп</span><b>${(dist / e * 100).toFixed(2)}%</b></div>
    <div><span class="mut">Размер позиции</span><b>${notional.toFixed(2)} USDT</b></div>
    <div><span class="mut">Количество</span><b>${qty < 1 ? qty.toPrecision(4) : qty.toFixed(qty < 100 ? 3 : 1)}</b></div>
    <div><span class="mut">Маржа при ${lev}x</span><b>${margin.toFixed(2)} USDT</b></div>
    <div><span class="mut">Ликвидация ≈</span><b>${fmtP(liq)}</b></div>
    ${rr ? `<div><span class="mut">Прибыль на тейке</span><b class="up">+${profit.toFixed(2)} USDT</b></div><div><span class="mut">R:R</span><b class="up">1:${rr.toFixed(2)}</b></div>` : ''}`;
  const warns = [];
  if (L ? liq >= sl : liq <= sl) warns.push(['bad', `⚠️ Ликвидация (${fmtP(liq)}) наступит раньше стопа! Уменьши плечо до ${Math.max(1, Math.floor(1 / (dist / e + mm + 0.002)))}x или меньше.`]);
  else if (Math.abs(liq - sl) / e < 0.01) warns.push(['mid', 'Ликвидация очень близко к стопу — на проскальзывании может выбить.']);
  if (margin > dep) warns.push(['bad', `Нужно маржи ${margin.toFixed(2)} USDT — больше депозита. Подними плечо или уменьши риск.`]);
  else if (margin > dep * 0.5) warns.push(['mid', `Маржа занимает ${(margin / dep * 100).toFixed(0)}% депозита.`]);
  if (risk > 3) warns.push(['mid', `Риск ${risk}% на сделку — много. Обычно 0.5–2%.`]);
  if (!warns.length) warns.push(['ok', '✓ Стоп ближе ликвидации, маржа в пределах депозита.']);
  w.innerHTML = warns.map(([c, t]) => `<div class="warn ${c}">${t}</div>`).join('');
}
function toCalc(s) {
  C.dir = s.dir; $$('#cDir button').forEach(b => b.classList.toggle('on', b.dataset.v === s.dir));
  const d = dec(s.entry); $('#cEntry').value = s.entry.toFixed(d); $('#cSl').value = s.sl.toFixed(d); $('#cTp').value = s.tp2.toFixed(d); calc();
}

/* ---------- UI wiring ---------- */
function syncFilterUI() {
  $$('[data-setup]').forEach(b => b.classList.toggle('on', S.f.setups.has(b.dataset.setup)));
  $$('[data-dir]').forEach(b => b.classList.toggle('on', S.f.dir === b.dataset.dir));
  $$('[data-tfc]').forEach(b => b.classList.toggle('on', S.f.tf === b.dataset.tfc));
  $$('[data-str]').forEach(b => b.classList.toggle('on', S.f.str >= +b.dataset.str));
  $$('#tfSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.f.tf));
  $$('#strSeg button').forEach(b => b.classList.toggle('on', +b.dataset.v === S.f.str));
  $$('[data-tradfi]').forEach(b => b.classList.toggle('on', S.f.tradfi));
  $('#sort').value = S.sort; saveF(); renderSignals();
}
function wire() {
  $$('[data-setup]').forEach(b => b.onclick = () => { const k = b.dataset.setup; S.f.setups.has(k) ? S.f.setups.delete(k) : S.f.setups.add(k); syncFilterUI(); });
  $$('[data-dir]').forEach(b => b.onclick = () => { S.f.dir = S.f.dir === b.dataset.dir ? null : b.dataset.dir; syncFilterUI(); });
  $$('[data-tfc]').forEach(b => b.onclick = () => { S.f.tf = S.f.tf === b.dataset.tfc ? 'all' : b.dataset.tfc; syncFilterUI(); });
  $$('[data-str]').forEach(b => b.onclick = () => { S.f.str = S.f.str >= +b.dataset.str ? 1 : +b.dataset.str; syncFilterUI(); });
  $$('#tfSeg button').forEach(b => b.onclick = () => { S.f.tf = b.dataset.v; syncFilterUI(); });
  $$('#strSeg button').forEach(b => b.onclick = () => { S.f.str = +b.dataset.v; syncFilterUI(); });
  $$('[data-tradfi]').forEach(b => b.onclick = () => { S.f.tradfi = !S.f.tradfi; S.coins = []; S.signals = []; S.an = {}; syncFilterUI(); refreshMarket().then(refreshSignals); });
  $('#q').oninput = e => { S.f.q = e.target.value; renderSignals(); };
  const reset = () => { S.f = { setups: new Set(), dir: null, tf: 'all', str: 1, q: '', tradfi: S.f.tradfi }; $('#q').value = ''; syncFilterUI(); };
  $('#resetBtn').onclick = reset; $('#resetTop').onclick = reset;
  $('#sort').onchange = e => { S.sort = e.target.value; syncFilterUI(); };
  $('#refresh').onclick = () => { refreshMarket().then(refreshSignals); };
  $('#grid').onclick = e => { const c = e.target.closest('.card'); if (!c) return; const s = S.view[+c.dataset.i]; if (s) { openCoin(s.coin, s.tf, s); toCalc(s); } };
  $('#mk').onclick = e => { const r = e.target.closest('tr'); if (!r) return; const c = S.coins.find(x => x.base === r.dataset.b); if (c) openCoin(c, '1h', S.signals.find(s => s.coin.base === c.base && s.tf === '1h')); };
  $('#mClose').onclick = closeModal; $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  $('#mCalc').onclick = e => { e.preventDefault(); if (curSig) toCalc(curSig); closeModal(); if (innerWidth <= 820) tab('calc'); else $('#v-calc').scrollIntoView({ behavior: 'smooth' }); };
  $$('#cDir button').forEach(b => b.onclick = () => { C.dir = b.dataset.v; $$('#cDir button').forEach(x => x.classList.toggle('on', x === b)); calc(); });
  ['#cDep', '#cRisk', '#cLev', '#cEntry', '#cSl', '#cTp'].forEach(id => $(id).addEventListener('input', calc));
  try { const c = JSON.parse(localStorage.getItem('sb_c') || '{}'); if (c.dep) $('#cDep').value = c.dep; if (c.risk) $('#cRisk').value = c.risk; if (c.lev) $('#cLev').value = c.lev; } catch (e) { }
  $$('.tabbar button').forEach(b => b.onclick = () => tab(b.dataset.tab));
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { renderSignals(); renderHeader(); }, 200); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.lastScan && Date.now() - S.lastScan > CFG.REFRESH_SIGNALS) { refreshMarket().then(refreshSignals); } });
}
function tab(t) { $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + t)); scrollTo(0, 0); if (t === 'signals') renderSignals(); }

/* ---------- boot ---------- */
wire(); syncFilterUI(); calc();
refreshMarket().then(refreshSignals);
setInterval(() => { if (!document.hidden) refreshMarket().then(() => { if (S.view) renderSignals(); }); }, CFG.REFRESH_MARKET);
setInterval(() => { if (!document.hidden) refreshSignals(); }, CFG.REFRESH_SIGNALS);
setInterval(() => { if (S.lastScan) $('#upd').textContent = 'Обновлено ' + timeStr(S.lastScan) + ' · авто каждые 3 мин'; }, 30e3);
