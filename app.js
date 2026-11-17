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

const TYPE_RU = { breakout: 'Пробой', bounce: 'Отскок', pullback: 'Откат', smc: 'SMC / Ликвидность' };
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
    const inTop = new Set(S.coins.map(c => c.base)), prevX = Object.fromEntries((S.extra || []).map(c => [c.base, c]));
    S.extra = [...new Set(FAV.items.map(f => f.base))].filter(b => !inTop.has(b)).map(b => all.find(x => x.base === b)).filter(Boolean)
      .map(c => { const o = prevX[c.base]; if (o) o.prevTick = o.last; const r = Object.assign(o || {}, c); r.dirty = true; return r; });
    $('#src').textContent = 'Источник: ' + P[PROV].name + (PROV !== 'bybit' ? ' (резерв)' : '');
    S.lastMarket = Date.now(); renderHeader(); renderMarkets(); updatePricesUI();
    const key = liveCoins().map(c => c.base).join(',') + PROV; if (key !== LIVE.key) startLive();
    favBackfillAll();
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
      try { const sm = detectSMC(an, tf, c, htfTrend); if (sm.length) found.push(sm[0]); } catch (e) { console.warn('smc', e); }
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
  if (s.smc) lines.push([s.smc.sweep, '#ffc65c', 'Ликв.']);
  let mn = Math.min(...bars.map(b => b.l), ...lines.map(l => l[0])), mx = Math.max(...bars.map(b => b.h), ...lines.map(l => l[0])); const pad = (mx - mn) * 0.06; mn -= pad; mx += pad;
  const lblW = w < 230 ? 0 : 0, cw = w - lblW, Y = p => 4 + (mx - p) / (mx - mn) * (h - 8);
  const bw = cw / bars.length;
  if (s.smc && s.smc.fvg) { const f = s.smc.fvg, k = bars.findIndex(b => b.t >= f.t), x0 = (k < 0 ? 0 : k) * bw; x.fillStyle = 'rgba(139,124,255,.22)'; x.fillRect(x0, Y(f.hi), w - x0, Math.max(2, Y(f.lo) - Y(f.hi))); x.fillStyle = '#b9b0ff'; x.font = '600 9px -apple-system,Inter,sans-serif'; x.fillText('FVG', w - 26, Y(f.hi) + 9); }
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
  $('#mCalc').style.display = sig ? '' : 'none'; setFavBtn(sig);
  let an = S.an[coin.base + tf]; if (!an) { try { an = analyze(await klines(coin, tf), tf); if (an) S.an[coin.base + tf] = an; } catch (e) { } }
  const kv = []; if (sig) kv.push(['Вход', fmtP(sig.entry)], ['Стоп', `<span class="down">${fmtP(sig.sl)}</span>`], [`Тейк 1 (${(sig.rr1 || 1.5).toFixed(1)}R)`, fmtP(sig.tp1)], ['Тейк 2', `<span class="up">${fmtP(sig.tp2)}</span>`], ['R:R', '1:' + sig.rr.toFixed(2)], ...(sig.atr ? [['Стоп в ATR', (Math.abs(sig.entry - sig.sl) / sig.atr).toFixed(2)]] : []));
  if (sig && sig.smc) { const m = sig.smc; kv.push(['Снятая ликвидность', `<span style="color:var(--amber)">${fmtP(m.sweep)}${m.eq >= 2 ? ' · равные ×' + m.eq : ''}</span>`], ['FVG (вход)', m.fvg ? `<span style="color:#b9b0ff">${fmtP(m.fvg.lo)} – ${fmtP(m.fvg.hi)}</span>` : 'нет — вход по закрытию'], ['Пулы ликвидности', (m.pools || []).slice(0, 3).map(p => fmtP(p.p) + (p.n > 1 ? ' ×' + p.n : '')).join(' · ') || '—'], ['После TP1', 'стоп в безубыток']); }
  if (an) { const n = an.n; kv.push(['RSI(14)', an.r[n].toFixed(1)], ['ATR(14)', fmtP(an.A[n]) + ` (${(an.A[n] / an.c[n] * 100).toFixed(2)}%)`], ['EMA20 / EMA50', fmtP(an.e20[n]) + ' / ' + fmtP(an.e50[n])], ['VWAP', fmtP(an.vw[n])], ['POC', fmtP(an.vp.poc)], ['VAH / VAL', fmtP(an.vp.vah) + ' / ' + fmtP(an.vp.val)], ['Тренд', an.trend > 0 ? '<span class="up">▲ вверх</span>' : an.trend < 0 ? '<span class="down">▼ вниз</span>' : 'флэт']); }
  kv.push(['Funding', coin.funding == null ? '—' : (coin.funding * 100).toFixed(4) + '%'], ['OI', coin.oiUsd ? fmtBig(coin.oiUsd) + ' $' : '—'], ['Оборот 24ч', fmtBig(coin.turnover) + ' $']);
  $('#mKv').innerHTML = kv.map(([k, v]) => `<div><small>${k}</small>${v}</div>`).join('');
  $('#mReason').innerHTML = sig ? `${sig.fav ? `<b>⭐ Из избранного</b> · сохранено ${dtStr(sig.fav.savedAt)}${sig.fav.entry !== sig.fav.sigEntry ? ' · твой вход ' + fmtP(sig.fav.entry) : ''}<br>` : ''}<b>Почему:</b> ${esc(sig.why)}${(sig.tags || []).length ? '. Плюс: ' + esc(sig.tags.join(', ')) : ''}.${sig.fresh ? '' : ' Сигнал на одну-две свечи раньше — цена могла уйти от входа.'}` : '';
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
  if (sig && sig.smc) { const m = sig.smc; pl(m.sweep, '#ffc65c', 'Снята ликв.', 1);
    (m.pools || []).forEach(p => pl(p.p, 'rgba(255,198,92,.55)', 'Ликв.' + (p.n > 1 ? ' ×' + p.n : ''), 2));
    const boxes = []; if (m.fvg) boxes.push([m.fvg, 'rgba(139,124,255,.20)', 'rgba(139,124,255,.75)', 'FVG вход']); if (m.tgtFvg) boxes.push([m.tgtFvg, 'rgba(255,198,92,.12)', 'rgba(255,198,92,.6)', 'FVG цель']);
    if (boxes.length) { const ov = document.createElement('canvas'); ov.className = 'ovl'; el.appendChild(ov);
      const draw = () => { if (!chart) return; const r = el.getBoundingClientRect(), dpr = devicePixelRatio || 1; ov.width = r.width * dpr; ov.height = r.height * dpr; ov.style.width = r.width + 'px'; ov.style.height = r.height + 'px';
        const g = ov.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height); const right = r.width - chart.priceScale('right').width();
        for (const [f, fill, stroke, label] of boxes) { let x0 = chart.timeScale().timeToCoordinate(T(f.t)); if (x0 == null) x0 = 0; const y1 = cs.priceToCoordinate(f.hi), y2 = cs.priceToCoordinate(f.lo); if (y1 == null || y2 == null || x0 > right) continue;
          g.fillStyle = fill; g.fillRect(x0, y1, right - x0, Math.max(2, y2 - y1)); g.strokeStyle = stroke; g.lineWidth = 1; g.strokeRect(x0 + .5, y1 + .5, right - x0 - 1, Math.max(2, y2 - y1)); g.fillStyle = stroke; g.font = '600 11px -apple-system,Inter,sans-serif'; g.fillText(label, x0 + 4, y1 + 12); } };
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(draw)); chartSeries && (chartSeries.ovl = draw); setTimeout(draw, 60); } }
  if (sig) { pl(sig.entry, '#e8eaff', 'Вход'); pl(sig.sl, '#ff5e7a', 'Стоп'); pl(sig.tp1, '#3ddc97', 'Тейк 1'); pl(sig.tp2, '#3ddc97', 'Тейк 2');
    const mk = sig.fav ? an.bars.filter(b => b.t <= sig.fav.savedAt).pop() : an.closed[sig.barIdx];
    if (mk) cs.setMarkers([{ time: T(mk.t), position: sig.dir === 'long' ? 'belowBar' : 'aboveBar', color: sig.dir === 'long' ? '#3ddc97' : '#ff5e7a', shape: sig.dir === 'long' ? 'arrowUp' : 'arrowDown', text: sig.fav ? '⭐ вход' : TYPE_RU[sig.type] }]); }
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
  $$('.dnav button').forEach(b => b.onclick = () => dtab(b.dataset.dtab));
  $('#mFav').onclick = e => { e.preventDefault(); if (!curSig) return; const id = favId(curSig); if (FAV.items.some(f => f.id === id) || curSig.fav) { closeModal(); openFavTab(); return; } favAdd(curSig); setFavBtn(curSig); toast('⭐ Сохранено в избранное'); };
  $('#favExport').onclick = favExport; $('#favImport').onchange = favImport;
  $('#favList').addEventListener('click', favClick); $('#favList').addEventListener('input', favInput); $('#favList').addEventListener('change', favChange);
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { renderSignals(); renderHeader(); }, 200); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; refreshMarket(); if (!liveOk()) startLive(); if (S.lastScan && Date.now() - S.lastScan > CFG.REFRESH_SIGNALS) refreshSignals(); });
  addEventListener('pageshow', e => { if (e.persisted) { refreshMarket(); startLive(); } });
  addEventListener('online', () => { refreshMarket(); startLive(); });
}
function tab(t) {
  if (t === 'fav') renderFav();
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + t));
  document.body.classList.toggle('dfav', t === 'fav');
  document.body.classList.toggle('dscr', t === 'screener');
  const d = t === 'fav' || t === 'screener' ? t : 'signals';
  $$('.dnav button').forEach(b => b.classList.toggle('on', b.dataset.dtab === d));
  scrollTo(0, 0);
  if (t === 'signals') renderSignals();
  if (window.Screener) window.Screener.setActive(t === 'screener');
}

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
  LIVE.prov = k; LIVE.started = Date.now(); LIVE.last = 0; LIVE.key = liveCoins().map(c => c.base).join(',') + PROV;
  // map provider symbol -> coin (same provider: use its own id, e.g. 1000PEPEUSDT)
  const map = {}; liveCoins().forEach(c => { map[k === PROV ? c.id : W.sym(c)] = c; });
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
    c.prevTick = c.last; c.last = p; LIVE.last = Date.now(); c.tickAt = LIVE.last; favTick(c.base, p);
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
  for (const c of liveCoins()) {
    if (!c.dirty && !c.prevTick) continue; const up = c.prevTick == null ? null : c.last > c.prevTick ? true : c.last < c.prevTick ? false : null;
    $$(`[data-px="${c.base}"]`).forEach(el => { const t = fmtP(c.last); if (el.textContent !== t) { el.textContent = t; if (up !== null) flash(el, up); } });
    $$(`[data-chg="${c.base}"]`).forEach(el => { el.textContent = pct(c.chg); el.className = cls(c.chg); });
    $$(`[data-fund="${c.base}"]`).forEach(el => { if (c.funding != null) { el.textContent = (c.funding * 100).toFixed(4) + '%'; el.className = cls(c.funding); } });
    $$(`[data-now="${c.base}"]`).forEach(el => { const t = fmtP(c.last); if (el.textContent !== t) { el.textContent = t; if (up !== null) flash(el, up); }
      const e = +el.dataset.entry, L = el.dataset.dir === 'long', d = (c.last / e - 1) * 100, sp = el.nextElementSibling; if (sp) { sp.textContent = '(' + pct(d) + ')'; sp.className = cls(d * (L ? 1 : -1)); } });
    c.dirty = false; c.prevTick = null;
  }
  if (Date.now() - lastMini > 4000 && S.view) { lastMini = Date.now(); $$('#grid canvas.mini').forEach(cv => { const s = S.view[+cv.dataset.i]; if (s && s.coin.tickAt && s.coin.tickAt > (cv._t || 0)) { cv._t = Date.now(); drawMini(cv, s); } }); }
  if (chartSeries) { const { cs, an, T } = chartSeries, b = an.bars[an.bars.length - 1]; try { cs.update({ time: T(b.t), open: b.o, high: b.h, low: b.l, close: b.c }); if (chartSeries.ovl) chartSeries.ovl(); } catch (e) { } }
  favLive(); if (DEMO.st) renderDemo(); renderHeader(); setLivePill();
}
function setLivePill() {
  const el = $('#live'); if (!el) return;
  if (liveOk()) { el.className = 'pill live on'; el.textContent = '● LIVE · ' + P[LIVE.prov].name; }
  else { el.className = 'pill live'; el.textContent = S.lastMarket ? '○ цены: REST · ' + timeStr(new Date(S.lastMarket)) : '○ подключение…'; }
}

