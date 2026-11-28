import { supabaseStore, memoryStore } from './store.js';
import { SHELVES, shelfOf, libraryRows, AXES, LABELS, PHASES, AX_COLOR, IN_ASSERTION } from './library.js';
import { readImport, runImport } from './import.js';
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
const shVars = (sh) => `--c:${sh.color};--ct:${sh.text}`;
function tile(b) {
  const st = boxState(b), sh = shelfOf(b.shelf);
  return `<a class="tile${st.empty ? ' empty' : ' neon'}" href="#/n/${b.id}" style="${shVars(sh)}"><span class="tt">${esc(b.title)}</span>${st.empty ? '' : miniOf(b, st)}${st.ok ? `<span class="okn">納得 ${st.ok}</span>` : ''}</a>`;
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
    else if (view === 'letter') await viewLetter(a, my);
    else if (view === 'grow') await viewGrow(my);
    else location.hash = '#/';
  } catch (e) { fail(e); }
  if (!b) window.scrollTo(0, 0);
}
const live = (my) => my === renderSeq;
function crumbs(list) {
  $('crumbs').innerHTML = `<a href="#/" class="home glow" lang="ko">유리</a>` + list.map((x) => `<span class="sep" aria-hidden="true">›</span>${x.href ? `<a href="${x.href}">${esc(x.t)}</a>` : `<b>${esc(x.t)}</b>`}`).join('');
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
  const [unfiled, spring] = await Promise.all([store.unfiledCount().catch(() => 0), springHtml()]);
  if (!live(my)) return;
  recordMilestones();
  crumbs([]);
  const ok = okTotal();
  const next = MILESTONES.find((m) => m > ok);
  const month = monthStart();
  const want = secMeta.find((s) => s.want && !s.ok_at);
  const todays = stickies.length ? stickies[stickies.length - 1] : null;   // いちばん前に貼った付箋から
  const recent = boxes().filter((b) => b.opened_at).sort((a, c) => c.opened_at.localeCompare(a.opened_at)).slice(0, 3);
  const tiles = SHELVES.map((sh) => {
    const ids = new Set(boxes().filter((b) => b.shelf === sh.id).map((b) => b.id));
    const plus = cardMeta.filter((c) => ids.has(c.box_id) && c.created_at >= month).length + secMeta.filter((s) => ids.has(s.box_id) && s.ok_at && s.ok_at >= month).length;
    return `<a class="shelf-tile neon" href="#/s/${sh.id}" style="${shVars(sh)}"><span class="sn">${sh.name}</span><span class="sk${plus ? ' glow' : ' z'}">+${plus}</span></a>`;
  }).join('');
  let today;
  if (todays) today = `<a class="today" href="#/st/${todays.id}"><span class="k glow">今日の1つ</span><span class="b">${esc(short(todays.body, 60))}</span><span class="w">付箋から</span></a>`;
  else if (want) { const b = byId.get(want.box_id); today = `<a class="today" href="#/n/${want.box_id}/${want.id}"><span class="k glow">今日の1つ</span><span class="b">${esc(want.title)}</span><span class="w">${esc(b ? b.title : '')}・次に埋めたい</span></a>`; }
  else today = '<div class="today"><span class="k glow">今日の1つ</span><span class="w">付箋を貼るか、マスを「次に埋めたい」にすると、ここに出てくる。</span></div>';
  const reached = MILESTONES.filter((m) => m <= ok).pop();
  paint(logoHtml()
    + `<p style="text-align:center;margin:0 0 22px"><a href="#/grow" class="sign neon" aria-label="育ちを見る"><b class="glow">${ok}</b><span>${reached ? '枚、すごい！' : '枚 納得'}</span>${next ? `<span class="nx">次は ${next}</span>` : ''}</a></p>`
    + today + spring
    + `<section><p class="lbl">入口</p><div class="shelves">${tiles}</div></section>`
    + `<section><p class="lbl" style="color:#FFC94D">付箋</p><div class="stack">${stickies.slice(0, 3).map(stickyCard).join('')}</div>${stickies.length > 3 ? '<a class="more" href="#/stickies">付箋をぜんぶ見る</a>' : ''}${stickyForm()}</section>`
    + (recent.length ? `<section><p class="lbl">最近の箱</p><div class="tiles">${recent.map(tile).join('')}</div></section>` : '')
    + (unfiled ? `<section><a class="more" href="#/izumi">前の泉のかけらを、箱に納め直す</a></section>` : ''));
}
function logoHtml() {
  const d = new Date();
  return `<div class="hero"><h1 class="logo-k glow" lang="ko">유리</h1><div class="logo-r" aria-hidden="true"><span lang="ko">유리</span></div><p class="ym">YURI　${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}</p></div>`;
}
const stickyForm = () => `<form class="sform" data-form="sticky"><input type="text" name="body" placeholder="付箋を貼る" aria-label="付箋" enterkeyhint="done"><button class="btn">貼る</button></form>`;
const stickyCard = (s) => `<a class="sticky-c" href="#/st/${s.id}"><span class="b">${esc(short(s.body, 80))}</span><span class="d">${dlabel(s.created_at)}${s.hint_box && byId.get(s.hint_box) ? ' · 近い箱：' + esc(byId.get(s.hint_box).title) : ''}</span></a>`;

// ---- 棚と階層：中身を図（タイル）で ----
async function viewNode(n, my, focus) {
  if (!n) { location.hash = '#/'; return; }
  if (n.is_box) return viewBox(n, my, focus);
  if (n.key === 'hon') return viewBooks(my);
  if (n.key === 'nichijo') return viewDiaryShelf(my);
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
  paint(`<div class="shelf-head" style="${shVars(sh)}">${shapeSvg(sh.shape, sh.color, 30)}<h1>${esc(isShelf ? sh.name : n.title)}</h1></div>`
    + (isShelf && n.shelf === 'genba' ? '<div class="row"><button class="btn" data-act="procAdd">手続を足す</button></div>' : '')
    + (n.shelf === 'kamoku' ? `<div class="row"><button class="btn" data-act="kamokuAdd"${isShelf ? '' : ` data-parent="${esc(n.key)}"`}>科目を足す</button></div>` : '')
    + (direct.length ? `<div class="tiles">${direct.map(tile).join('')}</div>` : '')
    + sub.map((g) => group(g, 0)).join('')
    + (!ch.length ? `<p class="hint">${'まだ箱がない。'}</p>` : ''));
}

// ---- 箱 ----
let boxCtx = null;   // 開いている箱の中身
async function viewBox(b, my, focus) {
  store.touchNode(b.id).then(() => { b.opened_at = new Date().toISOString(); }).catch(() => {});
  const [secs, paras, cards, links, mk, bk] = await Promise.all([store.sections(b.id), store.paras(b.id), store.cards(b.id), store.links(b.id), store.kvGet('marks:' + b.id), b.shelf === 'hon' ? store.kvGet('books') : null, loadMeta()]);
  if (b.key === 'eigo/英字新聞') await loadLetters(false);
  if (!live(my)) return;
  books = bk || books;
  marks = { box: b.id, by: mk || {} };
  boxCtx = { b, secs, paras, cards, links, pair: true, fold: foldPref(), fromSticky: hashParam('from'), writing: null };
  crumbs(shelfCrumb(b));
  drawBox(focus);
  loadNear(b, my);
}
const foldPref = () => { try { return localStorage.getItem('yuri-fold') === '1'; } catch { return false; } };   // 原文を畳んでおくか（この端末だけ）
function redraw() { const y = scrollY; drawBox(); scrollTo(0, y); }   // 書いている場所から動かさずに描き直す
function drawBox(focus) {
  const { b } = boxCtx, sh = shelfOf(b.shelf);
  let body = '';
  if (b.shelf === 'kanki') body = kankiBody();
  else if (b.shelf === 'kamoku') body = kamokuBody();
  else if (b.shelf === 'hon') body = bookBody();
  else if (b.shelf === 'nichijo') body = diaryBody();
  else if (b.shelf === 'genba') body = procBody();
  else if (b.key === 'eigo/英字新聞') body = paperBody();
  else if (b.key === 'eigo/単語帳') body = wordsBody();
  const path = shelfCrumb(b).slice(0, -1);
  paint(`<div class="boxv" style="${shVars(sh)}"><div class="box-head"><p class="path">${path.map((x) => x.href ? `<a href="${x.href}">${esc(x.t)}</a>` : esc(x.t)).join(' › ')}</p><h1 class="glow">${esc(b.title)}</h1><div class="row"><a class="btn ghost small" href="#/prep/${b.id}">予習</a><button class="btn ghost small" data-act="link">つなぐ</button></div></div>`
    + body + (b.shelf === 'nichijo' || b.shelf === 'eigo' ? '' : notesBlock()) + `<section><h2>つながり</h2><div id="links" class="links">${linksHtml([])}</div></section></div>`);
  if (focus) document.getElementById('sec-' + focus)?.scrollIntoView({ block: 'start' });
  if (boxCtx.fromSticky) { const t = document.querySelector('#noteForm textarea'); t?.scrollIntoView({ block: 'center' }); t?.focus(); }
}

