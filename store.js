// データの出し入れ。本番は Supabase、?demo を付けて開くとブラウザ内だけの試し用。

const COLS = 'id, body, created_at, group_id, seq, source, lens, pinned_at, resolved_at, handoff, handoff_done_at, book_id, scene, image_path, pos_x, pos_y';
const flat = (rows) => (rows || []).map((r) => ({ ...r.item, similarity: r.similarity, literal: r.literal }));
const BUCKET = 'photos';

export function supabaseStore(sb) {
  const must = ({ data, error }) => { if (error) throw error; return data; };
  let uid = null;
  const me = async () => uid || (uid = (await sb.auth.getUser()).data.user.id);
  const urlCache = new Map();
  return {
    kind: 'supabase',
    async session() { return (await sb.auth.getSession()).data.session; },
    onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s)); },
    async signIn(email, password) { must(await sb.auth.signInWithPassword({ email, password })); },
    async signOut() { await sb.auth.signOut(); },

    // ---- かけら ----
    async insert(rows) { return must(await sb.from('kakera').insert(rows).select(COLS)); },
    async restore(rows) { must(await sb.from('kakera').insert(rows)); },
    async remove(id) {
      const row = must(await sb.from('kakera').select(COLS + ', embedding, source_ref').eq('id', id).single());
      must(await sb.from('kakera').delete().eq('id', id));
      return row;
    },
    async patch(id, fields) { must(await sb.from('kakera').update(fields).eq('id', id)); },
    async recent(before, limit, lens, since) {
      let q = sb.from('kakera').select(COLS).order('created_at', { ascending: false }).order('seq').limit(limit);
      if (before) q = q.lt('created_at', before);
      if (since) q = q.gte('created_at', since);
      if (lens) q = q.eq('lens', lens);
      return must(await q);
    },
    async between(from, to) {
      return must(await sb.from('kakera').select(COLS).gte('created_at', from).lt('created_at', to)
        .order('created_at', { ascending: false }).order('seq').limit(300));
    },
    async pins() { return must(await sb.from('kakera').select(COLS).not('pinned_at', 'is', null).order('pinned_at', { ascending: false }).limit(50)); },
    async setResolved(id) { must(await sb.from('kakera').update({ resolved_at: new Date().toISOString() }).eq('id', id)); },
    async setPin(id, on) { must(await sb.from('kakera').update({ pinned_at: on ? new Date().toISOString() : null }).eq('id', id)); },
    async siblings(groupId) { return must(await sb.from('kakera').select(COLS).eq('group_id', groupId).order('seq')); },
    async match(vec, n, excludeGroup) {
      return flat(must(await sb.rpc('match_kakera', { q_emb: JSON.stringify(vec), n, exclude_group: excludeGroup || null })));
    },
    async related(id, n) { return flat(must(await sb.rpc('related_kakera', { target: id, n }))); },
    async search(q, vec, n, lens) {
      return flat(must(await sb.rpc('search_kakera', { q, q_emb: JSON.stringify(vec), n, lens_filter: lens || null })));
    },
    async byScene(words, limit) {
      let q = sb.from('kakera').select(COLS).order('created_at', { ascending: false }).limit(limit);
      for (const w of words) q = q.ilike('scene', `%${w}%`);
      return must(await q);
    },
    async handoffs() {
      return must(await sb.from('kakera').select(COLS).eq('handoff', true).is('handoff_done_at', null).order('created_at', { ascending: false }).limit(100));
    },
    async unresolvedCandidates() {
      return must(await sb.from('kakera').select(COLS).eq('source', 'hand').is('resolved_at', null)
        .or('body.ilike.*？*,body.ilike.*?*,body.ilike.*あやしい*,body.ilike.*怪しい*,body.ilike.*わからない*,body.ilike.*分からない*,body.ilike.*要確認*')
        .order('created_at', { ascending: false }).limit(200));
    },
    async ofBook(bookId) { return must(await sb.from('kakera').select(COLS).eq('book_id', bookId).order('created_at')); },
    async updateBody(id, body) { must(await sb.from('kakera').update({ body, embedding: null }).eq('id', id)); },
    async pending(limit) {
      return must(await sb.from('kakera').select('id, body, source, lens, group_id, seq, handoff')
        .or('embedding.is.null,lens.is.null,and(lens.eq.daily,source.in.(gmail,yahoo))').limit(limit));
    },
    async setEmbedding(id, vec, fields = {}) {
      must(await sb.from('kakera').update({ embedding: JSON.stringify(vec), ...fields }).eq('id', id));
    },
    async unplaced(limit) {
      return must(await sb.from('kakera').select('id').is('pos_x', null).eq('seq', 0).not('embedding', 'is', null)
        .order('created_at').limit(limit));
    },
    async stars() {
      return must(await sb.from('kakera').select('id, body, created_at, source, lens, handoff, resolved_at, pos_x, pos_y')
        .not('pos_x', 'is', null).eq('seq', 0).order('created_at', { ascending: false }).limit(5000));
    },
    async existingRefs(source) {
      return new Set(must(await sb.from('kakera').select('source_ref').eq('source', source).not('source_ref', 'is', null).limit(20000)).map((r) => r.source_ref));
    },

    // ---- 英単語 ----
    async bumpWords(ws, origin, kakeraId) { if (ws.length) must(await sb.rpc('bump_words', { ws, src: origin, kid: kakeraId })); },
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

    // ---- 柱 ----
    async pillars() { return must(await sb.from('pillars').select('*').order('name')); },
    async savePillar(p) {
      const row = { name: p.name, kind: p.kind || 'subject', sections: p.sections, source: p.source || 'hand', updated_at: new Date().toISOString() };
      if (p.id) return must(await sb.from('pillars').update(row).eq('id', p.id).select().single());
      return must(await sb.from('pillars').upsert(row, { onConflict: 'user_id,name' }).select().single());
    },
    async removePillar(id) { must(await sb.from('pillars').delete().eq('id', id)); },

    // ---- 本 ----
    async books() { return must(await sb.from('books').select('*').order('started_at', { ascending: false })); },
    async addBook(b) { return must(await sb.from('books').insert(b).select().single()); },
    async patchBook(id, fields) { must(await sb.from('books').update(fields).eq('id', id)); },

    // ---- ちょっとした状態 ----
    async kvGet(key) { return (must(await sb.from('kv').select('value').eq('key', key).maybeSingle()) || {}).value ?? null; },
    async kvSet(key, value) {
      if (value === null) { must(await sb.from('kv').delete().eq('key', key)); return; }
      must(await sb.from('kv').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' }));
    },

    // ---- 写真 ----
    async uploadPhoto(id, full, thumb) {
      const base = `${await me()}/${id}`;
      must(await sb.storage.from(BUCKET).upload(base + '.jpg', full, { contentType: 'image/jpeg', upsert: true }));
      must(await sb.storage.from(BUCKET).upload(base + '_t.jpg', thumb, { contentType: 'image/jpeg', upsert: true }));
      return base + '.jpg';
    },
    async photoUrls(paths) {
      const need = paths.filter((p) => p && !urlCache.has(p));
      if (need.length) {
        const res = must(await sb.storage.from(BUCKET).createSignedUrls(need, 60 * 60 * 6));
        for (const r of res) if (r.signedUrl) urlCache.set(r.path, r.signedUrl);
      }
      return Object.fromEntries(paths.map((p) => [p, urlCache.get(p)]));
    },
    async removePhoto(path) {
      if (path) await sb.storage.from(BUCKET).remove([path, path.replace(/\.jpg$/, '_t.jpg')]);
    },
  };
}

