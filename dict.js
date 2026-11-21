// 英和辞書（EJDict・CC0 / パブリックドメイン）。頭文字ごとのファイルを必要なときだけ読み、ブラウザが覚えておく
const BASE = 'https://cdn.jsdelivr.net/gh/kujirahand/EJDict@2dd9e71ffcefce89b4d946ce07bf51fa0573aac0/src/';
const files = new Map();

function file(letter) {
  if (!files.has(letter)) {
    files.set(letter, fetch(BASE + letter + '.txt').then((r) => (r.ok ? r.text() : '')).catch(() => { files.delete(letter); return ''; }));
  }
  return files.get(letter);
}

// 変化形から元の形の候補を作る（stopped → stop, studies → study など）
function forms(w) {
  const out = [w];
  const add = (x) => { if (x && x.length > 2 && !out.includes(x)) out.push(x); };
  if (w.endsWith('ies') || w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s')) add(w.slice(0, -1));
  for (const suf of ['ing', 'ed']) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, -suf.length);
    add(stem); add(stem + 'e');
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (w.endsWith('d')) add(w.slice(0, -1));
  return out;
}

// 見つかれば { word, senses: [...] }、なければ null
export async function lookup(word) {
  const w = word.toLowerCase();
  if (!/^[a-z]/.test(w)) return null;
  const text = await file(w[0]);
  if (!text) return null;
  for (const f of forms(w)) {
    const i = text.search(new RegExp(`^${f.replace(/[-']/g, '\\$&')}\\t`, 'mi'));
    if (i < 0) continue;
    const line = text.slice(i, text.indexOf('\n', i) >>> 0 || undefined);
    const senses = line.split('\t')[1].split(' / ').map((s) => s.replace(/[『』]/g, '').replace(/《\+[^》]*》/g, '').replace(/〈[CU]〉/g, '').trim()).filter(Boolean);
    return { word: f, senses };
  }
  return null;
}