// ---- 私語訳を直接書く ----
// 私語訳の文：改行はそのまま。「・」「-」で始まる行は箇条書き、「①」「1.」「(1)」で始まる行は番号つき
const NUM_RE = /^\s*([①-⑳]|[0-9０-９]{1,2}[.．)）]|[(（][0-9０-９]{1,2}[)）])\s*(.*)$/;
const BUL_RE = /^\s*(?:[・•●]|[-－*]\s)\s*(.*)$/;
// 書くところに並べる道具：・ 箇条書き／① 番号（head なら ■ 見出しも）。押すと同じフォームの textarea に効く
const fmtBar = (head) => `<span class="fmtbar">${head ? '<button type="button" class="btn ghost small" data-act="heading" aria-label="見出しにする">■ 見出し</button>' : ''}<button type="button" class="btn ghost small" data-act="bullet" aria-label="箇条書きにする">・ 箇条書き</button><button type="button" class="btn ghost small" data-act="numbered" aria-label="番号をつける">① 番号</button></span>`;
const fmtTarget = (act) => (act.closest('form') || document).querySelector('textarea') || $('trBody');
function trText(body) {
  const out = []; let list = null;
  const flush = () => { if (list) { out.push(list.html + '</' + list.tag + '>'); list = null; } };
  const open = (tag) => { if (!list || list.tag !== tag) { flush(); list = { tag, html: `<${tag} class="${tag === 'ul' ? 'trl' : 'trn'}">` }; } };
  for (const ln of String(body).split('\n')) {
    let m;
    if ((m = ln.match(/^\s*■\s*(.*)$/))) { flush(); out.push(`<span class="trh">${esc(m[1])}</span>`); }
    else if ((m = ln.match(NUM_RE))) { open('ol'); list.html += `<li><span class="mk">${esc(m[1])}</span>${esc(m[2])}</li>`; }
    else if ((m = ln.match(BUL_RE))) { open('ul'); list.html += `<li>${esc(m[1])}</li>`; }
    else { flush(); const ind = ln.match(/^[ \t\u3000]*/)[0], n = [...ind].reduce((a, ch) => a + (ch === ' ' ? 0.5 : 1), 0), t = ln.slice(ind.length); out.push(`<span class="trline"${n ? ` style="padding-left:${Math.min(n, 6)}em"` : ''}>${esc(t) || '&nbsp;'}</span>`); }
  }
  flush();
  return out.join('');
}
// 番号の次：① → ②、1. → 2.、(1) → (2)
function nextNum(mk) {
  const c = mk.charCodeAt(0);
  if (c >= 0x2460 && c < 0x2473) return String.fromCharCode(c + 1);
  const n = parseInt(z2h(mk).replace(/[^0-9]/g, ''), 10) + 1;
  return z2h(mk).startsWith('(') || mk.startsWith('（') ? `(${n})` : `${n}.`;
}
const z2h = (x) => x.replace(/[０-９Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[－‐]/g, '-');
function refsOf(c) {   // 行がつながっている原文の項番号
  const ids = new Set(c ? c.para_ids || [] : []);
  return [...new Set(boxCtx.paras.filter((p) => ids.has(p.id)).map((p) => p.label))].join(', ');
}
function trForm(secId, c, paraId) {
  const refs = paraId ? '' : `<label class="small-l" for="trRefs">元にした原文の項（なくてもいい）</label><input type="text" id="trRefs" name="refs" placeholder="例：47, A136" value="${esc(refsOf(c))}" autocomplete="off">`;
  return `<form class="trform" data-form="trans" data-sec="${secId}"${paraId ? ` data-para="${paraId}"` : ''}${c ? ` data-edit="${c.id}"` : ''}>`
    + `<label class="sr" for="trBody">私語訳</label><textarea id="trBody" name="body" rows="8" placeholder="自分の言葉で（改行できる）">${esc(c ? c.body : '')}</textarea>` + refs
    + `<div class="row">${c ? `<button type="button" class="btn ghost small danger" data-act="trDel" data-id="${c.id}">消す</button>` : ''}${fmtBar()}<span class="grow"></span><button type="button" class="btn ghost small" data-act="trCancel">やめる</button><button class="btn small">${c ? '直す' : '書く'}</button></div></form>`;
}

// ---- 原文マーカー（箱ごとに kv 'marks:<箱>' へ。{段落id: [{s,e,t}]}） ----
let marks = { box: null, by: {} };
function markRanges(p) {
  const out = [];
  for (const m of marks.by[p.id] || []) {
    let s = m.s;
    if (p.body.slice(m.s, m.e) !== m.t) { s = p.body.indexOf(m.t); if (s < 0) continue; }
    out.push([s, s + m.t.length]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
// 原文の中の「監基報315」「第48項」「A136項」を、その箱・その段落へのリンクにする
const REF = /(監査基準報告書|監基報)\s*([0-9０-９]{3})(?:第([0-9０-９]+)項)?|第?(F?A?[0-9０-９]+(?:-[0-9]+JP)?)項/g;
function stdBox(num) { return boxes().find((b) => b.shelf === 'kanki' && b.key.endsWith('/' + num)); }
function linkify(raw, p) {
  const list = boxCtx && boxCtx.b.id === p.box_id ? boxCtx.paras : prepParas;
  let out = '', at = 0, m;
  REF.lastIndex = 0;
  while ((m = REF.exec(raw))) {
    let a = null;
    if (m[2]) {
      const b = stdBox(z2h(m[2]));
      if (b && b.id !== p.box_id) a = `<a class="ref" href="#/n/${b.id}">`;
    } else {
      const lab = z2h(m[4]);
      if (list.some((x) => x.box_id === p.box_id && x.label === lab)) a = `<a class="ref" href="#" data-act="goPara" data-label="${esc(lab)}">`;
    }
    if (!a) continue;
    out += esc(raw.slice(at, m.index)) + a + esc(m[0]) + '</a>';
    at = m.index + m[0].length;
  }
  return out + esc(raw.slice(at));
}
function origHtml(p) {
  let html = '', at = 0;
  markRanges(p).forEach(([s, e], i) => {
    if (s < at) s = at;
    if (e <= s) return;
    html += linkify(p.body.slice(at, s), p) + `<mark data-pid="${p.id}" data-mi="${i}">${linkify(p.body.slice(s, e), p)}</mark>`;
    at = e;
  });
  html += linkify(p.body.slice(at), p);
  return `<p class="orig" data-pid="${p.id}"><span class="pn">${esc(p.label || '')}</span><span class="ob">${html}</span><button class="ocopy" data-act="copyOrig" data-pid="${p.id}" aria-label="この段落の原文をコピー">コピー</button></p>`;
}
function goPara(label) {   // 同じ箱の段落へ飛ぶ（畳んでいたら開く）
  const list = boxCtx ? boxCtx.paras : prepParas;
  const p = list.find((x) => x.label === label); if (!p) return;
  if (boxCtx && !boxCtx.pair) { boxCtx.pair = true; drawBox(); }
  const row = document.getElementById('p-' + p.id) || document.querySelector(`.orig[data-pid="${p.id}"]`);
  if (!row) return;
  const bd = row.querySelector('.pbody'); if (bd && bd.hidden) { bd.hidden = false; const c = row.querySelector('.pchip'); c?.classList.add('on'); c?.setAttribute('aria-expanded', 'true'); }
  const d = row.closest('details'); if (d) d.open = true;
  row.scrollIntoView({ block: 'center' });
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
}
async function saveMarks(pid, list) {
  if (list.length) marks.by[pid] = list; else delete marks.by[pid];
  await store.kvSet('marks:' + marks.box, Object.keys(marks.by).length ? marks.by : null);
  const p = (boxCtx && boxCtx.b.id === marks.box ? boxCtx.paras : prepParas).find((x) => x.id === pid);
  if (p) document.querySelectorAll(`.orig[data-pid="${pid}"]`).forEach((el) => { el.outerHTML = origHtml(p); });
}
let pendingMark = null, markTimer = 0;
function markBar(text, on) { const b = $('markBtn'); b.textContent = text; b.hidden = !on; }
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  clearTimeout(markTimer);
  if (!sel.rangeCount || sel.isCollapsed) {   // ボタンを押した拍子に選択が消えることがあるので、少し待ってから隠す
    if (pendingMark && pendingMark.add) markTimer = setTimeout(() => { if (pendingMark && pendingMark.add) { pendingMark = null; markBar('', false); } }, 600);
    return;
  }
  const r = sel.getRangeAt(0);
  const ob = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement)?.closest('.ob');
  const ob2 = (r.endContainer.nodeType === 1 ? r.endContainer : r.endContainer.parentElement)?.closest('.ob');
  if (!ob || ob !== ob2) { pendingMark = null; markBar('', false); return; }
  const pre = document.createRange(); pre.setStart(ob, 0); pre.setEnd(r.startContainer, r.startOffset);
  let s = pre.toString().length, t = r.toString();
  const lead = t.length - t.trimStart().length; s += lead; t = t.trim();
  if (!t) return;
  pendingMark = { add: true, pid: ob.parentElement.dataset.pid, s, e: s + t.length, t };
  markBar('マーカーを引く', true);
});
$('markBtn').addEventListener('pointerdown', (e) => e.preventDefault());   // 押しても選んだところを消さない
async function applyMark() {
  clearTimeout(markTimer);
  const m = pendingMark; pendingMark = null; markBar('', false);
  if (!m || !marks.box) return;
  const cur = (marks.by[m.pid] || []).slice();
  if (m.add) {
    const p = (boxCtx && boxCtx.b.id === marks.box ? boxCtx.paras : prepParas).find((x) => x.id === m.pid);
    if (!p) return;
    const rs = [...markRanges(p), [m.s, m.e]].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of rs) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push(r.slice()); }
    getSelection().removeAllRanges();
    await saveMarks(m.pid, merged.map(([s, e]) => ({ s, e, t: p.body.slice(s, e) })));
    toast('マーカーを引いた');
  } else {
    const p = (boxCtx && boxCtx.b.id === marks.box ? boxCtx.paras : prepParas).find((x) => x.id === m.pid);
    const rs = markRanges(p).filter((_, i) => i !== m.mi);
    await saveMarks(m.pid, rs.map(([s, e]) => ({ s, e, t: p.body.slice(s, e) })));
    toast('マーカーを消した');
  }
}

// 監基報：上に地図、下に節ごとの図と私語訳（行ごとに「原」で原文が開く）
function kankiBody() {
  const { secs, paras, cards, pair } = boxCtx;
  const pById = new Map(paras.map((p) => [p.id, p]));
  if (!secs.length && !paras.length) return '<p class="hint">原文と私語訳はまだ入っていない。原文のPDFと一緒に、Claude Code で作って取り込む。</p>';
  const hasTr = (s) => cards.some((c) => c.kind === 'trans' && c.section_id === s.id);
  const state = (s) => (s.ok_at ? 'ok' : s.want ? 'want' : hasTr(s) ? 'draft' : 'none');
  const done = new Set(cards.filter((c) => c.kind === 'trans').flatMap((c) => c.para_ids || []));   // 私語訳がついた段落
  const prog = (ps) => { const n = ps.filter((p) => done.has(p.id)).length; return { n, N: ps.length, pc: ps.length ? Math.round((n / ps.length) * 100) : 0 }; };
  const all = prog(paras);
  const bar = (pc) => `<span class="pbar" aria-hidden="true"><i style="width:${pc}%"></i></span>`;
  const progress = paras.length ? `<p class="progress">私語訳 <b class="num glow">${all.n}</b><span class="num"> / ${all.N}</span> 段落 ${bar(all.pc)}<span class="num pc">${all.pc}%</span></p>` : '';
  const map = `<div class="map">${PHASES.map(([p, label]) => `<div class="phase"><span class="pl">${label}</span>${secs.filter((s) => s.phase === p).map((s) => `<a class="cell c-${state(s)}" href="#/n/${boxCtx.b.id}/${s.id}">${esc(short(s.title, 16))}${bar(prog(paras.filter((p) => p.section_id === s.id)).pc)}</a>`).join('') || '<span class="cell c-none blank"></span>'}</div>`).join('')}</div>`
    + `<p class="legend"><i class="c-none"></i>まだ<i class="c-want"></i>次に埋めたい<i class="c-draft"></i>下書き<i class="c-ok"></i>納得</p>`;
  const orig = origHtml;
  const sec = (s) => {
    const lines = cards.filter((c) => c.kind === 'trans' && c.section_id === s.id).sort((a, c) => a.seq - c.seq);
    const own = paras.filter((p) => p.section_id === s.id);
    const st = state(s);
    const sp = prog(own);
    const head = `<div class="sec-h"><h2>${esc(s.title)}</h2><span class="ph">${(PHASES.find(([p]) => p === s.phase) || [])[1] || ''}</span>${own.length ? `<span class="sprog num${sp.n === sp.N ? ' full' : ''}">${sp.n}/${sp.N}</span>` : ''}</div>`
      + `<div class="row">${s.ok_at ? `<span class="okmark">納得 ${dlabel(s.ok_at)}</span><button class="btn ghost small" data-act="unok" data-id="${s.id}">下書きに戻す</button>`
        : `${own.length ? `<button class="btn ghost small" data-act="copySec" data-id="${s.id}">原文をコピー</button>` : ''}<button class="btn ghost small" data-act="want" data-id="${s.id}" aria-pressed="${!!s.want}">${s.want ? '次に埋めたい ✓' : '次に埋めたい'}</button>${lines.length ? `<button class="btn small" data-act="ok" data-id="${s.id}">納得</button>` : ''}`}</div>`;
    const w = boxCtx.writing;
    const ownIds = new Set(own.map((p) => p.id));
    const home = (c) => (c.para_ids || []).find((x) => ownIds.has(x)) || null;   // 行が並ぶ段落（いちばん最初につながっている段落）
    const fix = (c) => `<button class="gen fix" data-act="trEdit" data-id="${c.id}" aria-label="この行を直す">直す</button>`;
    const writeBtn = w && w.sec === s.id && !w.card && !w.para ? trForm(s.id, null, null) : `<button class="btn ghost small" data-act="trAdd" data-id="${s.id}">私語訳を書く</button>`;
    const dg = s.diagram ? renderDiagram(s.diagram) : '';
    const mat = `<div class="row"><button class="btn ghost small" data-act="material" data-id="${s.id}">私語訳の材料をコピー</button></div>`;
    let inner;
    if (pair) {   // 原文に沿って、段落ごとに私語訳を対で
      const byPara = new Map(), loose = [];
      for (const c of lines) { const h = home(c); if (h) { if (!byPara.has(h)) byPara.set(h, []); byPara.get(h).push(c); } else loose.push(c); }
      const line = (c) => (w && w.card === c.id ? trForm(s.id, c, home(c)) : `<div class="tr">${trText(c.body)}<span class="trbtn">${fix(c)}</span></div>`);
      inner = dg + (loose.length ? `<div class="loose">${loose.map(line).join('')}</div>` : '')
        + (own.length ? `<div class="pairs">${own.map((p) => `<div class="prow${done.has(p.id) ? ' has' : ''}" id="p-${p.id}"><span class="plab num">${esc(p.label || '')}</span><div class="po">${boxCtx.fold ? `<button class="gen pchip" data-act="pOpen" aria-expanded="false">原 ${esc(p.label || '')}</button><div class="pbody" hidden>${orig(p)}</div>` : orig(p)}</div><div class="pt">${(byPara.get(p.id) || []).map(line).join('')}`
          + (w && w.para === p.id && !w.card ? trForm(s.id, null, p.id) : `<button class="addtr" data-act="trAdd" data-id="${s.id}" data-para="${p.id}">＋ 私語訳</button>`) + '</div></div>').join('')}</div>` : writeBtn)
        + (lines.length ? '' : mat);
    } else if (!lines.length) {
      inner = `<p class="hint">私語訳はまだ。</p>${writeBtn}${mat}`;
    } else {
      inner = dg + '<div class="lines">' + lines.map((c) => {
        const ps = (c.para_ids || []).map((x) => pById.get(x)).filter(Boolean);
        if (w && w.card === c.id) return trForm(s.id, c, null);
        return `<div class="line"><div class="tr">${trText(c.body)}<span class="trbtn">${ps.length ? `<button class="gen" data-act="gen" aria-expanded="false" aria-label="原文を開く">原</button> ` : ''}${fix(c)}</span></div><div class="side" hidden>${ps.map(orig).join('')}</div></div>`;
      }).join('') + '</div>' + writeBtn;
    }
    return `<section class="sec s-${st}" id="sec-${s.id}">${head}${inner}</section>`;
  };
  return map + progress + `<div class="row"><button class="btn ghost small" data-act="pair" aria-pressed="${!pair}">${pair ? '私語訳だけ見る' : '原文と対で見る'}</button>${pair ? `<button class="btn ghost small" data-act="fold" aria-pressed="${boxCtx.fold}">${boxCtx.fold ? '原文を開く' : '原文を畳む'}</button>` : ''}</div>` + secs.map(sec).join('');
}

