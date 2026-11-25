/**
 * かけらの泉：Gmail の見張り番
 *
 * メルマガ用の Gmail アカウントで script.google.com に貼って使う。
 * 1時間ごとに新しいメールを見て、受け付ける差出人のものだけを段落に分けて泉に沈める。
 *
 * 受け付けるもの
 *   - SENDERS に書いた差出人（アドレス、または @example.com のようなドメイン）
 *   - YAHOO_ADDRESS からの転送（転送の前置きは取り除く）
 *
 * 設定はすべて「プロジェクトの設定 → スクリプト プロパティ」に入れる（このファイルには書かない）
 *   SUPABASE_URL   https://xxxx.supabase.co
 *   SUPABASE_KEY   sb_publishable_…（公開用の鍵）
 *   INGEST_TOKEN   02_ingest.sql で発行した取り込み専用の鍵
 *   SENDERS        news@example.com, @example.jp  （カンマ区切り）
 *   YAHOO_ADDRESS  自分の Yahoo メールのアドレス
 *
 *   FOLDER_LABEL   （なくてよい）まとめて取り込むラベル名。初期値は「泉行き」
 *
 * 使い方
 *   0. listSenders を実行 → 最近の差出人の一覧（SENDERS に入れる候補）が出る。足したら recheck
 *   1. tryIt を実行 → ログに「何が沈むか」が出る（まだ送らない）
 *   2. setup を実行 → 1時間ごとの見張りが始まる（最初の1回もすぐ動く）
 *   「泉行き」ラベルをまとめて取り込むとき
 *   3. tryFolder を実行 → 最初の5通ぶんの「何が沈むか」が出る
 *   4. importFolder を実行 → 全部沈める（多いときは自動で続きから再開する）
 */

const DONE_LABEL = 'kakera-done';   // 取り込んだスレッドに付く
const LOOKBACK = 'newer_than:14d';  // 見に行く範囲
const MAX = 260;                    // 1段落のめやす（アプリと同じ）

function setup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'watch')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('watch').timeBased().everyHours(1).create();
  watch();
}

function tryIt() { watch(true); }

// 最近14日に届いたメールの差出人を、多い順にログに出す（SENDERS に入れる候補）。何も送らない
function listSenders() {
  const cfg = conf_();
  const count = {};
  for (const th of GmailApp.search(LOOKBACK, 0, 200)) {
    for (const msg of th.getMessages()) {
      const a = addr_(msg.getFrom());
      if (!count[a]) count[a] = { n: 0, name: name_(msg.getFrom()), subject: msg.getSubject() };
      count[a].n++;
    }
  }
  const rows = Object.keys(count).sort((a, b) => count[b].n - count[a].n);
  console.log(`いまの SENDERS：${cfg.senders.length ? cfg.senders.join(', ') : '（空っぽ）'}\n\n最近14日の差出人：\n` +
    rows.map((a) => `${accepted_(a, cfg.senders) ? '✓' : '・'} ${a}（${count[a].n}通）${count[a].name} 「${String(count[a].subject).slice(0, 40)}」`).join('\n') +
    '\n\n✓ は取り込む差出人。取り込みたいアドレスを SENDERS にカンマ区切りで足してから recheck を実行する');
}

// 最近14日の「見た」印を外して、もう一度見張る（SENDERS を足したあとに。同じメールは二度入らない）
function recheck() {
  const label = GmailApp.getUserLabelByName(DONE_LABEL);
  if (label) {
    const threads = GmailApp.search(`label:${DONE_LABEL} ${LOOKBACK}`, 0, 200);
    if (threads.length) label.removeFromThreads(threads);
  }
  watch();
}

