'use strict';
/* ===== Signals core: indicators + signal engine. Shared by the signals board (browser) and the paper-trading bot (Node). ===== */
function fmtP(p) { if (p == null || !isFinite(p)) return '—'; const a = Math.abs(p); const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a >= 0.001 ? 6 : 8; return p.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
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
/* ---------- SMC / liquidity (separate detector: NOT used by detect(), so callers opt in explicitly) ----------
   Trigger: liquidity sweep of a swing low/high (wick through, close back inside) on a volume spike.
   Entry: unmitigated Fair Value Gap (3-candle imbalance) between the sweep and price, else the close.
   SL beyond the sweep wick. TP1 = nearest opposite liquidity/FVG, TP2 = next liquidity pool. After TP1 → stop to breakeven. */
function swingPts(b, from, to, k = 3) {
  const hi = [], lo = [];
  for (let i = Math.max(k, from); i <= Math.min(b.length - 1 - k, to); i++) {
    let h = true, l = true;
    for (let j = 1; j <= k; j++) { if (b[i].h < b[i - j].h || b[i].h <= b[i + j].h) h = false; if (b[i].l > b[i - j].l || b[i].l >= b[i + j].l) l = false; }
    if (h) hi.push({ i, p: b[i].h }); if (l) lo.push({ i, p: b[i].l });
  }
  return { hi, lo };
}
function fvgs(b, from, to) { // bull: gap between b[k-2].h and b[k].l ; bear: between b[k].h and b[k-2].l
  const out = [];
  for (let k = Math.max(2, from); k <= to; k++) {
    if (b[k].l > b[k - 2].h) out.push({ dir: 'bull', lo: b[k - 2].h, hi: b[k].l, i: k, t: b[k - 2].t });
    if (b[k].h < b[k - 2].l) out.push({ dir: 'bear', lo: b[k].h, hi: b[k - 2].l, i: k, t: b[k - 2].t });
  }
  return out;
}
function poolsOf(pts, a, isHigh, tol = 0.2) { // cluster equal highs/lows → liquidity pools
  const s = pts.slice().sort((x, y) => x.p - y.p), cl = [];
  for (const q of s) { const l = cl[cl.length - 1]; if (l && q.p - l.max <= tol * a) { l.max = q.p; l.sum += q.p; l.n++; l.last = Math.max(l.last, q.i); } else cl.push({ min: q.p, max: q.p, sum: q.p, n: 1, last: q.i }); }
  return cl.map(c => ({ p: isHigh ? c.max : c.min, lo: c.min, hi: c.max, n: c.n, i: c.last }));
}
function detectSMC(an, tf, coin, htfTrend) {
  const { closed: b, r, A, vp, lv, n } = an; const out = [];
  if (!b || b.length < 120) return out;
  const W = 150, st = n - W;
  for (let i = n; i >= n - 4; i--) { // i = sweep bar (up to 4 bars back, so the displacement + FVG can form after it)
    const x = b[i], a = A[i]; if (!a) continue;
    const vavg = b.slice(i - 20, i).reduce((s, y) => s + y.v, 0) / 20, vr = Math.max(x.v, i < n ? b[i + 1].v : 0) / (vavg || 1);
    if (vr < 1.3) continue; // volume spike confirmation
    const range = x.h - x.l || 1e-12, sw = swingPts(b, st, i - 3);
    for (const L of [true, false]) {
      // swept swing: price wicked through it on bar i and closed back inside; it was intact before bar i
      const cand = (L ? sw.lo : sw.hi).filter(q => q.i >= i - 80 && (L ? x.l < q.p && x.c > q.p : x.h > q.p && x.c < q.p));
      const intact = q => { for (let j = q.i + 1; j < i; j++) if (L ? b[j].l < q.p : b[j].h > q.p) return false; return true; };
      const swept = cand.filter(intact); if (!swept.length) continue;
      const wick = L ? (Math.min(x.o, x.c) - x.l) / range : (x.h - Math.max(x.o, x.c)) / range;
      if (wick < 0.3) continue;
      // the liquidity that was taken: deepest swept level + how many equal lows/highs sat there
      const lvl = L ? Math.min(...swept.map(q => q.p)) : Math.max(...swept.map(q => q.p));
      const eq = (L ? sw.lo : sw.hi).filter(q => Math.abs(q.p - lvl) <= 0.2 * a).length;
      // FVG entry zone: unmitigated, same direction, between the sweep extreme and the close
      // FVG left by the displacement after the sweep (k-2 >= sweep bar - 1), still unmitigated up to the last closed bar
      const unmit = g => { for (let j = g.i + 1; j <= n; j++) if (L ? b[j].l <= g.lo : b[j].h >= g.hi) return false; return true; };
      const fvg = fvgs(b, i + 1, n).filter(g => g.dir === (L ? 'bull' : 'bear') && unmit(g) && (L ? g.lo > x.l : g.hi < x.h) && g.hi - g.lo >= 0.05 * a)
        .sort((p, q) => L ? q.hi - p.hi : p.lo - q.lo)[0] || null;
      if (!fvg && i < n - 1) continue; // older sweep only counts with a fresh FVG to enter from
      let entry = x.c, limit = false;
      if (fvg) { const mid = (fvg.lo + fvg.hi) / 2; if (Math.abs(b[n].c - mid) <= 1.5 * a) { entry = mid; limit = true; } else if (i < n - 1) continue; }
      let sl = L ? x.l - 0.2 * a : x.h + 0.2 * a, risk = L ? entry - sl : sl - entry;
      if (risk < 0.4 * a) { risk = 0.4 * a; sl = L ? entry - risk : entry + risk; }
      if (risk > 3.5 * a) continue;
      // targets: opposite liquidity pools (equal highs/lows first) and opposite FVGs
      const opp = poolsOf(L ? sw.hi : sw.lo, a, L).filter(pl => L ? pl.p > entry + risk : pl.p < entry - risk).sort((p, q) => L ? p.p - q.p : q.p - p.p);
      const oppF = fvgs(b, st, n).filter(g => g.dir === (L ? 'bear' : 'bull') && (L ? g.lo > entry + risk : g.hi < entry - risk) && unmit(g)).map(g => ({ p: L ? g.lo : g.hi, n: 0, fvg: g }));
      const tgts = opp.concat(oppF).sort((p, q) => L ? p.p - q.p : q.p - p.p);
      let tp1 = tgts[0] ? tgts[0].p : (L ? entry + 1.5 * risk : entry - 1.5 * risk);
      if (Math.abs(tp1 - entry) / risk > 4) tp1 = L ? entry + 1.5 * risk : entry - 1.5 * risk;
      const pool2 = opp.filter(pl => L ? pl.p > tp1 + 0.3 * a : pl.p < tp1 - 0.3 * a).sort((p, q) => (q.n - p.n) || (L ? p.p - q.p : q.p - p.p))[0];
      let tp2 = pool2 && Math.abs(pool2.p - entry) / risk <= 6 ? pool2.p : (L ? entry + Math.max(2.5 * risk, Math.abs(tp1 - entry) * 1.6) : entry - Math.max(2.5 * risk, Math.abs(tp1 - entry) * 1.6));
      if (Math.abs(tp2 - entry) / risk < 2) tp2 = L ? entry + 2 * risk : entry - 2 * risk;
      // still valid? no SL / TP1 after the signal bar
      let dead = false; for (const y of an.bars.slice(i + 1)) if (L ? (y.l <= sl || y.h >= tp1) : (y.h >= sl || y.l <= tp1)) { dead = true; break; }
      if (dead) continue;
      const zone = (lv || []).filter(l => l.n >= 2 && Math.abs(l.p - lvl) <= 0.6 * a)[0];
      let sc = 1, tags = ['SMC'];
      if (vr >= 1.8) { sc += 1; tags.push('объём ×' + vr.toFixed(1)); } else { sc += 0.5; tags.push('объём ×' + vr.toFixed(1)); }
      if (eq >= 2) { sc += 1; tags.push(`равные ${L ? 'минимумы' : 'максимумы'} ×${eq}`); }
      if (fvg) { sc += 0.5; tags.push('FVG'); }
      if (zone) { sc += 0.5; tags.push('зона S/R'); }
      const dirN = L ? 1 : -1; if (htfTrend === dirN) { sc += 1; tags.push('тренд ст. ТФ ✓'); } else if (htfTrend === -dirN) { sc -= 0.5; tags.push('против ст. ТФ'); }
      if (vp && (L ? Math.abs(lvl - vp.val) < a : Math.abs(lvl - vp.vah) < a)) { sc += 0.5; tags.push(L ? 'у VAL' : 'у VAH'); }
      if (r[i] != null && ((L && r[i] > 72) || (!L && r[i] < 28))) { sc -= 1; tags.push('RSI перегрет'); }
      const rr = Math.abs(tp2 - entry) / risk; if (rr >= 3) sc += 0.5;
      if (Math.round(sc) < 2) continue;
      tags.push('после TP1 — стоп в б/у');
      const t2why = pool2 ? `ликвидность ${L ? 'над' : 'под'} ${fmtP(tp2)}` : `${fmtP(tp2)}`;
      const why = `Снятие ликвидности ${L ? 'под' : 'над'} ${fmtP(lvl)}${eq >= 2 ? ` (равные ${L ? 'лои' : 'хаи'} ×${eq})` : ''} + возврат` +
        (fvg ? `, FVG ${fmtP(fvg.lo)}–${fmtP(fvg.hi)}${limit ? ' (вход лимиткой в середину)' : ''}` : '') + `, цель — ${t2why}`;
      out.push({ key: coin.base + tf + 'smc' + (L ? 'long' : 'short'), coin, tf, type: 'smc', dir: L ? 'long' : 'short', entry, sl, tp1, tp2, lvl, rr, rr1: Math.abs(tp1 - entry) / risk,
        strength: Math.max(1, Math.min(5, Math.round(sc))), t: x.t + tfMs(tf), barIdx: i, fresh: i >= n - 1 || limit, rsi: r[i], vr, atr: a, vp, why, tags,
        smc: { sweep: lvl, sweepIdx: i, eq, fvg: fvg ? { lo: fvg.lo, hi: fvg.hi, t: fvg.t } : null, sweepT: x.t, limit, be: true,
          pools: opp.slice(0, 4).map(pl => ({ p: pl.p, n: pl.n })), tgtFvg: (tgts[0] && tgts[0].fvg) ? { lo: tgts[0].fvg.lo, hi: tgts[0].fvg.hi, t: tgts[0].fvg.t } : null } });
    }
    if (out.length) break;
  }
  return out.sort((p, q) => q.strength - p.strength || q.rr - p.rr);
}


if (typeof module !== 'undefined' && module.exports) module.exports = { fmtP, ema, rsi, atr, vwapRolling, volProfile, levels, trendOf, analyze, detect, detectSMC, swingPts, fvgs, tfMs, VWAPN, HTF };
