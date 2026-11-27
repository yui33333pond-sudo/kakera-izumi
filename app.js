import { supabaseStore, memoryStore } from './store.js';
import { SHELVES, shelfOf, libraryRows, AXES, LABELS, PHASES } from './library.js';
import { renderDiagram } from './diagram.js';
import { seedDemo } from './demo.js';

// ---- 調整つまみ（multilingual-e5-small は、関係ない文どうしでも 0.80 前後になる。近い話は 0.83〜0.9） ----
const SEARCH_MIN = 0.825;  // 探すときに出す近さ（キーワードが入っていれば常に出す）
const SEARCH_BAND = 0.05;  //   いちばん近いものから、これ以上離れたものは出さない
const NEAR_BOX = 0.91;     // 箱どうしを点線でつなぐ近さ（近い3組の平均。同じ会計の話どうしは 0.89 前後になる）
const STICKY_NEAR = 0.84;  // 付箋に近い箱を出す近さ
const MILESTONES = [1, 10, 30, 50, 100, 200, 300, 500, 1000];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dlabel = (iso) => { const d = new Date(iso); return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()); };
const short = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString(); };

// ---- 保存先 ----
const demo = new URLSearchParams(location.search).has('demo');
const cfg = window.KAKERA_CONFIG || {};
let store;
if (demo) store = memoryStore();
else if (cfg.supabaseUrl && cfg.supabaseKey) {
  store = supabaseStore(window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  }));
}

// ---- 意味（端末の中で計算する） ----
const worker = new Worker(new URL('./embed-worker.js', import.meta.url), { type: 'module' });
let modelReady = false, reqId = 0;
const waiting = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { status(`意味のモデルを準備中（初回だけ・この端末に保存）… ${m.total ? Math.round((m.loaded / m.total) * 100) : 0}%`); return; }
  if (m.type === 'ready') { modelReady = true; status(''); return; }
  const w = waiting.get(m.id); if (!w) return;
  waiting.delete(m.id);
  m.error ? w.reject(new Error(m.error)) : w.resolve(m.vectors);
};
const embed = (texts, kind = 'passage') => new Promise((resolve, reject) => {
  const id = ++reqId; waiting.set(id, { resolve, reject });
  worker.postMessage({ id, texts, kind });
});
function status(t) { $('status').textContent = t; }

let toastTimer = 0;
function toast(msg) {
  $('toast').textContent = msg; $('toast').classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('on'), 4000);
}
const fail = (e) => { console.error(e); toast('うまくいかなかった：' + (e.message || e)); };
async function copy(text, okMsg = 'コピーした。Claudeに貼ってね') {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { openModal('コピー用', `<p class="hint">長押しで全部選んでコピーしてね。</p><textarea class="copybox" readonly>${esc(text)}</textarea>`); }
}

// ---- 書庫の場所 ----
let nodes = [], byId = new Map(), byKey = new Map(), kids = new Map();
let secMeta = [], cardMeta = [], stickies = [];
async function loadLibrary() {
  nodes = await store.nodes();
  byId = new Map(nodes.map((n) => [n.id, n])); byKey = new Map(nodes.map((n) => [n.key, n])); kids = new Map();
  for (const n of nodes) { if (!kids.has(n.parent_key)) kids.set(n.parent_key, []); kids.get(n.parent_key).push(n); }
}
async function loadMeta() {
  [secMeta, cardMeta, stickies] = await Promise.all([store.allSections(), store.cardMeta(), store.stickies()]);
}
const childrenOf = (key) => kids.get(key) || [];
const pathOf = (n) => { const out = []; for (let x = n; x; x = byKey.get(x.parent_key)) out.unshift(x); return out; };
const boxes = () => nodes.filter((n) => n.is_box);
// 箱の育ち：納得した数・中身があるか
function boxState(b) {
  const secs = secMeta.filter((s) => s.box_id === b.id);
  const cs = cardMeta.filter((c) => c.box_id === b.id);
  const ok = secs.filter((s) => s.ok_at).length + cs.filter((c) => c.kind === 'row' && c.ok_at).length;
  return { secs, cs, ok, empty: !secs.length && !cs.length };
}
const okTotal = () => secMeta.filter((s) => s.ok_at).length + cardMeta.filter((c) => c.kind === 'row' && c.ok_at).length;

// ---- 形 ----
const SHAPES = {
  square: '<rect x="3" y="3" width="18" height="18" rx="3"/>',
  stack: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="10" width="18" height="5" rx="1.5"/><rect x="3" y="16" width="18" height="5" rx="1.5"/>',
  circle: '<circle cx="12" cy="12" r="9.5"/>',
  book: '<path d="M4 4h7v16H4zM13 4h7v16h-7z"/>',
  triangle: '<path d="M12 3l10 18H2z"/>',
  leaf: '<path d="M4 20C4 9 11 4 21 4c0 10-6 16-17 16z"/>',
};
const shapeSvg = (shape, color, size = 24) => `<svg class="shape" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="fill:${color}">${SHAPES[shape]}</svg>`;

