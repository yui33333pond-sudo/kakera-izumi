// 図を描く。形は5つ：内と外（inout）／流れ（flow）／対比（contrast）／階層（tree）／中心と周り（hub）
// 色は意味で固定：含む＝緑（in）、含まない＝橙（out）、付箋＝黄（note）。それ以外は黒の線
//
// 書き方（私語訳と一緒に作って取り込む）
//   { "type": "inout", "label": "監査人が見るもの", "inside": ["不正による虚偽表示"], "outside": [{ "t": "不正の法的な判断", "tone": "out" }] }
//   { "type": "flow", "steps": ["リスクを見つける", "対応を決める", { "t": "結論", "tone": "in" }] }
//   { "type": "contrast", "left": { "title": "不正", "items": ["意図あり"] }, "right": { "title": "誤謬", "items": ["意図なし"] } }
//   { "type": "tree", "root": "不正", "children": [{ "t": "不正な財務報告", "children": ["収益の前倒し"] }, { "t": "資産の流用" }] }
//   { "type": "hub", "center": "職業的懐疑心", "around": ["鵜呑みにしない", "記録を確かめる"] }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (x, tone) => (typeof x === 'string' ? { t: x, tone } : { t: x.t ?? x.text ?? '', tone: x.tone || tone, children: x.children });
const chip = (x, tone) => { const i = norm(x, tone); return `<span class="dg-i${i.tone ? ' dg-' + i.tone : ''}">${esc(i.t)}</span>`; };
const list = (arr, tone) => (arr || []).map((x) => chip(x, tone)).join('');

export const DIAGRAM_TYPES = [['inout', '内と外'], ['flow', '流れ'], ['contrast', '対比'], ['tree', '階層'], ['hub', '中心と周り']];

export function renderDiagram(d) {
  if (!d || !d.type) return '';
  const cap = d.title ? `<p class="dg-cap">${esc(d.title)}</p>` : '';
  let body = '';
  switch (d.type) {
    case 'inout':
      body = `<div class="dg-inout"><div class="dg-in">${d.label ? `<span class="dg-lab">${esc(d.label)}</span>` : ''}<div class="dg-items">${list(d.inside, 'in')}</div></div>`
        + (d.outside && d.outside.length ? `<div class="dg-out"><span class="dg-lab">外</span><div class="dg-items">${list(d.outside, 'out')}</div></div>` : '') + '</div>';
      break;
    case 'flow':
      body = `<div class="dg-flow">${(d.steps || []).map((x) => chip(x)).join('<span class="dg-arrow" aria-hidden="true">→</span>')}</div>`;
      break;
    case 'contrast': {
      const side = (s, tone) => `<div class="dg-side"><b>${esc(s && s.title)}</b><div class="dg-items">${list(s && s.items, tone)}</div></div>`;
      body = `<div class="dg-contrast">${side(d.left, d.left && d.left.tone)}<span class="dg-vs" aria-hidden="true">⇄</span>${side(d.right, d.right && d.right.tone)}</div>`;
      break;
    }
    case 'tree': {
      const node = (x) => { const i = norm(x); return `<li>${chip(i)}${i.children && i.children.length ? `<ul>${i.children.map(node).join('')}</ul>` : ''}</li>`; };
      body = `<div class="dg-tree"><ul><li>${chip(d.root)}${d.children && d.children.length ? `<ul>${d.children.map(node).join('')}</ul>` : ''}</li></ul></div>`;
      break;
    }
    case 'hub':
      body = `<div class="dg-hub"><div class="dg-center">${esc(norm(d.center).t)}</div><div class="dg-items">${list(d.around)}</div></div>`;
      break;
    default: return '';
  }
  return `<figure class="dg dg-t-${esc(d.type)}">${cap}${body}</figure>`;
}
