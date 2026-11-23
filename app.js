import { supabaseStore, memoryStore } from './store.js';
import { lookup } from './dict.js';
import { LENSES, lensLabel, loadProtos, classify, isHandoff, wordsFromMine, wordsFromMail, KINDS, kindOf, mostlyEnglish, learnKind, kindFields } from './lens.js';
import { currentScene, hereRounded, sceneLabel, parseSceneQuery } from './scene.js';
import { shrink, readText } from './photo.js';
import { isbnFromPhoto, lookupIsbn, searchBooks } from './book.js';
import { readFiles, parsePage, pillarToText, textToSections, role, TEMPLATES } from './notion.js';
import { openSky, placeNear } from './sky.js';

// ---- 調整つまみ（関係ない文どうしは 0.1〜0.3、近い話は 0.4 以上になりやすい） ----
const RIPPLE_MIN = 0.40;   // 波紋に出す近さ
const THREAD_MIN = 0.36;   // 糸の先に出す近さ
const SEARCH_MIN = 0.30;   // 探すときに出す近さ（文字が含まれていれば常に出す）
const PILLAR_MIN = 0.50;   // 柱の見出しに寄ってくる近さ
const MARK_MIN = 0.47;    // 長い投げ込みで「強くつながっている段落」に印をつける近さ
const PILLAR_LINK = 0.50;  // 柱どうしを糸でつなぐ近さ
const SUGGEST_NEAR = 0.50; // 柱の提案：このくらい近いかけらが
const SUGGEST_COUNT = 4;   //   これだけ（投げたものと合わせて5つ）集まったら
const NO_PILLAR = 0.45;    //   ただし、すでにこのくらい近い柱があれば聞かない
const RECENT_DAYS = 3;     // 地層に出すのは最近の数日だけ
const GO_WAIT = 20 * 60e3; // 「行ってくる」から「どうだった？」まで

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const mine = (it) => !it.source || it.source === 'hand';

// ---- 保存先 ----
const demo = new URLSearchParams(location.search).has('demo');
const cfg = window.KAKERA_CONFIG || {};
let store;
if (demo) { store = memoryStore(); window.__kakera = { get store() { return store; }, embed: (...a) => embed(...a), loadWord: () => loadWord(), kvs: () => kvs, renderAsks: () => renderAsks() }; }
else if (cfg.supabaseUrl && cfg.supabaseKey) {
  store = supabaseStore(window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  }));
}

// ---- 埋め込み（別スレッドで動かす） ----
const worker = new Worker(new URL('./embed-worker.js', import.meta.url), { type: 'module' });
let modelReady = false, reqId = 0;
const waiting = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    const pct = m.total ? Math.round((m.loaded / m.total) * 100) : 0;
    $('model').textContent = `泉の準備中（初回だけ・この端末に保存）… ${pct}%`;
    return;
  }
  if (m.type === 'ready') { modelReady = true; $('model').textContent = ''; return; }
  const w = waiting.get(m.id); if (!w) return;
  waiting.delete(m.id);
  m.error ? w.reject(new Error(m.error)) : w.resolve(m.vectors);
};
const embed = (texts, kind) => new Promise((resolve, reject) => {
  const id = ++reqId; waiting.set(id, { resolve, reject });
  worker.postMessage({ id, texts, kind });
});

// ---- 長文は段落に ----
const MAX = 260;
function splitParas(text) {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (t.length <= MAX) return [t];
  const out = [];
  for (const block of t.split(/\n\s*\n/)) {
    const b = block.trim(); if (!b) continue;
    if (b.length <= MAX * 1.6) { out.push(b); continue; }
    let cur = '';
    for (const s of b.split(/(?<=[。．！？!?\n]|\.\s)/)) {
      if (cur && (cur + s).length > MAX) { out.push(cur.trim()); cur = ''; }
      cur += s;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  const merged = [];
  for (const p of out) {
    if (merged.length && (p.length < 40 || merged[merged.length - 1].length < 40)) merged[merged.length - 1] += '\n\n' + p;
    else merged.push(p);
  }
  return merged;
}

// ---- 表示まわり ----
const pad = (n) => String(n).padStart(2, '0');
const dlabel = (iso) => { const d = new Date(iso); return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()); };
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const relDay = (iso) => { const n = Math.round((dayStart(Date.now()) - dayStart(iso)) / DAY); return n === 0 ? '（今日）' : n === 1 ? '（昨日）' : ''; };
const dkey = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
const known = new Map(); // id -> row（開くときに使う）
const gkey = (it) => it.group_id || it.id;
// 同じ投げ込み（メルマガ1通など）は1つにまとめる。並びは先に出たものを残す
const oneEach = (list) => { const seen = new Set(); return list.filter((r) => { const g = gkey(r); if (seen.has(g)) return false; seen.add(g); return true; }); };
const isMail = (it) => it.source === 'gmail' || it.source === 'yahoo';
const thumbOf = (p) => p.replace(/\.jpg$/, '_t.jpg');
const short = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
const bookTitle = (id) => (books.find((b) => b.id === id) || {}).title || '本';
const tag = (it, more = 0) => [
  it.pinned_at ? '📌' : '', isMail(it) ? 'メルマガ' : '', it.source === 'notion' ? 'Notion' : '',
  it.book_id ? '📖 ' + esc(short(bookTitle(it.book_id), 16)) : '', more ? `全 ${more + 1} 段落` : '',
].filter(Boolean).map((t) => ' · ' + t).join('');
const EM_WORDS = /([A-Za-z][A-Za-z'’-]{2,}(?:\s+[A-Za-z][A-Za-z'’-]{2,})*|\d+(?:[.,:/]\d+)*)/;
const EM_NUMS = /(\d+(?:[.,:/]\d+)*)/;
const emph = (str, re) => String(str).split(re).map((x, i) => (i % 2 ? `<b class="em">${esc(x)}</b>` : esc(x))).join('');
const HEAD = /^([^。：:！!？?\n]{1,48}[。：:！!？?\n])([\s\S]+)$/;
const shape = (k) => `<svg class="sh" viewBox="0 0 11 11" aria-hidden="true">${KINDS[k][1]}</svg>`;
// opt.more：同じ投げ込みのほかの段落の数 / opt.note：右下に添える一言
const card = (it, cls = '', opt = {}) => {
  known.set(it.id, it);
  const k = kindOf(it), re = mostlyEnglish(it.body) ? EM_NUMS : EM_WORDS;
  const m = it.body.match(HEAD), head = (m ? m[1] : it.body).trim(), rest = m ? m[2].trim() : '';
  const thumb = it.image_path ? `<img class="thumb" data-path="${esc(thumbOf(it.image_path))}" alt="">` : '';
  return `<button class="k kd-${k} ${cls}${thumb ? ' has-thumb' : ''}" data-id="${it.id}">${thumb}<span class="d">${shape(k)}<span class="kl">${KINDS[k][0]}</span>${dlabel(it.created_at)}${tag(it, opt.more)}</span>`
    + `<span class="h1">${emph(head, re)}</span>${rest ? `<span class="rest clip">${emph(rest, re)}</span>` : ''}${opt.note ? `<span class="note">${esc(opt.note)}</span>` : ''}</button>`;
};

// 写真のサムネイルは、画面に出たときに署名付きURLを取りに行く
let hydrateTimer = 0;
new MutationObserver(() => { clearTimeout(hydrateTimer); hydrateTimer = setTimeout(hydrate, 60); }).observe(document.body, { childList: true, subtree: true });
async function hydrate() {
  const imgs = [...document.querySelectorAll('img[data-path]:not([src])')];
  if (!imgs.length || !store) return;
  try {
    const urls = await store.photoUrls([...new Set(imgs.map((i) => i.dataset.path))]);
    for (const i of imgs) if (urls[i.dataset.path]) i.src = urls[i.dataset.path];
  } catch (e) { console.error(e); }
}

let toastTimer = 0, lastDel = null;
function toast(msg, undo = false) {
  $('toastMsg').textContent = msg;
  $('toast').classList.toggle('plain', !undo);
  $('toast').classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('on'), 6000);
}
const fail = (e) => { console.error(e); toast('うまくいかなかった：' + (e.message || e)); };

// ---- ちょっとした状態（端末をまたいで同じに） ----
const kvs = {};
const KV_KEYS = ['book', 'places', 'going', 'weekly', 'asked_clusters', 'scan_handoff_v1'];
async function loadKv() {
  const vals = await Promise.all(KV_KEYS.map((k) => store.kvGet(k).catch(() => null)));
  KV_KEYS.forEach((k, i) => { kvs[k] = vals[i]; });
}
async function setKv(k, v) { kvs[k] = v; await store.kvSet(k, v); }

// どの一覧に入っていても、同じかけらの中身をそろえる
function patchLocal(id, fields) {
  for (const r of [...strata, ...hits, ...pins, ...agoRows, known.get(id)].filter(Boolean)) if (r.id === id) Object.assign(r, fields);
}

