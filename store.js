// データの出し入れ。本番は Supabase、?demo を付けて開くとブラウザ内だけの試し用。

const COLS = 'id, body, created_at, group_id, seq, source, lens';

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
    async recent(before, limit, lens) {
      let q = sb.from('kakera').select(COLS).order('created_at', { ascending: false }).order('seq').limit(limit);
      if (before) q = q.lt('created_at', before);
      if (lens) q = q.eq('lens', lens);
      return must(await q);
    },
    async siblings(groupId) {
      return must(await sb.from('kakera').select(COLS).eq('group_id', groupId).order('seq'));
    },
    async match(vec, n, excludeGroup) {
      return must(await sb.rpc('match_kakera', { q_emb: JSON.stringify(vec), n, exclude_group: excludeGroup || null }));
    },
    async related(id, n) { return must(await sb.rpc('related_kakera', { target: id, n })); },
    async search(q, vec, n, lens) {
      return must(await sb.rpc('search_kakera', { q, q_emb: JSON.stringify(vec), n, lens_filter: lens || null }));
    },
    async updateBody(id, body) {
      must(await sb.from('kakera').update({ body, embedding: null }).eq('id', id));
    },
    // 意味の計算かレンズの見分けがまだのもの
    async pending(limit) {
      return must(await sb.from('kakera').select('id, body, source, lens').or('embedding.is.null,lens.is.null').limit(limit));
    },
    async setEmbedding(id, vec, lens) {
      const patch = { embedding: JSON.stringify(vec) };
      if (lens) patch.lens = lens;
      must(await sb.from('kakera').update(patch).eq('id', id));
    },

    // ---- 英単語 ----
    async bumpWords(ws, origin, kakeraId) {
      if (ws.length) must(await sb.rpc('bump_words', { ws, src: origin, kid: kakeraId }));
    },
    async wordOfDay(today) {
      const done = must(await sb.from('words').select('*').eq('last_seen', today).limit(1));
      if (done.length) return { w: done[0], answered: done[0].due > today || done[0].status === 'known' };
      const cands = must(await sb.from('words').select('*').eq('status', 'learning').lte('due', today)
        .or('origin.eq.mine,freq.gte.2').order('due').limit(200));
      return { w: pickWord(cands), answered: false };
    },
    async touchWord(word, patch) { must(await sb.from('words').update(patch).eq('word', word)); },
    async examples(word) {
      const re = `\\m${word}(s|es|ed|d|ing)?\\M`;
      return must(await sb.from('kakera').select('id, body, created_at, source').in('source', ['gmail', 'yahoo'])
        .filter('body', 'imatch', re).order('created_at', { ascending: false }).limit(12));
    },
    async kakera(id) { return must(await sb.from('kakera').select(COLS).eq('id', id).maybeSingle()); },
  };
}

// ---- 試し用（?demo）：同じ動きをブラウザのメモリだけで ----
export function memoryStore() {
  let rows = [];
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  let words = [];
  const pub = ({ id, body, created_at, group_id, seq, source, lens }) => ({ id, body, created_at, group_id, seq, source, lens });
  const near = (vec, n, ex) => rows.filter((r) => r.embedding && r.group_id !== ex)
    .map((r) => ({ ...pub(r), similarity: dot(vec, r.embedding) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, n);
  return {
    kind: 'memory',
    async session() { return { user: { email: 'demo' } }; },
    onAuth() {}, async signIn() {}, async signOut() {},
    async insert(list) {
      const out = list.map((r) => ({ id: crypto.randomUUID(), created_at: r.created_at || new Date().toISOString(), seq: 0, source: 'hand', lens: null, ...r,
        embedding: r.embedding ? JSON.parse(r.embedding) : null }));
      rows.push(...out); return out.map(pub);
    },
    async restore(list) { rows.push(...list); },
    async remove(id) { const r = rows.find((x) => x.id === id); rows = rows.filter((x) => x.id !== id); return r; },
    async recent(before, limit, lens) {
      return rows.filter((r) => (!before || r.created_at < before) && (!lens || r.lens === lens))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.seq - b.seq).slice(0, limit).map(pub);
    },
    async siblings(g) { return rows.filter((r) => r.group_id === g).sort((a, b) => a.seq - b.seq).map(pub); },
    async match(vec, n, ex) { return near(vec, n, ex); },
    async related(id, n) { const t = rows.find((r) => r.id === id); return t && t.embedding ? near(t.embedding, n, t.group_id) : []; },
    async search(q, vec, n, lens) {
      const ql = q.toLowerCase();
      return rows.filter((r) => r.embedding && (!lens || r.lens === lens)).map((r) => {
        const literal = r.body.toLowerCase().includes(ql);
        return { ...pub(r), similarity: dot(vec, r.embedding), literal };
      }).sort((a, b) => (b.similarity + (b.literal ? 0.05 : 0)) - (a.similarity + (a.literal ? 0.05 : 0))).slice(0, n);
    },
    async updateBody(id, body) { const r = rows.find((x) => x.id === id); if (r) { r.body = body; r.embedding = null; } },
    async pending(limit) { return rows.filter((r) => !r.embedding || !r.lens).slice(0, limit).map(({ id, body, source, lens }) => ({ id, body, source, lens })); },
    async setEmbedding(id, vec, lens) { const r = rows.find((x) => x.id === id); if (r) { r.embedding = vec; if (lens) r.lens = lens; } },
    async bumpWords(ws, origin, kid) {
      for (const w0 of ws) {
        const w = w0.toLowerCase(); const o = words.find((x) => x.word === w);
        if (o) { o.freq++; if (origin === 'mine') { o.origin = 'mine'; o.kakera_id = kid; } }
        else words.push({ word: w, origin, kakera_id: kid, freq: 1, status: 'learning', step: 0, due: '2000-01-01', last_seen: null });
      }
    },
    async wordOfDay(today) {
      const done = words.find((w) => w.last_seen === today);
      if (done) return { w: done, answered: done.due > today || done.status === 'known' };
      return { w: pickWord(words.filter((w) => w.status === 'learning' && w.due <= today && (w.origin === 'mine' || w.freq >= 2))), answered: false };
    },
    async touchWord(word, patch) { Object.assign(words.find((w) => w.word === word) || {}, patch); },
    async examples(word) {
      const re = new RegExp(`\\b${word}(s|es|ed|d|ing)?\\b`, 'i');
      return rows.filter((r) => (r.source === 'gmail' || r.source === 'yahoo') && re.test(r.body)).map(pub);
    },
    async kakera(id) { const r = rows.find((x) => x.id === id); return r ? pub(r) : null; },
    get _words() { return words; },
  };
}

// 今日の1語の選び方：復習（前に「まだ」を押したもの）→ 自分で投げた単語 → メルマガでよく出る単語
export function pickWord(cands) {
  const score = (w) => (w.step > 0 ? 0 : w.origin === 'mine' ? 1 : 2);
  return cands.slice().sort((a, b) => score(a) - score(b) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || b.freq - a.freq)[0] || null;
}
