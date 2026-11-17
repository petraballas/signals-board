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
      if (j.retCode !== 0) throw new Error('API ' + j.retMsg);
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
      const j = await getJSON(`${this.base}/futures/usdt/candlesticks?contract=${id}&interval=${tf}&limit=${limit}`);
      return j.map(r => ({ t: r.t * 1000, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.sum }));
    },
    async oiHist(id) {
      const j = await getJSON(`${this.base}/futures/usdt/contract_stats?contract=${id}&interval=1h&limit=48`);
      return j.map(r => ({ t: r.time * 1000, oi: +r.open_interest, usd: +r.open_interest_usd }));
    },
  },
};
const ALL = ['bybit', 'okx', 'gate'];
let PROV = null; // active provider key
// Provider health: a provider that times out / is blocked (CORS, 403, 451, network) is skipped for 10 min,
// so a geo-blocked Bybit doesn't cost a timeout on every refresh. Last working provider is remembered.
const DEAD = {};
const alive = k => !DEAD[k] || Date.now() - DEAD[k] > 6e5;
function markDead(k, e) { const m = (e && e.message) || ''; if (!/429|HTTP 400|HTTP 404|^API/.test(m)) DEAD[k] = Date.now(); }
function order() {
  if (FORCE && P[FORCE]) return [FORCE, ...ALL.filter(x => x !== FORCE)];
  let pref = null; try { pref = localStorage.getItem('sb_prov'); } catch (e) { }
  const o = pref && ALL.includes(pref) ? [pref, ...ALL.filter(x => x !== pref)] : ALL.slice();
  const a = o.filter(alive); return a.length ? a : o;
}
const ORDER = ALL;

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
  for (const k of order()) {
    try { const t = await P[k].tickers(); if (!t.length) throw new Error('empty'); PROV = k; delete DEAD[k]; if (!FORCE) try { localStorage.setItem('sb_prov', k); } catch (e) { } return t; }
    catch (e) { lastErr = e; markDead(k, e); console.warn('tickers fail', k, e.message); }
  }
  throw lastErr;
}
async function klines(coin, tf) {
  const idFor = k => k === PROV ? coin.id : k === 'bybit' ? coin.base + 'USDT' : k === 'okx' ? coin.base + '-USDT-SWAP' : coin.base + '_USDT';
  const ord = [PROV, ...ALL.filter(k => k !== PROV)].filter(k => alive(k) || k === PROV);
  let err; for (const k of ord) { try { return await retry(() => P[k].klines(idFor(k), tf)); } catch (e) { err = e; markDead(k, e); } }
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
let mktBusy = null;
function refreshMarket() { if (!mktBusy) mktBusy = _refreshMarket().finally(() => { mktBusy = null; }); return mktBusy; }
async function _refreshMarket() {
  try {
    const [all, cs] = await Promise.all([loadTickers(), S.f.tradfi ? null : cryptoSet()]);
    const top = all.filter(x => !STABLE.test(x.base) && x.turnover > 0 && x.last > 0 && (!cs || cs.has(x.base))).sort((a, b) => b.turnover - a.turnover).slice(0, CFG.TOP);
    const prev = Object.fromEntries(S.coins.map(c => [c.base, c]));
    S.coins = top.map(c => { const o = prev[c.base]; if (o) o.prevTick = o.last; const r = Object.assign(o || {}, c); r.dirty = true; return r; });
    $('#src').textContent = 'Источник: ' + P[PROV].name + (PROV !== 'bybit' ? ' (резерв)' : '');
    S.lastMarket = Date.now(); renderHeader(); renderMarkets(); updatePricesUI();
    const key = S.coins.map(c => c.base).join(',') + PROV; if (key !== LIVE.key) startLive();
  } catch (e) { $('#upd').textContent = 'Нет связи с биржами — повторяю…'; }
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
      <div class="meta"><span>Сейчас <b class="px" data-now="${esc(s.coin.base)}" data-entry="${s.entry}" data-dir="${s.dir}">${fmtP(s.coin.last)}</b> <span data-nowp="${esc(s.coin.base)}" class="${cls((s.coin.last / s.entry - 1) * (L ? 1 : -1))}">(${pct((s.coin.last / s.entry - 1) * 100)})</span></span><span>RSI ${s.rsi.toFixed(0)}</span></div>
    </div>`; }).join('');
  S.view = a;
  requestAnimationFrame(() => $$('#grid canvas.mini').forEach(cv => drawMini(cv, S.view[+cv.dataset.i])));
}
function drawMini(cv, s) {
  if (!s || !cv.isConnected) return; const an = S.an[s.coin.base + s.tf]; if (!an) return; const [x, w, h] = hidpi(cv); x.clearRect(0, 0, w, h);
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
  $('#mk').innerHTML = S.coins.map(c => `<tr data-b="${esc(c.base)}"><td><b>${esc(c.base)}</b></td><td class="px" data-px="${esc(c.base)}">${fmtP(c.last)}</td><td data-chg="${esc(c.base)}" class="${cls(c.chg)}">${pct(c.chg)}</td><td class="hide-m mut">${fmtBig(c.turnover)}</td><td data-fund="${esc(c.base)}" class="${c.funding == null ? 'dim' : cls(c.funding)}">${c.funding == null ? '—' : (c.funding * 100).toFixed(4) + '%'}</td><td>${tr(c.tr1h)} ${tr(c.tr4h)}</td><td class="hide-m ${c.rsi1h > 70 ? 'down' : c.rsi1h < 30 ? 'up' : ''}">${c.rsi1h ? c.rsi1h.toFixed(0) : '—'}</td></tr>`).join('');
}

/* ---------- modal + chart ---------- */
let chart = null, curSig = null, chartSeries = null;
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
  chartSeries = null; if (chart) { chart.remove(); chart = null; }
  if (!an) { el.innerHTML = '<div class="empty">Не удалось загрузить свечи</div>'; return; }
  if (!window.LightweightCharts) { el.innerHTML = '<canvas style="width:100%;height:100%"></canvas>'; if (sig) drawMini(el.firstChild, sig); return; }
  const off = -new Date().getTimezoneOffset() * 60, T = t => Math.floor(t / 1000) + off;
  chart = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: 'rgba(0,0,0,0)' }, textColor: '#9aa3c7', fontFamily: '-apple-system,Inter,sans-serif' },
    grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } }, rightPriceScale: { borderColor: 'rgba(255,255,255,.1)' },
    timeScale: { borderColor: 'rgba(255,255,255,.1)', timeVisible: true }, crosshair: { mode: 0 } });
  const cs = chart.addCandlestickSeries({ upColor: '#3ddc97', downColor: '#ff5e7a', borderVisible: false, wickUpColor: '#3ddc97', wickDownColor: '#ff5e7a', priceFormat: { type: 'price', precision: dec(an.last), minMove: Math.pow(10, -dec(an.last)) } });
  chartSeries = { cs, an, T }; cs.setData(an.bars.map(b => ({ time: T(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
  const line = (arr, color, w = 1.5) => { const s = chart.addLineSeries({ color, lineWidth: w, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); s.setData(arr.map((v, i) => v == null ? null : { time: T(an.closed[i].t), value: v }).filter(Boolean)); };
  line(an.e20, 'rgba(139,124,255,.9)'); line(an.e50, 'rgba(255,198,92,.85)'); line(an.vw, 'rgba(90,200,250,.7)', 1);
  const pl = (p, color, title, style = 2) => cs.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
  pl(an.vp.poc, 'rgba(255,255,255,.45)', 'POC', 1); pl(an.vp.vah, 'rgba(255,255,255,.25)', 'VAH', 3); pl(an.vp.val, 'rgba(255,255,255,.25)', 'VAL', 3);
  if (sig) { pl(sig.entry, '#e8eaff', 'Вход'); pl(sig.sl, '#ff5e7a', 'Стоп'); pl(sig.tp1, '#3ddc97', 'Тейк 1'); pl(sig.tp2, '#3ddc97', 'Тейк 2');
    cs.setMarkers([{ time: T(an.closed[sig.barIdx].t), position: sig.dir === 'long' ? 'belowBar' : 'aboveBar', color: sig.dir === 'long' ? '#3ddc97' : '#ff5e7a', shape: sig.dir === 'long' ? 'arrowUp' : 'arrowDown', text: TYPE_RU[sig.type] }]); }
  chart.timeScale().setVisibleLogicalRange({ from: an.bars.length - 90, to: an.bars.length + 3 });
}
const dec = p => { const a = Math.abs(p); return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a >= 0.001 ? 6 : 8; };
function closeModal() { $('#modal').classList.remove('open'); document.body.style.overflow = ''; chartSeries = null; if (chart) { chart.remove(); chart = null; } }

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
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; refreshMarket(); if (!liveOk()) startLive(); if (S.lastScan && Date.now() - S.lastScan > CFG.REFRESH_SIGNALS) refreshSignals(); });
  addEventListener('pageshow', e => { if (e.persisted) { refreshMarket(); startLive(); } });
  addEventListener('online', () => { refreshMarket(); startLive(); });
}
function tab(t) { $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + t)); scrollTo(0, 0); if (t === 'signals') renderSignals(); }

/* ---------- live prices (WebSocket, with provider fallback) ---------- */
const now = () => Math.floor(Date.now() / 1000);
const chunk = (a, n) => a.reduce((r, x, i) => (i % n ? r[r.length - 1].push(x) : r.push([x]), r), []);
const WSP = {
  bybit: { url: 'wss://stream.bybit.com/v5/public/linear', sym: c => c.base + 'USDT',
    subs: ids => chunk(ids.map(i => 'tickers.' + i), 10).map(a => ({ op: 'subscribe', args: a })), ping: () => ({ op: 'ping' }),
    parse: m => { if (!m.topic || !m.data || !m.data.symbol) return; const d = m.data; return [{ id: d.symbol, last: d.lastPrice, chg: d.price24hPcnt !== undefined ? +d.price24hPcnt * 100 : undefined, funding: d.fundingRate, oiUsd: d.openInterestValue }]; } },
  okx: { url: 'wss://ws.okx.com/ws/v5/public', sym: c => c.base + '-USDT-SWAP',
    subs: ids => chunk(ids.map(i => ({ channel: 'tickers', instId: i })), 20).map(a => ({ op: 'subscribe', args: a })), ping: () => 'ping',
    parse: m => { if (!m.data || !m.arg || m.arg.channel !== 'tickers') return; return m.data.map(d => ({ id: d.instId, last: d.last, chg: (+d.last / +d.open24h - 1) * 100 })); } },
  gate: { url: 'wss://fx-ws.gateio.ws/v4/ws/usdt', sym: c => c.base + '_USDT',
    subs: ids => [{ time: now(), channel: 'futures.tickers', event: 'subscribe', payload: ids }], ping: () => ({ time: now(), channel: 'futures.ping' }),
    parse: m => { if (m.channel !== 'futures.tickers' || m.event !== 'update' || !Array.isArray(m.result)) return; return m.result.map(d => ({ id: d.contract, last: d.last, chg: d.change_percentage !== undefined ? +d.change_percentage : undefined, funding: d.funding_rate })); } },
};
const LIVE = { ws: null, prov: null, last: 0, started: 0, key: '', tried: [], pingT: null, gen: 0 };
const liveOk = () => LIVE.ws && Date.now() - LIVE.last < 20e3;
function stopLive() { LIVE.gen++; clearInterval(LIVE.pingT); if (LIVE.ws) { try { LIVE.ws.onclose = null; LIVE.ws.close(); } catch (e) { } } LIVE.ws = null; }
function startLive(skipCurrent) {
  if (!S.coins.length || typeof WebSocket === 'undefined') return;
  const pref = [PROV, ...ALL.filter(k => k !== PROV)].filter(Boolean);
  if (skipCurrent && LIVE.prov) LIVE.tried.push(LIVE.prov); else if (!skipCurrent) LIVE.tried = [];
  let k = pref.find(x => !LIVE.tried.includes(x)); if (!k) { LIVE.tried = []; k = pref[0]; }
  stopLive(); const gen = LIVE.gen, W = WSP[k];
  LIVE.prov = k; LIVE.started = Date.now(); LIVE.last = 0; LIVE.key = S.coins.map(c => c.base).join(',') + PROV;
  // map provider symbol -> coin (same provider: use its own id, e.g. 1000PEPEUSDT)
  const map = {}; S.coins.forEach(c => { map[k === PROV ? c.id : W.sym(c)] = c; });
  let ws; try { ws = new WebSocket(W.url); } catch (e) { return; }
  LIVE.ws = ws;
  ws.onopen = () => { if (gen !== LIVE.gen) return; W.subs(Object.keys(map)).forEach(m => ws.send(JSON.stringify(m))); LIVE.pingT = setInterval(() => { try { const p = W.ping(); ws.send(typeof p === 'string' ? p : JSON.stringify(p)); } catch (e) { } }, 18e3); };
  ws.onmessage = e => { if (gen !== LIVE.gen || e.data === 'pong') return; let m; try { m = JSON.parse(e.data); } catch (x) { return; } const ticks = W.parse(m); if (!ticks) return;
    for (const t of ticks) applyTick(map[t.id], t); };
  ws.onerror = () => { };
  ws.onclose = () => { if (gen !== LIVE.gen) return; const quick = !LIVE.last; LIVE.ws = null; setLivePill(); setTimeout(() => { if (gen === LIVE.gen) startLive(quick); }, quick ? 500 : 3000); };
  // no ticks within 8s → try next provider
  setTimeout(() => { if (gen === LIVE.gen && !LIVE.last) startLive(true); }, 8000);
  setLivePill();
}
function applyTick(c, t) {
  if (!c) return; const p = +t.last;
  if (t.last !== undefined && t.last !== '' && isFinite(p) && p > 0) {
    if (c.last && Math.abs(p / c.last - 1) > 0.25) return; // symbol mismatch guard (e.g. 1000x contracts)
    c.prevTick = c.last; c.last = p; LIVE.last = Date.now(); c.tickAt = LIVE.last;
    for (const tf of CFG.TFS) { const an = S.an[c.base + tf]; if (!an) continue; const b = an.bars, L = b[b.length - 1], ms = tfMs(tf);
      if (Date.now() >= L.t + ms) { const t0 = L.t + Math.floor((Date.now() - L.t) / ms) * ms; b.push({ t: t0, o: p, h: p, l: p, c: p, v: 0 }); } else { L.c = p; if (p > L.h) L.h = p; if (p < L.l) L.l = p; }
      an.last = p; }
  } else if (t.funding === undefined && t.chg === undefined) return;
  if (t.chg !== undefined && isFinite(t.chg)) c.chg = t.chg;
  if (t.funding !== undefined && t.funding !== '' && isFinite(+t.funding)) c.funding = +t.funding;
  if (t.oiUsd !== undefined && isFinite(+t.oiUsd) && +t.oiUsd > 0) c.oiUsd = +t.oiUsd;
  c.dirty = true; scheduleUI();
}
let uiT = null, lastUI = 0, lastMini = 0;
function scheduleUI() { if (uiT) return; const wait = Math.max(0, 700 - (Date.now() - lastUI)); uiT = setTimeout(() => { uiT = null; lastUI = Date.now(); requestAnimationFrame(updatePricesUI); }, wait); }
function flash(el, up) { el.classList.remove('tk-up', 'tk-dn'); void el.offsetWidth; el.classList.add(up ? 'tk-up' : 'tk-dn'); }
function updatePricesUI() {
  for (const c of S.coins) {
    if (!c.dirty && !c.prevTick) continue; const up = c.prevTick == null ? null : c.last > c.prevTick ? true : c.last < c.prevTick ? false : null;
    $$(`[data-px="${c.base}"]`).forEach(el => { const t = fmtP(c.last); if (el.textContent !== t) { el.textContent = t; if (up !== null) flash(el, up); } });
    $$(`[data-chg="${c.base}"]`).forEach(el => { el.textContent = pct(c.chg); el.className = cls(c.chg); });
    $$(`[data-fund="${c.base}"]`).forEach(el => { if (c.funding != null) { el.textContent = (c.funding * 100).toFixed(4) + '%'; el.className = cls(c.funding); } });
    $$(`[data-now="${c.base}"]`).forEach(el => { const t = fmtP(c.last); if (el.textContent !== t) { el.textContent = t; if (up !== null) flash(el, up); }
      const e = +el.dataset.entry, L = el.dataset.dir === 'long', d = (c.last / e - 1) * 100, sp = el.nextElementSibling; if (sp) { sp.textContent = '(' + pct(d) + ')'; sp.className = cls(d * (L ? 1 : -1)); } });
    c.dirty = false; c.prevTick = null;
  }
  if (Date.now() - lastMini > 4000 && S.view) { lastMini = Date.now(); $$('#grid canvas.mini').forEach(cv => { const s = S.view[+cv.dataset.i]; if (s && s.coin.tickAt && s.coin.tickAt > (cv._t || 0)) { cv._t = Date.now(); drawMini(cv, s); } }); }
  if (chartSeries) { const { cs, an, T } = chartSeries, b = an.bars[an.bars.length - 1]; try { cs.update({ time: T(b.t), open: b.o, high: b.h, low: b.l, close: b.c }); } catch (e) { } }
  renderHeader(); setLivePill();
}
function setLivePill() {
  const el = $('#live'); if (!el) return;
  if (liveOk()) { el.className = 'pill live on'; el.textContent = '● LIVE · ' + P[LIVE.prov].name; }
  else { el.className = 'pill live'; el.textContent = S.lastMarket ? '○ цены: REST · ' + timeStr(new Date(S.lastMarket)) : '○ подключение…'; }
}

/* ---------- boot ---------- */
wire(); syncFilterUI(); calc();
refreshMarket().then(refreshSignals);
// REST price polling: every 60s normally, every 8s whenever the live stream is not healthy
setInterval(() => { if (document.hidden) return; const age = Date.now() - (S.lastMarket || 0); if (age > CFG.REFRESH_MARKET || (!liveOk() && age > 8e3)) refreshMarket(); }, 4e3);
setInterval(() => { if (!document.hidden && S.coins.length && !liveOk() && Date.now() - LIVE.started > 15e3) startLive(); setLivePill(); }, 5e3);
setInterval(() => { if (!document.hidden) refreshSignals(); }, CFG.REFRESH_SIGNALS);
setInterval(() => { if (S.lastScan) $('#upd').textContent = 'Обновлено ' + timeStr(S.lastScan) + ' · авто каждые 3 мин'; }, 30e3);
