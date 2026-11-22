// 本：バーコード（ISBN）や表紙から題名を引く。openBD と Google Books（どちらも無料・鍵なし）

async function decodeBarcode(file) {
  // 使える端末では標準の BarcodeDetector、なければ ZXing（端末の中で読む）
  if ('BarcodeDetector' in window) {
    try {
      const det = new window.BarcodeDetector({ formats: ['ean_13'] });
      const bmp = await createImageBitmap(file);
      const codes = await det.detect(bmp);
      if (codes.length) return codes[0].rawValue;
    } catch { /* ZXing に回す */ }
  }
  const Z = await import('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/+esm');
  const url = URL.createObjectURL(file);
  try {
    const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13]], [Z.DecodeHintType.TRY_HARDER, true]]);
    const reader = new Z.BrowserMultiFormatReader(hints);
    const res = await reader.decodeFromImageUrl(url);
    return res.getText();
  } finally { URL.revokeObjectURL(url); }
}

export async function isbnFromPhoto(file) {
  let code = null;
  try { code = await decodeBarcode(file); } catch { code = null; }
  if (!code) return null;
  code = code.replace(/\D/g, '');
  return /^97[89]\d{10}$/.test(code) ? code : null;   // 本のバーコードだけ（下段の値段のバーコードは除く）
}

export async function lookupIsbn(isbn) {
  try {
    const j = await (await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn}`)).json();
    const s = j && j[0] && j[0].summary;
    if (s && s.title) return { title: s.title, author: (s.author || '').replace(/,\d{4}-(\d{4})?/g, '').replace(/,/g, '').trim() || null, isbn, cover_url: s.cover || null };
  } catch { /* 次へ */ }
  const list = await searchBooks(`isbn:${isbn}`);
  return list[0] ? { ...list[0], isbn } : null;
}

// Google Books → 国立国会図書館サーチ → Open Library の順に探す（どれも無料・鍵なし。混んでいると断られることがある）
export async function searchBooks(q) {
  for (const f of [google, ndl, openLibrary]) {
    try { const list = await f(q); if (list.length) return list; } catch { /* 次へ */ }
  }
  return [];
}

async function google(q) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&langRestrict=ja`);
  if (!r.ok) throw new Error(r.status);
  const j = await r.json();
  return (j.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const isbn = (v.industryIdentifiers || []).find((x) => x.type === 'ISBN_13');
    return {
      title: v.title + (v.subtitle ? ' ' + v.subtitle : ''),
      author: (v.authors || []).join('、') || null,
      isbn: isbn ? isbn.identifier : null,
      cover_url: v.imageLinks ? (v.imageLinks.thumbnail || '').replace(/^http:/, 'https:') : null,
    };
  }).filter((b) => b.title);
}

async function ndl(q) {
  const isbnQ = q.match(/^isbn:(\d+)$/);
  const r = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?${isbnQ ? 'isbn=' + isbnQ[1] : 'title=' + encodeURIComponent(q)}&cnt=5`);
  if (!r.ok) throw new Error(r.status);
  const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
  const out = [];
  for (const it of xml.getElementsByTagName('item')) {
    const get = (tag) => { const e = it.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ''; };
    const isbn = [...it.getElementsByTagName('dc:identifier')].map((e) => e.textContent.replace(/\D/g, '')).find((x) => /^97[89]\d{10}$/.test(x)) || null;
    const title = get('dc:title') || get('title');
    if (!title || out.some((b) => b.title === title)) continue;
    out.push({ title, author: [...new Set((get('author') || get('dc:creator')).split(/[,、]\s*/).map((x) => x.replace(/\s*著$/, '').trim()).filter(Boolean))].join('、') || null, isbn, cover_url: isbn ? `https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg` : null });
  }
  return out;
}

async function openLibrary(q) {
  const isbnQ = q.match(/^isbn:(\d+)$/);
  const r = await fetch(`https://openlibrary.org/search.json?${isbnQ ? 'isbn=' + isbnQ[1] : 'q=' + encodeURIComponent(q)}&limit=5&fields=title,author_name,isbn,cover_i`);
  if (!r.ok) throw new Error(r.status);
  const j = await r.json();
  return (j.docs || []).map((d) => ({
    title: d.title, author: (d.author_name || []).join('、') || null,
    isbn: (d.isbn || []).find((x) => /^97[89]\d{10}$/.test(x)) || null,
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
  })).filter((b) => b.title);
}