// ---- 地層 ----
let strata = [], sunk = false, curLens = null;
async function loadStrata() {
  const since = new Date(dayStart(Date.now()) - (RECENT_DAYS - 1) * DAY).toISOString();
  const [rows, older] = await Promise.all([store.recent(null, 1000, curLens, since), store.recent(since, 1, curLens)]);
  strata = rows; sunk = older.length > 0;
  renderStrata();
}
// 同じ投げ込みは最初の段落1枚に（段落の数を添える）
function groupCards(list) {
  const count = new Map();
  for (const it of list) count.set(gkey(it), (count.get(gkey(it)) || 0) + 1);
  const firsts = new Map();
  for (const it of list) { const g = gkey(it), f = firsts.get(g); if (!f || it.seq < f.seq) firsts.set(g, it); }
  return oneEach(list).map((it) => card(firsts.get(gkey(it)), '', { more: count.get(gkey(it)) - 1 }));
}
function renderStrata() {
  $('strataTitle').textContent = curLens ? `最近のかけら（${lensLabel(curLens)}）` : '最近のかけら';
  const sunkNote = sunk ? '<div class="sunk"><div class="bar"></div><p>それより前のかけらは底に沈んでる。探したときと、湧いてきたときにだけ出てくるよ。</p></div>' : '';
  if (!strata.length) { $('strata').innerHTML = (curLens ? '<p class="empty">この数日、このレンズのかけらはない。</p>' : '<p class="empty">この数日はまだ何も投げてない。</p>') + sunkNote; return; }
  const days = []; let cur = null;
  for (const it of strata) {
    const k = dkey(it.created_at);
    if (!cur || cur.k !== k) { cur = { k, t: it.created_at, list: [] }; days.push(cur); }
    cur.list.push(it);
  }
  $('strata').innerHTML = days.map((g, i) => `<div class="layer" style="--p:${Math.min(20 + i * 25, 100)}%"><div class="bar"></div><div><h3>${dlabel(g.t)}${relDay(g.t)}</h3><div class="list">${groupCards(g.list).join('')}</div></div></div>`).join('') + sunkNote;
}

// ---- 1年前のこのころ（同じ日の前後1週間を年ごとに） ----
let agoRows = [];
async function loadAgo() {
  const now = new Date();
  const years = await Promise.all([1, 2, 3, 4, 5].map(async (y) => {
    const c = new Date(now); c.setFullYear(now.getFullYear() - y); c.setHours(0, 0, 0, 0);
    const rows = await store.between(new Date(c.getTime() - 7 * DAY).toISOString(), new Date(c.getTime() + 8 * DAY).toISOString());
    return { y, c, rows };
  })).catch(() => []);
  const got = years.filter((x) => x.rows.length);
  agoRows = got.flatMap((x) => x.rows);
  $('ago').innerHTML = got.length ? `<h2>1年前のこのころ</h2>` + got.map(({ y, c, rows }) => {
    const cards = groupCards(rows);
    return `<div class="ago-year"><h3>${y}年前 · ${c.getMonth() + 1}月${c.getDate()}日の前後</h3><div class="list">${cards.slice(0, 3).join('')}`
      + (cards.length > 3 ? `<details class="more-cards"><summary>ほか ${cards.length - 3} 個</summary><div class="list">${cards.slice(3).join('')}</div></details>` : '') + '</div></div>';
  }).join('') : '';
}

// ---- 持ち出しの見張り：社名・人名・金額らしきもの ----
const NOT_PERSON = /^(皆|客|奥|神|お客|みな)/;
const LEAK = [
  ['社名', /株式会社|㈱|（株）|\(株\)|有限会社|合同会社|\b(?:Inc|Corp|LLC|Ltd)\b\.?|Co\.,\s?Ltd|ホールディングス|監査法人|[一-龥ァ-ヶA-Za-z]{2,8}銀行/g],
  ['人名', /[一-龥]{1,4}(?:さん|様|氏|部長|課長|社長|専務|常務|係長)/g],
  ['金額', /[¥￥$]\s?\d[\d,]*|\d[\d,.]*\s?(?:円|万円|億円|千円|百万円|ドル)|\d{1,3}(?:,\d{3})+/g],
];
function leaks(text) {
  const out = [];
  for (const [label, re] of LEAK) {
    let m = [...new Set(text.match(re) || [])];
    if (label === '人名') m = m.filter((x) => !NOT_PERSON.test(x));
    if (m.length) out.push(`${label}（${m.slice(0, 3).join('、')}）`);
  }
  return out;
}

// ---- 投げる ----
const PREP = /^(.{1,24}?)\s*(をやる|やる|やります|行ってくる|に行く|行く|いく)$/;
let throwing = false, pendingPhoto = null;
async function throwIt(opt = {}) {
  const text = $('inp').value.trim();
  const photo = pendingPhoto;
  if ((!text && !photo) || throwing) return;
  // 「〇〇やる」は保存せずに直前モードを開く
  if (!opt.plain && !photo) {
    const m = text.match(PREP);
    if (m && !/[。\n]/.test(text)) { openView({ t: 'prep', id: m[1].replace(/[をにへ]$/, '').trim() }); return; }
  }
  if (!opt.checked) {
    const found = leaks(text);
    if (found.length) {
      $('ripple').innerHTML = `<div class="guard"><p>投げる前にひとつだけ：${esc(found.join('・'))} っぽいものがある。会社の機密じゃない？</p>`
        + `<div class="row"><button class="ghost small" data-act="guardFix">やめて直す</button><button class="throw small" data-act="guardGo" data-plain="${opt.plain ? 1 : ''}">このまま投げる</button></div></div>`;
      return;
    }
  }
  throwing = true; $('throw').disabled = true;
  const s = $('surface'); s.classList.remove('go'); void s.offsetWidth; s.classList.add('go');
  const pin = $('pinThrow').getAttribute('aria-pressed') === 'true';
  const now = new Date().toISOString();
  const extra = { ...(pin ? { pinned_at: now } : {}), ...(curBook() ? { book_id: curBook().id } : {}) };
  try {
    $('inp').value = '';
    setPhoto(null);
    if (pin) $('pinThrow').setAttribute('aria-pressed', 'false');
    await sink(text || '（写真）', { extra, photo, suggest: true });
    if (pin) loadPins();
  } catch (e) { fail(e); }
  finally { throwing = false; $('throw').disabled = false; }
}

// 文字を沈めて、意味を持たせ、波紋を返す（投げる・答える の共通）
async function sink(text, { extra = {}, photo = null, suggest = false } = {}) {
  const paras = splitParas(text);
  const group_id = crypto.randomUUID();
  const now = new Date().toISOString();
  // 先に文字だけ沈める（モデルの準備がまだでも消えない）
  const rows = await store.insert(paras.map((body, seq) => ({ body, seq, group_id, created_at: now, ...extra })));
  rows.sort((a, b) => a.seq - b.seq);
  if (!curLens) { strata.unshift(...rows); renderStrata(); }
  $('ripple').innerHTML = `<div class="lab">沈んだよ${rows.length > 1 ? `（裏で ${rows.length} つの段落に分けた）` : ''}。波紋を待ってる…</div>`;
  // 情景（時間帯・天気・場所の雰囲気）はあとから添える
  currentScene(kvs.places).then((sc) => {
    if (!sc) return;
    for (const r of rows) { patchLocal(r.id, { scene: sc }); store.patch(r.id, { scene: sc }).catch(() => {}); }
  }).catch(() => {});
  try {
    if (photo) {
      const { full, thumb } = await shrink(photo);
      const path = await store.uploadPhoto(rows[0].id, full, thumb);
      await store.patch(rows[0].id, { image_path: path });
      patchLocal(rows[0].id, { image_path: path }); rows[0].image_path = path; renderStrata();
      $('ripple').innerHTML = '<div class="lab">沈んだよ。写真の文字を読んでる…（初回は読み取りの道具を取ってくるので少し待つ）</div>';
      let ocr = '';
      try { ocr = await readText(full, (st, p) => { $('model').textContent = `写真の文字を読んでる… ${Math.round(p * 100)}%`; }); } catch (e) { console.error(e); }
      $('model').textContent = '';
      if (ocr.replace(/\s/g, '').length >= 4) {
        const body = (text === '（写真）' ? '' : text + '\n\n') + '［写真の文字］\n' + ocr;
        await store.updateBody(rows[0].id, body);
        rows[0].body = body; patchLocal(rows[0].id, { body }); renderStrata();
      }
    }
    const vecs = await embed(rows.map((r) => r.body));
    await settle(rows, vecs, true);
    if (!curLens) renderStrata();
    const best = oneEach((await Promise.all(vecs.map((v) => store.match(v, 2, group_id)))).flat().sort((a, b) => b.similarity - a.similarity));
    const hit = best[0];
    $('ripple').innerHTML = hit && hit.similarity >= RIPPLE_MIN
      ? `<div class="lab">波紋：これと近いかも</div>${card(hit)}`
      : `<div class="lab">沈んだよ。まだ似たかけらはないみたい。</div>`;
    if (suggest && mine(rows[0])) {
      const sg = await suggestion(rows, vecs).catch(() => null);
      if (sg) showSuggestion(sg);
    }
  } catch (e) {
    $('ripple').innerHTML = '<div class="lab">沈んだよ。波紋はあとで届く。</div>';
    fail(e);
  }
  return rows;
}

// ---- 写真を添える ----
function setPhoto(file) {
  pendingPhoto = file;
  const box = $('photoPrev');
  if (box.dataset.url) URL.revokeObjectURL(box.dataset.url);
  if (!file) { box.hidden = true; box.innerHTML = ''; delete box.dataset.url; $('photoBtn').setAttribute('aria-pressed', 'false'); return; }
  const url = URL.createObjectURL(file);
  box.dataset.url = url;
  box.innerHTML = `<img src="${url}" alt="添える写真"><span>写真を添えて投げる。写っている文字も読んで、探せるようにするよ。</span><button class="ghost small" data-act="photoOff" aria-label="写真をやめる">✕</button>`;
  box.hidden = false;
  $('photoBtn').setAttribute('aria-pressed', 'true');
}

