import { supabaseStore, memoryStore } from './store.js';
import { lookup } from './dict.js';
import { LENSES, lensLabel, loadProtos, classify, wordsFromMine, wordsFromMail } from './lens.js';

// ---- 調整つまみ（関係ない文どうしは 0.1〜0.3、近い話は 0.4 以上になりやすい） ----
const RIPPLE_MIN = 0.40;   // 波紋に出す近さ
const THREAD_MIN = 0.36;   // 糸の先に出す近さ
const SEARCH_MIN = 0.30;   // 探すときに出す近さ（文字が含まれていれば常に出す）
const PAGE = 200;

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;

// ---- 保存先 ----
const demo = new URLSearchParams(location.search).has('demo');
const cfg = window.KAKERA_CONFIG || {};
let store;
if (demo) { store = memoryStore(); window.__kakera = { get store() { return store; }, embed: (...a) => embed(...a), loadWord: () => loadWord() }; }
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
const MAX = 260; // モデルが一度に読めるのは短めなので、段落もこのくらいに
function splitParas(text) {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (t.length <= MAX) return [t];
  const out = [];
  for (const block of t.split(/\n\s*\n/)) {
    const b = block.trim(); if (!b) continue;
    if (b.length <= MAX * 1.6) { out.push(b); continue; }
    // とても長い段落は文の切れ目でまとめ直す
    let cur = '';
    for (const s of b.split(/(?<=[。．！？!?\n]|\.\s)/)) {
      if (cur && (cur + s).length > MAX) { out.push(cur.trim()); cur = ''; }
      cur += s;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  // 短すぎる段落は前とくっつける
  const merged = [];
  for (const p of out) {
    if (merged.length && (p.length < 40 || merged[merged.length - 1].length < 40)) merged[merged.length - 1] += '\n\n' + p;
    else merged.push(p);
  }
  return merged;
}

// ---- 表示まわり ----
const dlabel = (iso) => {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const diff = Math.round((a - d) / DAY);
  if (diff === 0) return '今日';
  if (diff === 1) return '昨日';
  return (d.getFullYear() !== a.getFullYear() ? d.getFullYear() + '年' : '') + (d.getMonth() + 1) + '月' + d.getDate() + '日';
};
const dkey = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
const known = new Map(); // id -> row（開くときに使う）
const tag = (it) => [it.pinned_at ? '📌' : '', it.source === 'gmail' || it.source === 'yahoo' ? 'メルマガ' : '', lensLabel(it.lens)].filter(Boolean).map((t) => ' · ' + t).join('');
const card = (it, cls = '') => { known.set(it.id, it); return `<button class="k ${cls}" data-id="${it.id}"><span class="d">${dlabel(it.created_at)}${tag(it)}</span><span class="clip">${esc(it.body)}</span></button>`; };

let toastTimer = 0, lastDel = null;
function toast(msg, undo = false) {
  $('toastMsg').textContent = msg;
  $('toast').classList.toggle('plain', !undo);
  $('toast').classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('on'), 6000);
}
const fail = (e) => { console.error(e); toast('うまくいかなかった：' + (e.message || e)); };

// ---- 地層 ----
let strata = [], oldest = null, curLens = null;
async function loadStrata(reset) {
  if (reset) { strata = []; oldest = null; }
  const rows = await store.recent(oldest, PAGE, curLens);
  strata.push(...rows);
  if (rows.length) oldest = rows[rows.length - 1].created_at;
  $('more').hidden = rows.length < PAGE;
  renderStrata();
}
function renderStrata() {
  $('strataTitle').textContent = curLens ? `積もったかけら（${lensLabel(curLens)}）` : '積もったかけら';
  if (!strata.length) { $('strata').innerHTML = curLens ? '<p class="empty">このレンズのかけらはまだない。</p>' : '<p class="empty">まだ何も沈んでない。上から投げてみて。</p>'; return; }
  const groups = []; let cur = null;
  for (const it of strata) {
    const k = dkey(it.created_at);
    if (!cur || cur.k !== k) { cur = { k, t: it.created_at, list: [] }; groups.push(cur); }
    cur.list.push(it);
  }
  $('strata').innerHTML = groups.map((g, i) => {
    // 同じ投げ込み（メルマガ1通など）は2段落まで見せて、残りはたたむ
    const runs = [];
    for (const it of g.list) {
      const last = runs[runs.length - 1];
      if (last && last[0].group_id === it.group_id) last.push(it); else runs.push([it]);
    }
    const cards = runs.map((run) => run.slice(0, 2).map((it, j) => card(it, j ? 'chain' : '')).join('')
      + (run.length > 2 ? `<button class="fold" data-id="${run[0].id}">…ほか ${run.length - 2} 段落</button>` : '')).join('');
    return `<div class="layer" style="--p:${Math.min(20 + i * 14, 100)}%"><div class="bar"></div><div><h3>${dlabel(g.t)}</h3><div class="list">${cards}</div></div></div>`;
  }).join('');
}

// ---- 投げる ----
let throwing = false;
async function throwIt() {
  const text = $('inp').value.trim();
  if (!text || throwing) return;
  throwing = true; $('throw').disabled = true;
  const s = $('surface'); s.classList.remove('go'); void s.offsetWidth; s.classList.add('go');
  try {
    const paras = splitParas(text);
    const group_id = crypto.randomUUID();
    const now = new Date().toISOString();
    // 先に文字だけ沈める（モデルの準備がまだでも消えない）
    const pin = $('pinThrow').getAttribute('aria-pressed') === 'true';
    const rows = await store.insert(paras.map((body, seq) => ({ body, seq, group_id, created_at: now, ...(pin ? { pinned_at: now } : {}) })));
    if (pin) { $('pinThrow').setAttribute('aria-pressed', 'false'); loadPins(); }
    rows.sort((a, b) => a.seq - b.seq);
    $('inp').value = '';
    if (!curLens) { strata.unshift(...rows); renderStrata(); }
    $('ripple').innerHTML = `<div class="lab">沈んだよ${rows.length > 1 ? `（${rows.length}つの段落に分けた）` : ''}。波紋を待ってる…</div>`;

    const vecs = await embed(paras);
    await settle(rows, vecs, true);
    if (!curLens) renderStrata();
    // どの段落からでも、いちばん近い過去のかけらを1つだけ
    const best = (await Promise.all(vecs.map((v) => store.match(v, 1, group_id)))).flat()
      .sort((a, b) => b.similarity - a.similarity);
    const hit = best[0];
    $('ripple').innerHTML = hit && hit.similarity >= RIPPLE_MIN
      ? `<div class="lab">波紋：これと近いかも</div>${card(hit)}`
      : `<div class="lab">沈んだよ。まだ似たかけらはないみたい。</div>`;
  } catch (e) {
    $('ripple').innerHTML = '<div class="lab">沈んだよ。波紋はあとで届く。</div>';
    fail(e);
  } finally {
    throwing = false; $('throw').disabled = false;
  }
}

// ---- 探す ----
let hits = [], searchTimer = 0, searchSeq = 0;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $('q').value.trim();
  if (!q) { hits = []; $('results').innerHTML = '<p class="empty">言葉がちがっても、日本語と英語をまたいでも、近いかけらが近い順に並ぶよ。</p>'; return; }
  searchTimer = setTimeout(() => runSearch(q), 350);
}
async function runSearch(q) {
  const my = ++searchSeq;
  if (!modelReady) $('results').innerHTML = '<p class="empty">泉の準備中…</p>';
  try {
    const [v] = await embed([q]);
    const rows = await store.search(q, v, 12, curLens);
    if (my !== searchSeq) return;
    hits = rows.filter((r) => r.literal || r.similarity >= SEARCH_MIN);
    renderResults(q);
  } catch (e) { if (my === searchSeq) fail(e); }
}
function renderResults(q) {
  if (!hits.length) { $('results').innerHTML = '<p class="empty">近いかけらは見つからなかった。</p>'; return; }
  const lo = SEARCH_MIN - 0.02, hi = Math.max(...hits.map((h) => h.similarity));
  $('results').innerHTML = hits.map((h, n) => `<div class="res"><input type="checkbox" id="c${n}" checked aria-label="Claudeに渡す"><div>${card(h)}<div class="meter" style="width:${Math.max(8, ((h.similarity - lo) / Math.max(hi - lo, 0.01)) * 100)}%"></div></div></div>`).join('')
    + `<button class="ask" id="ask">チェックしたものでClaudeに聞く文章をコピー</button><span class="copied" id="copied"></span><textarea class="manual" id="manual" readonly aria-label="コピー用"></textarea>`;
}
const nums = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫';
function claudePrompt() {
  const q = $('q').value.trim();
  const sel = hits.filter((_h, n) => $('c' + n)?.checked);
  return `【質問】${q}について、まとめて\n\n【私のメモ】\n` + sel.map((h, n) => `${nums[n]} ${dlabel(h.created_at)}：${h.body}`).join('\n')
    + '\n\n上のメモだけを根拠に、どのメモから言えるか番号を付けて答えて';
}