/* ---------- favorites ("Я вошёл") — snapshots in localStorage, independent of the live signal list ---------- */
const FAV_KEY = 'sb_fav_v1';
const FAV = { items: [] };
try { const a = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); if (Array.isArray(a)) FAV.items = a; } catch (e) { }
let favSaveT = null;
function favSave(now) { const w = () => { clearTimeout(favSaveT); favSaveT = null; try { localStorage.setItem(FAV_KEY, JSON.stringify(FAV.items)); } catch (e) { toast('Не удалось сохранить (память браузера)'); } }; if (now) w(); else if (!favSaveT) favSaveT = setTimeout(w, 1500); }
addEventListener('pagehide', () => favSave(true));
addEventListener('storage', e => { if (e.key !== FAV_KEY) return; try { const a = JSON.parse(e.newValue || '[]'); if (Array.isArray(a)) { FAV.items = a; renderFav(); } } catch (x) { } });
const liveCoins = () => S.coins.concat(S.extra || []);
const coinOf = base => liveCoins().find(c => c.base === base);
const favId = s => [s.coin.base, s.tf, s.type, s.dir, s.t].join('|');
const dtStr = ms => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ST_RU = { active: '● Активна', tp1: '✓ TP1 достигнут', tp2: '✓✓ TP2 достигнут', stop: '✕ Стоп', tp1stop: 'TP1 ✓ → потом стоп' };
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2200); }
function setFavBtn(sig) { const b = $('#mFav'); if (!b) return; b.style.display = sig ? '' : 'none'; if (!sig) return; const saved = sig.fav || FAV.items.some(f => f.id === favId(sig)); b.classList.toggle('saved', !!saved); b.textContent = saved ? '★ В избранном — открыть' : '⭐ В избранное / Я вошёл'; }
function favAdd(s) {
  const now = Date.now();
  const f = { id: favId(s), base: s.coin.base, sym: s.coin.id, prov: PROV, dir: s.dir, type: s.type, tf: s.tf,
    entry: s.entry, sigEntry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, rr: s.rr, strength: s.strength, why: s.why, tags: s.tags || [],
    smc: s.smc || null, sigT: s.t, savedAt: now, priceAtSave: s.coin.last, note: '', status: 'active', chkT: now, hi: s.coin.last, lo: s.coin.last, statusAt: null };
  FAV.items.unshift(f); favSave(true); favCount(); renderFav();
  if (!S.coins.some(c => c.base === f.base)) refreshMarket();
}
function favStep(f, hi, lo, t) {
  if (f.status === 'stop' || f.status === 'tp2' || f.status === 'tp1stop') return false;
  const L = f.dir === 'long', sl = L ? lo <= f.sl : hi >= f.sl, t1 = L ? hi >= f.tp1 : lo <= f.tp1, t2 = L ? hi >= f.tp2 : lo <= f.tp2, was = f.status;
  if (f.status === 'active') { if (sl) f.status = 'stop'; else if (t2) f.status = 'tp2'; else if (t1) f.status = 'tp1'; } // same candle: stop first (conservative)
  else if (f.status === 'tp1') { if (sl) f.status = 'tp1stop'; else if (t2) f.status = 'tp2'; }
  if (f.status !== was) { f.statusAt = t; return true; } return false;
}
function favTick(base, p) {
  let ch = false; for (const f of FAV.items) { if (f.base !== base) continue; f.last = p; f.hi = Math.max(f.hi ?? p, p); f.lo = Math.min(f.lo ?? p, p); if (favStep(f, p, p, Date.now())) { ch = true; toast(`${f.base}: ${ST_RU[f.status]}`); } f.chkT = Date.now(); }
  if (ch) { favSave(true); renderFav(); } else favSave();
}
// catch up on price history since the last check (e.g. tab was closed) from candles
let favBfBusy = false, favBfAt = 0;
async function favBackfillAll(force) {
  if (favBfBusy || !PROV || !FAV.items.length || (!force && Date.now() - favBfAt < 3e5)) return; favBfBusy = true; favBfAt = Date.now();
  try { for (const f of FAV.items) { if (['stop', 'tp2', 'tp1stop'].includes(f.status)) continue; try { await favBackfill(f); } catch (e) { } } }
  finally { favBfBusy = false; favSave(true); renderFav(); }
}
async function favBackfill(f) {
  const from = Math.max(f.savedAt, (f.chkT || f.savedAt) - 6e4), age = Date.now() - from, tf = age < 70 * 36e5 ? '15m' : age < 290 * 36e5 ? '1h' : '4h', ms = tfMs(tf);
  const coin = coinOf(f.base) || { base: f.base, id: PROV === f.prov ? f.sym : f.base + (PROV === 'okx' ? '-USDT-SWAP' : PROV === 'gate' ? '_USDT' : 'USDT') };
  const bars = await klines(coin, tf);
  for (const b of bars) { if (b.t + ms <= from) continue; f.hi = Math.max(f.hi ?? b.h, b.h); f.lo = Math.min(f.lo ?? b.l, b.l); favStep(f, b.h, b.l, Math.max(b.t, f.savedAt)); }
  if (bars.length) { f.last = bars[bars.length - 1].c; } f.chkT = Date.now();
}
function favPnl(f, p) { if (!p || !f.entry) return null; const L = f.dir === 'long', pc = (p / f.entry - 1) * 100 * (L ? 1 : -1), r = (L ? p - f.entry : f.entry - p) / Math.abs(f.entry - f.sl || 1e-12); return { pc, r }; }
function favNear(f, p) { if (!p || ['stop', 'tp2', 'tp1stop'].includes(f.status)) return f.status === 'active' ? '' : 'сделка по уровням завершена'; const lv = [['стопа', f.sl], ...(f.status === 'tp1' ? [] : [['TP1', f.tp1]]), ['TP2', f.tp2]].map(([n, v]) => [n, Math.abs(p / v - 1) * 100]).sort((a, b) => a[1] - b[1])[0]; return `до ${lv[0]} ${lv[1].toFixed(2)}%`; }
function favCount() { $$('.favCnt').forEach(el => el.textContent = FAV.items.length ? FAV.items.length : ''); }
function favPrice(f) { const c = coinOf(f.base); return c && c.last ? c.last : f.last; }
function renderFav() {
  favCount(); const el = $('#favList'); if (!el) return; const a = FAV.items;
  const act = a.filter(f => f.status === 'active' || f.status === 'tp1').length;
  $('#favStat').innerHTML = a.length ? `<span class="pill">Всего: ${a.length}</span><span class="pill">В работе: ${act}</span><span class="dim">Статус считается по цене с момента сохранения (свечи + live). Тот же свечной бар: сначала стоп.</span>` : '';
  if (!a.length) { el.innerHTML = '<div class="empty glass" style="grid-column:1/-1">Пока пусто. Открой график сигнала и нажми «⭐ В избранное / Я вошёл» — сделка сохранится здесь, даже когда сигнал исчезнет из списка.</div>'; return; }
  const d = v => { const x = dec(v); return (+v).toFixed(x); };
  el.innerHTML = a.map(f => { const L = f.dir === 'long', p = favPrice(f), pn = favPnl(f, p);
    return `<div class="card glass fav ${f.dir}" data-id="${esc(f.id)}">
      <div class="top"><div><div class="sym">${esc(f.base)}/USDT</div><div class="stype"><span class="dot" style="margin:0;background:var(--${L ? 'green' : 'red'})"></span>${TYPE_RU[f.type] ? TYPE_RU[f.type].toUpperCase() : ''} · <span class="tf">${TF_RU[f.tf] || f.tf}</span> · <span class="stars">${'★'.repeat(f.strength || 0)}</span></div></div>
      <span class="badge ${f.dir}">${L ? 'ЛОНГ' : 'ШОРТ'}</span></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="stchip st-${f.status}" data-st>${ST_RU[f.status]}</span><span class="dim" style="font-size:12px">сохранено ${dtStr(f.savedAt)}${f.statusAt ? ' · статус с ' + dtStr(f.statusAt) : ''}</span></div>
      <div class="live-row"><div><div class="dim" style="font-size:11px">Цена сейчас</div><div class="px" data-px="${esc(f.base)}">${fmtP(p)}</div><div class="dim" style="font-size:11px" data-near>${favNear(f, p)}</div></div>
        <div class="pnl ${pn ? cls(pn.pc) : 'mut'}" data-pnl><span>${pn ? pct(pn.pc) : '—'}</span><small>${pn ? (pn.r >= 0 ? '+' : '') + pn.r.toFixed(2) + 'R от твоего входа' : 'нет цены'}</small></div></div>
      <div class="lv"><span>Сигнал: вход</span><span>${fmtP(f.sigEntry)}</span><span>R:R</span><span class="up">1:${(+f.rr).toFixed(1)}</span></div>
      <div class="edit">
        <label class="me">Мой вход<input inputmode="decimal" data-f="entry" value="${d(f.entry)}"></label>
        <label>Стоп<input inputmode="decimal" data-f="sl" value="${d(f.sl)}" style="color:var(--red)"></label>
        <label>Тейк 1<input inputmode="decimal" data-f="tp1" value="${d(f.tp1)}"></label>
        <label>Тейк 2<input inputmode="decimal" data-f="tp2" value="${d(f.tp2)}" style="color:var(--green)"></label>
      </div>
      <div class="reason">${esc(f.why || '')}</div>
      <textarea data-f="note" placeholder="Заметка: плечо, размер, мысли по сделке…">${esc(f.note || '')}</textarea>
      <div class="acts"><button data-a="chart">📈 График</button><button data-a="calc">▦ Калькулятор</button><button class="del" data-a="del" title="Удалить">🗑</button></div>
    </div>`; }).join('');
}
function favLive() {
  if (!FAV.items.length) return; const vis = $('#v-fav'); if (!vis || !vis.offsetParent) return;
  for (const card of $$('#favList .fav')) { const f = FAV.items.find(x => x.id === card.dataset.id); if (!f) continue; const p = favPrice(f), pn = favPnl(f, p);
    const pe = card.querySelector('[data-pnl]'); if (pe && pn) { pe.className = 'pnl ' + cls(pn.pc); pe.firstElementChild.textContent = pct(pn.pc); pe.lastElementChild.textContent = (pn.r >= 0 ? '+' : '') + pn.r.toFixed(2) + 'R от твоего входа'; }
    const ne = card.querySelector('[data-near]'); if (ne) ne.textContent = favNear(f, p);
    const st = card.querySelector('[data-st]'); if (st && st.textContent !== ST_RU[f.status]) { st.textContent = ST_RU[f.status]; st.className = 'stchip st-' + f.status; } }
}
function favFind(e) { const card = e.target.closest('.fav'); return card && FAV.items.find(x => x.id === card.dataset.id); }
function favInput(e) { const f = favFind(e), k = e.target.dataset.f; if (!f || !k) return; if (k === 'note') { f.note = e.target.value; favSave(); return; }
  const v = parseFloat(String(e.target.value).replace(',', '.').replace(/\s/g, '')); if (!(v > 0)) return; f[k] = v; if (k === 'entry') { favSave(); favLive(); } }