// ---- 探す ----
let hits = [], searchTimer = 0, searchSeq = 0, sceneNote = '';
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $('q').value.trim();
  if (!q) { hits = []; $('results').innerHTML = '<p class="empty">言葉がちがっても、日本語と英語をまたいでも、近いかけらが近い順に並ぶよ。「雨の朝」のように、投げたときの情景でも探せる。</p>'; return; }
  searchTimer = setTimeout(() => runSearch(q), 350);
}
async function runSearch(q) {
  const my = ++searchSeq;
  if (!modelReady) $('results').innerHTML = '<p class="empty">泉の準備中…</p>';
  try {
    const { words, rest } = parseSceneQuery(q);
    let rows;
    sceneNote = '';
    if (words.length && (!rest || words.length >= 2)) {
      // 情景で探す
      if (!rest) rows = (await store.byScene(words, 40)).filter((r) => !curLens || r.lens === curLens).map((r) => ({ ...r, similarity: 1, literal: true }));
      else {
        const [v] = await embed([rest]);
        rows = (await store.search(rest, v, 60, curLens)).filter((r) => r.scene && words.every((w) => r.scene.includes(w)) && (r.literal || r.similarity >= SEARCH_MIN));
      }
      sceneNote = `情景「${words.join('・')}」${rest ? `で「${rest}」に近いもの` : 'のときに投げたかけら'}`;
    }
    if (!rows || !rows.length) {
      const [v] = await embed([q]);
      rows = (await store.search(q, v, 24, curLens)).filter((r) => r.literal || r.similarity >= SEARCH_MIN);
      if (sceneNote) sceneNote += 'は見つからなかったので、言葉の意味で探した';
    }
    if (my !== searchSeq) return;
    hits = oneEach(rows).slice(0, 12);
    renderResults();
  } catch (e) { if (my === searchSeq) fail(e); }
}
function renderResults() {
  const note = sceneNote ? `<p class="scene-note">${esc(sceneNote)}</p>` : '';
  if (!hits.length) { $('results').innerHTML = note + '<p class="empty">近いかけらは見つからなかった。</p>'; return; }
  const lo = SEARCH_MIN - 0.02, hi = Math.max(...hits.map((h) => h.similarity));
  $('results').innerHTML = note + hits.map((h, n) => `<div class="res"><input type="checkbox" id="c${n}" checked aria-label="Claudeに渡す"><div>${card(h, '', { note: h.seq > 0 ? '長い投げ込みの一部' : '' })}<div class="meter" style="width:${h.similarity >= 1 ? 100 : Math.max(8, ((h.similarity - lo) / Math.max(hi - lo, 0.01)) * 100)}%"></div></div></div>`).join('')
    + `<button class="ask" id="ask">チェックしたものでClaudeに聞く文章をコピー</button><span class="copied" id="copied"></span><textarea class="manual" id="manual" readonly aria-label="コピー用"></textarea>`;
}
const nums = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫';
function claudePrompt() {
  const q = $('q').value.trim();
  const sel = hits.filter((_h, n) => $('c' + n)?.checked);
  return `【質問】${q}について、まとめて\n\n【私のメモ】\n` + sel.map((h, n) => `${nums[n]} ${dlabel(h.created_at)}：${h.body}`).join('\n')
    + '\n\n上のメモだけを根拠に、どのメモから言えるか番号を付けて答えて';
}

// ---- 開く：かけら・柱・直前モード・本。開いた順に積み、「戻る」で前へ ----
let stack = [];
const same = (a, b) => a && b && a.t === b.t && a.id === b.id;
const isTop = (v) => same(stack[stack.length - 1], v);
function openView(v, { push = true } = {}) {
  if (push && !isTop(v)) stack.push(v);
  if (!$('sheet').classList.contains('on')) { $('sheet').classList.add('on'); document.body.classList.add('locked'); }
  const fn = { k: renderKakera, pillar: renderPillar, prep: renderPrep, book: renderBook, shelf: renderShelf }[v.t];
  fn(v.id).catch(fail);
}
const openSheet = (id) => openView({ t: 'k', id });
const refresh = () => { const v = stack[stack.length - 1]; if (v && $('sheet').classList.contains('on')) openView(v, { push: false }); };
function closeSheet() {
  $('sheet').classList.remove('on'); stack = [];
  if ($('sky').hidden) document.body.classList.remove('locked');
}
const backSheet = () => { stack.pop(); stack.length ? openView(stack[stack.length - 1], { push: false }) : closeSheet(); };
function paint(meta, buttons, body) {
  $('panel').innerHTML = `<div class="sbar">${stack.length > 1 ? '<button class="ghost small" id="back">‹ 戻る</button>' : ''}<span class="d">${meta}</span>${buttons}<button class="ghost small" id="close" aria-label="閉じる">閉じる ✕</button></div><div class="sbody">${body}</div>`;
  $('panel').scrollTop = 0;
}

// ---- かけらを開く（長い投げ込みは全段落を1枚で。関係する段落に印） ----
async function renderKakera(id) {
  const v = { t: 'k', id };
  let it = known.get(id);
  if (!it) { it = await store.kakera(id); if (!it) { backSheet(); return; } known.set(id, it); }
  const draw = (sibs) => {
    const group = sibs.length > 1;
    const head = sibs[0];
    const k = kindOf(group ? head : it);
    const full = group
      ? `<div class="paras">${sibs.map((s, i) => `<p class="para${s.id === id && it.seq > 0 ? ' focus' : ''}" data-pid="${s.id}"><span class="pno">${i + 1}</span>${esc(s.body)}</p>`).join('')}</div>`
      : `<div class="full" id="full">${esc(it.body)}</div>`;
    const photo = sibs.find((s) => s.image_path);
    const book = head.book_id || it.book_id;
    const fixed = (group ? head : it).kind_fix;
    paint(`<button class="kindbtn kd-${k}" data-act="kindOpen" aria-expanded="false" title="種類を選び直す">${shape(k)}${KINDS[k][0]}${fixed ? '（自分で）' : ''} ▾</button> · ${dlabel(it.created_at)}${tag(it)}`,
      `<button class="ghost small" id="pinBtn" data-id="${id}" aria-pressed="${!!it.pinned_at}">${it.pinned_at ? '📌 外す' : '📌 ピン'}</button>`
      + `<button class="ghost small" id="edit">${group ? 'この段落を直す' : '直す'}</button>`,
      `<div class="kindrow" id="kindRow" hidden><p class="hint-s">種類を選び直す。直した結果は覚えて、次から似たかけらに使う。</p><div class="lenses">`
      + Object.entries(KINDS).map(([key, [label]]) => `<button class="chip kchip kd-${key}" data-act="kindSet" data-k="${key}" aria-pressed="${key === k}">${shape(key)}${label}</button>`).join('')
      + (fixed ? `<button class="chip" data-act="kindSet" data-k="">自動に戻す</button>` : '') + '</div></div>'
      + (photo ? `<img class="photo" data-path="${esc(photo.image_path)}" alt="写真">` : '')
      + full
      + (it.scene ? `<p class="scene">${esc(sceneLabel(it.scene))}</p>` : '')
      + (book ? `<p class="bookline-s">📖 ${esc(bookTitle(book))} を読んでいたとき <button class="ghost small" data-act="unbook" data-id="${head.id}">本から外す</button></p>` : '')
      + (k === 'u' ? `<div class="prow" style="margin:-4px 0 14px"><button class="ghost small" id="resolve" data-id="${id}">◆ 解決した</button></div>` : '')
      + (it.handoff && !it.handoff_done_at ? `<div class="prow" style="margin:-4px 0 14px"><button class="ghost small" data-done="${id}">▲ 申し送り、やった</button></div>` : '')
      + `<div class="editbox" id="editbox" hidden><textarea id="editText" aria-label="かけらを直す"></textarea><div class="prow"><button class="ghost" id="editCancel">やめる</button><button class="throw" id="editSave" data-id="${id}">直して沈める</button></div></div>`
      + `<h2>糸の先</h2><div class="stack" id="threads"><p class="empty">糸をたぐってる…</p></div>`
      + `<div class="prow"><button class="del" id="del" data-id="${id}">${group ? `この投げ込みを消す（${sibs.length} 段落）` : 'このかけらを消す'}</button></div>`);
  };
  draw([it]);
  const sibs = it.group_id ? await store.siblings(it.group_id) : [it];
  if (!isTop(v)) return;
  if (!sibs.some((s) => s.id === id)) sibs.push(it);
  sibs.forEach((s) => { if (!known.has(s.id)) known.set(s.id, s); });
  if (sibs.length > 1) draw(sibs);
  $('panel').dataset.group = JSON.stringify(sibs.map((s) => s.id));
  // 段落ごとに糸をたぐって、まとめる
  const rels = await Promise.all(sibs.slice(0, 20).map((s) => store.related(s.id, 3).catch(() => [])));
  if (!isTop(v) || !$('threads')) return;
  const all = [];
  rels.forEach((list, i) => list.forEach((r) => all.push({ ...r, from: i })));
  all.sort((a, b) => b.similarity - a.similarity);
  const good = oneEach(all.filter((r) => r.similarity >= THREAD_MIN)).slice(0, 3);
  if (sibs.length > 1) {
    rels.forEach((list, i) => {
      if (list.some((r) => r.similarity >= MARK_MIN)) document.querySelector(`.para[data-pid="${sibs[i].id}"]`)?.classList.add('linked');
    });
  }
  $('threads').innerHTML = good.length
    ? good.map((r) => card(r, '', { note: sibs.length > 1 ? `第 ${r.from + 1} 段落から` : '' })).join('')
      + (sibs.length > 1 ? '<p class="hint-s">● の段落は、ほかのかけらと強くつながっているところ。</p>' : '')
    : '<p class="empty">まだ糸はつながってない。</p>';
}

