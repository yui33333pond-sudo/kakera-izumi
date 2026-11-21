import { supabaseStore, memoryStore } from './store.js';

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
if (demo) { store = memoryStore(); window.__kakera = { get store() { return store; }, embed: (...a) => embed(...a) }; }
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
const card = (it, cls = '') => { known.set(it.id, it); return `<button class="k ${cls}" data-id="${it.id}"><span class="d">${dlabel(it.created_at)}</span><span class="clip">${esc(it.body)}</span></button>`; };

let toastTimer = 0, lastDel = null;
function toast(msg, undo = false) {
  $('toastMsg').textContent = msg;
  $('toast').classList.toggle('plain', !undo);
  $('toast').classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('on'), 6000);
}
const fail = (e) => { console.error(e); toast('うまくいかなかった：' + (e.message || e)); };

// ---- 地層 ----
let strata = [], oldest = null;
async function loadStrata(reset) {
  if (reset) { strata = []; oldest = null; }
  const rows = await store.recent(oldest, PAGE);
  strata.push(...rows);
  if (rows.length) oldest = rows[rows.length - 1].created_at;
  $('more').hidden = rows.length < PAGE;
  renderStrata();
}
function renderStrata() {
  if (!strata.length) { $('strata').innerHTML = '<p class="empty">まだ何も沈んでない。上から投げてみて。</p>'; return; }
  const groups = []; let cur = null;
  for (const it of strata) {
    const k = dkey(it.created_at);
    if (!cur || cur.k !== k) { cur = { k, t: it.created_at, list: [] }; groups.push(cur); }
    cur.list.push(it);
  }
  $('strata').innerHTML = groups.map((g, i) => {
    let prev = null;
    const cards = g.list.map((it) => { const c = card(it, prev === it.group_id ? 'chain' : ''); prev = it.group_id; return c; }).join('');
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
    const rows = await store.insert(paras.map((body, seq) => ({ body, seq, group_id, created_at: now })));
    rows.sort((a, b) => a.seq - b.seq);
    $('inp').value = '';
    strata.unshift(...rows); renderStrata();
    $('ripple').innerHTML = `<div class="lab">沈んだよ${rows.length > 1 ? `（${rows.length}つの段落に分けた）` : ''}。波紋を待ってる…</div>`;

    const vecs = await embed(paras);
    await Promise.all(rows.map((r, i) => store.setEmbedding(r.id, vecs[i])));
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
    const rows = await store.search(q, v, 12);
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
async function openSheet(id) {
  const it = known.get(id); if (!it) return;
  $('panel').innerHTML = `<span class="d" style="color:var(--mute);font-size:13px">${dlabel(it.created_at)}</span><div class="full" id="full">${esc(it.body)}</div><div class="editbox" id="editbox" hidden><textarea id="editText" aria-label="かけらを直す"></textarea><div class="prow"><button class="ghost" id="editCancel">やめる</button><button class="throw" id="editSave" data-id="${id}">直して沈める</button></div></div><div id="sibs"></div><h2>糸の先</h2><div class="stack" id="threads"><p class="empty">糸をたぐってる…</p></div><div class="prow"><button class="ghost" id="close">閉じる</button><button class="ghost" id="edit">直す</button><button class="del" id="del" data-id="${id}">このかけらを消す</button></div>`;
  $('sheet').classList.add('on');
  try {
    const [sibs, rel] = await Promise.all([store.siblings(it.group_id), store.related(id, 3)]);
    if (!$('threads')) return;
    if (sibs.length > 1) $('sibs').innerHTML = `<h2>同じとき投げた段落</h2><div class="stack">${sibs.map((s) => card(s, 'sib' + (s.id === id ? ' cur' : ''))).join('')}</div>`;
    const good = rel.filter((r) => r.similarity >= THREAD_MIN);
    $('threads').innerHTML = good.length ? good.map((r) => card(r)).join('') : '<p class="empty">まだ糸はつながってない。</p>';
  } catch (e) { fail(e); }
}
const closeSheet = () => $('sheet').classList.remove('on');

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
    openSheet(id);
    toast('直した');
    const [v] = await embed([body]);
    await store.setEmbedding(id, v);
    if ($('sheet').classList.contains('on')) openSheet(id); // 糸の先を新しい中身で引き直す
  } catch (e) { fail(e); $('editSave') && ($('editSave').disabled = false); }
}

// ---- 埋め込み待ちのかけら（取り込み分など）を後から処理 ----
async function backfill() {
  try {
    for (;;) {
      const rows = await store.unembedded(16);
      if (!rows.length) return;
      $('model').textContent = `まだ波紋の出ないかけらを${rows.length}件ずつ整え中…`;
      const vecs = await embed(rows.map((r) => r.body));
      for (let i = 0; i < rows.length; i++) await store.setEmbedding(rows[i].id, vecs[i]);
    }
  } catch (e) { console.error(e); }
  finally { if (modelReady) $('model').textContent = ''; }
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
  }
  embed(null).catch(() => {}); // モデルを先に温める
  try { await loadStrata(true); } catch (e) { fail(e); }
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
  const k = e.target.closest('.k'); if (k) { openSheet(k.dataset.id); return; }
  if (e.target.id === 'close') { closeSheet(); return; }
  if (e.target.id === 'edit') { startEdit(); return; }
  if (e.target.id === 'editCancel') { cancelEdit(); return; }
  if (e.target.id === 'editSave') { saveEdit(e.target.dataset.id); return; }
  if (e.target.id === 'del') {
    const id = e.target.dataset.id;
    try {
      lastDel = await store.remove(id);
      strata = strata.filter((r) => r.id !== id); renderStrata();
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