// 箱の小さな図：監基報は地図の4マス、勘定科目は6つの軸（行があるところが色づく）
function miniOf(b, st) {
  if (b.shelf === 'kanki') {
    return `<span class="mini">${PHASES.map(([p]) => {
      const s = st.secs.filter((x) => x.phase === p);
      const cls = !s.length ? '' : s.every((x) => x.ok_at) ? 'ok' : s.some((x) => x.ok_at) ? 'part' : s.some((x) => x.want) ? 'want' : 'has';
      return `<i class="${cls}"></i>`;
    }).join('')}</span>`;
  }
  if (b.shelf === 'kamoku') {
    const rows = cardMeta.filter((c) => c.box_id === b.id && c.kind === 'row');
    return `<span class="mini">${AXES.map(([ax]) => { const r = rows.filter((x) => x.axis === ax); return `<i class="${!r.length ? '' : r.every((x) => x.ok_at) ? 'ok' : r.some((x) => x.ok_at) ? 'part' : 'has'}"></i>`; }).join('')}</span>`;
  }
  return '';
}
function tile(b) {
  const st = boxState(b), sh = shelfOf(b.shelf);
  return `<a class="tile${st.empty ? ' empty' : ''}" href="#/n/${b.id}" style="--c:${sh.color}"><span class="tt">${esc(b.title)}</span>${st.empty ? '' : miniOf(b, st)}${st.ok ? `<span class="okn">納得 ${st.ok}</span>` : ''}</a>`;
}

// ---- 画面の切り替え（#/ … が今いる場所） ----
const route = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/').map(decodeURIComponent);
const hashParam = (k) => new URLSearchParams(location.hash.split('?')[1] || '').get(k);
let renderSeq = 0;
async function render() {
  const [view, a, b] = route();
  const my = ++renderSeq;
  closeModal();
  if (view !== 'q') $('q').value = '';
  try {
    if (!view) await viewHome(my);
    else if (view === 's') await viewNode(shelfOf(a) ? { key: a, shelf: a, title: shelfOf(a).name, is_box: false } : null, my);
    else if (view === 'n') await viewNode(byId.get(a), my, b);
    else if (view === 'q') await viewSearch(a || '', my);
    else if (view === 'prep') await viewPrep(byId.get(a), my);
    else if (view === 'st') await viewSticky(a, my);
    else if (view === 'stickies') await viewStickies(my);
    else if (view === 'izumi') await viewIzumi(my);
    else location.hash = '#/';
  } catch (e) { fail(e); }
  if (!b) window.scrollTo(0, 0);
}
const live = (my) => my === renderSeq;
function crumbs(list) {
  $('crumbs').innerHTML = `<a href="#/" class="home">vitrine</a>` + list.map((x) => `<span class="sep" aria-hidden="true">›</span>${x.href ? `<a href="${x.href}">${esc(x.t)}</a>` : `<b>${esc(x.t)}</b>`}`).join('');
  const last = $('crumbs').lastElementChild; if (last) last.scrollIntoView({ inline: 'end', block: 'nearest' });
}
function shelfCrumb(n) {
  const sh = shelfOf(n.shelf);
  return [{ t: sh.name, href: `#/s/${sh.id}` }, ...pathOf(n).map((x, i, arr) => ({ t: x.title, href: i === arr.length - 1 ? null : `#/n/${x.id}` }))];
}
const paint = (html) => { $('view').innerHTML = html; };

// ---- ダッシュボード ----
async function viewHome(my) {
  await loadMeta();
  const unfiled = await store.unfiledCount().catch(() => 0);
  if (!live(my)) return;
  crumbs([]);
  const ok = okTotal();
  const next = MILESTONES.find((m) => m > ok);
  const month = monthStart();
  const want = secMeta.find((s) => s.want && !s.ok_at);
  const todays = stickies.length ? stickies[stickies.length - 1] : null;   // いちばん前に貼った付箋から
  const recent = boxes().filter((b) => b.opened_at).sort((a, c) => c.opened_at.localeCompare(a.opened_at)).slice(0, 3);
  const tiles = SHELVES.map((sh) => {
    const ids = new Set(boxes().filter((b) => b.shelf === sh.id).map((b) => b.id));
    const okN = secMeta.filter((s) => ids.has(s.box_id) && s.ok_at).length + cardMeta.filter((c) => ids.has(c.box_id) && c.kind === 'row' && c.ok_at).length;
    const plus = cardMeta.filter((c) => ids.has(c.box_id) && c.created_at >= month).length + secMeta.filter((s) => ids.has(s.box_id) && s.ok_at && s.ok_at >= month).length;
    return `<a class="shelf-tile" href="#/s/${sh.id}" style="--c:${sh.color}">${shapeSvg(sh.shape, sh.color, 34)}<span class="sn">${sh.name}</span><span class="sk">${okN ? `納得 ${okN}` : ''}${plus ? `<b>今月 +${plus}</b>` : ''}</span></a>`;
  }).join('');
  let today;
  if (todays) today = `<a class="today sticky-c" href="#/st/${todays.id}"><span class="k">付箋</span><span class="b">${esc(short(todays.body, 60))}</span></a>`;
  else if (want) { const b = byId.get(want.box_id); today = `<a class="today" href="#/n/${want.box_id}/${want.id}"><span class="k">次に埋めたい</span><span class="b">${esc(b ? b.title : '')}　${esc(want.title)}</span></a>`; }
  else today = '<p class="hint">付箋を貼るか、マスを「次に埋めたい」にすると、ここに出てくる。</p>';
  paint(`<section class="hero"><h1 class="logo">vitrine</h1><p class="ms"><b>${ok}</b><span>枚 納得</span>${next ? `<span class="nx">次の節目 ${next}</span>` : ''}</p></section>`
    + `<section><h2>今日の1つ</h2>${today}</section>`
    + `<section><h2>棚</h2><div class="shelves">${tiles}</div></section>`
    + `<section><h2>付箋</h2>${stickyForm()}<div class="stack">${stickies.slice(0, 3).map(stickyCard).join('')}</div>${stickies.length > 3 ? '<a class="more" href="#/stickies">付箋をぜんぶ見る</a>' : ''}</section>`
    + (recent.length ? `<section><h2>最近の箱</h2><div class="tiles">${recent.map(tile).join('')}</div></section>` : '')
    + (unfiled ? `<section><a class="more" href="#/izumi">前の泉のかけらを、箱に納め直す</a></section>` : ''));
}
const stickyForm = () => `<form class="sform" data-form="sticky"><input type="text" name="body" placeholder="付箋を貼る" aria-label="付箋" enterkeyhint="done"><button class="btn">貼る</button></form>`;
const stickyCard = (s) => `<a class="sticky-c" href="#/st/${s.id}"><span class="b">${esc(short(s.body, 80))}</span><span class="d">${dlabel(s.created_at)}${s.hint_box && byId.get(s.hint_box) ? ' · 近い箱：' + esc(byId.get(s.hint_box).title) : ''}</span></a>`;