// ---- 直す ----
function startEdit() {
  const it = known.get(stack[stack.length - 1].id);
  $('editText').value = it.body;
  if ($('full')) $('full').hidden = true;
  document.querySelector('.para.focus')?.classList.add('editing');
  $('editbox').hidden = false; $('edit').hidden = true;
  $('editText').focus();
}
function cancelEdit() { if ($('full')) $('full').hidden = false; document.querySelector('.para.editing')?.classList.remove('editing'); $('editbox').hidden = true; $('edit').hidden = false; }
async function saveEdit(id) {
  const body = $('editText').value.trim();
  const it = known.get(id);
  if (!body || !it) return;
  if (body === it.body) { cancelEdit(); return; }
  $('editSave').disabled = true;
  try {
    await store.updateBody(id, body);
    patchLocal(id, { body }); it.body = body; renderStrata();
    if (hits.length) renderResults();
    refresh();
    toast('直した');
    const [v] = await embed([body]);
    await settle([it], [v], false);
    if (isTop({ t: 'k', id })) refresh();
  } catch (e) { fail(e); $('editSave') && ($('editSave').disabled = false); }
}

// ---- 消す（長い投げ込みはまるごと。元に戻せる） ----
async function removeIt(id) {
  const ids = JSON.parse($('panel').dataset.group || '[]');
  const list = ids.length ? ids : [id];
  try {
    const removed = [];
    for (const x of list) removed.push(await store.remove(x));
    const batch = { rows: removed.filter(Boolean) };
    lastDel = batch;
    const gone = new Set(list);
    strata = strata.filter((r) => !gone.has(r.id)); renderStrata(); loadPins();
    hits = hits.filter((r) => !gone.has(r.id)); if (hits.length || $('q').value.trim()) renderResults();
    closeSheet(); toast(list.length > 1 ? `${list.length} 段落を消した` : 'かけらを消した', true);
    // 写真は、元に戻されなかったときだけあとで消す
    const photos = batch.rows.map((r) => r.image_path).filter(Boolean);
    if (photos.length) setTimeout(() => { if (!batch.undone) photos.forEach((p) => store.removePhoto(p).catch(() => {})); }, 8000);
  } catch (err) { fail(err); }
}

// ---- 埋め込み待ちのかけら（取り込み分など）を後から処理 ----
let backfilling = false;
async function backfill() {
  if (backfilling) return;
  backfilling = true;
  let done = 0;
  try {
    const seen = new Set();
    for (;;) {
      const rows = await store.pending(16);
      if (!rows.length || rows.every((r) => seen.has(r.id))) break;   // 同じものが戻ってきたら止める（ぐるぐる回らない）
      rows.forEach((r) => seen.add(r.id));
      $('model').textContent = `取り込んだかけらを整え中…（${done}件済み）`;
      const vecs = await embed(rows.map((r) => r.body));
      for (let i = 0; i < rows.length; i++) await settle([rows[i]], [vecs[i]], !rows[i].lens);
      done += rows.length;
    }
    await placeStars();
    await scanHandoffs();
  } catch (e) { console.error(e); }
  finally {
    backfilling = false;
    if (modelReady) $('model').textContent = '';
    if (done) { loadStrata().catch(() => {}); loadWord(); }
  }
}

// 意味を保存し、レンズと申し送りを見分け、星座に置き、（初回だけ）英単語を拾う
async function settle(rows, vecs, bump) {
  const protos = await loadProtos(embed).catch(() => null);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const fields = { lens: classify(row, vecs[i], protos) };
    if (row.kind_fix) Object.assign(fields, kindFields(row.kind_fix, { ...row, ...fields }));   // 自分で選んだ種類はそのまま
    else if (!row.handoff) {
      // 選び直した例にとても近ければ、その種類にする。なければいつもの見分け
      const learned = learnKind(vecs[i], await kindExamples());
      if (learned) Object.assign(fields, { kind_learned: learned }, kindFields(learned, { ...row, ...fields }));
      else {
        if (row.kind_learned) fields.kind_learned = null;
        if (isHandoff(row, vecs[i], protos)) fields.handoff = true;
      }
    }
    await store.setEmbedding(row.id, vecs[i], fields);
    Object.assign(row, fields); patchLocal(row.id, fields);
    if (row.seq === 0 && row.pos_x == null) {
      try { const p = placeNear(await store.match(vecs[i], 8, row.group_id)); await store.patch(row.id, p); Object.assign(row, p); } catch (e) { console.error(e); }
    }
    if (!bump) continue;
    try {
      if (isMail(row)) await store.bumpWords(wordsFromMail(row.body), 'mail', row.id);
      else if (fields.lens === 'word') { await store.bumpWords(wordsFromMine(row.body), 'mine', row.id); loadWord(); }
    } catch (e) { console.error(e); }
  }
}

// ---- 種類の手直し：選び直した例を覚えて、次からの見分けに使う ----
let kindEx = null;
async function kindExamples() {
  if (!kindEx) kindEx = store.kindExamples().catch((e) => { console.error(e); kindEx = null; return []; });
  return kindEx;
}
async function fixKind(k) {
  const id = stack[stack.length - 1].id;
  const ids = JSON.parse($('panel').dataset.group || '[]');
  const list = ids.length ? ids : [id];
  try {
    for (const x of list) {
      const it = known.get(x) || { id: x };
      const f = k ? { kind_fix: k, kind_learned: null, ...kindFields(k, it) } : { kind_fix: null, kind_learned: null, lens: null, handoff: false };   // 自動に戻す：見分け直しは backfill で
      await store.patch(x, f);
      patchLocal(x, f);
    }
    // 覚えている例を入れ替える
    const ex = (await kindExamples()).filter((e) => !list.includes(e.id));
    kindEx = Promise.resolve(k ? [...(await store.kindExamples(list)), ...ex] : ex);
    renderStrata(); if (hits.length) renderResults(); loadPins(); refresh();
    toast(k ? `「${KINDS[k][0]}」に直した。似たかけらは次からこの種類にするね` : '自動の見分けに戻した');
    if (!k) { await backfill(); refresh(); }
  } catch (e) { fail(e); }
}

// 星座にまだ置いていないかけら（前からあったもの）を、古い順に置く
async function placeStars() {
  for (let guard = 0; guard < 100; guard++) {
    const list = await store.unplaced(20);
    if (!list.length) return;
    $('model').textContent = '星座に星を置いてる…';
    for (const { id } of list) await store.patch(id, placeNear(await store.related(id, 8)));
  }
}

// 前から投げていたかけらのうち、申し送りっぽいものを一度だけ拾い直す
async function scanHandoffs() {
  if (kvs.scan_handoff_v1) return;
  const protos = await loadProtos(embed);
  const rows = (await store.recent(null, 800)).filter((r) => mine(r) && !r.handoff && r.body.length <= 300);
  for (let i = 0; i < rows.length; i += 16) {
    const part = rows.slice(i, i + 16);
    const vecs = await embed(part.map((r) => r.body));
    for (let j = 0; j < part.length; j++) {
      if (isHandoff(part[j], vecs[j], protos)) { await store.patch(part[j].id, { handoff: true }); patchLocal(part[j].id, { handoff: true }); }
    }
  }
  await setKv('scan_handoff_v1', true);
  renderStrata();
}

// ---- 未解決 → 解決した / 申し送り → やった ----
async function resolveIt(id) {
  try {
    await store.setResolved(id);
    patchLocal(id, { resolved_at: new Date().toISOString() });
    renderStrata(); if (hits.length) renderResults(); loadPins(); refresh();
    toast('解決した');
  } catch (e) { fail(e); }
}
async function handoffDone(id) {
  try {
    const at = new Date().toISOString();
    await store.patch(id, { handoff_done_at: at });
    patchLocal(id, { handoff_done_at: at });
    renderStrata(); if (hits.length) renderResults(); refresh();
    toast('申し送り、やった');
  } catch (e) { fail(e); }
}

// ---- ピン ----
let pins = [];
async function loadPins() {
  try { pins = await store.pins(); } catch (e) { console.error(e); pins = []; }
  $('pins').hidden = !pins.length;
  $('pinList').innerHTML = pins.map((p) => `<div class="pinrow">${card(p)}<button class="ghost small done" data-unpin="${p.id}" aria-label="ピンを外す">済んだ</button></div>`).join('');
}
async function togglePin(id, on) {
  try {
    await store.setPin(id, on);
    patchLocal(id, { pinned_at: on ? new Date().toISOString() : null });
    renderStrata(); await loadPins(); refresh();
    toast(on ? 'ピンした' : 'ピンを外した');
  } catch (e) { fail(e); }
}

// ---- レンズ ----
function renderLenses() {
  $('lenses').innerHTML = [{ id: null, label: 'すべて' }, ...LENSES].map((l) =>
    `<button class="chip" data-lens="${l.id || ''}" aria-pressed="${curLens === l.id}">${l.label}</button>`).join('');
}
function setLens(id) {
  curLens = id || null;
  renderLenses();
  loadStrata().catch(fail);
  onSearchInput();
}