function watch(dryRun) {
  dryRun = dryRun === true;  // 時間で動くときは引数にイベントが入るので、true のときだけ「見るだけ」
  const cfg = conf_();
  const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  const threads = GmailApp.search(`-label:${DONE_LABEL} ${LOOKBACK}`, 0, 40);
  let sunk = 0, seen = 0;

  for (const th of threads) {
    const items = [];
    for (const msg of th.getMessages()) {
      const k = toKakera_(msg, cfg);
      if (k) items.push(...k);
    }
    if (items.length) {
      seen++;
      if (dryRun) {
        console.log(`--- ${th.getFirstMessageSubject()}（${items.length}段落）\n` +
          items.slice(0, 4).map((i) => '・' + i.body.slice(0, 120).replace(/\n/g, ' ')).join('\n'));
        continue;
      }
      for (let i = 0; i < items.length; i += 200) sunk += send_(cfg, items.slice(i, i + 200));
    }
    if (!dryRun) th.addLabel(label);  // 受け付けないメールも「見た」印を付けて次から飛ばす
  }
  console.log(dryRun ? `試し：沈む予定のメール ${seen} 通` : `沈めた段落 ${sunk} 個（メール ${seen} 通）`);
}

// ---------- 「泉行き」ラベルの中身をまとめて取り込む ----------
// 差出人は問わない。転送なら前置きを取る。量が多くても、6分の制限が近づいたら1分後に続きから再開する。
const FOLDER_DONE = 'kakera-folder-done';

function tryFolder() { importFolder(true); }

function importFolder(dryRun) {
  dryRun = dryRun === true;
  const cfg = conf_();
  if (!GmailApp.getUserLabelByName(cfg.folder)) throw new Error(`ラベル「${cfg.folder}」が見つからない`);
  const done = GmailApp.getUserLabelByName(FOLDER_DONE) || GmailApp.createLabel(FOLDER_DONE);
  const q = `label:${cfg.folder.replace(/[\s\/]/g, '-')} -label:${FOLDER_DONE}`;
  const started = Date.now();
  let sunk = 0, seen = 0, more = false;

  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'importFolder')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  for (;;) {
    const threads = GmailApp.search(q, 0, dryRun ? 5 : 50);
    if (!threads.length) break;
    for (const th of threads) {
      const items = [];
      for (const msg of th.getMessages()) {
        const k = toKakera_(msg, cfg, true);
        if (k) items.push(...k);
      }
      if (items.length) seen++;
      if (dryRun) {
        console.log(`--- ${th.getFirstMessageSubject()}（${items.length}段落）\n` +
          items.slice(0, 4).map((i) => '・' + i.body.slice(0, 120).replace(/\n/g, ' ')).join('\n'));
        continue;
      }
      for (let i = 0; i < items.length; i += 200) sunk += send_(cfg, items.slice(i, i + 200));
      th.addLabel(done);
      if (Date.now() - started > 4.5 * 60 * 1000) { more = true; break; }
    }
    if (dryRun || more) break;
  }

  if (more) ScriptApp.newTrigger('importFolder').timeBased().after(60 * 1000).create();
  console.log(dryRun ? `試し：最初の ${seen} 通ぶん（全部ではない）`
    : `沈めた段落 ${sunk} 個（メール ${seen} 通）` + (more ? '。まだ残りがあるので1分後に続きから動く' : `。「${cfg.folder}」は全部終わった`));
}

// ---------- 1通のメール → かけら ----------
function toKakera_(msg, cfg, acceptAll) {
  const from = addr_(msg.getFrom());
  let body = msg.getPlainBody() || '';
  let subject = msg.getSubject() || '';
  let sender = name_(msg.getFrom());
  let source = 'gmail';

  const fw = (acceptAll || (cfg.yahoo && from === cfg.yahoo)) ? stripForward_(body) : null;
  if (fw) {
    body = fw.body;
    subject = fw.subject || subject.replace(/^\s*(fwd?|転送)\s*[:：]\s*/i, '');
    sender = fw.from ? name_(fw.from) : sender;
    if (from === cfg.yahoo) source = 'yahoo';
  } else if (!acceptAll && !accepted_(from, cfg.senders)) {
    return null;                             // 登録した差出人でも、自分の Yahoo からの転送でもない
  }

  const paras = splitParas_(clean_(body));
  if (!paras.length) return null;
  paras[0] = `【${sender}】${subject}\n\n${paras[0]}`;

  const group = Utilities.getUuid();
  const when = msg.getDate().toISOString();
  const id = msg.getId();
  return paras.map((p, seq) => ({
    body: p, seq, group_id: group, created_at: when, source, source_ref: `${id}:${seq}`,
  }));
}