// ---- 開く（糸の先） ----
// 開いた順に積んでおき、「戻る」で前のかけらへ
let sheetStack = [];
async function openSheet(id, { push = true } = {}) {
  const it = known.get(id); if (!it) return;
  if (push) { if (sheetStack[sheetStack.length - 1] !== id) sheetStack.push(id); }
  const canBack = sheetStack.length > 1;
  $('panel').innerHTML = `<div class="sbar">`
    + (canBack ? `<button class="ghost small" id="back">‹ 戻る</button>` : '')
    + `<span class="d">${dlabel(it.created_at)}${tag(it)}</span>`
    + `<button class="ghost small" id="pinBtn" data-id="${id}" aria-pressed="${!!it.pinned_at}">${it.pinned_at ? '📌 外す' : '📌 ピン'}</button>`
    + `<button class="ghost small" id="edit">直す</button><button class="ghost small" id="close" aria-label="閉じる">閉じる ✕</button></div>`
    + `<div class="sbody"><div class="full" id="full">${esc(it.body)}</div><div class="editbox" id="editbox" hidden><textarea id="editText" aria-label="かけらを直す"></textarea><div class="prow"><button class="ghost" id="editCancel">やめる</button><button class="throw" id="editSave" data-id="${id}">直して沈める</button></div></div><div id="sibs"></div><h2>糸の先</h2><div class="stack" id="threads"><p class="empty">糸をたぐってる…</p></div><div class="prow"><button class="del" id="del" data-id="${id}">このかけらを消す</button></div></div>`;
  $('panel').scrollTop = 0;
  if (!$('sheet').classList.contains('on')) { $('sheet').classList.add('on'); document.body.classList.add('locked'); }
  try {
    const [sibs, rel] = await Promise.all([store.siblings(it.group_id), store.related(id, 3)]);
    if (!$('threads') || sheetStack[sheetStack.length - 1] !== id) return;  // その間に別のかけらを開いていたら捨てる
    if (sibs.length > 1) $('sibs').innerHTML = `<h2>同じとき投げた段落</h2><div class="stack">${sibs.map((s) => card(s, 'sib' + (s.id === id ? ' cur' : ''))).join('')}</div>`;
    const good = rel.filter((r) => r.similarity >= THREAD_MIN);
    $('threads').innerHTML = good.length ? good.map((r) => card(r)).join('') : '<p class="empty">まだ糸はつながってない。</p>';
  } catch (e) { fail(e); }
}
const closeSheet = () => { $('sheet').classList.remove('on'); document.body.classList.remove('locked'); sheetStack = []; };
const backSheet = () => { sheetStack.pop(); const prev = sheetStack[sheetStack.length - 1]; prev ? openSheet(prev, { push: false }) : closeSheet(); };