function favChange(e) { const f = favFind(e), k = e.target.dataset.f; if (!f || !k || k === 'note') return;
  if (k !== 'entry') { f.rr = Math.abs(f.tp2 - f.entry) / Math.abs(f.entry - f.sl || 1e-12); f.status = 'active'; f.statusAt = null; f.chkT = f.savedAt; f.hi = f.lo = null; favSave(true); renderFav(); favBackfillAll(true); toast('Уровни обновлены — статус пересчитан'); }
  else { f.rr = Math.abs(f.tp2 - f.entry) / Math.abs(f.entry - f.sl || 1e-12); favSave(true); renderFav(); toast('Твой вход сохранён'); } }
function favSig(f) { const c = coinOf(f.base) || { base: f.base, id: PROV === f.prov ? f.sym : f.base + (PROV === 'okx' ? '-USDT-SWAP' : PROV === 'gate' ? '_USDT' : 'USDT'), last: f.last, chg: null, funding: null };
  return { coin: c, tf: f.tf, type: f.type, dir: f.dir, entry: f.entry, sl: f.sl, tp1: f.tp1, tp2: f.tp2, rr: Math.abs(f.tp2 - f.entry) / Math.abs(f.entry - f.sl || 1e-12), strength: f.strength, why: f.why, tags: f.tags || [], smc: f.smc || null, fresh: true, t: f.sigT, fav: f }; }