// ---- 棚と階層：中身を図（タイル）で ----
async function viewNode(n, my, focus) {
  if (!n) { location.hash = '#/'; return; }
  if (n.is_box) return viewBox(n, my, focus);
  await loadMeta();
  if (!live(my)) return;
  const sh = shelfOf(n.shelf);
  const isShelf = n.key === n.shelf;
  crumbs(isShelf ? [{ t: sh.name }] : shelfCrumb(n));
  const group = (g, depth) => {
    const ch = childrenOf(g.key);
    const bx = ch.filter((c) => c.is_box), sub = ch.filter((c) => !c.is_box);
    return `<section class="grp d${depth}"><h${depth + 2}><a href="#/n/${g.id}">${esc(g.title)}</a></h${depth + 2}>`
      + (bx.length ? `<div class="tiles">${bx.map(tile).join('')}</div>` : '')
      + sub.map((s) => group(s, Math.min(depth + 1, 2))).join('') + '</section>';
  };
  const ch = childrenOf(n.key);
  const direct = ch.filter((c) => c.is_box), sub = ch.filter((c) => !c.is_box);
  paint(`<div class="shelf-head" style="--c:${sh.color}">${shapeSvg(sh.shape, sh.color, 30)}<h1>${esc(isShelf ? sh.name : n.title)}</h1></div>`
    + (direct.length ? `<div class="tiles">${direct.map(tile).join('')}</div>` : '')
    + sub.map((g) => group(g, 0)).join('')
    + (!ch.length ? `<p class="hint">${n.shelf === 'nichijo' ? '日常の棚は月ごとに育つ（あとで作る）。' : n.shelf === 'hon' ? '本は1冊＝1箱（あとで作る）。' : 'まだ箱がない。'}</p>` : ''));
}

// ---- 箱 ----
let boxCtx = null;   // 開いている箱の中身
async function viewBox(b, my, focus) {
  store.touchNode(b.id).then(() => { b.opened_at = new Date().toISOString(); }).catch(() => {});
  const [secs, paras, cards, links] = await Promise.all([store.sections(b.id), store.paras(b.id), store.cards(b.id), store.links(b.id), loadMeta()]);
  if (!live(my)) return;
  boxCtx = { b, secs, paras, cards, links, pair: false, fromSticky: hashParam('from') };
  crumbs(shelfCrumb(b));
  drawBox(focus);
  loadNear(b, my);
}
function drawBox(focus) {
  const { b } = boxCtx, sh = shelfOf(b.shelf);
  let body = '';
  if (b.shelf === 'kanki') body = kankiBody();
  else if (b.shelf === 'kamoku') body = kamokuBody();
  paint(`<div class="boxv" style="--c:${sh.color}"><div class="box-head"><h1>${esc(b.title)}</h1><div class="row"><a class="btn ghost small" href="#/prep/${b.id}">予習</a><button class="btn ghost small" data-act="link">つなぐ</button></div></div>`
    + body + notesBlock() + `<section><h2>つながり</h2><div id="links" class="links">${linksHtml([])}</div></section></div>`);
  if (focus) document.getElementById('sec-' + focus)?.scrollIntoView({ block: 'start' });
  if (boxCtx.fromSticky) { const t = document.querySelector('#noteForm textarea'); t?.scrollIntoView({ block: 'center' }); t?.focus(); }
}