// ---- 柱 ----
let pillars = [];
const pvCache = new Map();
async function loadPillars() {
  try { pillars = await store.pillars(); } catch (e) { console.error(e); pillars = []; }
  $('pillars').hidden = !pillars.length;
  $('pillarList').innerHTML = pillars.map((p) => `<button class="chip pchip" data-pillar="${p.id}">${p.kind === 'standard' ? '◇' : '▮'} ${esc(p.name)}</button>`).join('');
}
const plain = (h) => h.replace(/^\s*\d+\s*[)）.．]\s*/, '');
const normalize = (v) => { const n = Math.sqrt(dot(v, v)) || 1; return v.map((x) => x / n); };
// 柱の見出しごとの意味（中身が変わったときだけ計算し直す）
async function pillarVecs() {
  const out = [];
  for (const p of pillars) {
    const key = JSON.stringify([p.name, p.sections]);
    let c = pvCache.get(p.id);
    if (!c || c.key !== key) {
      const texts = p.sections.map((s) => `${p.name} ${plain(s.h)}：${s.items.join(' / ')}`.slice(0, 400));
      const secs = texts.length ? await embed(texts) : [];
      const base = secs.length ? secs : await embed([p.name]);
      const cen = normalize(base[0].map((_x, i) => base.reduce((a, v) => a + v[i], 0) / base.length));
      c = { key, secs, cen }; pvCache.set(p.id, c);
    }
    out.push({ p, ...c });
  }
  return out;
}
const item = (s) => {
  const m = s.match(/^([^：:]{1,20})[：:]\s*(.+)$/);
  const re = mostlyEnglish(s) ? EM_NUMS : EM_WORDS;
  return m ? `<b>${esc(m[1])}</b>：${emph(m[2], re)}` : emph(s, re);
};
async function renderPillar(id) {
  const v = { t: 'pillar', id };
  const p = pillars.find((x) => x.id === id);
  if (!p) { backSheet(); return; }
  paint(`柱 · ${p.kind === 'standard' ? '基準' : '科目'}${p.source === 'notion' ? ' · Notion' : ''}`,
    `<button class="ghost small" data-act="prepOf" data-name="${esc(p.name)}">直前モード</button><button class="ghost small" data-act="pEdit">直す</button>`,
    `<h1 class="ptitle" id="pTitle">${esc(p.name)}</h1><div id="pView">`
    + `<details class="gather loose" id="gLoose" hidden><summary>「${esc(p.name)}」が出てくるかけら <span class="gn"></span>（見出しはまだ）</summary><div class="stack"></div></details>`
    + p.sections.map((s, i) => `<section class="psec r-${role(s.h)}"><h3>${esc(s.h)}</h3>`
      + (s.items.length ? `<ul>${s.items.map((x) => `<li>${item(x)}</li>`).join('')}</ul>` : '<p class="empty small-empty">まだ空っぽ。かけらが寄ってくるのを待つか、「直す」で書ける。</p>')
      + `<details class="gather" id="g${i}"><summary>寄ってきたかけら <span class="gn">…</span></summary><div class="stack"></div></details></section>`).join('')
    + `<h2>糸の先の柱</h2><div class="plinks" id="plinks"><p class="empty">たぐってる…</p></div></div>`
    + `<div class="editbox" id="pEditBox" hidden><label class="hint-s" for="pName">名前</label><input type="text" id="pName" value="${esc(p.name)}">`
    + `<label class="hint-s" for="pText">中身（## が見出し、- が項目）</label><textarea id="pText" class="ptext">${esc(pillarToText(p))}</textarea>`
    + `<div class="prow"><label class="hint-s"><input type="radio" name="pKind" value="subject"${p.kind !== 'standard' ? ' checked' : ''}> 科目</label><label class="hint-s"><input type="radio" name="pKind" value="standard"${p.kind === 'standard' ? ' checked' : ''}> 基準</label></div>`
    + `<div class="prow"><button class="del" data-act="pDel" data-id="${id}">この柱を消す</button><button class="ghost" data-act="pCancel">やめる</button><button class="throw" data-act="pSave" data-id="${id}">直す</button></div></div>`);
  if (!modelReady) $('plinks').innerHTML = '<p class="empty">泉の準備ができたら、かけらが寄ってくる。</p>';
  const all = await pillarVecs();
  const me = all.find((x) => x.p.id === id);
  if (!me || !isTop(v)) return;
  // 見出しごとに近いかけらを集め、いちばん近い見出しに寄せる
  const [lists, lit] = await Promise.all([Promise.all(me.secs.map((sv) => store.match(sv, 20))), store.search(p.name, me.cen, 40, null).catch(() => [])]);
  const best = new Map();
  lists.forEach((list, i) => list.forEach((r) => {
    if (r.similarity < PILLAR_MIN || r.handoff) return;
    const o = best.get(gkey(r));
    if (!o || r.similarity > o.r.similarity) best.set(gkey(r), { r, i });
  }));
  if (!isTop(v)) return;
  me.secs.forEach((_s, i) => {
    const got = [...best.values()].filter((x) => x.i === i).sort((a, b) => b.r.similarity - a.r.similarity);
    const box = $('g' + i); if (!box) return;
    box.querySelector('.gn').textContent = got.length ? `${got.length}` : '0';
    box.querySelector('.stack').innerHTML = got.length ? got.map((x) => card(x.r)).join('') : '<p class="empty small-empty">まだ寄ってきてない。</p>';
  });
  // 意味ではまだ見出しに寄らないけれど、柱の名前が出てくるもの
  const loose = oneEach(lit.filter((r) => r.literal && !r.handoff && !best.has(gkey(r))));
  if (loose.length) {
    $('gLoose').hidden = false;
    $('gLoose').querySelector('.gn').textContent = loose.length;
    $('gLoose').querySelector('.stack').innerHTML = loose.map((r) => card(r)).join('');
  }
  const links = all.filter((x) => x.p.id !== id).map((x) => ({ p: x.p, s: dot(x.cen, me.cen) })).filter((x) => x.s >= PILLAR_LINK).sort((a, b) => b.s - a.s).slice(0, 3);
  $('plinks').innerHTML = links.length ? links.map((x) => `<button class="chip pchip" data-pillar="${x.p.id}">${esc(x.p.name)}</button>`).join('') : '<p class="empty small-empty">まだほかの柱とはつながってない。</p>';
}
async function savePillarEdit(id) {
  const p = pillars.find((x) => x.id === id);
  const name = $('pName').value.trim();
  if (!p || !name) return;
  const kind = document.querySelector('input[name=pKind]:checked').value;
  try {
    await store.savePillar({ id, name, kind, sections: textToSections($('pText').value), source: p.source });
    await loadPillars(); refresh(); toast('柱を直した');
  } catch (e) { fail(e); }
}

// 柱の提案：同じ話題が5つほど集まり、近い柱がまだないとき、一度だけ聞く
async function suggestion(rows, vecs) {
  if (rows.length > 3) return null;
  const v = vecs[0];
  const near = oneEach((await store.match(v, 14, rows[0].group_id)).filter((r) => r.similarity >= SUGGEST_NEAR && mine(r)));
  if (near.length < SUGGEST_COUNT) return null;
  for (const x of await pillarVecs()) if (dot(x.cen, v) >= NO_PILLAR || x.secs.some((s) => dot(s, v) >= NO_PILLAR + 0.05)) return null;
  const ids = [rows[0].id, ...near.map((r) => r.id)];
  if ((kvs.asked_clusters || []).some((a) => a.filter((x) => ids.includes(x)).length >= 3)) return null;
  return { ids, n: ids.length };
}
let sgNow = null;
function showSuggestion(sg) {
  sgNow = sg;
  $('ripple').insertAdjacentHTML('beforeend', `<div class="suggest" id="suggest"><p>似た話のかけらが ${sg.n} つ集まってきた。柱にする？</p>`
    + `<input type="text" id="sgName" placeholder="柱の名前（例：棚卸、収益認識）" aria-label="柱の名前">`
    + `<div class="row"><button class="ghost small" data-act="sgNo">今はいい</button><button class="ghost small" data-act="sgMake" data-kind="standard">基準の型で</button><button class="throw small" data-act="sgMake" data-kind="subject">科目の型で</button></div></div>`);
}
async function answerSuggestion(kind) {
  const sg = sgNow; if (!sg) return;
  let name = '';
  if (kind) {
    name = $('sgName').value.trim();
    if (!name) { $('sgName').focus(); toast('柱の名前を入れてね'); return; }
  }
  sgNow = null;
  $('suggest')?.remove();
  try {
    await setKv('asked_clusters', [...(kvs.asked_clusters || []), sg.ids].slice(-60));
    if (!kind) return;
    const p = await store.savePillar({ name, kind, sections: TEMPLATES[kind].map((h) => ({ h, items: [] })) });
    await loadPillars();
    openView({ t: 'pillar', id: p.id });
  } catch (e) { fail(e); }
}