// ---- 直す ----
function startEdit() {
  $('editText').value = $('full').textContent;
  $('full').hidden = true; $('editbox').hidden = false; $('edit').hidden = true;
  $('editText').focus();
}
function cancelEdit() { $('full').hidden = false; $('editbox').hidden = true; $('edit').hidden = false; }
async function saveEdit(id) {
  const body = $('editText').value.trim();
  const it = known.get(id);
  if (!body || !it) return;
  if (body === it.body) { cancelEdit(); return; }
  $('editSave').disabled = true;
  try {
    await store.updateBody(id, body);           // 文字を先に保存（意味はこのあと計算し直す）
    for (const list of [strata, hits]) for (const r of list) if (r.id === id) r.body = body;
    it.body = body; renderStrata();
    if (hits.length) renderResults();
    openSheet(id, { push: false });
    toast('直した');
    const [v] = await embed([body]);
    await settle([it], [v], false);
    if ($('sheet').classList.contains('on') && sheetStack[sheetStack.length - 1] === id) openSheet(id, { push: false }); // 糸の先を新しい中身で引き直す
  } catch (e) { fail(e); $('editSave') && ($('editSave').disabled = false); }
}

// ---- 埋め込み待ちのかけら（取り込み分など）を後から処理 ----
async function backfill() {
  let done = 0;
  try {
    for (;;) {
      const rows = await store.pending(16);
      if (!rows.length) return;
      $('model').textContent = `取り込んだかけらを整え中…（${done}件済み）`;
      const vecs = await embed(rows.map((r) => r.body));
      // レンズがまだ無い＝初めて整えるかけら。そのときだけ英単語を数える
      for (let i = 0; i < rows.length; i++) await settle([rows[i]], [vecs[i]], !rows[i].lens);
      done += rows.length;
    }
  } catch (e) { console.error(e); }
  finally {
    if (modelReady) $('model').textContent = '';
    if (done) { loadStrata(true).catch(() => {}); loadWord(); }
  }
}

