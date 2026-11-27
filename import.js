// 取り込む：Claude Code が書き出したファイル（content/*.json）を、ログイン中の自分として箱に入れる
// 何度入れても同じ結果になる。納得・次に埋めたい・追記は消えない
//
// 形（1つの箱なら { box, ... }、いくつもなら { boxes: [ {...}, {...} ] }）
// {
//   "box": "kanki/200番台 総括/240",                 // 箱の場所（library.js の key）
//   "sections": [{ "seq": 1, "title": "範囲と責任", "phase": "kamae", "diagram": {…} }],   // diagram は書いたときだけ上書き
//   "paras":    [{ "seq": 1, "section": 1, "label": "1", "body": "原文…" }],            // section は節の seq
//   "trans":    [{ "section": 1, "seq": 1, "body": "私語訳…", "paras": ["1", "A2"] }],  // 書いた節の、ファイルから入れた私語訳はこの通りになる（アプリで書いた・直した行はさわらない）
//   "rows":     [{ "axis": "jitsuzai", "labels": ["abunai"], "body": "…" }]              // 勘定科目の行。同じ軸・同じ文はとばす
// }
import { AXES, LABELS, PHASES } from './library.js';

const PH = new Set(PHASES.map(([p]) => p));
const AX = new Set(AXES.map(([a]) => a));

export function readImport(text, byKey) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('ファイルの形が読めなかった（JSON ではないみたい）'); }
  const list = Array.isArray(data) ? data : data.boxes || [data];
  return list.map((x) => {
    const b = byKey.get(x.box);
    if (!b) throw new Error(`箱が見つからない：${x.box || '（box がない）'}`);
    const secs = x.sections || [], paras = x.paras || [], trans = x.trans || [], rows = x.rows || [];
    for (const s of secs) if (!PH.has(s.phase)) throw new Error(`節「${s.title}」のマスが変：${s.phase}`);
    for (const r of rows) {
      if (!AX.has(r.axis)) throw new Error(`行の軸が変：${r.axis}`);
      for (const l of r.labels || []) if (!LABELS[l]) throw new Error(`行のラベルが変：${l}`);
    }
    return { b, secs, paras, trans, rows, diagrams: secs.filter((s) => s.diagram !== undefined).length };
  });
}

export async function runImport(store, plan) {
  const done = [];
  for (const { b, secs, paras, trans, rows } of plan) {
    if (secs.length) {
      await store.upsert('sections', secs.map((s) => ({ box_id: b.id, seq: s.seq, title: s.title, phase: s.phase, ...(s.diagram !== undefined ? { diagram: s.diagram } : {}) })), 'box_id,seq');
    }
    const secBySeq = new Map((await store.sections(b.id)).map((s) => [s.seq, s.id]));
    const sid = (n) => { const v = secBySeq.get(n); if (!v) throw new Error(`節 ${n} がない`); return v; };

    if (paras.length) {
      const old = new Map((await store.paras(b.id)).map((p) => [p.seq, p]));
      const changed = [], moved = [];
      for (const p of paras) {
        const row = { box_id: b.id, seq: p.seq, section_id: sid(p.section), label: p.label || null, body: p.body };
        const o = old.get(p.seq);
        if (!o || o.body !== p.body) changed.push({ ...row, embedding: null });
        else if (o.label !== row.label || o.section_id !== row.section_id) moved.push(row);
      }
      if (changed.length) await store.upsert('paras', changed, 'box_id,seq');
      if (moved.length) await store.upsert('paras', moved, 'box_id,seq');
      await store.trimParas(b.id, Math.max(...paras.map((p) => p.seq)));
    }

    if (trans.length) {
      const byLabel = new Map();
      for (const p of await store.paras(b.id)) { if (!byLabel.has(p.label)) byLabel.set(p.label, []); byLabel.get(p.label).push(p.id); }
      const cards = (await store.cards(b.id)).filter((c) => c.kind === 'trans' && c.box_id === b.id && (c.labels || []).includes('file'));
      const keep = new Set();
      for (const t of trans) {
        const section_id = sid(t.section);
        const para_ids = (t.paras || []).flatMap((l) => byLabel.get(String(l)) || []);
        const o = cards.find((c) => c.section_id === section_id && c.seq === t.seq);
        if (o) {
          keep.add(o.id);
          if (o.body !== t.body) await store.patchCard(o.id, { body: t.body, para_ids, embedding: null });
          else if (JSON.stringify(o.para_ids || []) !== JSON.stringify(para_ids)) await store.patchCard(o.id, { para_ids });
        } else await store.addCard({ box_id: b.id, kind: 'trans', section_id, seq: t.seq, body: t.body, para_ids, labels: ['file'] });
      }
      const touched = new Set(trans.map((t) => sid(t.section)));
      for (const c of cards) if (touched.has(c.section_id) && !keep.has(c.id)) await store.removeCard(c.id);
    }

    if (rows.length) {
      const old = (await store.cards(b.id)).filter((c) => c.kind === 'row' && c.box_id === b.id);
      let seq = old.length;
      for (const r of rows) {
        if (old.some((o) => o.axis === r.axis && o.body === r.body)) continue;
        await store.addCard({ box_id: b.id, kind: 'row', axis: r.axis, labels: r.labels || [], body: r.body, seq: seq++ });
      }
    }
    done.push(b);
  }
  return done;
}
