// Notion の書き出し（Markdown、または Markdown が入った zip）を読む。
// 柱の型（基礎知識／リスク／内部統制／開示／トピック、または 要点／改正点／実務／迷ったところ／トピック）に
// 見出しが2つ以上合うページは「柱」、それ以外はふつうのかけらとして返す

const SUBJECT = [/基礎/, /リスク|留意事項/, /統制/, /開示/, /トピック/];
const STANDARD = [/要点/, /改正/, /実務/, /迷/, /トピック/];
export const TEMPLATES = {
  subject: ['1) 基礎知識', '2) 科目特有のリスク・留意事項', '3) 内部統制上の留意事項', '4) 開示上の留意事項', '5) トピック'],
  standard: ['1) 要点', '2) 改正点', '3) 実務での効き方', '4) 迷ったところ', '5) トピック'],
};

async function unzip(file) {
  const JSZip = (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default;
  const zip = await JSZip.loadAsync(file);
  const out = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (/\.zip$/i.test(entry.name)) out.push(...await unzip(await entry.async('blob')));   // Notion は zip の中に zip のことがある
    else if (/\.(md|txt)$/i.test(entry.name)) out.push({ name: entry.name, text: await entry.async('string') });
  }
  return out;
}

export async function readFiles(fileList) {
  const out = [];
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) out.push(...await unzip(f));
    else if (/\.(md|txt)$/i.test(f.name)) out.push({ name: f.name, text: await f.text() });
  }
  return out;
}

// Notion のファイル名「題名 1a2b3c….md」から題名を取り出す
const titleFromName = (name) => name.split('/').pop().replace(/\.(md|txt)$/i, '').replace(/\s+[0-9a-f]{32}$/i, '').trim();

const cleanLine = (l) => l
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // 画像
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')         // リンクは文字だけ
  .replace(/\*\*|__|`/g, '')
  .trim();

const isHeading = (l) => /^#{1,6}\s+/.test(l) || (/^\s*\d+\s*[)）.．]\s*\S/.test(l) && l.trim().length <= 30 && !/[。]$/.test(l.trim()));
const headingText = (l) => l.replace(/^#{1,6}\s+/, '').trim();

export function parsePage({ name, text }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let title = titleFromName(name);
  if (/^#\s+/.test(lines[0] || '')) { title = headingText(lines.shift()); }

  const sections = [];
  let cur = null;
  const loose = [];
  for (const raw of lines) {
    const l = cleanLine(raw);
    if (!l) continue;
    if (isHeading(raw.trim())) { cur = { h: headingText(cleanLine(raw.trim())), items: [] }; sections.push(cur); continue; }
    const item = l.replace(/^([-*+・•]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim();
    if (!item) continue;
    if (cur) cur.items.push(item); else loose.push(item);
  }
  const heads = sections.map((s) => s.h).join(' ');
  const score = (tpl) => tpl.filter((re) => re.test(heads)).length;
  const subj = score(SUBJECT), std = score(STANDARD);
  if (Math.max(subj, std) >= 2) {
    if (loose.length) sections.unshift({ h: 'メモ', items: loose });
    return { type: 'pillar', name: title, kind: std > subj ? 'standard' : 'subject', sections };
  }
  // ふつうのページ：本文をそのままかけらに（題名を頭に）
  const body = [title, ...lines.map((l) => cleanLine(l.replace(/^#{1,6}\s+/, '')))].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { type: 'page', name: title, body, ref: name };
}

// 柱を編集するための Markdown と、その読み戻し
export const pillarToText = (p) => p.sections.map((s) => `## ${s.h}\n` + s.items.map((i) => `- ${i}`).join('\n')).join('\n\n');
export function textToSections(text) {
  const sections = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    if (/^#{1,6}\s+/.test(l)) { cur = { h: headingText(l), items: [] }; sections.push(cur); continue; }
    const item = l.replace(/^([-*+・•])\s*/, '').trim();
    if (!cur) { cur = { h: 'メモ', items: [] }; sections.push(cur); }
    if (item) cur.items.push(item);
  }
  return sections;
}

// 見出しの役割（直前モードで使う）
export function role(h) {
  return /リスク|留意事項/.test(h) && !/統制|開示/.test(h) ? 'risk'
    : /統制/.test(h) ? 'control' : /基礎/.test(h) ? 'basic' : /開示/.test(h) ? 'disclosure'
    : /要点/.test(h) ? 'point' : /改正/.test(h) ? 'revision' : /実務/.test(h) ? 'practice' : /迷/.test(h) ? 'doubt'
    : /トピック/.test(h) ? 'topic' : 'other';
}