function accepted_(from, senders) {
  return senders.some((s) => (s.startsWith('@') ? from.endsWith(s) : from === s));
}

// ---------- 転送の前置きを取る ----------
function stripForward_(text) {
  const t = text.replace(/\r\n?/g, '\n');
  const mark = /^[ \t>]*-{2,}\s*(?:Forwarded [Mm]essage|Original [Mm]essage|転送メッセージ|転送されたメッセージ|元のメッセージ)\s*-{2,}[ \t]*$/m;
  const m = t.match(mark);
  if (!m) return null;
  const lines = t.slice(m.index + m[0].length).split('\n').map((l) => l.replace(/^>\s?/, ''));
  const hdr = {};
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  for (; i < lines.length; i++) {
    const h = lines[i].match(/^\s*(From|差出人|Date|Sent|日付|日時|送信日時|Subject|件名|To|宛先|Cc)\s*[:：]\s*(.*)$/i);
    if (h) { hdr[h[1].toLowerCase()] = h[2].trim(); continue; }
    if (!lines[i].trim() || Object.keys(hdr).length) break;
  }
  return {
    body: lines.slice(i).join('\n'),
    from: hdr.from || hdr['差出人'] || null,
    subject: hdr.subject || hdr['件名'] || null,
  };
}

// ---------- メルマガの本文を整える ----------
function clean_(text) {
  let t = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  t = t.replace(/https?:\/\/\S{50,}/g, '');                    // 長い追跡リンクは捨てる
  t = t.split('\n').filter((l) => {
    const s = l.trim();
    if (/^https?:\/\/\S+$/.test(s)) return false;                // URLだけの行
    if (/^[-=_*#~─━＝＊・◆◇■□●○★☆…\s]{4,}$/.test(s)) return false; // 飾り線
    return true;
  }).join('\n');
  // 終わりのほうの「配信停止」などから下は落とす
  const foot = /(配信停止|配信解除|購読解除|登録解除|メール配信の停止|unsubscribe|manage (your )?(preferences|subscription)|このメールは.{0,30}(送信|配信)専用)/i;
  const lines = t.split('\n');
  for (let i = Math.floor(lines.length * 0.6); i < lines.length; i++) {
    if (foot.test(lines[i])) {
      let j = i;
      while (j > 0 && lines[j - 1].trim()) j--;                  // その段落の頭から
      t = lines.slice(0, j).join('\n');
      break;
    }
  }
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- 段落に分ける（アプリの splitParas と同じ考え方） ----------
function splitParas_(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= MAX) return [t];
  const out = [];
  for (const block of t.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
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

// ---------- 送る ----------
function send_(cfg, items) {
  const res = UrlFetchApp.fetch(`${cfg.url}/rest/v1/rpc/ingest_kakera`, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: cfg.key },
    payload: JSON.stringify({ token: cfg.token, items }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error(`泉に届かなかった ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
  return Number(res.getContentText()) || 0;
}

// ---------- 小物 ----------
function conf_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'INGEST_TOKEN']) {
    if (!p[k]) throw new Error(`スクリプト プロパティ ${k} が空`);
  }
  return {
    url: p.SUPABASE_URL.replace(/\/+$/, ''),
    key: p.SUPABASE_KEY,
    token: p.INGEST_TOKEN,
    senders: (p.SENDERS || '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
    yahoo: (p.YAHOO_ADDRESS || '').trim().toLowerCase(),
    folder: (p.FOLDER_LABEL || '泉行き').trim(),
  };
}
function addr_(from) { const m = String(from).match(/<([^>]+)>/); return (m ? m[1] : String(from)).trim().toLowerCase(); }
function name_(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*</);
  return (m && m[1].trim()) || addr_(from);
}