// 勘定科目：アサーション軸ごとに、色ラベル付きの行
const labHtml = (l, rowColor) => { const L = LABELS[l]; return L ? `<span class="lab" style="--lc:${L[1] || rowColor || '#C9CFDB'}">${L[0]}</span>` : ''; };
// ---- 勘定科目の箱：基礎知識（自由に・見出しつき）／アサーション（行）＋全般／トピック（追記） ----
// 基礎知識は kind 'trans'・節なし・labels ['kn:kiso']。全般の行は axis なし＋labels 'zenpan'、未整理の行は axis なし＋labels 'mise'
const knCard = (k) => boxCtx.cards.find((c) => c.kind === 'trans' && c.box_id === boxCtx.b.id && (c.labels || []).includes('kn:' + k));
const ZEN_COLOR = '#E6EAF2';
const KLABELS = ['abunai', 'tashikameru'];   // 行につけるラベル（リスク・手続）
const rowAxisName = (r) => (r.axis ? AXES.find(([k]) => k === r.axis)[1] : '全般');
function kisoHtml() {
  const c = knCard('kiso'), w = boxCtx.writing || {};
  const inner = w.kn === 'kiso'
    ? `<form class="trform" data-form="knote" data-kn="kiso"><label class="sr" for="trBody">基礎知識</label><textarea id="trBody" name="body" rows="12" placeholder="■ 定義&#10;① …&#10;■ 範囲&#10;・ …">${esc(c ? c.body : '')}</textarea>`
      + `<div class="row">${fmtBar(true)}<span class="grow"></span><button type="button" class="btn ghost small" data-act="trCancel">やめる</button><button class="btn small">しまう</button></div></form>`
    : c ? `<div class="tr">${trText(c.body)}</div><div class="row"><button class="gen fix" data-act="knEdit" data-kn="kiso">直す</button></div>`
    : `<p class="none">定義・範囲などを、見出し（■）をつけて。</p><button class="gen fix" data-act="knEdit" data-kn="kiso">書く</button>`;
  return `<section class="fr neon knfr"><p class="lbl">基礎知識</p>${inner}</section>`;
}
// 前に入れた5つの欄のノート（基礎知識以外）：未整理に移せる
function oldNotesHtml() {
  const old = boxCtx.cards.filter((c) => c.kind === 'trans' && c.box_id === boxCtx.b.id && (c.labels || []).some((l) => /^kn:(?!kiso)/.test(l)));
  return old.length ? `<section class="fr knfr" style="--c:#FFC94D"><p class="lbl">前のノート（振り分けたら消える）</p>${old.map((c) => `<div class="tr">${trText(c.body)}</div>`).join('<hr>')}<div class="row"><button class="btn small" data-act="oldToMise">ぜんぶ未整理に移す</button></div></section>` : '';
}
// 未整理：1行ずつ、枠とラベルを選んで振り分ける
function miseHtml(rows) {
  if (!rows.length) return '';
  return `<section class="fr neon misefr" style="--c:#FFC94D;--ct:#FFE6A8"><p class="lbl">未整理 ${rows.length}</p><p class="hint small">ラベルを選んでから、入れる枠を押す。</p>`
    + rows.map((r) => `<div class="mise"><div class="tr">${trText(r.body)}</div>`
      + `<div class="chips">${KLABELS.map((l) => `<button class="chip${(r.labels || []).includes(l) ? ' on' : ''}" style="--lc:${LABELS[l][1] || '#C9CFDB'}" data-act="miseLab" data-id="${r.id}" data-l="${l}">${LABELS[l][0]}</button>`).join('')}</div>`
      + `<div class="chips">${AXES.map(([k, n]) => `<button class="chip ax" style="--lc:${AX_COLOR[k]}" data-act="miseTo" data-id="${r.id}" data-ax="${k}">${n}</button>`).join('')}<button class="chip ax" style="--lc:${ZEN_COLOR}" data-act="miseTo" data-id="${r.id}" data-ax="zenpan">全般</button><button class="chip ax" style="--lc:#3CF2B8" data-act="miseTo" data-id="${r.id}" data-ax="kiso">基礎知識へ</button><button class="chip x" data-act="rowDel" data-id="${r.id}" aria-label="消す">✕</button></div></div>`).join('')
    + '</section>';
}
function rowForm(r) {   // 行を直す（枠・ラベル・中身）
  const cur = r.axis || 'zenpan';
  return `<form class="trform rowform" data-form="rowEdit" data-edit="${r.id}"><select name="axis" aria-label="枠">${AXES.map(([k, n]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${n}</option>`).join('')}<option value="zenpan"${cur === 'zenpan' ? ' selected' : ''}>全般</option></select>`
    + `<div class="row">${KLABELS.map((k) => `<label class="chk"><input type="checkbox" name="labels" value="${k}"${(r.labels || []).includes(k) ? ' checked' : ''}> ${LABELS[k][0]}</label>`).join('')}</div>`
    + `<label class="sr" for="trBody">中身</label><textarea id="trBody" name="body" rows="4">${esc(r.body)}</textarea><div class="row">${fmtBar()}<span class="grow"></span><button type="button" class="btn ghost small" data-act="trCancel">やめる</button><button class="btn small">直す</button></div></form>`;
}
function kamokuBody() {
  const own = boxCtx.cards.filter((c) => c.kind === 'row' && c.box_id === boxCtx.b.id);
  const rows = own.filter((r) => r.axis), zen = own.filter((r) => !r.axis && (r.labels || []).includes('zenpan')), mise = own.filter((r) => !r.axis && (r.labels || []).includes('mise'));
  const w = boxCtx.writing || {};
  const rowHtml = (r, col) => (w.row === r.id ? rowForm(r) : `<div class="krow"><div class="kb">${(r.labels || []).length ? `<p class="labs">${(r.labels || []).map((l) => labHtml(l, col)).join('')}</p>` : ''}<div class="tr">${trText(r.body)}</div></div>`
    + `<span class="rbtn"><button class="ok-b${r.ok_at ? ' on' : ''}" data-act="${r.ok_at ? 'rowUnok' : 'rowOk'}" data-id="${r.id}" aria-pressed="${!!r.ok_at}">${r.ok_at ? '納得 ✓' : '納得'}</button><button class="ok-b" data-act="rowEdit" data-id="${r.id}">直す</button><button class="x" data-act="rowDel" data-id="${r.id}" aria-label="この行を消す">✕</button></span></div>`);
  const list = (ax) => { const l = rows.filter((r) => r.axis === ax); return l.length ? l.map((r) => rowHtml(r, AX_COLOR[ax])).join('') : '<p class="none">まだない</p>'; };
  const nameOf = (ax) => AXES.find(([k]) => k === ax)[1];
  const vars = (ax) => `--c:${AX_COLOR[ax]};--ct:color-mix(in srgb,${AX_COLOR[ax]} 45%,#fff)`;
  const fromProc = boxCtx.cards.filter((c) => c.kind === 'row' && c.box_id !== boxCtx.b.id && (c.labels || []).includes('point'));
  const procs = [...new Set(fromProc.map((c) => c.box_id))].map((id) => byId.get(id)).filter(Boolean);
  const procHtml = procs.length ? `<div class="fr neon procfr" style="${shVars(shelfOf('genba'))}"><p class="lbl">手続から</p>${procs.map((pb) => `<div class="pgrp"><a class="tag" href="#/n/${pb.id}" style="${shVars(shelfOf('genba'))}">${esc(pb.title)}</a><ul class="plist">${fromProc.filter((c) => c.box_id === pb.id).map((c) => `<li><div class="tr">${trText(c.body)}</div></li>`).join('')}</ul></div>`).join('')}</div>` : '';
  return kisoHtml() + oldNotesHtml()
    + `<div class="row" style="margin-top:24px"><p class="lbl" style="margin:0">アサーション</p><span class="grow"></span><button class="btn ghost small" data-act="knPaste">Notion から貼る</button></div>`
    + miseHtml(mise)
    + `<div class="fr afr neon">${IN_ASSERTION.map((ax) => `<div class="tube" style="${vars(ax)}"><h3>${nameOf(ax)}</h3>${list(ax)}</div>`).join('')}</div>`
    + `<div class="duo">${AXES.filter(([k]) => !IN_ASSERTION.includes(k)).map(([ax, n]) => `<div class="fr neon" style="${vars(ax)}"><h3>${n}</h3>${list(ax)}</div>`).join('')}</div>`
    + `<div class="fr neon" style="--c:${ZEN_COLOR};--ct:#fff"><h3>全般</h3>${zen.length ? zen.map((r) => rowHtml(r, ZEN_COLOR)).join('') : '<p class="none">どの枠にも入らないもの</p>'}</div>`
    + procHtml
    + `<details class="addrow"${w.adding ? ' open' : ''}><summary>行を足す</summary><form class="trform" data-form="row"><select name="axis" aria-label="枠">${AXES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}<option value="zenpan">全般</option></select>`
    + `<div class="row">${KLABELS.map((k) => `<label class="chk"><input type="checkbox" name="labels" value="${k}"> ${LABELS[k][0]}</label>`).join('')}</div>`
    + `<textarea name="body" rows="3" placeholder="1〜2行で" aria-label="行の中身"></textarea><div class="row">${fmtBar()}<span class="grow"></span><button class="btn">足す</button></div></form></details>`;
}
// Notion から貼った文を、1行ずつ未整理の行に。見出し（#）・空行・「特になし」はとばす。字下げした行は、上の行の続きにする
function notionLines(text) {
  const out = [];
  for (const ln of String(text).replace(/\r/g, '').split('\n')) {
    if (!ln.trim() || /^\s*#{1,6}\s/.test(ln) || /^\s*#{1,6}\s*$/.test(ln) || /^\s*(特になし|なし)\s*$/.test(ln)) continue;
    if (/^[ \t　]/.test(ln) && out.length) out[out.length - 1] += '\n' + ln.replace(/\s+$/, '');
    else out.push(ln.trim());
  }
  return out;
}
async function knSave(k, body) {
  const c = knCard(k);
  if (c && !body) await store.removeCard(c.id);
  else if (c) await store.patchCard(c.id, { body, embedding: null });
  else if (body) await store.addCard({ box_id: boxCtx.b.id, kind: 'trans', body, labels: ['kn:' + k], seq: 0 });
}
async function addMise(lines) {
  let seq = boxCtx.cards.filter((c) => c.kind === 'row').length;
  for (const body of lines) await store.addCard({ box_id: boxCtx.b.id, kind: 'row', labels: ['mise'], body, seq: seq++ });
}

// ---- 本：1冊＝1箱。題名・著者・読み始め・読み終わり（kv 'books' に {箱id: {author, start, end}}）、中身は自由に ----
let books = {};
const md = (d) => (d ? d.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1/$2/$3') : '');
const bookDates = (m) => (m.start ? `${md(m.start)} 〜 ${m.end ? md(m.end) : '読書中'}` : m.end ? `〜 ${md(m.end)}` : '');
async function viewBooks(my) {
  const bk = await store.kvGet('books');
  await loadMeta();
  if (!live(my)) return;
  books = bk || {};
  const sh = shelfOf('hon');
  crumbs([{ t: sh.name }]);
  const list = boxes().filter((b) => b.shelf === 'hon').map((b) => ({ b, m: books[b.id] || {} }))
    .sort((x, y) => (y.m.start || '').localeCompare(x.m.start || '') || x.b.title.localeCompare(y.b.title));
  const years = [...new Set(list.map((x) => (x.m.start || '').slice(0, 4) || '日付なし'))];
  paint(`<div class="shelf-head" style="${shVars(sh)}"><h1>${sh.name}</h1></div><div class="row"><button class="btn" data-act="bookAdd">本を足す</button></div>`
    + (list.length ? years.map((y) => `<section style="${shVars(sh)}"><p class="lbl num">${y}</p><div class="books">${list.filter((x) => ((x.m.start || '').slice(0, 4) || '日付なし') === y).map(({ b, m }) =>
      `<a class="book neon" href="#/n/${b.id}"><b>${esc(b.title)}</b>${m.author ? `<span class="au">${esc(m.author)}</span>` : ''}<span class="dt num${m.end ? ' done' : ''}">${esc(bookDates(m))}${m.end ? '　読了' : ''}</span></a>`).join('')}</div></section>`).join('')
      : '<p class="hint">まだ本がない。「本を足す」で1冊ずつ。</p>'));
}
function openBookForm(b) {
  const m = (b && books[b.id]) || {};
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  openModal(b ? '本を直す' : '本を足す', `<form class="bookform" data-form="book"${b ? ` data-edit="${b.id}"` : ''}>`
    + `<label for="bkTitle">題名</label><input type="text" id="bkTitle" name="body" required value="${esc(b ? b.title : '')}" autocomplete="off">`
    + `<label for="bkAuthor">著者</label><input type="text" id="bkAuthor" name="author" value="${esc(m.author || '')}" autocomplete="off">`
    + `<div class="two"><div><label for="bkStart">読み始め</label><input type="date" id="bkStart" name="start" value="${esc(b ? m.start || '' : today)}"></div>`
    + `<div><label for="bkEnd">読み終わり</label><input type="date" id="bkEnd" name="end" value="${esc(m.end || '')}"></div></div>`
    + `<div class="row">${b ? `<button type="button" class="btn ghost small danger" data-act="bookDel" data-id="${b.id}">この本を消す</button>` : ''}<span class="grow"></span><button class="btn">${b ? '直す' : '足す'}</button></div></form>`);
  $('bkTitle').focus();
}
function bookBody() {
  const { b, cards } = boxCtx, m = books[b.id] || {};
  const main = cards.find((c) => c.kind === 'trans' && c.box_id === b.id && !c.section_id);
  const editing = boxCtx.writing && boxCtx.writing.book;
  return `<p class="bmeta">${m.author ? `<span>${esc(m.author)}</span>` : ''}<span class="num">${esc(bookDates(m))}</span>${m.end ? '<span class="done">読了</span>' : ''}<button class="gen fix" data-act="bookEdit">直す</button></p>`
    + `<section class="fr neon bookmain"><p class="lbl">中身</p>`
    + (editing ? `<form class="trform" data-form="bookText"><label class="sr" for="trBody">中身</label><textarea id="trBody" name="body" rows="12" placeholder="自由に（改行・「・」・「①」が使える）">${esc(main ? main.body : '')}</textarea>`
        + `<div class="row">${fmtBar(true)}<span class="grow"></span><button type="button" class="btn ghost small" data-act="trCancel">やめる</button><button class="btn small">しまう</button></div></form>`
      : main ? `<div class="tr">${trText(main.body)}</div><div class="row"><button class="btn ghost small" data-act="bookWrite">書き足す・直す</button></div>`
      : `<p class="hint">まだ何も書いていない。</p><button class="btn ghost small" data-act="bookWrite">書く</button>`)
    + '</section>';
}

// ---- 日常：月ごとの箱（自動でできる）に、日付つきで自由に書く。書いたものは追記（note）と同じ1枚 ----
const localDay = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const WD = '日月火水木金土';
const dayLabel = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; };
async function monthBox(ym) {   // 'YYYY-MM' の箱。なければ作る
  const key = `nichijo/${ym}`;
  if (!byKey.has(key)) {
    await store.seedNodes([{ shelf: 'nichijo', key, parent_key: 'nichijo', title: `${ym.slice(0, 4)}年${+ym.slice(5)}月`, sort: `005.${ym}`, is_box: true }]);
    await loadLibrary();
  }
  return byKey.get(key);
}
async function viewDiaryShelf(my) {
  await loadMeta();
  if (!live(my)) return;
  const sh = shelfOf('nichijo');
  crumbs([{ t: sh.name }]);
  const months = boxes().filter((b) => b.shelf === 'nichijo').sort((a, b) => b.key.localeCompare(a.key));
  const years = [...new Set(months.map((b) => b.key.slice(8, 12)))];
  paint(`<div class="shelf-head" style="${shVars(sh)}"><h1>${sh.name}</h1></div><div class="row"><button class="btn" data-act="diaryNew">今日のことを書く</button></div>`
    + (months.length ? years.map((y) => `<section style="${shVars(sh)}"><p class="lbl num">${y}</p><div class="months">${months.filter((b) => b.key.slice(8, 12) === y).map((b) => {
      const n = cardMeta.filter((c) => c.box_id === b.id && c.kind === 'note').length;
      return `<a class="month neon" href="#/n/${b.id}"><b class="num glow">${+b.key.slice(13)}</b><span>月</span><span class="cnt num">${n}</span></a>`;
    }).join('')}</div></section>`).join('') : '<p class="hint">まだ何も書いていない。「今日のことを書く」から。書いた日の月の箱が、自動でできる。</p>'));
}
function diaryForm(c, fromSt) {
  const date = c ? localDay(new Date(c.created_at)) : fromSt ? localDay(new Date(fromSt.created_at)) : localDay();
  return `<form class="trform diaryform" data-form="diary"${c ? ` data-edit="${c.id}"` : ''}>`
    + `<div class="drow"><label for="dDate">日付</label><input type="date" id="dDate" name="date" value="${date}" required></div>`
    + `<label class="sr" for="trBody">日常</label><textarea id="trBody" name="body" rows="6" placeholder="どこに行った、誰といた、どうだった">${esc(c ? c.body : fromSt ? fromSt.body : '')}</textarea>`
    + `<div class="row">${fmtBar()}</div><div class="row">${c ? `<button type="button" class="btn ghost small danger" data-act="noteDel" data-id="${c.id}">消す</button><button type="button" class="btn ghost small" data-act="trCancel">やめる</button>` : ''}<span class="grow"></span><button class="btn small">${c ? '直す' : '書く'}</button></div></form>`;
}
function diaryBody() {
  const { b, cards, fromSticky } = boxCtx;
  const st = fromSticky && stickies.find((x) => x.id === fromSticky);
  const list = cards.filter((c) => c.kind === 'note' && c.box_id === b.id).sort((a, c) => c.created_at.localeCompare(a.created_at));
  const ed = boxCtx.writing && boxCtx.writing.diary;
  return `<section style="--c:#FF4FA8;--ct:#FFC6E3">${st ? '<p class="hint small">付箋から。書いたら、付箋ははがす</p>' : ''}${ed ? '' : diaryForm(null, st)}</section>`
    + `<section class="diary">${list.map((c) => ed === c.id ? diaryForm(c) : `<article class="dent"><p class="dd num glow">${dayLabel(c.created_at)}</p><div class="tr">${trText(c.body)}</div><div class="row"><button class="gen fix" data-act="diaryEdit" data-id="${c.id}">直す</button></div></article>`).join('')
      || '<p class="hint">この月はまだ何も書いていない。</p>'}</section>`;
}

// ---- 手続：実査・立会・詳細テスト… 気をつけること／科目ごとの論点（科目の箱にも出る）／持ち物／次に意識すること ----
// どれも kind 'row'（軸なし）。labels の先頭で欄を分ける：general / point / bring / next。持ち物のチェックは labels に 'checked'
const PARTS = [['general', '気をつけること（全般）', '例：現金は2人で数える'], ['point', '科目ごとの論点', ''], ['bring', '持ち物', '例：カイロ、電卓、ヘルメット'], ['next', '次に意識すること', '例：保管場所の一覧を先にもらう']];
function procBody() {
  const { b, cards } = boxCtx, w = boxCtx.writing || {};
  const rows = cards.filter((c) => c.kind === 'row' && c.box_id === b.id && !c.axis);
  const of = (part) => rows.filter((r) => (r.labels || [])[0] === part).sort((a, c) => a.seq - c.seq || a.created_at.localeCompare(c.created_at));
  const item = (r, check) => (w.item === r.id
    ? `<form class="trform" data-form="pitem" data-edit="${r.id}"><textarea id="trBody" name="body" rows="3" aria-label="直す">${esc(r.body)}</textarea><div class="row">${fmtBar()}<span class="grow"></span><button type="button" class="btn ghost small danger" data-act="pDel" data-id="${r.id}">✕</button><button type="button" class="btn ghost small" data-act="trCancel">やめる</button><button class="btn small">直す</button></div></form>`
    : `<div class="pitem${check && (r.labels || []).includes('checked') ? ' checked' : ''}">${check ? `<button class="pchk" data-act="pCheck" data-id="${r.id}" aria-pressed="${(r.labels || []).includes('checked')}" aria-label="チェック"></button>` : '<span class="pdot" aria-hidden="true"></span>'}<div class="pb tr">${trText(r.body)}</div><button class="gen fix" data-act="pEdit" data-id="${r.id}">直す</button></div>`);
  const add = (part, ph, tag) => `<form class="pform" data-form="pitem" data-part="${part}"${tag ? ` data-tag="${tag}"` : ''}><input type="text" name="body" placeholder="${esc(ph)}" aria-label="足す" autocomplete="off"><button class="btn small">足す</button></form>`;
  const frame = ([part, name, ph]) => {
    if (part === 'point') {
      const pts = of('point');
      const tagIds = [...new Set([...pts.map((r) => (r.tags || [])[0]).filter(Boolean), ...(w.tag ? [w.tag] : [])])];
      return `<section class="fr neon pfr"><p class="lbl">${name}</p>`
        + (tagIds.map((t) => { const kb = byId.get(t); return `<div class="pgrp"><a class="tag" href="#/n/${t}" style="${kb ? shVars(shelfOf(kb.shelf)) : ''}">${esc(kb ? kb.title : '？')}</a>${pts.filter((r) => (r.tags || [])[0] === t).map((r) => item(r)).join('')}${add('point', '例：期末日前後の売上を重点的に', t)}</div>`; }).join('')
          || '<p class="hint small">科目を選ぶと、その科目の箱にも「手続から」で出る。</p>')
        + `<button class="btn ghost small" data-act="pTag">＋ 科目を選ぶ</button></section>`;
    }
    const list = of(part);
    return `<section class="fr neon pfr"><p class="lbl">${name}</p>${list.map((r) => item(r, part === 'bring')).join('')}${add(part, ph)}`
      + (part === 'bring' && list.some((r) => (r.labels || []).includes('checked')) ? '<button class="btn ghost small" data-act="pUncheck">チェックを全部外す</button>' : '') + '</section>';
  };
  return PARTS.map(frame).join('');
}

// 追記：日付つき。ほかの箱にも出すときは、向こうでは「〇〇から」
function notesBlock() {
  const { b, cards, fromSticky } = boxCtx;
  const notes = cards.filter((c) => c.kind === 'note').sort((a, c) => c.created_at.localeCompare(a.created_at));
  const st = fromSticky && stickies.find((s) => s.id === fromSticky);
  return `<section class="notes-fr neon"><p class="lbl">${b.shelf === 'kamoku' ? 'トピック' : '追記'}</p>`
    + `<form id="noteForm" data-form="note">${st ? `<p class="hint small">付箋から。追記したら、付箋ははがす</p>` : ''}<textarea name="body" placeholder="気づいたこと、悩んだこと" aria-label="追記">${st ? esc(st.body) : ''}</textarea>`
    + `<div class="row">${fmtBar()}</div><div class="row"><span class="tagged" id="noteTags"></span><button type="button" class="btn ghost small" data-act="noteTag">ほかの箱にも出す</button><button class="btn">追記する</button></div></form>`
    + `<div class="stack">${notes.map((n) => {
      const from = n.box_id !== b.id && byId.get(n.box_id);
      const also = (n.tags || []).filter((t) => t !== b.id).map((t) => byId.get(t)).filter(Boolean);
      const tags = from ? [`<a class="tag" href="#/n/${from.id}" style="${shVars(shelfOf(from.shelf))}">${esc(from.title)}から</a>`]
        : also.map((x) => `<a class="tag" href="#/n/${x.id}" style="${shVars(shelfOf(x.shelf))}">${esc(x.title)}にも</a>`);
      return `<div class="note${from ? ' from' : ''}"><span class="dt">${dlabel(n.created_at)}</span><div class="tr">${trText(n.body)}</div>${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}<div class="rbtn"><button class="btn ghost small" data-act="noteEdit" data-id="${n.id}">直す</button><button class="btn ghost small" data-act="noteDel" data-id="${n.id}">消す</button></div></div>`;
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
let prepParas = [];
async function viewPrep(b, my) {
  if (!b) { location.hash = '#/'; return; }
  const [secs, paras, cards, mk] = await Promise.all([store.sections(b.id), store.paras(b.id), store.cards(b.id), store.kvGet('marks:' + b.id)]);
  if (!live(my)) return;
  marks = { box: b.id, by: mk || {} }; prepParas = paras;
  crumbs([...shelfCrumb(b).slice(0, -1), { t: b.title, href: `#/n/${b.id}` }, { t: '予習' }]);
  const notes = cards.filter((c) => c.kind === 'note').sort((a, c) => c.created_at.localeCompare(a.created_at));
  const rows = cards.filter((c) => c.kind === 'row' && c.box_id === b.id && (c.axis || (c.labels || []).includes('zenpan'))).sort((a, c) => (c.labels || []).includes('abunai') - (a.labels || []).includes('abunai'));
  const dgs = secs.filter((s) => s.diagram);
  let html = `<h1 class="ptitle">${esc(b.title)}、その前に</h1>`;
  html += `<section><h2>前に悩んだこと</h2>${notes.length ? `<div class="stack">${notes.map((n) => `<div class="note"><span class="d">${dlabel(n.created_at)}</span><div class="tr">${trText(n.body)}</div></div>`).join('')}</div>` : '<p class="hint small">追記はまだない。</p>'}</section>`;
  if (dgs.length) html += `<section><h2>図</h2>${dgs.map((s) => `<h3>${esc(s.title)}</h3>${renderDiagram(s.diagram)}`).join('')}</section>`;
  if (rows.length) html += `<section><h2>リスクから</h2>${rows.map((r) => { const col = AX_COLOR[r.axis] || ZEN_COLOR; return `<div class="tube" style="--c:${col};--ct:color-mix(in srgb,${col} 45%,#fff);margin-bottom:8px"><div class="krow"><div class="kb"><p class="labs"><span class="lab" style="--lc:${col}">${rowAxisName(r)}</span>${(r.labels || []).map((l) => labHtml(l, col)).join('')}</p><div class="tr">${trText(r.body)}</div></div></div></div>`; }).join('')}</section>`;
  if (paras.length) html += `<section><h2>原文</h2><details class="orig-all"><summary>${paras.length} 段落</summary>${paras.map(origHtml).join('')}</details></section>`;
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
    + `<div class="row"><button class="btn ghost" data-act="pick" data-id="${s.id}">箱を探して選ぶ</button><button class="btn ghost" data-act="stDiary" data-id="${s.id}" style="--c:#FF4FA8">日常に書く</button><button class="btn ghost" data-act="stDel" data-id="${s.id}">付箋をはがす</button></div>`);
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
  izumiRows = more ? [...izumiRows, ...part.filter((k) => !isLetter(k))] : part.filter((k) => !isLetter(k));
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

// ---- 育ち：納得の数の積み上がりと、棚ごとの月の数。区切り（1・10・30…）に届いた日は kv 'milestones' に残す ----
function okEvents() {
  const shelfOfBox = (id) => (byId.get(id) || {}).shelf;
  return [...secMeta.filter((s) => s.ok_at).map((s) => ({ at: s.ok_at, shelf: shelfOfBox(s.box_id) })),
    ...cardMeta.filter((c) => c.kind === 'row' && c.ok_at).map((c) => ({ at: c.ok_at, shelf: shelfOfBox(c.box_id) }))].sort((a, b) => a.at.localeCompare(b.at));
}
async function recordMilestones() {   // 初めて届いた日だけ残す（あとで納得を戻しても消えない）
  const ev = okEvents(), saved = (await store.kvGet('milestones').catch(() => null)) || {};
  let changed = false;
  for (const m of MILESTONES) if (ev.length >= m && !saved[m]) { saved[m] = ev[m - 1].at; changed = true; }
  if (changed) await store.kvSet('milestones', saved).catch(() => {});
  return saved;
}
const ym = (iso) => iso.slice(0, 7);
function lastMonths(n) { const out = [], d = new Date(); d.setDate(1); for (let i = n - 1; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`); } return out; }
function growLine(ev, ms) {   // 積み上がり（1本の線）。区切りに点と数
  const W = 340, H = 170, L = 30, R = 12, T = 14, B = 24;
  const t0 = new Date(ev[0].at).getTime(), t1 = Math.max(Date.now(), t0 + 864e5);
  const top = Math.max(5, ...MILESTONES.filter((m) => m >= ev.length).slice(0, 1), ev.length);
  const x = (t) => L + (t - t0) / (t1 - t0) * (W - L - R), y = (v) => T + (1 - v / top) * (H - T - B);
  let d = `M${x(t0).toFixed(1)},${y(0).toFixed(1)}`;
  ev.forEach((e, i) => { const t = new Date(e.at).getTime(); d += `H${x(t).toFixed(1)}V${y(i + 1).toFixed(1)}`; });
  d += `H${x(t1).toFixed(1)}`;
  const ticks = [0, Math.round(top / 2), top];
  const fmt = (t) => { const q = new Date(t); return `${q.getFullYear() % 100}/${q.getMonth() + 1}`; };
  const pts = MILESTONES.filter((m) => m <= ev.length).map((m) => { const t = new Date(ms[m] || ev[m - 1].at).getTime(); return { m, cx: x(Math.min(Math.max(t, t0), t1)), cy: y(m), t }; });
  return `<svg class="gline" viewBox="0 0 ${W} ${H}" role="img" aria-label="納得の数の積み上がり。いま ${ev.length}">`
    + ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}</text>`).join('')
    + `<text x="${L}" y="${H - 6}" class="ax">${fmt(t0)}</text><text x="${W - R}" y="${H - 6}" class="ax" text-anchor="end">今</text>`
    + `<path d="${d}" class="ln"/>`
    + `<text x="${W - R}" y="${y(ev.length) - 8}" class="lab" text-anchor="end">${ev.length}</text>`
    + pts.map((p, i) => `<g class="tip" data-tip="${p.m}枚目　${dlabel(new Date(p.t).toISOString())}"><circle cx="${p.cx}" cy="${p.cy}" r="14" class="hit"/><circle cx="${p.cx}" cy="${p.cy}" r="4.5" class="pt"/></g>`).join('')
    + '</svg>';
}
function shelfBars(sh, ev, months) {   // 棚ごと：12か月の棒（その棚の色1つ）
  const mine = ev.filter((e) => e.shelf === sh.id), by = new Map(months.map((m) => [m, 0]));
  for (const e of mine) if (by.has(ym(e.at))) by.set(ym(e.at), by.get(ym(e.at)) + 1);
  const max = Math.max(1, ...by.values()), W = 240, H = 44, bw = W / months.length;
  return `<div class="gshelf" style="${shVars(sh)}"><div class="gsn"><b>${sh.name}</b><span class="num">${mine.length}</span></div>`
    + `<svg class="gbars" viewBox="0 0 ${W} ${H + 2}" role="img" aria-label="${sh.name}の月ごとの納得">${months.map((m, i) => { const v = by.get(m), h = v ? Math.max(4, v / max * H) : 0;
      return `<g class="tip" data-tip="${sh.name}　${+m.slice(5)}月　${v}"><rect x="${i * bw}" y="0" width="${bw}" height="${H + 2}" class="hit"/>${v ? `<rect x="${i * bw + 2}" y="${H - h}" width="${bw - 4}" height="${h + 2}" rx="3" class="bar"/>` : `<rect x="${i * bw + 2}" y="${H - 1}" width="${bw - 4}" height="2" class="zero"/>`}</g>`; }).join('')}</svg></div>`;
}
async function viewGrow(my) {
  await loadMeta();
  const ms = await recordMilestones();
  if (!live(my)) return;
  crumbs([{ t: '育ち' }]);
  const ev = okEvents(), months = lastMonths(12), next = MILESTONES.find((m) => m > ev.length);
  const thisM = ev.filter((e) => ym(e.at) === months[11]).length;
  paint(`<h1 class="ptitle">育ち</h1>`
    + `<div class="gstats"><div><span class="lbl">納得</span><b class="num glow">${ev.length}</b></div><div><span class="lbl">今月</span><b class="num">+${thisM}</b></div>${next ? `<div><span class="lbl">次の区切り</span><b class="num">${next}</b></div>` : ''}</div>`
    + (ev.length ? `<section><p class="lbl">積み上がり</p>${growLine(ev, ms)}<p class="tipline hint small" aria-live="polite">点を押すと、その区切りに届いた日が出る。</p></section>` : '<p class="hint">まだ納得がない。マスや行を「納得」にすると、ここが育っていく。</p>')
    + `<section><p class="lbl">棚ごと（この12か月）</p><p class="hint small num">${+months[0].slice(5)}月 → ${+months[11].slice(5)}月</p><div class="gshelves">${SHELVES.map((sh) => shelfBars(sh, ev, months)).join('')}</div><p class="tipline hint small" aria-live="polite">棒を押すと、その月の数が出る。</p></section>`
    + `<section><p class="lbl">区切り</p><ul class="gms">${MILESTONES.map((m) => ms[m] ? `<li class="on"><b class="num glow">${m}</b><span>${dlabel(ms[m])}</span></li>` : `<li><b class="num">${m}</b><span>まだ</span></li>`).join('')}</ul></section>`);
}

// ---- 湧いてくる：ホームに、書いたものからランダムに1枚と、1年前のこのころ ----
function springCard(r) {
  const b = r.box_id && byId.get(r.box_id);
  const href = r.src === 'card' && b ? `#/n/${b.id}` : r.src === 'kakera' ? '#/izumi' : null;
  const where = r.src === 'card' ? (b ? b.title : '') : '前の泉';
  return `<${href ? `a href="${href}"` : 'div'} class="spring"><span class="b">${esc(short(r.body, 140))}</span><span class="d num">${dlabel(r.created_at)}${where ? ' · ' + esc(where) : ''}</span></${href ? 'a' : 'div'}>`;
}
async function springHtml() {
  const now = Date.now(), iso = (t) => new Date(t).toISOString();
  const [one, ago] = await Promise.all([store.spring().catch(() => null), store.between(iso(now - 372 * 864e5), iso(now - 358 * 864e5)).catch(() => [])]);
  return (one ? `<section><div class="lblrow"><p class="lbl" style="color:var(--cyan)">湧いてきた1枚</p><button class="gen" data-act="spring">もう1枚</button></div><div id="springOne">${springCard(one)}</div></section>` : '')
    + (ago.length ? `<section><p class="lbl">1年前のこのころ</p><div class="stack">${ago.map(springCard).join('')}</div></section>` : '');
}

// ---- 英語：英字新聞（メルマガが1通＝1枚で並ぶ）と単語帳（記事の単語を押して足す） ----
// 英字のメルマガかどうか：かなと漢字より英字がずっと多い
const isEnglish = (t) => { const s = String(t); const en = (s.match(/[A-Za-z]/g) || []).length, ja = (s.match(/[぀-ヿ一-鿿]/g) || []).length; return en > 40 && en > ja * 4; };
const isLetter = (k) => ['gmail', 'yahoo'].includes(k.source) && isEnglish(k.body);
const letterHead = (k) => { const m = String(k.body).match(/^【([^】]*)】([^\n]*)\n*([\s\S]*)$/); return m ? { from: m[1], subject: m[2].trim() || '（件名なし）', rest: m[3] } : { from: k.source === 'filed' ? '' : k.source || '', subject: short(k.body.split('\n')[0], 60), rest: k.body }; };
const paperBox = () => byKey.get('eigo/英字新聞'), wordBox = () => byKey.get('eigo/単語帳');
let letterRows = [];
async function loadLetters(more) {
  const page = await store.letters(40, more && letterRows.length ? letterRows[letterRows.length - 1].created_at : null);
  const en = page.filter((k) => isEnglish(k.body));
  letterRows = more ? [...letterRows, ...en] : en;
  letterRows.end = page.length < 40;
}
const letterList = () => `<div class="stack letters">${letterRows.map((k) => { const h = letterHead(k); return `<a class="letter neon" href="#/letter/${k.id}"><span class="d num">${dlabel(k.created_at)}${h.from ? ' · ' + esc(h.from) : ''}</span><b>${esc(h.subject)}</b><span class="b">${esc(short(h.rest, 110))}</span></a>`; }).join('')
  || '<p class="hint">まだ届いていない。英語のメルマガが Gmail に来ると、1時間以内にここに並ぶ。</p>'}</div>`
  + (letterRows.end ? '' : '<button class="btn ghost" data-act="lettersMore">もっと前</button>');
function paperBody() {   // 届いたメルマガ＋「箱に納める」でここに入れたもの（追記）
  const { b, cards } = boxCtx;
  const filed = cards.filter((c) => c.kind === 'note' && c.box_id === b.id).map((c) => ({ id: 'c:' + c.id, body: c.body, created_at: c.created_at, source: 'filed' }));
  const saved = letterRows;
  letterRows = [...saved, ...filed].sort((a, c) => c.created_at.localeCompare(a.created_at)); letterRows.end = saved.end;
  const html = `<section>${letterList()}</section>`;
  letterRows = saved;
  return html;
}

// 単語を押せるようにする：英字の並びを <span class="w"> に
let knownSet = new Set();   // 単語帳にある単語（小文字）
async function loadKnown() { const wb = wordBox(); knownSet = new Set(wb ? (await store.cards(wb.id)).filter((c) => c.kind === 'row' && (c.labels || []).includes('word')).map((c) => c.body.split('\n')[0].toLowerCase()) : []); return knownSet; }
const known = () => knownSet;
const knownForm = (kn, x) => { const w = x.toLowerCase(); return kn.has(w) || ['s', 'es', 'd', 'ed', 'ing'].some((e) => w.endsWith(e) && (kn.has(w.slice(0, -e.length)) || kn.has(w.slice(0, -e.length) + 'e'))) || (w.endsWith('ies') && kn.has(w.slice(0, -3) + 'y')); };
function tapText(text, kn) {
  return String(text).split('\n').map((ln) => `<span class="trline">${ln.split(/([A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z])/).map((x, i) => i % 2 ? `<span class="w${knownForm(kn, x) ? ' saved' : ''}">${esc(x)}</span>` : esc(x)).join('') || '&nbsp;'}</span>`).join('');
}
async function viewLetter(id, my) {
  await Promise.all([loadMeta(), loadKnown()]);
  let k = null, parts = null;
  if (id.startsWith('c:')) {   // 箱に納めた1枚（段落は空行で分かれている）
    const pb = paperBox(), c = pb && (await store.cards(pb.id)).find((x) => x.id === id.slice(2));
    if (c) { k = { ...c, source: 'filed' }; parts = letterHead(k).rest.split(/\n{2,}/); }
  } else {
    k = await store.kakera(id);
    if (k) { const sibs = k.group_id ? await store.siblings(k.group_id) : [k]; const rest = letterHead(k).rest; parts = (sibs.length ? sibs : [k]).map((x, i) => (i === 0 ? rest : x.body)); }
  }
  if (!live(my)) return;
  if (!k) { location.hash = '#/'; return; }
  const h = letterHead(k), sh = shelfOf('eigo'), pb = paperBox(), kn = known();
  crumbs([{ t: sh.name, href: '#/s/eigo' }, { t: '英字新聞', href: pb ? `#/n/${pb.id}` : null }, { t: short(h.subject, 24) }]);
  paint(`<div class="boxv" style="${shVars(sh)}"><div class="box-head"><p class="path num">${dlabel(k.created_at)}${h.from ? ' · ' + esc(h.from) : ''}</p><h1 class="glow article-t">${esc(h.subject)}</h1><p class="hint small">わからない単語を押すと、意味が出る。単語帳に足せる。</p></div>`
    + `<article class="article">${parts.map((p) => `<p class="ap">${tapText(p, kn)}</p>`).join('')}</article></div>`);
}
// 押した単語のまわりの1文（例文として残す）
function sentenceOf(el) {
  const p = el.closest('.trline') || el.parentElement, text = p.textContent;
  const idx = (() => { let i = 0; const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) { if (el.contains(n)) return i; i += n.textContent.length; } return 0; })();
  const st = Math.max(text.lastIndexOf('. ', idx), text.lastIndexOf('? ', idx), text.lastIndexOf('! ', idx));
  const ends = ['. ', '? ', '! '].map((s) => text.indexOf(s, idx)).filter((x) => x >= 0);
  const en = ends.length ? Math.min(...ends) + 1 : text.length;
  return text.slice(st < 0 ? 0 : st + 2, en).trim().slice(0, 300);
}
let wordPick = null;
async function openWord(word, sent, from) {
  openModal(word, '<p class="hint">辞書を引いてる…</p>');
  const r = await import('./dict.js').then((m) => m.lookup(word)).catch(() => null);
  if ($('modal').hidden) return;
  wordPick = { word: r ? r.word : word.toLowerCase(), mean: r ? r.senses.slice(0, 2).join(' / ') : '', sent, from };
  const has = known().has(wordPick.word);
  $('modal').querySelector('.mpanel > p.hint')?.remove();
  $('modal').querySelector('.mpanel').insertAdjacentHTML('beforeend',
    `<div class="wordpop">${r ? `${r.word !== word.toLowerCase() ? `<p class="hint small">もとの形：<b>${esc(r.word)}</b></p>` : ''}<ol class="senses">${r.senses.slice(0, 6).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '<p class="hint">この辞書には載っていなかった。</p>'}`
    + (sent ? `<p class="ex">${esc(sent)}</p>` : '')
    + `<label class="sr" for="wMean">意味（直せる）</label><input type="text" id="wMean" value="${esc(wordPick.mean)}" placeholder="意味を自分で書く" autocomplete="off">`
    + `<div class="row"><a class="btn ghost small" href="https://ejje.weblio.jp/content/${encodeURIComponent(wordPick.word)}" target="_blank" rel="noopener">Weblio</a><span class="grow"></span>${has ? '<span class="okmark">単語帳にある</span>' : '<button class="btn small" data-act="wordAdd">単語帳に足す</button>'}</div></div>`);
}
async function addWord(word, mean, sent, from) {
  const wb = wordBox(); if (!wb) return;
  await store.addCard({ box_id: wb.id, kind: 'row', labels: ['word'], body: [word, mean || '', sent || '', from || ''].join('\n'), seq: 0 });
  await loadMeta(); knownSet.add(word.toLowerCase());
  toast(`「${word}」を単語帳に足した`);
  backfill();
}
// 単語帳の箱：新しい順。覚えたら「覚えた」（納得と同じ数え方）
function wordsBody() {
  const { b, cards } = boxCtx, w = boxCtx.writing || {};
  const list = cards.filter((c) => c.kind === 'row' && c.box_id === b.id && (c.labels || []).includes('word')).sort((a, c) => c.created_at.localeCompare(a.created_at));
  const ok = list.filter((c) => c.ok_at).length;
  return `<section><form class="pform" data-form="word"><input type="text" name="word" placeholder="単語を足す（例：accrual）" aria-label="単語" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn small">引いて足す</button></form>`
    + (list.length ? `<p class="hint small num">${list.length}語 · 覚えた ${ok}</p>` : '')
    + `<div class="words">${list.map((c) => {
      const [word, mean, sent, from] = c.body.split('\n');
      if (w.word === c.id) return `<form class="wform" data-form="wordEdit" data-edit="${c.id}"><b class="wd">${esc(word)}</b><input type="text" name="mean" value="${esc(mean || '')}" aria-label="意味" autocomplete="off"><textarea name="sent" rows="2" aria-label="例文">${esc(sent || '')}</textarea><div class="row"><button type="button" class="btn ghost small danger" data-act="wordDel" data-id="${c.id}">消す</button><button type="button" class="btn ghost small" data-act="trCancel">やめる</button><span class="grow"></span><button class="btn small">直す</button></div></form>`;
      return `<article class="word${c.ok_at ? ' ok' : ''}"><div class="wtop"><b class="wd glow">${esc(word)}</b><button class="gen fix" data-act="wordEditOpen" data-id="${c.id}">直す</button><button class="gen wok${c.ok_at ? ' on' : ''}" data-act="wordOk" data-id="${c.id}">${c.ok_at ? '覚えた' : 'まだ'}</button></div>`
        + (mean ? `<p class="wm">${esc(mean)}</p>` : '') + (sent ? `<p class="ex">${esc(sent)}</p>` : '') + `<p class="d num">${dlabel(c.created_at)}${from ? ' · ' + esc(from) : ''}</p></article>`;
    }).join('') || '<p class="hint">まだない。英字新聞の記事で単語を押すと、ここに足せる。</p>'}</div></section>`;
}

// ---- 取り込む（Claude Code が content/ に書き出したファイル） ----
let impPlan = null;
function openImport() {
  impPlan = null;
  openModal('取り込む', `<p class="hint">Claude Code が書き出したファイル（content/ の .json）を選ぶ。何度入れても同じ結果になり、納得や追記は消えない。</p>`
    + `<input type="file" id="impFile" accept=".json,application/json" aria-label="取り込むファイル">`
    + `<details class="imp-paste"><summary>ファイルではなく貼り付ける</summary><textarea id="impText" class="copybox" placeholder="ここに貼る"></textarea></details><div id="impPrev" aria-live="polite"></div>`);
}
function previewImport(text) {
  impPlan = null;
  try {
    const plan = readImport(text, byKey);
    const n = (k, x, u) => (x[k].length ? `${u} ${x[k].length}` : '');
    $('impPrev').innerHTML = '<ul class="imp-list">' + plan.map((x) => `<li><b>${esc(x.b.title)}</b>　${[n('secs', x, '節'), n('paras', x, '段落'), n('trans', x, '私語訳'), x.diagrams ? `図 ${x.diagrams}` : '', n('rows', x, '行')].filter(Boolean).join('・') || '中身なし'}</li>`).join('') + '</ul>'
      + '<button class="btn" data-act="impGo">入れる</button>';
    impPlan = plan;
  } catch (e) { $('impPrev').innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}

// ---- 意味の計算待ちを、裏で少しずつ ----
let filling = false;
// 書いている最中・書いた直後は待つ（iPhone では計算が重く、手元がもたつくので）。少しずつ、手が止まっているときだけ進める
let lastTouch = 0;
const busy = () => Date.now() - lastTouch < 4000 || /^(TEXTAREA|INPUT)$/.test((document.activeElement || {}).tagName || '');
const waitIdle = async () => { while (busy() || document.hidden) await new Promise((r) => setTimeout(r, 1500)); };
async function backfill() {
  if (filling) return;
  filling = true;
  let done = 0;
  try {
    const seen = new Set();
    for (;;) {
      await waitIdle();
      const rows = (await store.pending(6)).filter((r) => !seen.has(r.t + r.id));
      if (!rows.length) break;
      rows.forEach((r) => seen.add(r.t + r.id));
      if (modelReady) status(`意味を計算中…（${done} 件済み）`);
      const vecs = await embed(rows.map((r) => r.body.slice(0, 1200)));
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
  if (f.dataset.form === 'knote' || f.dataset.form === 'knPaste') {
    try {
      if (f.dataset.form === 'knote') await knSave(f.dataset.kn, String(fd.get('body') || '').replace(/\s+$/, ''));
      else {
        const lines = notionLines(fd.get('body'));
        if (!lines.length) { toast('入れるものがなかった'); return; }
        await addMise(lines); closeModal(); toast(`${lines.length}行を未整理に入れた`);
      }
      boxCtx.writing = null; boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); backfill();
    } catch (err) { fail(err); }
    return;
  }
  if (f.dataset.form === 'kamoku') {
    try {
      const t = String(fd.get('title') || '').trim(), par = byKey.get(String(fd.get('parent'))); if (!t || !par) return;
      const key = `${par.key}/${t}`;
      if (!byKey.has(key)) { await store.seedNodes([{ shelf: 'kamoku', key, parent_key: par.key, title: t, sort: `${par.sort}.9.${t}`, is_box: true }]); await loadLibrary(); }
      closeModal(); location.hash = `#/n/${byKey.get(key).id}`;
    } catch (err) { fail(err); }
    return;
  }
  if (f.dataset.form === 'word' || f.dataset.form === 'wordEdit') {
    try {
      if (f.dataset.form === 'word') {
        const w = String(fd.get('word') || '').trim(); if (!w) return;
        const r = /^[A-Za-z]/.test(w) ? await import('./dict.js').then((m) => m.lookup(w)).catch(() => null) : null;
        const word = r ? r.word : w.toLowerCase();
        if ((await loadKnown()).has(word)) { toast(`「${word}」はもうある`); return; }
        await addWord(word, r ? r.senses.slice(0, 2).join(' / ') : '', '', '');
      } else {
        const c = boxCtx.cards.find((x) => x.id === f.dataset.edit), [word, , , from] = c.body.split('\n');
        await store.patchCard(c.id, { body: [word, String(fd.get('mean') || '').trim(), String(fd.get('sent') || '').trim(), from || ''].join('\n'), embedding: null });
        boxCtx.writing = null;
      }
      boxCtx.cards = await store.cards(boxCtx.b.id); redraw();
    } catch (err) { fail(err); }
    return;
  }
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
    } else if (f.dataset.form === 'book') {
      const edit = f.dataset.edit;
      const meta = { author: String(fd.get('author') || '').trim(), start: fd.get('start') || '', end: fd.get('end') || '' };
      books = (await store.kvGet('books')) || {};
      let id = edit;
      if (edit) await store.patchNode(edit, { title: body, sort: `003.${meta.start || '9999'}` });
      else {
        const key = `hon/${crypto.randomUUID().slice(0, 8)}`;
        await store.seedNodes([{ shelf: 'hon', key, parent_key: 'hon', title: body, sort: `003.${meta.start || '9999'}`, is_box: true }]);
        await loadLibrary(); id = byKey.get(key).id;
      }
      books[id] = meta; await store.kvSet('books', books);
      await loadLibrary(); closeModal(); toast(edit ? '直した' : '本を足した');
      const h = `#/n/${id}`; if (location.hash === h) render(); else location.hash = h;
      return;
    } else if (f.dataset.form === 'diary') {
      const date = String(fd.get('date') || localDay()), edit = f.dataset.edit;
      const box = await monthBox(date.slice(0, 7));
      const t = new Date(); const at = new Date(`${date}T${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:00`).toISOString();
      if (edit) await store.patchCard(edit, { body, box_id: box.id, created_at: at, embedding: null });
      else await store.addCard({ box_id: box.id, kind: 'note', body, created_at: at });
      const from = boxCtx && boxCtx.fromSticky;
      if (from) await store.removeSticky(from);
      toast(from ? '書いた。付箋ははがした' : edit ? '直した' : '書いた'); closeModal(); backfill();
      const h = `#/n/${box.id}`;
      if (location.hash === h && !from) { boxCtx.writing = null; boxCtx.cards = await store.cards(box.id); redraw(); loadMeta().catch(() => {}); } else location.hash = h;
      return;
    } else if (f.dataset.form === 'pitem') {
      const edit = f.dataset.edit;
      if (edit) await store.patchCard(edit, { body, embedding: null });
      else {
        const part = f.dataset.part, tag = f.dataset.tag;
        const seq = boxCtx.cards.filter((c) => c.kind === 'row' && c.box_id === boxCtx.b.id).length;
        await store.addCard({ box_id: boxCtx.b.id, kind: 'row', labels: [part], tags: tag ? [tag] : [], body, seq });
        if (tag && !boxCtx.links.some((l) => (l.a === tag || l.b === tag))) { await store.addLink(boxCtx.b.id, tag); boxCtx.links = await store.links(boxCtx.b.id); }
      }
      boxCtx.writing = null; boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); backfill();
      const again = f.dataset.tag ? document.querySelector(`.pform[data-part="point"][data-tag="${f.dataset.tag}"] input`) : document.querySelector(`.pform[data-part="${f.dataset.part}"] input`);
      if (!edit) again?.focus({ preventScroll: true });
      return;
    } else if (f.dataset.form === 'bookText') {
      const main = boxCtx.cards.find((c) => c.kind === 'trans' && c.box_id === boxCtx.b.id && !c.section_id);
      if (main) await store.patchCard(main.id, { body, embedding: null });
      else await store.addCard({ box_id: boxCtx.b.id, kind: 'trans', seq: 0, body });
      boxCtx.writing = null; boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); toast('しまった'); backfill();
      return;
    } else if (f.dataset.form === 'trans') {
      const secId = f.dataset.sec, editing = f.dataset.edit;
      const para = f.dataset.para, old = editing && boxCtx.cards.find((c) => c.id === editing);
      const want = para ? [] : String(fd.get('refs') || '').split(/[,、，\s]+/).map((x) => z2h(x).replace(/^第|項$/g, '').toUpperCase()).filter(Boolean);
      const para_ids = para ? (old ? old.para_ids : [para]) : boxCtx.paras.filter((p) => want.includes(String(p.label).toUpperCase())).map((p) => p.id);
      const miss = want.filter((l) => !boxCtx.paras.some((p) => String(p.label).toUpperCase() === l));
      if (editing) { await store.patchCard(editing, { body, para_ids, labels: [], embedding: null }); Object.assign(old, { body, para_ids, labels: [] }); }
      else {
        const seq = Math.max(0, ...boxCtx.cards.filter((c) => c.kind === 'trans' && c.section_id === secId).map((c) => c.seq || 0)) + 1;
        boxCtx.cards.push(await store.addCard({ box_id: boxCtx.b.id, kind: 'trans', section_id: secId, seq, body, para_ids }));
      }
      boxCtx.writing = null;
      redraw(); loadMeta().catch(() => {});
      toast(miss.length ? `${editing ? '直した' : '書いた'}。見つからない項：${miss.join('、')}` : editing ? '直した' : '書いた');
      backfill();
    } else if (f.dataset.form === 'row') {
      const seq = boxCtx.cards.filter((c) => c.kind === 'row').length;
      const ax = fd.get('axis');
      await store.addCard({ box_id: boxCtx.b.id, kind: 'row', axis: ax === 'zenpan' ? null : ax, labels: ax === 'zenpan' ? [...fd.getAll('labels'), 'zenpan'] : fd.getAll('labels'), body, seq });
      boxCtx.writing = { adding: true }; boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); backfill();
    } else if (f.dataset.form === 'rowEdit') {
      const ax = fd.get('axis');
      await store.patchCard(f.dataset.edit, { axis: ax === 'zenpan' ? null : ax, labels: ax === 'zenpan' ? [...fd.getAll('labels'), 'zenpan'] : fd.getAll('labels'), body, embedding: null });
      boxCtx.writing = null; boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); backfill();
    }
  } catch (err) { fail(err); }
});