// ---- 直前モード：「〇〇やる」 ----
async function renderPrep(topic) {
  const v = { t: 'prep', id: topic };
  const inpMatch = PREP.test($('inp').value.trim());
  paint(`直前モード · ${esc(topic)}`, '', `<h1 class="ptitle">${esc(topic)}、その前に</h1><div id="prepBody"><p class="empty">泉から集めてる…</p></div>`
    + `<div class="prow prep-btns">${inpMatch ? '<button class="ghost" data-act="plainThrow" title="直前モードにせず、ふつうのかけらとして投げる">ただ投げる</button>' : ''}<button class="throw" data-act="going" data-topic="${esc(topic)}">行ってくる</button></div>`);
  const [qv] = await embed([topic]);
  const pv = await pillarVecs();
  let pil = pillars.find((p) => p.name === topic) || pillars.find((p) => topic.includes(p.name) || p.name.includes(topic));
  if (!pil) { const b = pv.map((x) => ({ p: x.p, s: dot(x.cen, qv) })).sort((a, b) => b.s - a.s)[0]; if (b && b.s >= NO_PILLAR) pil = b.p; }
  const [res, handsAll] = await Promise.all([store.search(topic, qv, 40, null), store.handoffs().catch(() => [])]);
  if (!isTop(v)) return;
  const close = (r) => r.literal || r.similarity >= THREAD_MIN;
  const hands = oneEach([
    ...handsAll.filter((h) => h.body.startsWith(topic)),
    ...res.filter((r) => r.handoff && !r.handoff_done_at && (r.literal || r.similarity >= 0.4)),
  ]);
  const unres = oneEach(res.filter((r) => kindOf(r) === 'u' && close(r))).slice(0, 5);
  const near = oneEach(res.filter((r) => !r.handoff && kindOf(r) !== 'u' && close(r))).slice(0, 4);
  const sec = (roles) => (pil ? pil.sections.filter((s) => roles.includes(role(s.h)) && s.items.length) : []);
  const block = (title, secs) => secs.length ? `<h2>${title}</h2>` + secs.map((s) => `<div class="psec r-${role(s.h)}"><h3>${esc(s.h)}</h3><ul>${s.items.map((x) => `<li>${item(x)}</li>`).join('')}</ul></div>`).join('') : '';
  const std = pil && pil.kind === 'standard';
  let html = pil ? `<p class="hint-s">柱「${esc(pil.name)}」から</p>` : '<p class="hint-s">この話の柱はまだない。かけらから集めた。</p>';
  html += std ? block('まず見る', sec(['point', 'doubt'])) : block('まず見る：リスク', sec(['risk'])) + block('統制', sec(['control']));
  html += unres.length ? `<h2>未解決のまま</h2><div class="stack">${unres.map((r) => card(r)).join('')}</div>` : '';
  html += near.length ? `<h2>寄ってきたもの</h2><div class="stack">${near.map((r) => card(r)).join('')}</div>` : '';
  html += `<h2>前回の申し送り</h2>` + (hands.length
    ? `<div class="stack">${hands.map((h) => `<div class="pinrow">${card(h)}<button class="ghost small done" data-done="${h.id}">やった</button></div>`).join('')}</div>`
    : '<p class="empty small-empty">前回の自分からの申し送りはない。行ってきたら「どうだった？」って聞くね。</p>');
  const more = std ? sec(['revision', 'practice', 'topic']) : sec(['basic', 'disclosure', 'topic']);
  if (more.length) html += `<details class="gather"><summary>${std ? '改正点・実務・トピック' : '基礎知識・開示・トピック'}</summary>${block('', more)}</details>`;
  if (!pil && !unres.length && !near.length && !hands.length) html = '<p class="empty">まだ何も寄ってこない。行ってきたら、どうだったか聞かせてね。</p>';
  $('prepBody').innerHTML = html;
  if (pil) document.querySelector('.prep-btns').insertAdjacentHTML('afterbegin', `<button class="ghost" data-pillar="${pil.id}">柱を全部見る</button>`);
}
async function going(topic) {
  try {
    if (PREP.test($('inp').value.trim())) $('inp').value = '';
    await setKv('going', { topic, t: Date.now() });
    closeSheet(); renderAsks();
    toast('いってらっしゃい。あとで「どうだった？」って聞くね');
  } catch (e) { fail(e); }
}

// ---- 泉からの問いかけ：「どうだった？」と週1の問い ----
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const weekId = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
const weeklyDue = () => {
  const d = new Date(), day = d.getDay();
  return kvs.weekly !== weekId() && (demo || (day === 5 && d.getHours() >= 18) || day === 6 || day === 0);
};
function renderAsks() {
  const box = (kind, q, ph, skip) => `<div class="askbox"><p class="q">${q}</p><div class="arow"><input type="text" id="ans-${kind}" placeholder="${ph}" aria-label="答え" enterkeyhint="send">`
    + `<button class="throw small" data-act="ans" data-kind="${kind}">投げる</button><button class="ghost small" data-act="ansSkip" data-kind="${kind}">${skip}</button></div></div>`;
  const parts = [];
  const g = kvs.going;
  if (g && (demo || Date.now() - g.t >= GO_WAIT)) parts.push(box('going', `${esc(g.topic)}、どうだった？`, '次の自分に残したいこと', 'スキップ'));
  if (weeklyDue()) parts.push(box('weekly', '今週、どこでも使える話あった？', '一言で', 'なかった'));
  $('asks').innerHTML = parts.join('');
}
async function answerAsk(kind, skip) {
  const v = skip ? '' : ($('ans-' + kind)?.value || '').trim();
  if (!skip && !v) { $('ans-' + kind)?.focus(); return; }
  try {
    if (kind === 'going') {
      const topic = kvs.going.topic;
      await setKv('going', null);
      renderAsks();
      if (v) await sink(`${topic}：${v}`, { extra: { handoff: true } });
    } else {
      await setKv('weekly', weekId());
      renderAsks();
      if (v) await sink(v);
    }
    toast(skip ? (kind === 'weekly' ? 'また来週聞くね' : 'わかった') : '投げたよ');
  } catch (e) { fail(e); }
}

// ---- 本 ----
let books = [];
const curBook = () => books.find((b) => b.id === kvs.book && b.status === 'reading') || null;
async function loadBooks() { try { books = await store.books(); } catch (e) { console.error(e); books = []; } renderBookChip(); }
function renderBookChip() {
  const b = curBook();
  $('bookBtn').textContent = b ? `📖 ${b.title.length > 14 ? b.title.slice(0, 14) + '…' : b.title}` : '📖';
  $('bookBtn').classList.toggle('on', !!b);
  $('bookBtn').setAttribute('aria-label', b ? `いま読んでる本：${b.title}` : '本をセット');
}
let bookCands = [];
async function renderBook() {
  const b = curBook();
  const shelf = books.filter((x) => x.id !== (b && b.id));
  paint('本', '', (b
    ? `<div class="bookcard">${b.cover_url ? `<img src="${esc(b.cover_url)}" alt="">` : ''}<div><p class="hint-s">いま読んでる本</p><h1 class="ptitle">${esc(b.title)}</h1>${b.author ? `<p class="hint-s">${esc(b.author)}</p>` : ''}<p class="hint-s">セット中に投げたかけらは、この本に紐づく。</p></div></div>`
      + `<div class="prow"><button class="ghost" data-act="bookOff">外す</button><button class="ghost" data-act="shelf" data-id="${b.id}">この本のかけら</button><button class="throw" data-act="bookDone">読了</button></div>`
    : `<h2>いま読んでる本をセット</h2><div class="prow"><button class="ghost" data-act="scanBar">バーコードを撮る</button><button class="ghost" data-act="scanCover">表紙を撮る</button></div>`
      + `<div class="arow" style="margin-top:12px"><input type="text" id="bookQ" placeholder="題名を打って探す" enterkeyhint="search"><button class="throw small" data-act="bookFind">探す</button></div>`
      + `<div id="bookCands" class="stack" style="margin-top:12px"></div>`)
    + (shelf.length ? `<h2>本棚</h2><div class="stack">${shelf.map((x) => `<button class="k shelfrow" data-act="shelf" data-id="${x.id}">${esc(x.title)}<span class="d">${x.status === 'done' ? '読了 ' + dlabel(x.finished_at || x.started_at) : '途中'}</span></button>`).join('')}</div>` : ''));
}
function showCands(list, note = '') {
  bookCands = list;
  $('bookCands').innerHTML = (note ? `<p class="hint-s">${esc(note)}</p>` : '')
    + (list.length ? list.map((c, i) => `<button class="k bookcand" data-act="pickBook" data-i="${i}">${c.cover_url ? `<img src="${esc(c.cover_url)}" alt="">` : ''}<span><b>${esc(c.title)}</b>${c.author ? `<span class="d">${esc(c.author)}</span>` : ''}</span></button>`).join('')
      : '<p class="empty small-empty">見つからなかった。題名を打って探してみて。</p>');
}
async function bookFromBarcode(file) {
  $('bookCands').innerHTML = '<p class="empty">バーコードを読んでる…</p>';
  const isbn = await isbnFromPhoto(file);
  if (!isbn) { showCands([], 'バーコードが読めなかった。978 から始まる方のバーコードを大きめに撮ってみて。'); return; }
  const b = await lookupIsbn(isbn);
  showCands(b ? [b] : [], b ? `ISBN ${isbn}` : `ISBN ${isbn} の本が見つからなかった`);
}
async function bookFromCover(file) {
  $('bookCands').innerHTML = '<p class="empty">表紙の文字を読んでる…（初回は少し待つ）</p>';
  let text = '';
  try { text = await readText(file); } catch (e) { console.error(e); }
  const q = text.split('\n').map((x) => x.trim()).filter((x) => x.replace(/\s/g, '').length >= 2).sort((a, b) => b.length - a.length).slice(0, 2).join(' ').slice(0, 60);
  if (!q) { showCands([], '表紙の文字が読めなかった。題名を打って探してみて。'); return; }
  $('bookQ').value = q;
  showCands(await searchBooks(q), `表紙から「${q}」で探した`);
}
async function pickBook(i) {
  const c = bookCands[i]; if (!c) return;
  try {
    const b = await store.addBook({ title: c.title, author: c.author, isbn: c.isbn, cover_url: c.cover_url });
    books.unshift(b);
    await setKv('book', b.id);
    renderBookChip(); refresh(); toast(`「${b.title}」をセットした`);
  } catch (e) { fail(e); }
}
async function bookOff(done) {
  const b = curBook(); if (!b) return;
  try {
    if (done) { const at = new Date().toISOString(); await store.patchBook(b.id, { status: 'done', finished_at: at }); Object.assign(b, { status: 'done', finished_at: at }); }
    await setKv('book', null);
    renderBookChip(); refresh(); toast(done ? `読了！「${b.title}」は本棚へ` : '本を外した');
  } catch (e) { fail(e); }
}
async function renderShelf(id) {
  const b = books.find((x) => x.id === id);
  if (!b) { backSheet(); return; }
  paint('本のかけら', '', `<div class="bookcard">${b.cover_url ? `<img src="${esc(b.cover_url)}" alt="">` : ''}<div><h1 class="ptitle">${esc(b.title)}</h1>${b.author ? `<p class="hint-s">${esc(b.author)}</p>` : ''}<p class="hint-s">${dlabel(b.started_at)} から${b.finished_at ? ' ' + dlabel(b.finished_at) + ' 読了' : ' 読んでる'}</p></div></div><div class="stack" id="shelfList"><p class="empty">集めてる…</p></div>`);
  const rows = await store.ofBook(id);
  if (!isTop({ t: 'shelf', id })) return;
  $('shelfList').innerHTML = rows.length ? groupCards(rows).join('') : '<p class="empty">この本を読んでいたときのかけらはまだない。</p>';
}