// 監基報：上に地図、下に節ごとの図と私語訳（行ごとに「原」で原文が開く）
function kankiBody() {
  const { secs, paras, cards, pair } = boxCtx;
  const pById = new Map(paras.map((p) => [p.id, p]));
  if (!secs.length && !paras.length) return '<p class="hint">原文と私語訳はまだ入っていない。原文のPDFと一緒に、Claude Code で作って取り込む。</p>';
  const hasTr = (s) => cards.some((c) => c.kind === 'trans' && c.section_id === s.id);
  const state = (s) => (s.ok_at ? 'ok' : s.want ? 'want' : hasTr(s) ? 'draft' : 'none');
  const map = `<div class="map">${PHASES.map(([p, label]) => `<div class="phase"><span class="pl">${label}</span>${secs.filter((s) => s.phase === p).map((s) => `<a class="cell c-${state(s)}" href="#/n/${boxCtx.b.id}/${s.id}">${esc(short(s.title, 16))}</a>`).join('') || '<span class="cell c-none blank"></span>'}</div>`).join('')}</div>`
    + `<p class="legend"><i class="c-none"></i>まだ<i class="c-want"></i>次に埋めたい<i class="c-draft"></i>下書き<i class="c-ok"></i>納得</p>`;
  const orig = (p) => `<p class="orig"><span class="pn">${esc(p.label || '')}</span>${esc(p.body)}</p>`;
  const sec = (s) => {
    const lines = cards.filter((c) => c.kind === 'trans' && c.section_id === s.id).sort((a, c) => a.seq - c.seq);
    const own = paras.filter((p) => p.section_id === s.id);
    const st = state(s);
    const head = `<div class="sec-h"><h2>${esc(s.title)}</h2><span class="ph">${(PHASES.find(([p]) => p === s.phase) || [])[1] || ''}</span></div>`
      + `<div class="row">${s.ok_at ? `<span class="okmark">納得 ${dlabel(s.ok_at)}</span><button class="btn ghost small" data-act="unok" data-id="${s.id}">下書きに戻す</button>`
        : `<button class="btn ghost small" data-act="want" data-id="${s.id}" aria-pressed="${!!s.want}">${s.want ? '次に埋めたい ✓' : '次に埋めたい'}</button>${lines.length ? `<button class="btn small" data-act="ok" data-id="${s.id}">納得</button>` : ''}`}</div>`;
    let inner;
    if (!lines.length) {
      inner = `<p class="hint">私語訳はまだ。</p><button class="btn ghost small" data-act="material" data-id="${s.id}">私語訳の材料をコピー</button>`
        + (own.length ? `<details class="orig-all"><summary>原文（${own.length} 段落）</summary>${own.map(orig).join('')}</details>` : '');
    } else {
      inner = (s.diagram ? renderDiagram(s.diagram) : '') + `<div class="lines${pair ? ' pair' : ''}">` + lines.map((c) => {
        const ps = (c.para_ids || []).map((x) => pById.get(x)).filter(Boolean);
        return pair
          ? `<div class="line"><p class="tr">${esc(c.body)}</p><div class="side">${ps.map(orig).join('') || '<p class="hint small">（原文の段落なし）</p>'}</div></div>`
          : `<div class="line"><p class="tr">${esc(c.body)}${ps.length ? ` <button class="gen" data-act="gen" aria-expanded="false" aria-label="原文を開く">原</button>` : ''}</p><div class="side" hidden>${ps.map(orig).join('')}</div></div>`;
      }).join('') + '</div>';
    }
    return `<section class="sec s-${st}" id="sec-${s.id}">${head}${inner}</section>`;
  };
  return map + `<div class="row"><button class="btn ghost small" data-act="pair" aria-pressed="${pair}">${pair ? '私語訳だけにする' : '対で見る'}</button></div>` + secs.map(sec).join('');
}

// 勘定科目：アサーション軸ごとに、色ラベル付きの行
const labHtml = (l) => (LABELS[l] ? `<span class="lab" style="--lc:${LABELS[l][1]}">${LABELS[l][0]}</span>` : '');
function kamokuBody() {
  const rows = boxCtx.cards.filter((c) => c.kind === 'row' && c.box_id === boxCtx.b.id);
  const block = ([ax, name]) => {
    const list = rows.filter((r) => r.axis === ax);
    return `<section class="axis"><h2>${name}</h2>${list.length ? list.map((r) => `<div class="krow${r.ok_at ? ' ok' : ''}"><div class="labs">${(r.labels || []).map(labHtml).join('')}</div><p>${esc(r.body)}</p>`
      + `<div class="rbtn">${r.ok_at ? `<button class="btn ghost small" data-act="rowUnok" data-id="${r.id}">納得 ✓</button>` : `<button class="btn ghost small" data-act="rowOk" data-id="${r.id}">納得</button>`}<button class="btn ghost small" data-act="rowDel" data-id="${r.id}" aria-label="この行を消す">✕</button></div></div>`).join('')
      : '<p class="hint small">まだ行がない。</p>'}</section>`;
  };
  return `<p class="legend">${Object.values(LABELS).map(([n, c]) => `<span class="lab" style="--lc:${c}">${n}</span>`).join('')}</p>`
    + AXES.map(block).join('')
    + `<details class="addrow"><summary>行を足す</summary><form data-form="row"><select name="axis" aria-label="軸">${AXES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>`
    + `<div class="row">${Object.entries(LABELS).map(([k, [n]]) => `<label class="chk"><input type="checkbox" name="labels" value="${k}"> ${n}</label>`).join('')}</div>`
    + `<textarea name="body" placeholder="1〜2行で" aria-label="行の中身"></textarea><button class="btn">足す</button></form></details>`;
}

// 追記：日付つき。ほかの箱にも出すときは、向こうでは「〇〇から」
function notesBlock() {
  const { b, cards, fromSticky } = boxCtx;
  const notes = cards.filter((c) => c.kind === 'note').sort((a, c) => c.created_at.localeCompare(a.created_at));
  const st = fromSticky && stickies.find((s) => s.id === fromSticky);
  return `<section><h2>追記</h2>`
    + `<form id="noteForm" data-form="note">${st ? `<p class="hint small">付箋から。追記したら、付箋ははがす</p>` : ''}<textarea name="body" placeholder="気づいたこと、悩んだこと" aria-label="追記">${st ? esc(st.body) : ''}</textarea>`
    + `<div class="row"><span class="tagged" id="noteTags"></span><button type="button" class="btn ghost small" data-act="noteTag">ほかの箱にも出す</button><button class="btn">追記する</button></div></form>`
    + `<div class="stack">${notes.map((n) => {
      const from = n.box_id !== b.id && byId.get(n.box_id);
      const also = (n.tags || []).filter((t) => t !== b.id).map((t) => byId.get(t)).filter(Boolean);
      return `<div class="note${from ? ' from' : ''}"><span class="d">${dlabel(n.created_at)}${from ? ` · <a href="#/n/${from.id}">${esc(from.title)}</a>から` : ''}${!from && also.length ? ' · ' + also.map((x) => `<a href="#/n/${x.id}">${esc(x.title)}</a>`).join('、') + 'にも' : ''}</span>`
        + `<p>${esc(n.body)}</p><div class="rbtn"><button class="btn ghost small" data-act="noteEdit" data-id="${n.id}">直す</button><button class="btn ghost small" data-act="noteDel" data-id="${n.id}">消す</button></div></div>`;
    }).join('')}</div></section>`;
}
function linksHtml(near) {
  const { b, links } = boxCtx;
  const solid = links.map((l) => ({ id: l.id, other: byId.get(l.a === b.id ? l.b : l.a) })).filter((x) => x.other);
  const solidIds = new Set(solid.map((x) => x.other.id));
  const dotted = near.filter((x) => !solidIds.has(x.box_id) && byId.get(x.box_id)).map((x) => byId.get(x.box_id));
  if (!solid.length && !dotted.length) return '<p class="hint small">まだつながっていない。「つなぐ」で選ぶか、中身が近い箱があると点線でつながる。</p>';
  return solid.map((x) => `<span class="lk solid"><a href="#/n/${x.other.id}">${esc(x.other.title)}</a><button class="x" data-act="unlink" data-id="${x.id}" aria-label="つながりを外す">✕</button></span>`).join('')
    + dotted.map((x) => `<a class="lk dotted" href="#/n/${x.id}">${esc(x.title)}</a>`).join('');
}
async function loadNear(b, my) {
  try {
    const near = (await store.nearBoxes(b.id, 6)).filter((x) => x.sim >= NEAR_BOX);
    if (live(my) && $('links')) $('links').innerHTML = linksHtml(near);
  } catch (e) { console.error(e); }
}

