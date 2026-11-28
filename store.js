// データの出し入れ。本番は Supabase、?demo を付けて開くとブラウザ内だけの試し用。

const EMB_TABLES = ['cards', 'paras', 'stickies', 'kakera'];
const vec = (e) => (typeof e === 'string' ? JSON.parse(e) : e);

export function supabaseStore(sb) {
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const all = async (q) => {   // 1000行ずつ全部
    const out = [];
    for (let from = 0; from < 50000; from += 1000) {
      const part = must(await q().range(from, from + 999));
      out.push(...part);
      if (part.length < 1000) break;
    }
    return out;
  };
  return {
    kind: 'supabase',
    async session() { return (await sb.auth.getSession()).data.session; },
    onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s)); },
    async signIn(email, password) { must(await sb.auth.signInWithPassword({ email, password })); },
    async signOut() { await sb.auth.signOut(); },

    // ---- 書庫の場所 ----
    async nodes() { return all(() => sb.from('nodes').select('*').order('sort')); },
    async seedNodes(rows) { if (rows.length) must(await sb.from('nodes').upsert(rows, { onConflict: 'user_id,key' })); },
    async touchNode(id) { must(await sb.from('nodes').update({ opened_at: new Date().toISOString() }).eq('id', id)); },
    async patchNode(id, f) { must(await sb.from('nodes').update(f).eq('id', id)); },
    async removeNode(id) { must(await sb.from('nodes').delete().eq('id', id)); },

    // ---- 箱の中身 ----
    async sections(boxId) { return must(await sb.from('sections').select('*').eq('box_id', boxId).order('seq')); },
    async allSections() { return all(() => sb.from('sections').select('id, box_id, seq, title, phase, want, ok_at').order('seq')); },
    async patchSection(id, f) { must(await sb.from('sections').update(f).eq('id', id)); },
    async paras(boxId) { return must(await sb.from('paras').select('id, box_id, section_id, seq, label, body').eq('box_id', boxId).order('seq')); },
    // 取り込み：書いた列だけ入れる（列の組が違う行は分けて送る。送らない列は今の値のまま）
    async upsert(t, rows, onConflict) {
      const groups = new Map();
      for (const r of rows) { const k = Object.keys(r).sort().join(','); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
      for (const g of groups.values()) for (let i = 0; i < g.length; i += 500) must(await sb.from(t).upsert(g.slice(i, i + 500), { onConflict }));
    },
    async trimParas(boxId, maxSeq) { must(await sb.from('paras').delete().eq('box_id', boxId).gt('seq', maxSeq)); },
    async cards(boxId) {
      return must(await sb.from('cards').select('id, box_id, kind, section_id, seq, body, axis, labels, para_ids, tags, ok_at, created_at, updated_at')
        .or(`box_id.eq.${boxId},tags.cs.{${boxId}}`).order('seq').order('created_at'));
    },
    async cardMeta() { return all(() => sb.from('cards').select('id, box_id, kind, axis, ok_at, created_at')); },
    async addCard(row) { return must(await sb.from('cards').insert(row).select().single()); },
    async patchCard(id, f) { must(await sb.from('cards').update({ ...f, updated_at: new Date().toISOString() }).eq('id', id)); },
    async removeCard(id) { must(await sb.from('cards').delete().eq('id', id)); },

    // ---- 付箋 ----
    async stickies() { return must(await sb.from('stickies').select('id, body, hint_box, created_at').order('created_at', { ascending: false })); },
    async addSticky(body) { return must(await sb.from('stickies').insert({ body }).select('id, body, hint_box, created_at').single()); },
    async removeSticky(id) { must(await sb.from('stickies').delete().eq('id', id)); },

    // ---- つながり ----
    async links(boxId) { return must(await sb.from('links').select('*').or(`a.eq.${boxId},b.eq.${boxId}`)); },
    async addLink(a, b) { must(await sb.from('links').upsert({ a, b }, { onConflict: 'user_id,a,b', ignoreDuplicates: true })); },
    async removeLink(id) { must(await sb.from('links').delete().eq('id', id)); },
    async nearBoxes(boxId, n = 4) { return must(await sb.rpc('near_boxes', { box: boxId, n })); },

    // ---- 探す ----
    async search(q, v, n = 40) { return must(await sb.rpc('vsearch', { q, q_emb: v ? JSON.stringify(v) : null, n })); },

    // ---- 意味の計算待ち ----
    async pending(limit) {
      const out = [];
      for (const t of EMB_TABLES) {
        if (out.length >= limit) break;
        const rows = must(await sb.from(t).select('id, body').is('embedding', null).limit(limit - out.length));
        out.push(...rows.map((r) => ({ ...r, t })));
      }
      return out;
    },
    async setEmbedding(t, id, v) { must(await sb.from(t).update({ embedding: JSON.stringify(v) }).eq('id', id)); },

    // ---- 前の泉のかけら ----
    async kakera(id) { return must(await sb.from('kakera').select('id, body, created_at, source, group_id, seq').eq('id', id).maybeSingle()); },
    async siblings(g) { return must(await sb.from('kakera').select('id, body, seq').eq('group_id', g).order('seq')); },
    async unfiled(limit, before) {
      let q = sb.from('kakera').select('id, body, created_at, source, group_id').is('filed_at', null).eq('seq', 0).order('created_at', { ascending: false }).limit(limit);
      if (before) q = q.lt('created_at', before);
      return must(await q);
    },
    async letters(limit, before) {   // メルマガ（Gmail・Yahoo から来たもの）の1通目の段落
      let q = sb.from('kakera').select('id, body, created_at, source, group_id').eq('seq', 0).is('filed_at', null).in('source', ['gmail', 'yahoo']).order('created_at', { ascending: false }).limit(limit);
      if (before) q = q.lt('created_at', before);
      return must(await q);
    },
    async fileKakera(ids) { must(await sb.from('kakera').update({ filed_at: new Date().toISOString() }).in('id', ids)); },
    async unfiledCount() { const { count, error } = await sb.from('kakera').select('id', { count: 'exact', head: true }).is('filed_at', null).eq('seq', 0); if (error) throw error; return count || 0; },

    // ---- 湧いてくる：書いたもの（追記・私語訳）と前の泉から、ランダムに1枚／去年のこのころ ----
    async spring() {
      const cq = () => sb.from('cards').select('id', { count: 'exact', head: true }).in('kind', ['note', 'trans']);
      const kq = () => sb.from('kakera').select('id', { count: 'exact', head: true }).eq('seq', 0);
      const [c, k] = await Promise.all([cq(), kq()]);
      const nc = c.count || 0, nk = k.count || 0;
      if (nc + nk === 0) return null;
      const i = Math.floor(Math.random() * (nc + nk));
      if (i < nc) { const r = must(await sb.from('cards').select('id, box_id, kind, body, created_at').in('kind', ['note', 'trans']).order('created_at').range(i, i)); return r[0] ? { src: 'card', ...r[0] } : null; }
      const r = must(await sb.from('kakera').select('id, body, created_at, source').eq('seq', 0).order('created_at').range(i - nc, i - nc));
      return r[0] ? { src: 'kakera', ...r[0] } : null;
    },
    async between(from, to) {
      const [c, k] = await Promise.all([
        sb.from('cards').select('id, box_id, kind, body, created_at').in('kind', ['note', 'trans']).gte('created_at', from).lt('created_at', to).order('created_at').limit(3),
        sb.from('kakera').select('id, body, created_at, source').eq('seq', 0).gte('created_at', from).lt('created_at', to).order('created_at').limit(3),
      ]);
      return [...must(c).map((r) => ({ src: 'card', ...r })), ...must(k).map((r) => ({ src: 'kakera', ...r }))];
    },

    // ---- ちょっとした状態 ----
    async kvGet(key) { return (must(await sb.from('kv').select('value').eq('key', key).maybeSingle()) || {}).value ?? null; },
    async kvSet(key, value) {
      if (value === null) { must(await sb.from('kv').delete().eq('key', key)); return; }
      must(await sb.from('kv').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' }));
    },
  };
}

