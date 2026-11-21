// データの出し入れ。本番は Supabase、?demo を付けて開くとブラウザ内だけの試し用。

const COLS = 'id, body, created_at, group_id, seq';

export function supabaseStore(sb) {
  const must = ({ data, error }) => { if (error) throw error; return data; };
  return {
    kind: 'supabase',
    async session() { return (await sb.auth.getSession()).data.session; },
    onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s)); },
    async signIn(email, password) {
      must(await sb.auth.signInWithPassword({ email, password }));
    },
    async signOut() { await sb.auth.signOut(); },

    async insert(rows) { return must(await sb.from('kakera').insert(rows).select(COLS)); },
    async restore(rows) { must(await sb.from('kakera').insert(rows)); },
    async remove(id) {
      const row = must(await sb.from('kakera').select(COLS + ', embedding, source, source_ref').eq('id', id).single());
      must(await sb.from('kakera').delete().eq('id', id));
      return row;
    },
    async recent(before, limit) {
      let q = sb.from('kakera').select(COLS).order('created_at', { ascending: false }).order('seq').limit(limit);
      if (before) q = q.lt('created_at', before);
      return must(await q);
    },
    async siblings(groupId) {
      return must(await sb.from('kakera').select(COLS).eq('group_id', groupId).order('seq'));
    },
    async match(vec, n, excludeGroup) {
      return must(await sb.rpc('match_kakera', { q_emb: JSON.stringify(vec), n, exclude_group: excludeGroup || null }));
    },
    async related(id, n) { return must(await sb.rpc('related_kakera', { target: id, n })); },
    async search(q, vec, n) {
      return must(await sb.rpc('search_kakera', { q, q_emb: JSON.stringify(vec), n }));
    },
    async updateBody(id, body) {
      must(await sb.from('kakera').update({ body, embedding: null }).eq('id', id));
    },
    async unembedded(limit) {
      return must(await sb.from('kakera').select('id, body').is('embedding', null).limit(limit));
    },
    async setEmbedding(id, vec) {
      must(await sb.from('kakera').update({ embedding: JSON.stringify(vec) }).eq('id', id));
    },
  };
}

// ---- 試し用（?demo）：同じ動きをブラウザのメモリだけで ----
export function memoryStore() {
  let rows = [];
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const pub = ({ id, body, created_at, group_id, seq }) => ({ id, body, created_at, group_id, seq });
  const near = (vec, n, ex) => rows.filter((r) => r.embedding && r.group_id !== ex)
    .map((r) => ({ ...pub(r), similarity: dot(vec, r.embedding) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, n);
  return {
    kind: 'memory',
    async session() { return { user: { email: 'demo' } }; },
    onAuth() {}, async signIn() {}, async signOut() {},
    async insert(list) {
      const out = list.map((r) => ({ id: crypto.randomUUID(), created_at: r.created_at || new Date().toISOString(), seq: 0, ...r,
        embedding: r.embedding ? JSON.parse(r.embedding) : null }));
      rows.push(...out); return out.map(pub);
    },
    async restore(list) { rows.push(...list); },
    async remove(id) { const r = rows.find((x) => x.id === id); rows = rows.filter((x) => x.id !== id); return r; },
    async recent(before, limit) {
      return rows.filter((r) => !before || r.created_at < before)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.seq - b.seq).slice(0, limit).map(pub);
    },
    async siblings(g) { return rows.filter((r) => r.group_id === g).sort((a, b) => a.seq - b.seq).map(pub); },
    async match(vec, n, ex) { return near(vec, n, ex); },
    async related(id, n) { const t = rows.find((r) => r.id === id); return t && t.embedding ? near(t.embedding, n, t.group_id) : []; },
    async search(q, vec, n) {
      const ql = q.toLowerCase();
      return rows.filter((r) => r.embedding).map((r) => {
        const literal = r.body.toLowerCase().includes(ql);
        return { ...pub(r), similarity: dot(vec, r.embedding), literal };
      }).sort((a, b) => (b.similarity + (b.literal ? 0.05 : 0)) - (a.similarity + (a.literal ? 0.05 : 0))).slice(0, n);
    },
    async updateBody(id, body) { const r = rows.find((x) => x.id === id); if (r) { r.body = body; r.embedding = null; } },
    async unembedded(limit) { return rows.filter((r) => !r.embedding).slice(0, limit).map(({ id, body }) => ({ id, body })); },
    async setEmbedding(id, vec) { const r = rows.find((x) => x.id === id); if (r) r.embedding = vec; },
  };
}