// ---- 予習：前に悩んだこと（追記）→ 図 → 原文 ----
async function viewPrep(b, my) {
  if (!b) { location.hash = '#/'; return; }
  const [secs, paras, cards] = await Promise.all([store.sections(b.id), store.paras(b.id), store.cards(b.id)]);
  if (!live(my)) return;
  crumbs([...shelfCrumb(b).slice(0, -1), { t: b.title, href: `#/n/${b.id}` }, { t: '予習' }]);
  const notes = cards.filter((c) => c.kind === 'note').sort((a, c) => c.created_at.localeCompare(a.created_at));
  const rows = cards.filter((c) => c.kind === 'row' && c.box_id === b.id).sort((a, c) => (c.labels || []).includes('abunai') - (a.labels || []).includes('abunai'));
  const dgs = secs.filter((s) => s.diagram);
  let html = `<h1 class="ptitle">${esc(b.title)}、その前に</h1>`;
  html += `<section><h2>前に悩んだこと</h2>${notes.length ? `<div class="stack">${notes.map((n) => `<div class="note"><span class="d">${dlabel(n.created_at)}</span><p>${esc(n.body)}</p></div>`).join('')}</div>` : '<p class="hint small">追記はまだない。</p>'}</section>`;
  if (dgs.length) html += `<section><h2>図</h2>${dgs.map((s) => `<h3>${esc(s.title)}</h3>${renderDiagram(s.diagram)}`).join('')}</section>`;
  if (rows.length) html += `<section><h2>危ないところから</h2>${rows.map((r) => `<div class="krow${r.ok_at ? ' ok' : ''}"><div class="labs">${(r.labels || []).map(labHtml).join('')}</div><p>${esc(r.body)}</p></div>`).join('')}</section>`;
  if (paras.length) html += `<section><h2>原文</h2><details class="orig-all"><summary>${paras.length} 段落</summary>${paras.map((p) => `<p class="orig"><span class="pn">${esc(p.label || '')}</span>${esc(p.body)}</p>`).join('')}</details></section>`;
  paint(html);
}

