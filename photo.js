// 写真：端末で縮小してから保存し、写っている文字を端末の中で読み取る（tesseract.js・無料）

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を開けなかった')); };
    img.src = url;
  });
}

function draw(img, max, quality) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
}

// 長い辺 1600px と 360px の2つを作る
export async function shrink(file) {
  const { img, url } = await loadImage(file);
  try {
    const [full, thumb] = await Promise.all([draw(img, 1600, 0.82), draw(img, 360, 0.75)]);
    return { full, thumb };
  } finally { URL.revokeObjectURL(url); }
}

let worker = null;
export async function readText(blob, onProgress) {
  if (!worker) {
    worker = (async () => {
      const T = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js');
      return (T.createWorker ? T : T.default).createWorker(['jpn', 'eng'], 1, {
        logger: (m) => { if (onProgress && m.status && typeof m.progress === 'number') onProgress(m.status, m.progress); },
      });
    })().catch((e) => { worker = null; throw e; });
  }
  const w = await worker;
  const { data } = await w.recognize(blob);
  // 日本語の文字のあいだに入る空白を詰める
  return (data.text || '')
    .replace(/([぀-ヿ㐀-鿿＀-￯])[ \t]+(?=[぀-ヿ㐀-鿿＀-￯])/g, '$1')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