// ---- 試し用（?demo）：同じ動きをブラウザのメモリだけで ----
export function memoryStore() {
  let rows = [], words = [], pillarRows = [], bookRows = [];
  const kv = new Map(), photos = new Map();
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const pub = (r) => { const { embedding, source_ref, ...rest } = r; return rest; };
  const desc = (a, b) => b.created_at.localeCompare(a.created_at) || a.seq - b.seq;
  const near = (vec, n, ex) => rows.filter((r) => r.embedding && r.group_id !== ex)
    .map((r) => ({ ...pub(r), similarity: dot(vec, r.embedding) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, n);
  const find = (id) => rows.find((x) => x.id === id);
  const blank = { seq: 0, source: 'hand', lens: null, pinned_at: null, resolved_at: null, handoff: false, handoff_done_at: null, book_id: null, scene: null, image_path: null, pos_x: null, pos_y: null };
  return {
    kind: 'memory',
    async session() { return { user: { email: 'demo' } }; },
    onAuth() {}, async signIn() {}, async signOut() {},
    async insert(list) {
      const out = list.map((r) => ({ id: crypto.randomUUID(), created_at: r.created_at || new Date().toISOString(), ...blank, ...r,
        embedding: r.embedding ? JSON.parse(r.embedding) : null }));
      rows.push(...out); return out.map(pub);
    },
    async restore(list) { rows.push(...list); },
    async remove(id) { const r = find(id); rows = rows.filter((x) => x.id !== id); return r; },
    async patch(id, fields) { Object.assign(find(id) || {}, fields); },
    async recent(before, limit, lens, since) {
      return rows.filter((r) => (!before || r.created_at < before) && (!since || r.created_at >= since) && (!lens || r.lens === lens))
        .sort(desc).slice(0, limit).map(pub);
    },
    async between(from, to) { return rows.filter((r) => r.created_at >= from && r.created_at < to).sort(desc).map(pub); },
    async pins() { return rows.filter((r) => r.pinned_at).sort((a, b) => b.pinned_at.localeCompare(a.pinned_at)).map(pub); },
    async setResolved(id) { const r = find(id); if (r) r.resolved_at = new Date().toISOString(); },
    async setPin(id, on) { const r = find(id); if (r) r.pinned_at = on ? new Date().toISOString() : null; },
    async siblings(g) { return rows.filter((r) => r.group_id === g).sort((a, b) => a.seq - b.seq).map(pub); },
    async match(vec, n, ex) { return near(vec, n, ex); },
    async related(id, n) { const t = find(id); return t && t.embedding ? near(t.embedding, n, t.group_id) : []; },
    async search(q, vec, n, lens) {
      const ql = q.toLowerCase();
      return rows.filter((r) => r.embedding && (!lens || r.lens === lens)).map((r) => {
        const literal = r.body.toLowerCase().includes(ql);
        return { ...pub(r), similarity: dot(vec, r.embedding), literal };
      }).sort((a, b) => (b.similarity + (b.literal ? 0.05 : 0)) - (a.similarity + (a.literal ? 0.05 : 0))).slice(0, n);
    },
    async byScene(ws, limit) { return rows.filter((r) => r.scene && ws.every((w) => r.scene.includes(w))).sort(desc).slice(0, limit).map(pub); },
    async handoffs() { return rows.filter((r) => r.handoff && !r.handoff_done_at).sort(desc).map(pub); },
    async unresolvedCandidates() { return rows.filter((r) => r.source === 'hand' && !r.resolved_at).sort(desc).map(pub); },
    async ofBook(id) { return rows.filter((r) => r.book_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(pub); },
    async updateBody(id, body) { const r = find(id); if (r) { r.body = body; r.embedding = null; } },
    async pending(limit) {
      return rows.filter((r) => !r.embedding || !r.lens || (r.lens === 'daily' && (r.source === 'gmail' || r.source === 'yahoo'))).slice(0, limit)
        .map(({ id, body, source, lens, group_id, seq, handoff }) => ({ id, body, source, lens, group_id, seq, handoff }));
    },
    async setEmbedding(id, vec, fields = {}) { const r = find(id); if (r) Object.assign(r, { embedding: vec }, fields); },
    async unplaced(limit) { return rows.filter((r) => r.pos_x == null && r.seq === 0 && r.embedding).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit).map((r) => ({ id: r.id })); },
    async stars() { return rows.filter((r) => r.pos_x != null && r.seq === 0).map(pub); },
    async existingRefs(source) { return new Set(rows.filter((r) => r.source === source && r.source_ref).map((r) => r.source_ref)); },
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
    async kakera(id) { const r = find(id); return r ? pub(r) : null; },
    async pillars() { return pillarRows.slice().sort((a, b) => a.name.localeCompare(b.name)); },
    async savePillar(p) {
      let row = pillarRows.find((x) => (p.id && x.id === p.id) || (!p.id && x.name === p.name));
      if (!row) { row = { id: crypto.randomUUID(), created_at: new Date().toISOString() }; pillarRows.push(row); }
      Object.assign(row, { name: p.name, kind: p.kind || 'subject', sections: p.sections, source: p.source || 'hand' });
      return row;
    },
    async removePillar(id) { pillarRows = pillarRows.filter((x) => x.id !== id); },
    async books() { return bookRows.slice().sort((a, b) => b.started_at.localeCompare(a.started_at)); },
    async addBook(b) { const row = { id: crypto.randomUUID(), status: 'reading', started_at: new Date().toISOString(), ...b }; bookRows.push(row); return row; },
    async patchBook(id, f) { Object.assign(bookRows.find((x) => x.id === id) || {}, f); },
    async kvGet(k) { return kv.has(k) ? kv.get(k) : null; },
    async kvSet(k, v) { v === null ? kv.delete(k) : kv.set(k, v); },
    async uploadPhoto(id, full, thumb) { const p = `demo/${id}.jpg`; photos.set(p, URL.createObjectURL(full)); photos.set(p.replace('.jpg', '_t.jpg'), URL.createObjectURL(thumb)); return p; },
    async photoUrls(paths) { return Object.fromEntries(paths.map((p) => [p, photos.get(p)])); },
    async removePhoto() {},
    get _words() { return words; },
    get _rows() { return rows; },
  };
}

// 今日の1語の選び方：復習（前に「まだ」を押したもの）→ 自分で投げた単語 → メルマガでよく出る単語
export function pickWord(cands) {
  const score = (w) => (w.step > 0 ? 0 : w.origin === 'mine' ? 1 : 2);
  return cands.slice().sort((a, b) => score(a) - score(b) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || b.freq - a.freq)[0] || null;
}