function favClick(e) { const b = e.target.closest('button[data-a]'); if (!b) return; const f = favFind(e); if (!f) return; const a = b.dataset.a;
  if (a === 'chart') { const s = favSig(f); openCoin(s.coin, s.tf, s); }
  else if (a === 'calc') { toCalc(favSig(f)); if (innerWidth <= 820) tab('calc'); else { dtab('signals'); $('#v-calc').scrollIntoView({ behavior: 'smooth' }); } }
  else if (a === 'del') { if (!confirm(`Удалить ${f.base} (${f.dir === 'long' ? 'лонг' : 'шорт'}) из избранного?`)) return; FAV.items = FAV.items.filter(x => x !== f); favSave(true); renderFav(); toast('Удалено'); } }
function favExport() {
  const data = JSON.stringify({ app: 'signals-board', kind: 'favorites', v: 1, exportedAt: new Date().toISOString(), items: FAV.items }, null, 2);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = 'signals-izbrannoe-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); toast('Файл с избранным сохранён');
}
function favImport(e) {
  const file = e.target.files && e.target.files[0]; if (!file) return; const r = new FileReader();
  r.onload = () => { try { const j = JSON.parse(r.result); const arr = Array.isArray(j) ? j : j.items; if (!Array.isArray(arr)) throw 0;
      let n = 0; for (const f of arr) { if (!f || !f.id || !f.base || !(+f.entry > 0) || !(+f.sl > 0) || !['long', 'short'].includes(f.dir)) continue; if (FAV.items.some(x => x.id === f.id)) continue; FAV.items.push(Object.assign({ status: 'active', note: '', tags: [] }, f)); n++; }
      FAV.items.sort((a, b) => b.savedAt - a.savedAt); favSave(true); renderFav(); toast(n ? `Импортировано: ${n}` : 'Новых сделок в файле нет'); if (n) refreshMarket(); }
    catch (x) { toast('Не похоже на файл избранного'); } e.target.value = ''; };
  r.readAsText(file);
}
function dtab(t) {
  document.body.classList.toggle('dfav', t === 'fav');
  document.body.classList.toggle('dscr', t === 'screener');
  $$('.dnav button').forEach(b => b.classList.toggle('on', b.dataset.dtab === t));
  if (t === 'fav' || t === 'screener') {
    $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + t));
  } else {
    $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === 'signals'));
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-signals'));
  }
  if (t === 'fav') renderFav();
  if (window.Screener) window.Screener.setActive(t === 'screener');
}
function openFavTab() { if (innerWidth <= 820) tab('fav'); else dtab('fav'); scrollTo(0, 0); }
setInterval(() => { if (!document.hidden) favBackfillAll(); }, 6e4);
favCount();