// ---- 星座 ----
const KCOLOR = { w: '#9fb4ff', e: '#6fd3c8', d: '#f0c25a', h: '#ff9a7f', u: '#ff8a75' };
async function showSky() {
  try {
    const stars = await store.stars();
    openSky({
      host: $('sky'), stars,
      colorOf: (s) => KCOLOR[kindOf(s)],
      labelOf: (s) => `${dlabel(s.created_at)}  ${s.body.replace(/\s+/g, ' ').slice(0, 60)}`,
      onPick: async (s) => { const full = await store.kakera(s.id); if (full) { known.set(full.id, full); openSheet(full.id); } },
    });
    if (!stars.length) toast('まだ星がない。かけらを投げると、ここに置かれていく');
  } catch (e) { fail(e); }
}

// ---- Notion の書き出しを取り込む ----
async function importNotion(files) {
  try {
    toast('Notion の書き出しを読んでる…');
    const pages = (await readFiles(files)).map(parsePage);
    const refs = await store.existingRefs('notion');
    let np = 0, nk = 0;
    for (const pg of pages) {
      if (pg.type === 'pillar') { await store.savePillar({ name: pg.name, kind: pg.kind, sections: pg.sections, source: 'notion' }); np++; continue; }
      if (!pg.body || pg.body.replace(/\s/g, '').length < 4) continue;
      const gid = crypto.randomUUID();
      const rows = splitParas(pg.body).map((body, seq) => ({ body, seq, group_id: gid, source: 'notion', source_ref: `${pg.ref}:${seq}` }))
        .filter((r) => !refs.has(r.source_ref));
      if (!rows.length) continue;
      await store.insert(rows); nk++;
    }
    await loadPillars();
    toast(pages.length ? `柱 ${np} 枚、ページ ${nk} 枚を取り込んだ。意味づけは裏で進めるね` : 'Markdown のページが見つからなかった');
    backfill();
  } catch (e) { fail(e); }
}

// ---- 家・職場の目安 ----
async function setPlace(name) {
  const p = await hereRounded();
  if (!p) { toast('位置がわからなかった。位置情報を許可してね'); return; }
  try { await setKv('places', { ...(kvs.places || {}), [name]: p }); toast(`ここを「${name}」にした（座標そのものは、かけらには残さない）`); } catch (e) { fail(e); }
}

// ---- 今日の英単語 ----
const today = () => ymd(new Date());
const later = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const GAPS = [1, 3, 7, 14, 30];
let wordNow = null, wordLoading = false, wordExamples = [];

function sentencesWith(body, word) {
  const re = new RegExp(`\\b${word}(s|es|ed|d|ing)?\\b`, 'i');
  return body.replace(/^【[^】]*】[^\n]*\n*/, '').split(/(?<=[.!?。！？])\s+|\n+/)
    .map((x) => x.trim()).filter((x) => x.length >= 12 && re.test(x));
}
const mark = (text, word) => esc(text.length > 220 ? text.slice(0, 220) + '…' : text)
  .replace(new RegExp(`\\b(${word}(?:s|es|ed|d|ing)?)\\b`, 'ig'), '<mark>$1</mark>');

async function loadWord() {
  if (wordLoading) return;
  wordLoading = true;
  try {
    const t = today();
    const { w, answered } = await store.wordOfDay(t);
    $('wordday').hidden = false;
    if (!w) {
      wordNow = null;
      $('wordBox').innerHTML = '<p class="empty">まだ湧いてくる単語がない。英単語を投げるか、メルマガが溜まるのを待ってね。</p>';
      return;
    }
    if (w.last_seen !== t) await store.touchWord(w.word, { last_seen: t });
    wordNow = w;
    const ex = [];
    for (const r of await store.examples(w.word)) {
      for (const sen of sentencesWith(r.body, w.word)) { if (!ex.some((e) => e.s === sen)) ex.push({ s: sen, r }); if (ex.length >= 3) break; }
      if (ex.length >= 3) break;
    }
    const mineRow = w.origin === 'mine' && w.kakera_id ? await store.kakera(w.kakera_id) : null;
    const meta = w.origin === 'mine' ? '自分で投げた単語' : `メルマガで ${w.freq} 回`;
    const again = w.step > 0 ? ` · ${w.step + 1} 回目` : '';
    $('wordBox').innerHTML = `<div class="wd-word">${esc(w.word)}</div><p class="wd-meta">${meta}${again}</p>`
      + `<div class="wd-mean" id="wdMean"><span class="empty">意味をさがしてる…</span></div>`
      + (mineRow ? `<div class="wd-mine">${card(mineRow)}</div>` : '')
      + (ex.length ? `<ul class="wd-ex">${ex.map((e) => `<li>${mark(e.s, w.word)}<span class="d">${dlabel(e.r.created_at)}</span></li>`).join('')}</ul>`
        : '<p class="empty small-empty">メルマガの中の例文はまだない。</p>')
      + (answered
        ? `<p class="wd-done">${w.status === 'known' ? '卒業！かけらは検索にずっと残るよ。' : `また ${GAPS[Math.min(w.step - 1, GAPS.length - 1)]} 日後に湧いてくる。`}今日の1語はおしまい。</p>`
        : '<div class="row wd-btns"><button class="ghost" id="wKnow">知ってる</button><button class="throw" id="wAgain">まだ</button></div>');
    wordExamples = ex.map((e) => e.s);
    showMeaning(w.word);
  } catch (e) { console.error(e); $('wordday').hidden = true; }
  finally { wordLoading = false; }
}
async function showMeaning(word) {
  const link = `<a class="wd-link" href="https://ejje.weblio.jp/content/${encodeURIComponent(word)}" target="_blank" rel="noopener noreferrer">Weblioで見る</a>`
    + `<button class="ghost small" id="wAsk">Claudeに聞く文章をコピー</button><span class="copied" id="wCopied"></span>`;
  let html;
  try {
    const hit = await lookup(word);
    html = hit
      ? `<ol class="wd-senses">${hit.senses.slice(0, 4).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`
        + (hit.word !== word ? `<p class="wd-meta">（${esc(hit.word)} の形で）</p>` : '')
      : '<p class="empty small-empty">手元の辞書には載ってなかった。専門用語かも。</p>';
  } catch { html = '<p class="empty small-empty">辞書を開けなかった。</p>'; }
  if (wordNow && wordNow.word === word && $('wdMean')) $('wdMean').innerHTML = html + `<div class="wd-links">${link}</div>`;
}
function wordPrompt() {
  const w = wordNow.word;
  return `英単語「${w}」の意味を、会計・監査の文脈も含めて日本語でやさしく教えて。品詞、よく一緒に使う言い方、覚え方のコツもあれば。`
    + (wordExamples.length ? `\n\n私が読んだメルマガに出てきた文：\n${wordExamples.map((x) => '・' + x).join('\n')}\n\nこの文の中ではどういう意味かも教えて。` : '');
}
async function answerWord(knowIt) {
  const w = wordNow; if (!w) return;
  const patch = knowIt ? { status: 'known' } : { step: w.step + 1, due: later(GAPS[Math.min(w.step, GAPS.length - 1)]) };
  try { await store.touchWord(w.word, patch); await loadWord(); } catch (e) { fail(e); }
}

// ---- 入口 ----
function showGate(msg = '') {
  $('app').hidden = true; $('gate').hidden = false; $('gateMsg').textContent = msg;
  $('email').value = localStorage.getItem('kakera-email') || '';
}
let started = false;
async function showApp(session) {
  $('gate').hidden = true; $('app').hidden = false;
  $('who').textContent = demo ? 'お試しモード（閉じると消える）' : session.user.email;
  if (started) return; started = true;
  onSearchInput();
  if (demo) await seedDemo();
  embed(null).catch(() => {}); // モデルを先に温める
  renderLenses();
  await loadKv();
  await Promise.all([loadBooks(), loadPillars()]);
  renderAsks();
  loadPins();
  try { await loadStrata(); } catch (e) { fail(e); }
  loadAgo().catch(console.error);
  loadWord();
  backfill();
  setInterval(renderAsks, 5 * 60e3);
}

