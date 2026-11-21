// 端末の中だけで動く埋め込みモデル（無料・外部APIなし）
// 初回だけモデル（約120MB）をダウンロードし、以後はブラウザに保存されたものを使う
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

// 日本語と英語をまたいで同じ意味を近くに置くよう学習された小さなモデル（384次元）
const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
let ready = null;

function load() {
  if (!ready) {
    ready = pipeline('feature-extraction', MODEL, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
          self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
        }
      },
    }).then((pipe) => {
      self.postMessage({ type: 'ready' });
      return pipe;
    });
  }
  return ready;
}

self.onmessage = async (e) => {
  const { id, texts } = e.data;
  try {
    const pipe = await load();
    if (!texts) { self.postMessage({ id, vectors: [] }); return; }
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    self.postMessage({ id, vectors: out.tolist() });
  } catch (err) {
    ready = null;
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