/* ---------- paper bot demo-account widget (reads the bot's public state.json; live prices add unrealized PnL) ---------- */
const DEMO = { st: null, at: 0, sparkAt: 0 };
const DEMO_URLS = ['https://raw.githubusercontent.com/petraballas/paper-trades/data/state.json', 'https://petraballas.github.io/paper-trades/state.json'];
async function loadDemo() {
  const res = await Promise.allSettled(DEMO_URLS.map(u => getJSON(u + '?t=' + Date.now(), 10000)));
  const ok = res.filter(r => r.status === 'fulfilled' && r.value && isFinite(r.value.balance)).map(r => r.value).sort((a, b) => (b.lastRun || 0) - (a.lastRun || 0));
  if (ok.length && (!DEMO.st || (ok[0].lastRun || 0) >= (DEMO.st.lastRun || 0))) { DEMO.st = ok[0]; DEMO.at = Date.now(); DEMO.sparkAt = 0; }
  renderDemo();
}
const usd = v => (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdS = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
function demoCalc() {
  const s = DEMO.st, start = (s.rules && s.rules.START) || 1000; let u = 0, live = false, open = 0;
  for (const p of s.positions || []) { if (p.status !== 'open' || !p.qty) continue; open++; let px = p.last ?? p.fill; const c = typeof coinOf === 'function' ? coinOf(p.base) : null;
    if (c && c.last && px && Math.abs(c.last / px - 1) < 0.2) { px = c.last; live = true; } // guard against 1000x symbol mismatch
    u += (p.dir === 'long' ? px - p.fill : p.fill - px) * p.qty; }
  const eq = s.balance + u, mid = new Date().setHours(0, 0, 0, 0), ser = s.equity || [];
  const before = ser.filter(x => x.t < mid).pop(); const base = before ? before.e : (s.created >= mid ? start : (ser[0] ? ser[0].e : start));
  return { eq, start, chg: eq - start, pc: (eq / start - 1) * 100, today: eq - base, open, pend: (s.pending || []).length, live, ser: ser.map(x => x.e).concat(eq) };
}
function renderDemo() {
  const set = (id, html, c) => { const el = $(id); if (!el) return; el.innerHTML = html; if (c !== undefined) el.className = c; };
  if (!DEMO.st) { set('#dChg', 'нет данных', 'sub mut'); set('#mdSub', 'нет данных'); return; }
  const d = demoCalc(), stale = Date.now() - (DEMO.st.lastRun || 0) > 15 * 6e4;
  const dot = d.live && !stale ? 'ddot on' : stale ? 'ddot stale' : 'ddot';
  const runAgo = DEMO.st.lastRun ? ago(DEMO.st.lastRun) : '';
  const tip = `Бот обновлял ${runAgo}${d.live ? ' · нереализованный PnL по live-ценам' : ''}`;
  ['#dDot', '#mdDot'].forEach(i => { const el = $(i); if (el) { el.className = dot; el.title = tip; } });
  set('#dEq', usd(d.eq)); set('#mdEq', usd(d.eq));
  set('#dChg', `${usdS(d.chg)} (${pct(d.pc)}) <span class="mut">с $${d.start}</span>`, 'sub ' + cls(d.chg));
  const pos = `${d.open} поз.${d.pend ? ' · ' + d.pend + ' ждут' : ''}`;
  set('#dToday', `сегодня <span class="${cls(d.today)}">${usdS(d.today)}</span> · ${pos}`, 'sub mut');
  set('#mdChg', `${pct(d.pc)} · ${usdS(d.chg)}`); const mc = $('#mdChg'); if (mc) mc.className = cls(d.chg);
  set('#mdSub', `сегодня <span class="${cls(d.today)}">${usdS(d.today)}</span> · ${pos}`);
  const w = $('#demoW'); if (w) w.title = 'Открыть демо-счёт бота · ' + tip;
  if (Date.now() - DEMO.sparkAt > 5000 && d.ser.length > 1) { DEMO.sparkAt = Date.now(); drawSpark($('#dSpark'), d.ser); }
}
loadDemo(); setInterval(() => { if (!document.hidden) loadDemo(); }, 45e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - DEMO.at > 3e4) loadDemo(); });

/* ---------- boot ---------- */
wire(); syncFilterUI(); calc();
refreshMarket().then(refreshSignals);
// REST price polling: every 60s normally, every 8s whenever the live stream is not healthy
setInterval(() => { if (document.hidden) return; const age = Date.now() - (S.lastMarket || 0); if (age > CFG.REFRESH_MARKET || (!liveOk() && age > 8e3)) refreshMarket(); }, 4e3);
setInterval(() => { if (!document.hidden && S.coins.length && !liveOk() && Date.now() - LIVE.started > 15e3) startLive(); setLivePill(); }, 5e3);
setInterval(() => { if (!document.hidden) refreshSignals(); }, CFG.REFRESH_SIGNALS);
setInterval(() => { if (S.lastScan) $('#upd').textContent = 'Обновлено ' + timeStr(S.lastScan) + ' · авто каждые 3 мин'; }, 30e3);