// 意味を保存し、レンズを見分け、（初回だけ）英単語を拾う
async function settle(rows, vecs, bump) {
  const protos = await loadProtos(embed).catch(() => null);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lens = classify(row, vecs[i], protos);
    await store.setEmbedding(row.id, vecs[i], lens);
    row.lens = lens;
    for (const list of [strata]) for (const r of list) if (r.id === row.id) r.lens = lens;
    if (!bump) continue;
    try {
      if (row.source === 'gmail' || row.source === 'yahoo') await store.bumpWords(wordsFromMail(row.body), 'mail', row.id);
      else if (lens === 'word') { await store.bumpWords(wordsFromMine(row.body), 'mine', row.id); loadWord(); }
    } catch (e) { console.error(e); }
  }
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
    const at = on ? new Date().toISOString() : null;
    for (const r of [...strata, ...hits, known.get(id)].filter(Boolean)) if (r.id === id) r.pinned_at = at;
    renderStrata(); await loadPins();
    if ($('sheet').classList.contains('on') && sheetStack[sheetStack.length - 1] === id) openSheet(id, { push: false });
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
  loadStrata(true).catch(fail);
  onSearchInput();
}

// ---- 今日の英単語 ----
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const today = () => ymd(new Date());
const later = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const GAPS = [1, 3, 7, 14, 30];
let wordNow = null, wordLoading = false;

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
    if (w.last_seen !== t) await store.touchWord(w.word, { last_seen: t });   // 今日の1語に決める（PCとスマホで同じ語になる）
    wordNow = w;
    const ex = [];
    for (const r of await store.examples(w.word)) {
      for (const sen of sentencesWith(r.body, w.word)) { if (!ex.some((e) => e.s === sen)) ex.push({ s: sen, r }); if (ex.length >= 3) break; }
      if (ex.length >= 3) break;
    }
    const mine = w.origin === 'mine' && w.kakera_id ? await store.kakera(w.kakera_id) : null;
    const meta = w.origin === 'mine' ? '自分で投げた単語' : `メルマガで ${w.freq} 回`;
    const again = w.step > 0 ? ` · ${w.step + 1} 回目` : '';
    $('wordBox').innerHTML = `<div class="wd-word">${esc(w.word)}</div><p class="wd-meta">${meta}${again}</p>`
      + `<div class="wd-mean" id="wdMean"><span class="empty">意味をさがしてる…</span></div>`
      + (mine ? `<div class="wd-mine">${card(mine)}</div>` : '')
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
let wordExamples = [];
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
  if (demo) {
    const S = [[0, 'accrual って発生主義のことか。メルマガの記事で出てきて、会計の勉強とつながった'], [0, '今日は朝から会議続きでしんどかった。夕方の散歩で少し戻った'], [2, '研修メモ：監基報240、職業的懐疑心の話がかなり多かった。経営者への質問も増えそう'], [5, 'Read an article on fraud risk assessment: auditors should revisit the risk of material misstatement due to fraud every year.'], [9, '仕訳の練習。前払費用と未払費用、時間のずれをどっちに置くかで混乱する'], [14, '"skepticism" の発音、スケプティシズム。'], [21, 'Felt foggy all day, maybe the weather. A short walk always helps on tough days.'], [30, '収益認識の5ステップ、契約の識別から。']];
    await store.insert(S.map(([d, body], i) => ({ body, group_id: crypto.randomUUID(), created_at: new Date(Date.now() - d * DAY - i * 36e5).toISOString() })));
    const M = ['【Audit Weekly】Fraud and estimates\n\nRegulators found that auditors often fail to challenge management estimates. Professional skepticism means questioning the assumptions behind each estimate.',
      '【Audit Weekly】Revenue\n\nMany restatements come from revenue recognition errors. Auditors should challenge unusual journal entries near period end, and keep skepticism about side agreements.',
      '【会計ニュース】リース\n\n新しいリース会計基準では、借手はほぼすべてのリースを貸借対照表に計上する。'];
    await store.insert(M.map((body, i) => ({ body, source: 'gmail', group_id: crypto.randomUUID(), created_at: new Date(Date.now() - (i + 1) * DAY).toISOString() })));
  }
  embed(null).catch(() => {}); // モデルを先に温める
  renderLenses();
  loadPins();
  try { await loadStrata(true); } catch (e) { fail(e); }
  loadWord();
  backfill();
}

