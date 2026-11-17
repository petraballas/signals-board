'use strict';
/* Statistics from recorded outcomes only: paper-bot state.json and on-device favorites.
   A missing result stays unresolved. Nothing is inferred from price. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StatsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const WIN = { TP2: 1, 'TP1+BE': 1 };
  const LOSS = { SL: 1, LIQ: 1 };
  const FLAT = { BE: 1 };
  const SRC_DEMO = 'Демо-счёт';
  const SRC_FAV = 'Избранное';
  const SRC_BOARD = 'Доска';

  function arr(v) { return Array.isArray(v) ? v : []; }
  function blank() { return { n: 0, win: 0, loss: 0, flat: 0, mixed: 0, open: 0, notTriggered: 0, unresolved: 0 }; }
  function add(c, outcome) { c.n++; if (blank()[outcome] !== undefined && outcome !== 'n') c[outcome]++; else c.unresolved++; }
  function count(items) { const c = blank(); for (const it of items) add(c, it.outcome); return c; }
  function rate(c) { const d = c.win + c.loss; return d ? c.win / d : null; }
  function row(source, p, outcome, detail) {
    return {
      source, base: (p && p.base) || '—', dir: (p && p.dir) || '', type: (p && p.type) || '', tf: (p && p.tf) || '',
      outcome, detail: detail || '', tp1Hit: !!(p && p.tp1Hit),
    };
  }
  function fromResult(result) {
    if (WIN[result]) return 'win';
    if (LOSS[result]) return 'loss';
    if (FLAT[result]) return 'flat';
    return 'unresolved';
  }
  function fromPaper(state) {
    const out = [];
    if (!state || typeof state !== 'object') return out;
    for (const p of arr(state.closed)) {
      const result = p && p.result;
      out.push(row(SRC_DEMO, p, fromResult(result), result || 'нет метки'));
    }
    for (const p of arr(state.positions)) {
      const st = p && p.status;
      if (!st || st === 'open') out.push(row(SRC_DEMO, p, 'open', p && p.tp1Hit ? 'открыта · TP1 взят' : 'открыта'));
      else if (st === 'closed') out.push(row(SRC_DEMO, p, fromResult(p.result), p.result || 'нет метки'));
      else out.push(row(SRC_DEMO, p, 'unresolved', String(st)));
    }
    for (const p of arr(state.pending)) out.push(row(SRC_DEMO, p, 'unresolved', 'ждёт вход'));
    for (const p of arr(state.cancelled)) out.push(row(SRC_DEMO, p, 'unresolved', 'не исполнен'));
    return out;
  }
  function fromFav(items) {
    return arr(items).map(f => {
      const st = f && f.status;
      if (st === 'tp2') return row(SRC_FAV, f, 'win', 'TP2');
      if (st === 'stop') return row(SRC_FAV, f, 'loss', 'стоп');
      if (st === 'tp1stop') return row(SRC_FAV, f, 'mixed', 'TP1, потом стоп');
      if (st === 'tp1') return row(SRC_FAV, Object.assign({}, f, { tp1Hit: true }), 'open', 'открыта · TP1 взят');
      if (st === 'active') return row(SRC_FAV, f, 'open', 'открыта');
      return row(SRC_FAV, f, 'unresolved', st ? String(st) : 'нет статуса');
    });
  }
  function fromJournal(items) {
    const known = { win: 1, loss: 1, open: 1, notTriggered: 1, flat: 1, mixed: 1, unresolved: 1 };
    return arr(items).map(s => {
      const outcome = s && known[s.outcome] ? s.outcome : 'unresolved';
      return row(SRC_BOARD, s, outcome, (s && (s.result || s.detail)) || (outcome === 'unresolved' ? 'нет свечей' : ''));
    });
  }
  function orderedSources(all, flags) {
  const g = group(all, i => i.source);
  const keys = [];
  if (flags.demo) keys.push(SRC_DEMO);
  keys.push(SRC_FAV);
  if (flags.board) keys.push(SRC_BOARD);
  return keys.map(key => g.find(r => r.key === key) || Object.assign({ key, winrate: null }, blank()));
}
function group(items, keyFn) {
    const map = new Map();
    for (const it of items) {
      const key = keyFn(it);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    }
    return Array.from(map.entries()).map(([key, list]) => {
      const c = count(list);
      return Object.assign({ key }, c, { winrate: rate(c) });
    }).sort((a, b) => (b.win + b.loss) - (a.win + a.loss) || b.n - a.n || String(a.key).localeCompare(String(b.key)));
  }
  function pickPaper(states) {
    const ok = arr(states).filter(s => s && typeof s === 'object' && isFinite(s.balance));
    ok.sort((a, b) => (b.lastRun || 0) - (a.lastRun || 0));
    return ok[0] || null;
  }
  function summarize(input) {
    const src = input || {};
    const paper = src.paper || null;
    const tracked = (paper ? fromPaper(paper) : []).concat(fromFav(src.favs));
    const boardKnown = src.journal != null;
    const board = boardKnown ? fromJournal(src.journal) : [];
    const all = tracked.concat(board);
    const counts = count(all);
    return {
      counts,
      winrate: rate(counts),
      openTp1: all.filter(i => i.outcome === 'open' && i.tp1Hit).length,
      waiting: all.filter(i => i.detail === 'waiting' || i.result === 'waiting').length,
      bySource: orderedSources(all, { demo: !!paper, board: boardKnown }),
      byDir: group(all, i => i.dir),
      byType: group(all, i => i.type),
      byCoin: group(all, i => i.base && i.base !== '—' ? i.base : ''),
      paperMissing: !paper,
      boardKnown,
      exchange: paper && paper.source ? String(paper.source) : '',
      paperAt: paper && paper.lastRun || null,
      seenSignals: paper && Array.isArray(paper.lastSignals) ? paper.lastSignals.length : null,
    };
  }

  return { summarize, pickPaper, count, fromPaper, fromFav, fromJournal, SRC_DEMO, SRC_FAV, SRC_BOARD };
});

(function () {
  if (typeof document === 'undefined') return;
  const C = globalThis.StatsCore;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const URLS = ['https://raw.githubusercontent.com/petraballas/paper-trades/data/state.json', 'https://petraballas.github.io/paper-trades/state.json'];
  const DIR = { long: 'Лонг', short: 'Шорт' };
  const TYPE = { breakout: 'Пробой', bounce: 'Отскок', pullback: 'Откат', smc: 'SMC' };
  let paper = null, paperMissing = true, paperErr = '', active = false, timer = null, busy = false;

  function num(v) { return v == null ? '—' : String(v); }
  function pct(r) { return r == null ? '—' : (r * 100).toFixed(1).replace('.', ',') + '%'; }
  async function getJSON(url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10000);
    try {
      const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function loadPaper() {
    const res = await Promise.allSettled(URLS.map(u => getJSON(u + '?t=' + Date.now())));
    const ok = res.filter(r => r.status === 'fulfilled').map(r => r.value);
    const picked = C.pickPaper(ok);
    if (picked) { paper = picked; paperMissing = false; paperErr = ''; }
    else { paperMissing = paper == null; paperErr = 'Демо-счёт не загрузился — его сделки в расчёт не входят.'; }
  }
  function favs() {
    try { if (window.SBStats && window.SBStats.favs) return window.SBStats.favs() || []; } catch (e) {}
    try { const a = JSON.parse(localStorage.getItem('sb_fav_v1') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function journal() {
    try { if (window.Journal && window.Journal.items) return window.Journal.items(); } catch (e) {}
    return null;
  }
  function snapshot() {
    return C.summarize({ paper: paperMissing ? null : paper, favs: favs(), journal: journal() });
  }
  function card(label, value, cls) {
    return '<div class="st-num glass"><span>' + esc(label) + '</span><b class="' + (cls || '') + '">' + esc(value) + '</b></div>';
  }
  function table(title, rows, labelOf) {
    if (!rows.length) return '';
    const body = rows.slice(0, 12).map(r => '<tr><td>' + esc(labelOf(r.key)) + '</td><td class="up">' + num(r.win) + '</td><td class="down">' + num(r.loss) + '</td><td>' + num(r.open) + '</td><td class="mut">' + num(r.notTriggered) + '</td><td>' + pct(r.winrate) + '</td></tr>').join('');
    return '<section class="st-block glass"><h3>' + esc(title) + '</h3><table class="st"><thead><tr><th></th><th>Плюс</th><th>Минус</th><th>Открыто</th><th>Не вход</th><th>Винрейт</th></tr></thead><tbody>' + body + '</tbody></table></section>';
  }
  function render() {
    const live = $('stLive'), upd = $('stUpd'), nums = $('stNums'), note = $('stNote'), grid = $('stGrid');
    if (!nums) return;
    const s = snapshot();
    const c = s.counts;
    if (busy) { live.className = 'pill live'; live.textContent = '○ обновление…'; }
    else if (paperErr && paperMissing) { live.className = 'pill live'; live.textContent = '○ нет демо-счёта'; }
    else { live.className = 'pill live on'; live.textContent = '● записанные сделки'; }
    const bits = [];
    let jstat = '';
    try { jstat = window.Journal && window.Journal.status ? window.Journal.status() : ''; } catch (e) {}
    if (jstat) bits.push(jstat);
    if (s.exchange) bits.push('биржа демо-счёта: ' + s.exchange);
    if (s.paperAt) bits.push('прогон ' + new Date(s.paperAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
    if (paperErr) bits.push(paperErr);
    upd.textContent = bits.join(' · ');
    nums.innerHTML = [
      card('Винрейт', pct(s.winrate)),
      card('Плюс', num(c.win), 'up'),
      card('Минус', num(c.loss), 'down'),
      card('Открыто', num(c.open)),
      card('Не вход', num(c.notTriggered), 'mut'),
    ].join('');
    const extra = [];
    extra.push('Винрейт = плюс / (плюс + минус). Плюс на доске — TP1 или TP2 раньше стопа. Одна свеча, где есть и стоп, и тейк, считается стопом, если свечи 5м не показывают другой порядок.');
    extra.push('Журнал доски лежит в этом браузере: у сайта нет фоновой задачи, а state.json демо-счёта хранит только сделки бота. Пока страница открыта, исход берётся из свечей той же биржи. Сигнал, ушедший с доски, в журнале остаётся.');
    if (s.waiting) extra.push('Ещё ждут вход: ' + s.waiting + '.');
    if (s.openTp1) extra.push('Из открытых демо/избранного TP1 уже взят у ' + s.openTp1 + ' — это ещё не закрытый плюс.');
    if (c.flat) extra.push('Безубыток без TP1: ' + c.flat + '.');
    if (c.mixed) extra.push('Смешанные (TP1, потом стоп): ' + c.mixed + '.');
    if (c.unresolved) extra.push('Без однозначного исхода и не в винрейте: ' + c.unresolved + '.');
    if (!s.boardKnown) extra.push('Доска в этом браузере ещё не сканировалась.');
    note.textContent = extra.join(' ');
    const srcLabel = k => k === C.SRC_DEMO ? 'Демо-счёт' : k === C.SRC_FAV ? 'Избранное' : k === C.SRC_BOARD ? 'Доска' : k;
    grid.innerHTML = [
      table('Откуда сделка', s.bySource, srcLabel),
      table('Направление', s.byDir, k => DIR[k] || k),
      table('Сетап', s.byType, k => TYPE[k] || k),
      table('Монета', s.byCoin, k => k),
    ].join('');
  }
  async function refresh(load) {
    if (load === false) { render(); return; }
    if (busy) return;
    busy = true;
    const btn = $('stRefresh'); if (btn) btn.classList.add('spin');
    render();
    try { await loadPaper(); } catch (e) { paperErr = 'Демо-счёт не загрузился — его сделки в расчёт не входят.'; }
    busy = false;
    if (btn) btn.classList.remove('spin');
    render();
  }
  function boot() {
    if (!$('v-stats')) return;
    $('stRefresh').addEventListener('click', () => refresh());
    window.addEventListener('storage', e => { if (e.key === 'sb_fav_v1' && active) render(); });
    window.Stats = {
      setActive(on) {
        active = !!on;
        clearInterval(timer); timer = null;
        if (!on) return;
        refresh();
        timer = setInterval(() => { if (!document.hidden && active) refresh(); }, 60000);
      },
      refresh,
    };
    render();
    if (location.hash === '#stats') {
      const narrow = matchMedia('(max-width:820px)').matches;
      const btn = document.querySelector(narrow ? '.tabbar [data-tab="stats"]' : '[data-dtab="stats"]');
      if (btn) btn.click();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