document.addEventListener('click', async (e) => {
  const mk = e.target.closest('mark[data-pid]');
  if (mk && getSelection().isCollapsed) { pendingMark = { add: false, pid: mk.dataset.pid, mi: +mk.dataset.mi }; markBar('このマーカーを消す', true); return; }
  if (pendingMark && !pendingMark.add && !e.target.closest('#markBtn')) { pendingMark = null; markBar('', false); }
  const tp = e.target.closest('svg .tip');
  if (tp) { const line = tp.closest('section').querySelector('.tipline'); if (line) line.textContent = tp.dataset.tip; document.querySelectorAll('svg .tip.on').forEach((x) => x.classList.remove('on')); tp.classList.add('on'); return; }
  const wd = e.target.closest('.article .w');
  if (wd && getSelection().isCollapsed) { const h = $('view').querySelector('.article-t'); openWord(wd.textContent, sentenceOf(wd), h ? h.textContent : ''); return; }
  const act = e.target.closest('[data-act]'); if (!act) return;
  const d = act.dataset;
  try {
    switch (d.act) {
      case 'mclose': closeModal(); return;
      case 'picked': { const cb = pickCb; closeModal(); if (cb) await cb(byId.get(d.id)); return; }
      case 'bullet': {   // 今の行の頭に「・」をつける（ついていたら外す）
        const t = fmtTarget(act); const v = t.value, at = t.selectionStart;
        const st = v.lastIndexOf('\n', at - 1) + 1;
        if (v.startsWith('・', st)) { const k = v.startsWith('・ ', st) ? 2 : 1; t.value = v.slice(0, st) + v.slice(st + k); t.setSelectionRange(Math.max(st, at - k), Math.max(st, at - k)); }
        else { t.value = v.slice(0, st) + '・ ' + v.slice(st); t.setSelectionRange(at + 2, at + 2); }
        t.focus(); return;
      }
      case 'numbered': {   // 今の行の頭に、上の行の続きの番号をつける（ついていたら外す）
        const t = fmtTarget(act); const v = t.value, at = t.selectionStart;
        const st = v.lastIndexOf('\n', at - 1) + 1;
        const cur = v.slice(st).split('\n')[0].match(NUM_RE);
        if (cur) { const k = v.slice(st).indexOf(cur[2]) ; t.value = v.slice(0, st) + v.slice(st + k); t.setSelectionRange(Math.max(st, at - k), Math.max(st, at - k)); t.focus(); return; }
        const prev = st > 0 ? v.slice(v.lastIndexOf('\n', st - 2) + 1, st - 1).match(NUM_RE) : null;
        const mk = (prev ? nextNum(prev[1]) : '①') + ' ';
        t.value = v.slice(0, st) + mk + v.slice(st); t.setSelectionRange(at + mk.length, at + mk.length); t.focus(); return;
      }
      case 'diaryNew': { const b = await monthBox(localDay().slice(0, 7)); location.hash = `#/n/${b.id}`; return; }
      case 'diaryEdit': boxCtx.writing = { diary: d.id }; redraw(); $('trBody')?.focus({ preventScroll: true }); return;
      case 'stDiary': { const st = stickies.find((x) => x.id === d.id); const b = await monthBox(localDay(new Date(st ? st.created_at : Date.now())).slice(0, 7)); location.hash = `#/n/${b.id}?from=${d.id}`; return; }
      case 'knEdit': boxCtx.writing = { kn: d.kn }; redraw(); $('trBody')?.focus({ preventScroll: true }); return;
      case 'knPaste': openModal('Notion から貼る', `<form class="trform" data-form="knPaste"><p class="hint small">ページの中身をまるごと貼る。1行ずつ「未整理」に入るので、あとで枠を選んで振り分ける。見出し（#）・空行・「特になし」は入れない。字下げした行は、上の行の続きになる。</p><label class="sr" for="knText">貼る</label><textarea id="knText" name="body" rows="12"></textarea><div class="row"><span class="grow"></span><button class="btn small">分けて入れる</button></div></form>`); return;
      case 'rowEdit': boxCtx.writing = { row: d.id }; redraw(); $('trBody')?.focus({ preventScroll: true }); return;
      case 'miseLab': {
        const c = boxCtx.cards.find((x) => x.id === d.id); const on = (c.labels || []).includes(d.l);
        c.labels = on ? c.labels.filter((x) => x !== d.l) : [...c.labels, d.l];
        await store.patchCard(c.id, { labels: c.labels }); redraw(); return;
      }
      case 'miseTo': {
        const c = boxCtx.cards.find((x) => x.id === d.id), labs = (c.labels || []).filter((x) => x !== 'mise');
        if (d.ax === 'kiso') { const k = knCard('kiso'); await knSave('kiso', (k ? k.body + '\n' : '') + c.body); await store.removeCard(c.id); }
        else await store.patchCard(c.id, d.ax === 'zenpan' ? { axis: null, labels: [...labs, 'zenpan'] } : { axis: d.ax, labels: labs });
        boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); return;
      }
      case 'oldToMise': {
        const old = boxCtx.cards.filter((c) => c.kind === 'trans' && c.box_id === boxCtx.b.id && (c.labels || []).some((l) => /^kn:(?!kiso)/.test(l)));
        await addMise(old.flatMap((c) => notionLines(c.body)));
        for (const c of old) await store.removeCard(c.id);
        boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); return;
      }
      case 'heading': {   // 今の行の頭に「■」をつける（ついていたら外す）
        const t = fmtTarget(act); const v = t.value, at = t.selectionStart;
        const st = v.lastIndexOf('\n', at - 1) + 1;
        if (v.startsWith('■', st)) { const k = v.startsWith('■ ', st) ? 2 : 1; t.value = v.slice(0, st) + v.slice(st + k); t.setSelectionRange(Math.max(st, at - k), Math.max(st, at - k)); }
        else { t.value = v.slice(0, st) + '■ ' + v.slice(st); t.setSelectionRange(at + 2, at + 2); }
        t.focus(); return;
      }
      case 'kamokuAdd': {
        const groups = nodes.filter((n) => n.shelf === 'kamoku' && !n.is_box).sort((a, b) => a.sort.localeCompare(b.sort));
        openModal('科目を足す', `<form class="bookform" data-form="kamoku"><label for="kTitle">科目の名前</label><input type="text" id="kTitle" name="title" placeholder="例：未収入金、ソフトウェア" autocomplete="off" required>`
          + `<label for="kPar">入れる場所</label><select id="kPar" name="parent">${groups.map((g) => `<option value="${esc(g.key)}"${g.key === d.parent ? ' selected' : ''}>${esc(pathOf(g).map((x) => x.title).join(' › '))}</option>`).join('')}</select>`
          + `<div class="row"><span class="grow"></span><button class="btn">足す</button></div></form>`);
        $('kTitle').focus(); return;
      }
      case 'procAdd': {
        const t = (prompt('手続の名前（例：残高確認、売上の詳細テスト）') || '').trim(); if (!t) return;
        const key = `genba/${t}`;
        if (!byKey.has(key)) { await store.seedNodes([{ shelf: 'genba', key, parent_key: 'genba', title: t, sort: `004.9.${t}`, is_box: true }]); await loadLibrary(); }
        location.hash = `#/n/${byKey.get(key).id}`; return;
      }
      case 'pEdit': boxCtx.writing = { item: d.id }; redraw(); $('trBody')?.focus({ preventScroll: true }); return;
      case 'pDel': await store.removeCard(d.id); boxCtx.writing = null; boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); return;
      case 'pCheck': {
        const c = boxCtx.cards.find((x) => x.id === d.id); const on = (c.labels || []).includes('checked');
        c.labels = on ? c.labels.filter((x) => x !== 'checked') : [...c.labels, 'checked'];
        await store.patchCard(c.id, { labels: c.labels }); redraw(); return;
      }
      case 'pUncheck':
        for (const c of boxCtx.cards.filter((x) => x.box_id === boxCtx.b.id && (x.labels || []).includes('checked'))) { c.labels = c.labels.filter((x) => x !== 'checked'); await store.patchCard(c.id, { labels: c.labels }); }
        redraw(); toast('チェックを外した。次の現場へ'); return;
      case 'pTag': openPicker('どの科目の論点？', (k) => { if (!k) return; boxCtx.writing = { tag: k.id }; redraw(); document.querySelector(`.pform[data-tag="${k.id}"] input`)?.focus(); }); return;
      case 'bookAdd': openBookForm(null); return;
      case 'bookEdit': openBookForm(boxCtx.b); return;
      case 'bookWrite': boxCtx.writing = { book: true }; redraw(); $('trBody')?.focus({ preventScroll: true }); return;
      case 'bookDel': {
        if (!confirm('この本と、中に書いたもの（中身・追記）をぜんぶ消す？元に戻せない。')) return;
        await store.removeNode(d.id); books = (await store.kvGet('books')) || {}; delete books[d.id]; await store.kvSet('books', books);
        await loadLibrary(); closeModal(); toast('消した'); location.hash = '#/s/hon'; return;
      }
      case 'goPara': e.preventDefault(); goPara(d.label); return;
      case 'copyOrig': { const p = (boxCtx ? boxCtx.paras : prepParas).find((x) => x.id === d.pid) || prepParas.find((x) => x.id === d.pid); if (p) copy(`${p.label ? p.label + '　' : ''}${p.body}`, '原文をコピーした'); return; }
      case 'copySec': { const own = boxCtx.paras.filter((p) => p.section_id === d.id); const s = boxCtx.secs.find((x) => x.id === d.id); copy(`${boxCtx.b.title}　${s.title}\n\n` + own.map((p) => `${p.label ? p.label + '　' : ''}${p.body}`).join('\n\n'), '節の原文をコピーした'); return; }
      case 'fold': boxCtx.fold = !boxCtx.fold; try { localStorage.setItem('yuri-fold', boxCtx.fold ? '1' : ''); } catch {} redraw(); return;
      case 'pOpen': { const bd = act.nextElementSibling; bd.hidden = !bd.hidden; act.setAttribute('aria-expanded', String(!bd.hidden)); act.classList.toggle('on', !bd.hidden); return; }
      case 'gen': { const side = act.closest('.line').querySelector('.side'); side.hidden = !side.hidden; act.setAttribute('aria-expanded', String(!side.hidden)); act.classList.toggle('on', !side.hidden); return; }
      case 'pair': boxCtx.pair = !boxCtx.pair; redraw(); return;
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
      case 'trAdd': boxCtx.writing = { sec: d.id, para: d.para || null }; redraw(); $('trBody')?.focus({ preventScroll: true }); return;
      case 'trEdit': { const c = boxCtx.cards.find((x) => x.id === d.id); boxCtx.writing = { sec: c.section_id, card: c.id }; redraw(); $('trBody')?.focus({ preventScroll: true }); return; }
      case 'trCancel': boxCtx.writing = null; redraw(); return;
      case 'trDel': {
        if (!confirm('この行を消す？')) return;
        const c = boxCtx.cards.find((x) => x.id === d.id);
        await store.removeCard(d.id); boxCtx.writing = null;
        boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); toast('消した'); return;
      }
      case 'mark': await applyMark(); return;
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
      case 'lettersMore': { const y = scrollY; await loadLetters(true); redraw(); scrollTo(0, y); return; }
      case 'wordAdd': { const w = wordPick; if (!w) return; await addWord(w.word, $('wMean')?.value.trim() || w.mean, w.sent, w.from); closeModal(); const kn = new Set([w.word]); document.querySelectorAll('.article .w').forEach((n) => { if (knownForm(kn, n.textContent)) n.classList.add('saved'); }); return; }
      case 'wordOk': { const c = boxCtx.cards.find((x) => x.id === d.id); await store.patchCard(c.id, { ok_at: c.ok_at ? null : new Date().toISOString() }); boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); return; }
      case 'wordEditOpen': boxCtx.writing = { word: d.id }; redraw(); return;
      case 'wordDel': if (!confirm('この単語を消す？')) return; await store.removeCard(d.id); boxCtx.writing = null; boxCtx.cards = await store.cards(boxCtx.b.id); redraw(); loadMeta().catch(() => {}); toast('消した'); return;
      case 'spring': { const r = await store.spring(); if (r && $('springOne')) $('springOne').innerHTML = springCard(r); return; }
      case 'izumiMore': viewIzumi(renderSeq, true); return;
      case 'import': openImport(); return;
      case 'impGo': {
        const plan = impPlan; if (!plan) return;
        act.disabled = true; act.textContent = '入れてる…';
        const done = await runImport(store, plan);
        impPlan = null; closeModal(); await loadMeta(); toast(`入れた：${done.map((b) => b.title).join('、')}`); backfill();
        const h = `#/n/${done[0].id}`; if (location.hash === h) render(); else location.hash = h;
        return;
      }
      case 'logout': await store.signOut(); location.reload(); return;
    }
  } catch (err) { fail(err); }
});
// 箇条書き・番号の行で改行したら、次の行も「・」や次の番号で始める（空の行で改行したら終える）
for (const ev of ['input', 'pointerdown', 'submit']) document.addEventListener(ev, () => { lastTouch = Date.now(); }, true);
// 日本語入力の確定の Enter では、番号・「・」を続けない
let compEnd = 0;
document.addEventListener('compositionend', () => { compEnd = Date.now(); }, true);
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (e.isComposing || e.keyCode === 229 || Date.now() - compEnd < 300) return;
  if (t.tagName !== 'TEXTAREA' || t.id === 'knText' || e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
  const v = t.value, at = t.selectionStart, st = v.lastIndexOf('\n', at - 1) + 1;
  const line = v.slice(st, at);
  const num = line.match(NUM_RE);
  if (!/^・/.test(line) && !num) return;
  e.preventDefault();
  if (/^・\s*$/.test(line) || (num && !num[2].trim())) { t.value = v.slice(0, st) + v.slice(at); t.setSelectionRange(st, st); return; }
  const ins = '\n' + (num ? nextNum(num[1]) : '・') + ' ';
  t.value = v.slice(0, at) + ins + v.slice(t.selectionEnd); t.setSelectionRange(at + ins.length, at + ins.length);
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'impFile' && e.target.files[0]) previewImport(await e.target.files[0].text());
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'pickQ') drawPick(e.target.value);
  if (e.target.id === 'impText') { clearTimeout(qTimer); const v = e.target.value; qTimer = setTimeout(() => v.trim() && previewImport(v), 300); }
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
