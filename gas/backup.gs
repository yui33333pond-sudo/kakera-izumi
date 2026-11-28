/**
 * 유리：週に1回、中身をぜんぶ Google ドライブに書き出す（バックアップ）
 *
 * 自分の Google アカウントで script.google.com →「新しいプロジェクト」に貼って使う。
 * 自分としてログインして読むので、見えるのは自分のものだけ（RLS のまま）。書き込みはしない。
 *
 * 設定はすべて「プロジェクトの設定 → スクリプト プロパティ」に入れる（このファイルにもチャットにも書かない）
 *   SUPABASE_URL    https://xxxx.supabase.co（config.js と同じ）
 *   SUPABASE_KEY    sb_publishable_…（config.js と同じ公開用の鍵）
 *   YURI_EMAIL      유리に入るときのメールアドレス
 *   YURI_PASSWORD   유리に入るときのパスワード
 *   FOLDER_NAME     （なくてよい）書き出すフォルダ名。初期値は「유리バックアップ」
 *   KEEP            （なくてよい）残しておく数。初期値は 12（＝約3か月分）
 *
 * 使い方
 *   1. tryIt を実行 → いま1回書き出して、表ごとの件数をログに出す（初回は権限の確認が出る）
 *   2. setup を実行 → 毎週日曜の朝4時ごろに自動で書き出す
 *
 * 書き出したファイル：yuri-2026-11-29.json（表ごとの行。検索用の数字の列 embedding は省く）
 */

const TABLES = ['nodes', 'sections', 'paras', 'cards', 'stickies', 'links', 'kv', 'kakera', 'words', 'pillars', 'books'];
const PAGE = 1000;

function setup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'backup')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(4).create();
  console.log('毎週日曜の朝4時ごろに書き出すようにした');
}

function tryIt() { backup(); }

function backup() {
  const cfg = cfg_();
  const token = login_(cfg);
  const out = { app: 'yuri', at: new Date().toISOString(), tables: {} };
  const counts = [];
  for (const t of TABLES) {
    const rows = readAll_(cfg, token, t);
    if (rows === null) { counts.push(`${t}: （ない）`); continue; }
    out.tables[t] = rows;
    counts.push(`${t}: ${rows.length}`);
  }
  const folder = folder_(cfg.folder);
  const day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const name = `yuri-${day}.json`;
  const old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);   // 同じ日にもう1回動いたら上書き
  folder.createFile(name, JSON.stringify(out), 'application/json');
  trim_(folder, cfg.keep);
  console.log(`書き出した：${folder.getName()}/${name}\n${counts.join('\n')}`);
}

// ---------- ここから下は中身 ----------
function cfg_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'YURI_EMAIL', 'YURI_PASSWORD']) {
    if (!p[k]) throw new Error(`スクリプト プロパティに ${k} がない`);
  }
  return {
    url: p.SUPABASE_URL.replace(/\/$/, ''), key: p.SUPABASE_KEY,
    email: p.YURI_EMAIL, password: p.YURI_PASSWORD,
    folder: p.FOLDER_NAME || '유리バックアップ', keep: Number(p.KEEP) || 12,
  };
}

function login_(cfg) {
  const res = UrlFetchApp.fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: cfg.key },
    payload: JSON.stringify({ email: cfg.email, password: cfg.password }),
  });
  if (res.getResponseCode() !== 200) throw new Error(`ログインできなかった（${res.getResponseCode()}）。メールアドレスとパスワードを確かめて`);
  return JSON.parse(res.getContentText()).access_token;
}

function readAll_(cfg, token, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = UrlFetchApp.fetch(`${cfg.url}/rest/v1/${table}?select=*&order=created_at.asc.nullsfirst&offset=${from}&limit=${PAGE}`, {
      muteHttpExceptions: true, headers: { apikey: cfg.key, Authorization: `Bearer ${token}` },
    });
    const code = res.getResponseCode();
    if (code === 404) return null;                       // その表はない
    if (code === 400 && from === 0) return readPlain_(cfg, token, table);   // created_at がない表
    if (code !== 200) throw new Error(`${table} を読めなかった（${code}）：${res.getContentText().slice(0, 200)}`);
    const page = JSON.parse(res.getContentText());
    for (const r of page) { delete r.embedding; rows.push(r); }
    if (page.length < PAGE) return rows;
  }
}

function readPlain_(cfg, token, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = UrlFetchApp.fetch(`${cfg.url}/rest/v1/${table}?select=*&offset=${from}&limit=${PAGE}`, {
      muteHttpExceptions: true, headers: { apikey: cfg.key, Authorization: `Bearer ${token}` },
    });
    if (res.getResponseCode() === 404) return null;
    if (res.getResponseCode() !== 200) throw new Error(`${table} を読めなかった（${res.getResponseCode()}）`);
    const page = JSON.parse(res.getContentText());
    for (const r of page) { delete r.embedding; rows.push(r); }
    if (page.length < PAGE) return rows;
  }
}

function folder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function trim_(folder, keep) {   // 古いものから、KEEP を超えたぶんをゴミ箱へ（30日は戻せる）
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); if (/^yuri-\d{4}-\d{2}-\d{2}\.json$/.test(f.getName())) files.push(f); }
  files.sort((a, b) => b.getName().localeCompare(a.getName()));
  files.slice(keep).forEach((f) => f.setTrashed(true));
}