// ---- 探す：キーワードが先、意味でも。箱ごとに分けて ----
const SRC = { card: '', para: '原文', sticky: '付箋', kakera: '前の泉' };
let lastHits = [];
async function viewSearch(q, my) {
  crumbs([{ t: '探す' }]);
  if (document.activeElement !== $('q')) $('q').value = q;
  if (!q.trim()) { paint('<p class="hint">言葉で探す。言葉がちがっても、意味が近ければ出てくる。「240やる」のように打つと予習が開く。</p>'); return; }
  const m = q.match(/^(.{1,20}?)\s*(をやる|やる|やります)$/);
  if (m) {
    const w = m[1].trim();
    const hit = boxes().find((b) => b.title.startsWith(w + ' ') || b.title === w || b.title.replace(/^\d+\s*/, '') === w) || boxes().find((b) => b.title.includes(w));
    if (hit) { location.hash = `#/prep/${hit.id}`; return; }
  }
  paint('<p class="hint">探してる…</p>');
  let v = null;
  try { [v] = await embed([q], 'query'); } catch (e) { console.error(e); }
  const raw = await store.search(q, v, 40);
  const top = Math.max(0, ...raw.map((r) => r.sim));
  const rows = raw.filter((r) => r.literal || (r.sim >= SEARCH_MIN && r.sim >= top - SEARCH_BAND));
  if (!live(my)) return;
  lastHits = rows;
  const ql = q.toLowerCase();
  const titleHits = boxes().filter((b) => b.title.toLowerCase().includes(ql)).slice(0, 6);
  const groups = new Map();
  for (const r of rows) { const k = r.box_id || r.src; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const kindName = (r) => (r.src === 'card' ? '' : SRC[r.src]);
  let html = titleHits.length ? `<section><h2>箱</h2><div class="tiles">${titleHits.map(tile).join('')}</div></section>` : '';
  for (const [k, list] of groups) {
    const b = byId.get(k);
    const head = b ? `<a href="#/n/${b.id}">${[shelfOf(b.shelf).name, ...pathOf(b).map((x) => x.title)].map(esc).join(' › ')}</a>` : esc(k === 'sticky' ? '付箋' : '前の泉（まだ納めていない）');
    html += `<section class="hitgrp"><h2>${head}</h2>${list.slice(0, 5).map((r) => {
      const href = r.src === 'sticky' ? `#/st/${r.id}` : b ? `#/n/${b.id}${r.section_id ? '/' + r.section_id : ''}` : '';
      const body = `<span class="d">${kindName(r) ? kindName(r) + ' · ' : ''}${dlabel(r.created_at)}</span><span class="b">${esc(short(r.body, 140))}</span>`;
      return r.src === 'kakera'
        ? `<div class="hit">${body}<button class="btn ghost small" data-act="file" data-id="${r.id}">箱に納める</button></div>`
        : `<a class="hit" href="${href}">${body}</a>`;
    }).join('')}</section>`;
  }
  if (!rows.length && !titleHits.length) {
    html += `<p class="hint">書庫には、まだ答えがないみたい。</p><div class="row"><button class="btn" data-act="toSticky">付箋にする</button><button class="btn ghost" data-act="chew">Claudeと噛み砕く</button></div>`;
  } else html += `<div class="row foot-row"><button class="btn ghost small" data-act="chew">Claudeと噛み砕く文章をコピー</button></div>`;
  paint(html);
}
// 噛み砕く：検索語・近い箱・原文の段落・私語訳の型
function chewPrompt(q) {
  const near = [...new Set(lastHits.filter((r) => r.box_id).map((r) => r.box_id))].slice(0, 3).map((id) => byId.get(id)).filter(Boolean);
  const paras = lastHits.filter((r) => r.src === 'para').slice(0, 4);
  const mine = lastHits.filter((r) => r.src === 'card').slice(0, 4);
  return `「${q}」について、私が納得できるように噛み砕いて。\n\n`
    + (near.length ? `【近い箱】${near.map((b) => b.title).join('／')}\n` : '')
    + (paras.length ? `【原文の段落】\n${paras.map((p) => '・' + p.body).join('\n')}\n` : '')
    + (mine.length ? `【私のメモ】\n${mine.map((p) => '・' + p.body).join('\n')}\n` : '')
    + `\n【私語訳の型】\n・1つの塊は1〜2行。やさしい言葉で、主語をはっきり\n・最後に、図にするなら「内と外／流れ／対比／階層／中心と周り」のどれかと、その中身\n・含む＝緑、含まない＝橙 で分けられるところは分けて`;
}

// ---- 付箋 ----
async function viewSticky(id, my) {
  stickies = await store.stickies();
  const s = stickies.find((x) => x.id === id);
  if (!live(my)) return;
  if (!s) { location.hash = '#/'; return; }
  crumbs([{ t: '付箋', href: '#/stickies' }, { t: dlabel(s.created_at) }]);
  paint(`<div class="sticky-big"><span class="d">${dlabel(s.created_at)}</span><p>${esc(s.body)}</p></div><h2>どの箱に追記する？</h2><div id="stNear" class="tiles"><p class="hint">近い箱を探してる…</p></div>`
    + `<div class="row"><button class="btn ghost" data-act="pick" data-id="${s.id}">箱を探して選ぶ</button><button class="btn ghost" data-act="stDel" data-id="${s.id}">付箋をはがす</button></div>`);
  // 近い箱：貼ったときに見つけたもの（すぐ出す）＋意味で近いもの（あとから足す）
  const cand = [];
  const draw = (done) => {
    const list = [...new Set(cand)].map((x) => byId.get(x)).filter(Boolean).slice(0, 4);
    $('stNear').innerHTML = list.map((b) => `<a class="tile" href="#/n/${b.id}?from=${s.id}" style="--c:${shelfOf(b.shelf).color}"><span class="tt">${esc(b.title)}</span><span class="okn">ここに書く</span></a>`).join('')
      + (done ? (list.length ? '' : '<p class="hint">近い箱は見つからなかった。「箱を探して選ぶ」から選んでね。</p>') : '<p class="hint small">意味でも探してる…</p>');
  };
  if (s.hint_box) cand.push(s.hint_box);
  draw(false);
  try {
    const [v] = await embed([s.body], 'query');
    for (const r of await store.search(s.body, v, 20)) if (r.box_id && r.src !== 'sticky' && (r.literal || r.sim >= STICKY_NEAR)) cand.push(r.box_id);
  } catch (e) { console.error(e); }
  if (!live(my) || !$('stNear')) return;
  draw(true);
}
async function viewStickies(my) {
  stickies = await store.stickies();
  if (!live(my)) return;
  crumbs([{ t: '付箋' }]);
  paint(`<h1 class="ptitle">付箋</h1>${stickyForm()}<div class="stack">${stickies.map(stickyCard).join('') || '<p class="hint">付箋はない。</p>'}</div>`);
}

// ---- 前の泉のかけら：箱に納め直す（日付はそのまま、追記として入る） ----
let izumiRows = [];
async function viewIzumi(my, more = false) {
  crumbs([{ t: '前の泉' }]);
  const part = await store.unfiled(30, more && izumiRows.length ? izumiRows[izumiRows.length - 1].created_at : null);
  if (!live(my)) return;
  izumiRows = more ? [...izumiRows, ...part] : part;
  paint(`<h1 class="ptitle">前の泉のかけら</h1><p class="hint">「箱に納める」で、その箱の追記になる（日付はそのまま）。納めたものはここから消える。探す欄からも出てくる。</p>`
    + `<div class="stack">${izumiRows.map((k) => `<div class="hit"><span class="d">${dlabel(k.created_at)}${k.source && k.source !== 'hand' ? ' · ' + esc(k.source) : ''}</span><span class="b">${esc(short(k.body, 160))}</span><button class="btn ghost small" data-act="file" data-id="${k.id}">箱に納める</button></div>`).join('') || '<p class="hint">ぜんぶ納めた。</p>'}</div>`
    + (part.length === 30 ? '<button class="btn ghost" data-act="izumiMore">もっと前</button>' : ''));
}
async function fileKakera(kid, box) {
  const k = await store.kakera(kid);
  if (!k) return;
  const sibs = k.group_id ? await store.siblings(k.group_id) : [k];
  const list = sibs.length ? sibs : [k];
  await store.addCard({ box_id: box.id, kind: 'note', body: list.map((x) => x.body).join('\n\n'), created_at: k.created_at });
  await store.fileKakera(list.map((x) => x.id));
  izumiRows = izumiRows.filter((x) => x.id !== kid);
  toast(`「${box.title}」に納めた`);
  if (route()[0] === 'izumi') viewIzumiRedraw(); else render();
  backfill();
}
function viewIzumiRedraw() {
  const box = document.querySelector('#view .stack');
  if (box) box.innerHTML = izumiRows.map((k) => `<div class="hit"><span class="d">${dlabel(k.created_at)}</span><span class="b">${esc(short(k.body, 160))}</span><button class="btn ghost small" data-act="file" data-id="${k.id}">箱に納める</button></div>`).join('') || '<p class="hint">ぜんぶ納めた。</p>';
}

// ---- 箱を選ぶ（つなぐ・付箋・納める・ほかの箱にも出す） ----
let pickCb = null;
function openPicker(title, cb) {
  openModal(title, `<input type="search" id="pickQ" placeholder="箱の名前で探す（例：240、現金）" aria-label="箱を探す"><div id="pickList" class="picklist"></div>`);
  pickCb = cb;
  drawPick(''); setTimeout(() => $('pickQ')?.focus(), 30);
}
function drawPick(q) {
  const ql = q.trim().toLowerCase();
  const list = (ql ? boxes().filter((b) => b.title.toLowerCase().includes(ql) || pathOf(b).some((x) => x.title.toLowerCase().includes(ql)))
    : boxes().filter((b) => b.opened_at).sort((a, c) => c.opened_at.localeCompare(a.opened_at))).slice(0, 20);
  $('pickList').innerHTML = list.map((b) => `<button class="pick" data-act="picked" data-id="${b.id}"><span class="d">${[shelfOf(b.shelf).name, ...pathOf(b).slice(0, -1).map((x) => x.title)].map(esc).join(' › ')}</span>${esc(b.title)}</button>`).join('')
    || `<p class="hint">${ql ? '見つからなかった。' : '名前を入れて探してね。'}</p>`;
}
function openModal(title, html) {
  $('modal').innerHTML = `<div class="mpanel" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="mbar"><b>${esc(title)}</b><button class="btn ghost small" data-act="mclose">閉じる ✕</button></div>${html}</div>`;
  $('modal').hidden = false;
}
function closeModal() { $('modal').hidden = true; $('modal').innerHTML = ''; pickCb = null; }

// ---- 意味の計算待ちを、裏で少しずつ ----
let filling = false;
async function backfill() {
  if (filling) return;
  filling = true;
  let done = 0;
  try {
    const seen = new Set();
    for (;;) {
      const rows = (await store.pending(24)).filter((r) => !seen.has(r.t + r.id));
      if (!rows.length) break;
      rows.forEach((r) => seen.add(r.t + r.id));
      if (modelReady) status(`意味を計算中…（${done} 件済み）`);
      const vecs = await embed(rows.map((r) => r.body.slice(0, 2000)));
      for (let i = 0; i < rows.length; i++) await store.setEmbedding(rows[i].t, rows[i].id, vecs[i]);
      done += rows.length;
    }
  } catch (e) { console.error(e); }
  finally { filling = false; if (modelReady) status(''); }
}

// ---- 操作 ----
let noteTags = [], qTimer = 0;
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  const fd = new FormData(f);
  const body = String(fd.get('body') || '').trim();
  if (!body) return;
  try {
    if (f.dataset.form === 'sticky') {
      await store.addSticky(body); f.reset(); toast('付箋を貼った'); render(); backfill();
    } else if (f.dataset.form === 'note') {
      const editing = f.dataset.edit;
      if (editing) await store.patchCard(editing, { body, tags: noteTags, embedding: null });
      else await store.addCard({ box_id: boxCtx.b.id, kind: 'note', body, tags: noteTags });
      noteTags = [];
      if (boxCtx.fromSticky) { await store.removeSticky(boxCtx.fromSticky); toast('追記した。付箋ははがした'); location.hash = `#/n/${boxCtx.b.id}`; }
      else { toast(editing ? '直した' : '追記した'); render(); }
      backfill();
    } else if (f.dataset.form === 'row') {
      const seq = boxCtx.cards.filter((c) => c.kind === 'row').length;
      await store.addCard({ box_id: boxCtx.b.id, kind: 'row', axis: fd.get('axis'), labels: fd.getAll('labels'), body, seq });
      render(); backfill();
    }
  } catch (err) { fail(err); }
});

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]'); if (!act) return;
  const d = act.dataset;
  try {
    switch (d.act) {
      case 'mclose': closeModal(); return;
      case 'picked': { const cb = pickCb; closeModal(); if (cb) await cb(byId.get(d.id)); return; }
      case 'gen': { const side = act.closest('.line').querySelector('.side'); side.hidden = !side.hidden; act.setAttribute('aria-expanded', String(!side.hidden)); act.classList.toggle('on', !side.hidden); return; }
      case 'pair': boxCtx.pair = !boxCtx.pair; drawBox(); return;
      case 'want': { const s = boxCtx.secs.find((x) => x.id === d.id); s.want = !s.want; await store.patchSection(s.id, { want: s.want }); await loadMeta(); drawBox(); return; }
      case 'ok': case 'unok': {
        const s = boxCtx.secs.find((x) => x.id === d.id); const before = okTotal();
        s.ok_at = d.act === 'ok' ? new Date().toISOString() : null; if (s.ok_at) s.want = false;
        await store.patchSection(s.id, { ok_at: s.ok_at, want: s.want }); await loadMeta(); drawBox();
        if (s.ok_at) milestone(before); return;
      }
      case 'rowOk': case 'rowUnok': {
        const before = okTotal(); const at = d.act === 'rowOk' ? new Date().toISOString() : null;
        await store.patchCard(d.id, { ok_at: at }); boxCtx.cards.find((c) => c.id === d.id).ok_at = at; await loadMeta(); drawBox();
        if (at) milestone(before); return;
      }
      case 'rowDel':
        if (d.sure) { await store.removeCard(d.id); boxCtx.cards = boxCtx.cards.filter((c) => c.id !== d.id); await loadMeta(); drawBox(); }
        else { d.sure = '1'; act.textContent = '消す？'; }
        return;
      case 'material': {
        const s = boxCtx.secs.find((x) => x.id === d.id);
        const own = boxCtx.paras.filter((p) => p.section_id === s.id);
        copy(`${boxCtx.b.title}「${s.title}」の私語訳を作って。\n\n【原文】\n${own.map((p) => `${p.label ? '(' + p.label + ') ' : ''}${p.body}`).join('\n')}\n\n【型】1つの塊は1〜2行。行ごとに、元にした段落番号を書く。最後に図（内と外／流れ／対比／階層／中心と周り）を1つ。`);
        return;
      }
      case 'noteTag': openPicker('ほかの箱にも出す', (b) => { if (b && !noteTags.includes(b.id) && b.id !== boxCtx.b.id) noteTags.push(b.id); $('noteTags').textContent = noteTags.map((x) => byId.get(x).title).join('、') + (noteTags.length ? 'にも' : ''); }); return;
      case 'noteEdit': {
        const n = boxCtx.cards.find((c) => c.id === d.id); const f = $('noteForm');
        f.dataset.edit = n.id; f.querySelector('textarea').value = n.body; noteTags = (n.tags || []).slice();
        $('noteTags').textContent = noteTags.map((x) => (byId.get(x) || {}).title).join('、') + (noteTags.length ? 'にも' : '');
        f.querySelector('button.btn:not(.ghost)').textContent = '直す';
        f.scrollIntoView({ block: 'center' }); f.querySelector('textarea').focus(); return;
      }
      case 'noteDel':
        if (d.sure) { await store.removeCard(d.id); render(); }
        else { d.sure = '1'; act.textContent = '本当に消す？'; }
        return;
      case 'link': openPicker('つなぐ箱を選ぶ', async (b) => { if (!b || b.id === boxCtx.b.id) return; await store.addLink(boxCtx.b.id, b.id); toast(`「${b.title}」とつないだ`); render(); }); return;
      case 'unlink': await store.removeLink(d.id); render(); return;
      case 'toSticky': { const q = $('q').value.trim(); if (!q) return; await store.addSticky(q); toast('付箋にした'); backfill(); location.hash = '#/'; return; }
      case 'chew': copy(chewPrompt($('q').value.trim())); return;
      case 'pick': openPicker('追記する箱を選ぶ', (b) => { if (b) location.hash = `#/n/${b.id}?from=${d.id}`; }); return;
      case 'stDel': await store.removeSticky(d.id); toast('付箋をはがした'); location.hash = '#/'; return;
      case 'file': openPicker('納める箱を選ぶ', (b) => b && fileKakera(d.id, b)); return;
      case 'izumiMore': viewIzumi(renderSeq, true); return;
      case 'logout': await store.signOut(); location.reload(); return;
    }
  } catch (err) { fail(err); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'pickQ') drawPick(e.target.value);
  if (e.target.id === 'q') {
    clearTimeout(qTimer);
    const v = e.target.value;
    qTimer = setTimeout(() => { const h = v.trim() ? `#/q/${encodeURIComponent(v.trim())}` : '#/'; if (location.hash !== h) location.hash = h; }, 450);
  }
});
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });
function milestone(before) {
  const after = okTotal();
  const m = MILESTONES.find((x) => before < x && after >= x);
  toast(m ? `${m}枚、すごい！` : '納得。色が満ちた');
}

