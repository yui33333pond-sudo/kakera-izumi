// 端末の中だけで動く埋め込みモデル（無料・外部APIなし）
// 初回だけモデル（約120MB）をダウンロードし、以後はブラウザに保存されたものを使う
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

// 文書探しのために学習された多言語の小さなモデル（384次元・512トークンまで読める）
// 探す言葉には「query: 」、しまうものには「passage: 」を頭に付ける決まり
const MODEL = 'Xenova/multilingual-e5-small';
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
  const { id, texts, kind } = e.data;
  try {
    const pipe = await load();
    if (!texts) { self.postMessage({ id, vectors: [] }); return; }
    const head = kind === 'query' ? 'query: ' : 'passage: ';
    const out = await pipe(texts.map((t) => head + t), { pooling: 'mean', normalize: true });
    self.postMessage({ id, vectors: out.tolist() });
  } catch (err) {
    ready = null;
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