async function seedDemo() {
  const at = (d, h = 0) => new Date(Date.now() - d * DAY - h * 36e5).toISOString();
  const S = [[0, 'accrual って発生主義のことか。メルマガの記事で出てきて、会計の勉強とつながった'], [0, '今日は朝から会議続きでしんどかった。夕方の散歩で少し戻った'], [2, '研修メモ：監基報240、職業的懐疑心の話がかなり多かった。経営者への質問も増えそう'], [5, 'Read an article on fraud risk assessment: auditors should revisit the risk of material misstatement due to fraud every year.'], [9, '仕訳の練習。前払費用と未払費用、時間のずれをどっちに置くかで混乱する'], [14, '"skepticism" の発音、スケプティシズム。'], [21, 'Felt foggy all day, maybe the weather. A short walk always helps on tough days.'], [30, '収益認識の5ステップ、契約の識別から。'],
    [3, '棚卸立会：次は保管場所の一覧を先にもらっておく'], [4, '棚卸の立会で、預け在庫の扱いがあやしい？'], [6, '棚卸のカットオフ、出荷基準と検収基準で期末の数字がずれる'], [8, '棚卸資産の評価、収益性の低下で簿価を切り下げる'], [11, '棚卸の差異は原因を必ず聞く。数え直しの記録も見る'], [12, '棚卸資産の滞留品、年齢調べの表で確認する'],
    [366, '去年の今ごろ：初めての棚卸立会。寒い倉庫で数えた'], [369, 'リースの勉強を始めた。使用権資産ってなに'], [731, '2年前の秋、簿記2級の勉強ノートを作り始めた']];
  await store.insert(S.map(([d, body], i) => ({ body, group_id: crypto.randomUUID(), created_at: at(d, i % 5), scene: i % 3 === 0 ? '雨 朝 家' : i % 3 === 1 ? '晴れ 夜 家' : 'くもり 昼 外' })));
  const M = ['【Audit Weekly】Fraud and estimates\n\nRegulators found that auditors often fail to challenge management estimates. Professional skepticism means questioning the assumptions behind each estimate.',
    '【Audit Weekly】Revenue\n\nMany restatements come from revenue recognition errors. Auditors should challenge unusual journal entries near period end, and keep skepticism about side agreements.',
    '【会計ニュース】リース\n\n新しいリース会計基準では、借手はほぼすべてのリースを貸借対照表に計上する。'];
  await store.insert(M.map((body, i) => ({ body, source: 'gmail', group_id: crypto.randomUUID(), created_at: at(i + 1) })));
  const long = ['【監査ノート】今週のまとめ', 'Inventory counts matter. Observe the count, test the cutoff, and ask about goods held by third parties. Count sheets should be pre-numbered and controlled.',
    'Revenue recognition remains the top area for restatements. Look at the contract terms, especially side letters and bill-and-hold arrangements.',
    'On a lighter note, our team went hiking last weekend and the autumn leaves were beautiful.'];
  const g = crypto.randomUUID();
  await store.insert(long.map((body, seq) => ({ body, seq, group_id: g, source: 'gmail', created_at: at(0, 3) })));
  await store.savePillar({ name: '棚卸', kind: 'subject', source: 'notion', sections: [
    { h: '1) 基礎知識', items: ['実地棚卸：期末に数えて帳簿と合わせる', '評価：収益性の低下で切り下げ'] },
    { h: '2) 科目特有のリスク・留意事項', items: ['預け在庫・預り在庫の漏れ', 'カットオフ：期末前後の出荷と入荷', '滞留品の評価'] },
    { h: '3) 内部統制上の留意事項', items: ['棚卸票は連番で管理', '数える人と記録する人を分ける'] },
    { h: '4) 開示上の留意事項', items: ['評価方法の注記'] },
    { h: '5) トピック', items: [] }] });
}

// ---- 操作 ----
$('throw').addEventListener('click', () => throwIt());
$('inp').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); throwIt(); } });
if (matchMedia('(pointer:coarse)').matches) $('kbdHint').textContent = '';
$('q').addEventListener('input', onSearchInput);
$('logout').addEventListener('click', async () => { await store.signOut(); location.reload(); });
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if ($('sheet').classList.contains('on')) closeSheet(); else if (!$('sky').hidden) $('skyClose')?.click(); }
  if (e.target.id === 'editText' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('editSave').click(); }
  if (e.target.id?.startsWith('ans-') && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); answerAsk(e.target.id.slice(4), false); }
  if (e.target.id === 'bookQ' && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); document.querySelector('[data-act=bookFind]').click(); }
});
$('undo').addEventListener('click', async () => {
  $('toast').classList.remove('on');
  if (!lastDel) return;
  const batch = lastDel; lastDel = null; batch.undone = true;
  try { await store.restore(batch.rows); await loadStrata(); loadPins(); } catch (e) { fail(e); }
});
$('photoBtn').addEventListener('click', () => $('photoIn').click());
$('photoIn').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) setPhoto(f); });
$('barIn').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) bookFromBarcode(f).catch(fail); });
$('coverIn').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) bookFromCover(f).catch(fail); });
$('notionIn').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) importNotion(fs); });
$('bookBtn').addEventListener('click', () => openView({ t: 'book', id: '' }));
$('skyBtn').addEventListener('click', showSky);

document.addEventListener('click', async (e) => {
  const t = e.target;
  const act = t.closest('[data-act]');
  if (act) {
    const d = act.dataset;
    switch (d.act) {
      case 'guardGo': $('ripple').innerHTML = ''; throwIt({ checked: true, plain: !!d.plain }); return;
      case 'guardFix': $('ripple').innerHTML = ''; $('inp').focus(); return;
      case 'photoOff': setPhoto(null); return;
      case 'kindOpen': { const open = $('kindRow').hidden; $('kindRow').hidden = !open; act.setAttribute('aria-expanded', String(open)); return; }
      case 'kindSet': fixKind(d.k || null); return;
      case 'plainThrow': closeSheet(); throwIt({ plain: true }); return;
      case 'going': going(d.topic); return;
      case 'prepOf': openView({ t: 'prep', id: d.name }); return;
      case 'pEdit': $('pView').hidden = true; $('pEditBox').hidden = false; act.hidden = true; return;
      case 'pCancel': refresh(); return;
      case 'pSave': savePillarEdit(d.id); return;
      case 'pDel':
        if (act.dataset.sure) { try { await store.removePillar(d.id); await loadPillars(); backSheet(); toast('柱を消した（かけらはそのまま）'); } catch (err) { fail(err); } }
        else { act.dataset.sure = '1'; act.textContent = '本当に消す？（もう一度押す）'; }
        return;
      case 'sgMake': answerSuggestion(d.kind); return;
      case 'sgNo': answerSuggestion(null); return;
      case 'ans': answerAsk(d.kind, false); return;
      case 'ansSkip': answerAsk(d.kind, true); return;
      case 'scanBar': $('barIn').click(); return;
      case 'scanCover': $('coverIn').click(); return;
      case 'bookFind': { const q = $('bookQ').value.trim(); if (q) { $('bookCands').innerHTML = '<p class="empty">探してる…</p>'; showCands(await searchBooks(q)); } return; }
      case 'pickBook': pickBook(+d.i); return;
      case 'bookOff': bookOff(false); return;
      case 'bookDone': bookOff(true); return;
      case 'shelf': openView({ t: 'shelf', id: d.id }); return;
      case 'unbook': {
        const ids = JSON.parse($('panel').dataset.group || '[]');
        try { for (const id of (ids.length ? ids : [d.id])) { await store.patch(id, { book_id: null }); patchLocal(id, { book_id: null }); } renderStrata(); refresh(); toast('本から外した'); } catch (err) { fail(err); }
        return;
      }
      case 'notion': $('notionIn').click(); return;
      case 'home': setPlace('家'); return;
      case 'work': setPlace('職場'); return;
    }
  }
  if (t.closest('[data-pillar]')) { openView({ t: 'pillar', id: t.closest('[data-pillar]').dataset.pillar }); return; }
  const k = t.closest('.k[data-id]'); if (k) { openSheet(k.dataset.id); return; }
  if (t.id === 'close') { closeSheet(); return; }
  if (t.id === 'back') { backSheet(); return; }
  if (t.id === 'resolve') { resolveIt(t.dataset.id); return; }
  if (t.dataset.done) { handoffDone(t.dataset.done); return; }
  if (t.id === 'pinBtn') { togglePin(t.dataset.id, t.getAttribute('aria-pressed') !== 'true'); return; }
  if (t.dataset.unpin) { togglePin(t.dataset.unpin, false); return; }
  if (t.id === 'pinThrow') { t.setAttribute('aria-pressed', String(t.getAttribute('aria-pressed') !== 'true')); return; }
  const chip = t.closest('.chip[data-lens]'); if (chip) { setLens(chip.dataset.lens); return; }
  if (t.id === 'wKnow') { answerWord(true); return; }
  if (t.id === 'wAgain') { answerWord(false); return; }
  if (t.id === 'wAsk') {
    try { await navigator.clipboard.writeText(wordPrompt()); $('wCopied').textContent = 'コピーした。Claudeに貼ってね'; }
    catch { $('wCopied').textContent = 'コピーできなかった'; }
    return;
  }
  if (t.id === 'edit') { startEdit(); return; }
  if (t.id === 'editCancel') { cancelEdit(); return; }
  if (t.id === 'editSave') { saveEdit(t.dataset.id); return; }
  if (t.id === 'del') { removeIt(t.dataset.id); return; }
  if (t.id === 'ask') {
    const txt = claudePrompt();
    try { await navigator.clipboard.writeText(txt); $('copied').textContent = 'コピーした。Claudeに貼ってね'; }
    catch { const m = $('manual'); m.style.display = 'block'; m.value = txt; m.select(); $('copied').textContent = '下の文章を長押しでコピーしてね'; }
  }
});

// ログイン
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  $('gateMsg').textContent = '確かめてる…';
  try {
    await store.signIn(email, $('password').value);
    localStorage.setItem('kakera-email', email);
    $('password').value = '';
  } catch (err) {
    $('gateMsg').textContent = /invalid/i.test(err.message) ? 'メールアドレスかパスワードがちがうみたい' : '入れなかった：' + err.message;
  }
});

(async () => {
  if (!store) { showGate(''); $('loginForm').hidden = true; $('gateMsg').textContent = 'config.js に Supabase の URL と公開キーを入れてね（README 参照）'; return; }
  store.onAuth((s) => { if (s) showApp(s); });
  const s = await store.session();
  s ? showApp(s) : showGate();
})();

if ('serviceWorker' in navigator && !demo) navigator.serviceWorker.register('./sw.js').catch(() => {});