// ---- 試し用（?demo）：同じ動きをブラウザのメモリだけで ----
export function memoryStore() {
  const T = { nodes: [], sections: [], paras: [], cards: [], stickies: [], links: [], kakera: [] };
  const kv = new Map();
  const id = () => crypto.randomUUID();
  const now = () => new Date().toISOString();
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const pub = (r) => { const { embedding, ...rest } = r; return rest; };
  const find = (t, x) => T[t].find((r) => r.id === x);
  return {
    kind: 'memory', T,
    async session() { return { user: { email: 'demo' } }; },
    onAuth() {}, async signIn() {}, async signOut() {},
    async nodes() { return T.nodes.slice().sort((a, b) => a.sort.localeCompare(b.sort)).map(pub); },
    async seedNodes(rows) { for (const r of rows) { const o = T.nodes.find((n) => n.key === r.key); if (o) Object.assign(o, r); else T.nodes.push({ id: id(), opened_at: null, created_at: now(), ...r }); } },
    async touchNode(x) { const n = find('nodes', x); if (n) n.opened_at = now(); },
    async patchNode(x, f) { Object.assign(find('nodes', x) || {}, f); },
    async removeNode(x) { T.nodes = T.nodes.filter((n) => n.id !== x); T.cards = T.cards.filter((c) => c.box_id !== x); },
    async sections(b) { return T.sections.filter((s) => s.box_id === b).sort((a, c) => a.seq - c.seq).map(pub); },
    async allSections() { return T.sections.map(pub); },
    async patchSection(x, f) { Object.assign(find('sections', x) || {}, f); },
    async paras(b) { return T.paras.filter((p) => p.box_id === b).sort((a, c) => a.seq - c.seq).map(pub); },
    async upsert(t, rows, onConflict) {
      const cols = onConflict.split(',');
      for (const r of rows) {
        const o = T[t].find((x) => cols.every((c) => x[c] === r[c]));
        if (o) Object.assign(o, r);
        else T[t].push({ id: id(), created_at: now(), embedding: null, want: false, ok_at: null, diagram: null, ...r });
      }
    },
    async trimParas(b, max) { T.paras = T.paras.filter((p) => !(p.box_id === b && p.seq > max)); },
    async cards(b) { return T.cards.filter((c) => c.box_id === b || (c.tags || []).includes(b)).sort((a, c) => a.seq - c.seq || a.created_at.localeCompare(c.created_at)).map(pub); },
    async cardMeta() { return T.cards.map(({ id: i, box_id, kind, axis, ok_at, created_at }) => ({ id: i, box_id, kind, axis, ok_at, created_at })); },
    async addCard(row) { const r = { id: id(), seq: 0, labels: [], para_ids: [], tags: [], ok_at: null, created_at: now(), updated_at: now(), embedding: null, section_id: null, axis: null, ...row }; T.cards.push(r); return pub(r); },
    async patchCard(x, f) { Object.assign(find('cards', x) || {}, f, { updated_at: now() }); },
    async removeCard(x) { T.cards = T.cards.filter((c) => c.id !== x); },
    async stickies() { return T.stickies.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).map(pub); },
    async addSticky(body) { const r = { id: id(), body, hint_box: null, created_at: now(), embedding: null }; T.stickies.push(r); return pub(r); },
    async removeSticky(x) { T.stickies = T.stickies.filter((s) => s.id !== x); },
    async links(b) { return T.links.filter((l) => l.a === b || l.b === b); },
    async addLink(a, b) { if (!T.links.some((l) => l.a === a && l.b === b)) T.links.push({ id: id(), a, b, created_at: now() }); },
    async removeLink(x) { T.links = T.links.filter((l) => l.id !== x); },
    async nearBoxes(b, n = 4) {
      const mine = [...T.cards, ...T.paras].filter((r) => r.box_id === b && r.embedding);
      const per = new Map();
      for (const o of [...T.cards, ...T.paras]) {
        if (o.box_id === b || !o.embedding) continue;
        for (const m of mine) { if (!per.has(o.box_id)) per.set(o.box_id, []); per.get(o.box_id).push(dot(o.embedding, m.embedding)); }
      }
      return [...per].map(([box_id, l]) => { const t = l.sort((x, y) => y - x).slice(0, 3); return { box_id, sim: t.reduce((a, x) => a + x, 0) / t.length }; })
        .sort((a, c) => c.sim - a.sim).slice(0, n);
    },
    async search(q, v, n = 40) {
      const ql = q.toLowerCase();
      const rows = [
        ...T.cards.map((r) => ({ src: 'card', ...r })), ...T.paras.map((r) => ({ src: 'para', ...r })),
        ...T.stickies.map((r) => ({ src: 'sticky', ...r, box_id: r.hint_box })), ...T.kakera.filter((k) => !k.filed_at).map((r) => ({ src: 'kakera', ...r, box_id: null })),
      ].map((r) => ({ src: r.src, id: r.id, box_id: r.box_id, section_id: r.section_id || null, body: r.body, created_at: r.created_at,
        sim: r.embedding && v ? dot(r.embedding, v) : 0, literal: !!q && r.body.toLowerCase().includes(ql), has: !!r.embedding }))
        .filter((r) => r.literal || (r.has && v));
      return rows.sort((a, b) => (b.literal - a.literal) || b.sim - a.sim).slice(0, n);
    },
    async pending(limit) {
      const out = [];
      for (const t of ['cards', 'paras', 'stickies', 'kakera']) for (const r of T[t]) if (!r.embedding && out.length < limit) out.push({ t, id: r.id, body: r.body });
      return out;
    },
    async setEmbedding(t, x, v) { const r = find(t, x); if (r) r.embedding = v; },
    async kakera(x) { const r = find('kakera', x); return r ? pub(r) : null; },
    async siblings(g) { return T.kakera.filter((k) => k.group_id === g).sort((a, b) => a.seq - b.seq).map(pub); },
    async unfiled(limit, before) { return T.kakera.filter((k) => !k.filed_at && !k.seq && (!before || k.created_at < before)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(pub); },
    async letters(limit, before) { return T.kakera.filter((k) => !k.seq && !k.filed_at && ['gmail', 'yahoo'].includes(k.source) && (!before || k.created_at < before)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(pub); },
    async fileKakera(ids) { for (const x of ids) { const r = find('kakera', x); if (r) r.filed_at = now(); } },
    async unfiledCount() { return T.kakera.filter((k) => !k.filed_at && !k.seq).length; },
    async spring() {
      const all = [...T.cards.filter((c) => ['note', 'trans'].includes(c.kind)).map((r) => ({ src: 'card', ...pub(r) })), ...T.kakera.filter((k) => !k.seq).map((r) => ({ src: 'kakera', ...pub(r) }))];
      return all.length ? all[Math.floor(Math.random() * all.length)] : null;
    },
    async between(from, to) {
      const inR = (r) => r.created_at >= from && r.created_at < to;
      return [...T.cards.filter((c) => ['note', 'trans'].includes(c.kind) && inR(c)).slice(0, 3).map((r) => ({ src: 'card', ...pub(r) })), ...T.kakera.filter((k) => !k.seq && inR(k)).slice(0, 3).map((r) => ({ src: 'kakera', ...pub(r) }))];
    },
    async kvGet(k) { return kv.has(k) ? kv.get(k) : null; },
    async kvSet(k, v) { v === null ? kv.delete(k) : kv.set(k, v); },
    // 試し用のデータを入れる
    put(t, rows) { const out = rows.map((r) => ({ id: id(), created_at: now(), embedding: null, ...r })); T[t].push(...out); return out; },
  };
}