$('throw').addEventListener('click', throwIt);
$('inp').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); throwIt(); } });
if (matchMedia('(pointer:coarse)').matches) $('kbdHint').textContent = '';
$('q').addEventListener('input', onSearchInput);
$('more').addEventListener('click', () => loadStrata(false).catch(fail));
$('logout').addEventListener('click', async () => { await store.signOut(); location.reload(); });
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if (e.target.id === 'editText' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('editSave').click(); }
});
$('undo').addEventListener('click', async () => {
  $('toast').classList.remove('on');
  if (!lastDel) return;
  const row = lastDel; lastDel = null;
  try { await store.restore([row]); await loadStrata(true); } catch (e) { fail(e); }
});
document.addEventListener('click', async (e) => {
  const k = e.target.closest('.k, .fold'); if (k) { openSheet(k.dataset.id); return; }
  if (e.target.id === 'close') { closeSheet(); return; }
  if (e.target.id === 'back') { backSheet(); return; }
  if (e.target.id === 'pinBtn') { togglePin(e.target.dataset.id, e.target.getAttribute('aria-pressed') !== 'true'); return; }
  if (e.target.dataset.unpin) { togglePin(e.target.dataset.unpin, false); return; }
  if (e.target.id === 'pinThrow') { e.target.setAttribute('aria-pressed', String(e.target.getAttribute('aria-pressed') !== 'true')); return; }
  const chip = e.target.closest('.chip'); if (chip) { setLens(chip.dataset.lens); return; }
  if (e.target.id === 'wKnow') { answerWord(true); return; }
  if (e.target.id === 'wAgain') { answerWord(false); return; }
  if (e.target.id === 'wAsk') {
    try { await navigator.clipboard.writeText(wordPrompt()); $('wCopied').textContent = 'コピーした。Claudeに貼ってね'; }
    catch { $('wCopied').textContent = 'コピーできなかった'; }
    return;
  }
  if (e.target.id === 'edit') { startEdit(); return; }
  if (e.target.id === 'editCancel') { cancelEdit(); return; }
  if (e.target.id === 'editSave') { saveEdit(e.target.dataset.id); return; }
  if (e.target.id === 'del') {
    const id = e.target.dataset.id;
    try {
      lastDel = await store.remove(id);
      strata = strata.filter((r) => r.id !== id); renderStrata(); loadPins();
      hits = hits.filter((r) => r.id !== id); if (hits.length || $('q').value.trim()) renderResults();
      closeSheet(); toast('かけらを消した', true);
    } catch (err) { fail(err); }
    return;
  }
  if (e.target.id === 'ask') {
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

// ホーム画面アプリ用（オフラインでも画面だけは開ける）
if ('serviceWorker' in navigator && !demo) navigator.serviceWorker.register('./sw.js').catch(() => {});