// ---- 入口 ----
function showGate(msg = '') {
  $('app').hidden = true; $('gate').hidden = false; $('gateMsg').textContent = msg;
  $('email').value = localStorage.getItem('kakera-email') || '';
}
let started = false;
async function showApp() {
  $('gate').hidden = true; $('app').hidden = false;
  if (started) return; started = true;
  embed(null).catch(() => {});
  try {
    await store.seedNodes(libraryRows());
    await loadLibrary();
    if (demo) { await seedDemo(store, byKey); await loadLibrary(); }
  } catch (e) { fail(e); return; }
  window.addEventListener('hashchange', render);
  await render();
  backfill();
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  $('gateMsg').textContent = '確かめてる…';
  try { await store.signIn(email, $('password').value); localStorage.setItem('kakera-email', email); $('password').value = ''; }
  catch (err) { $('gateMsg').textContent = /invalid/i.test(err.message) ? 'メールアドレスかパスワードがちがうみたい' : '入れなかった：' + err.message; }
});
(async () => {
  if (!store) { showGate('config.js に Supabase の URL と公開キーを入れてね（README 参照）'); $('loginForm').hidden = true; return; }
  store.onAuth((s) => { if (s) showApp(); });
  const s = await store.session();
  s ? showApp() : showGate();
})();
if ('serviceWorker' in navigator && !demo) navigator.serviceWorker.register('./sw.js').catch(() => {});
if (demo) window.__v = { get store() { return store; }, embed };
