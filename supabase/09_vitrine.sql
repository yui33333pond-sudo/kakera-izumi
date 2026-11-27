-- vitrine：書庫・箱・カード・付箋・検索。SQL Editor に丸ごと貼って Run（何度実行しても大丈夫）
-- 前の泉の表（kakera・words・pillars・books・kv）はそのまま残す。中身は消さない。
-- 意味のモデルを multilingual-e5-small に替えるので、かけらの「意味」だけは作り直す（本文はそのまま）。

-- 0) 前の泉の「意味」を空にする（アプリを開くと新しいモデルで計算し直す）
--    ※ 一度だけ。2回目以降の実行では、もう新しい意味を消さないようにする
do $$
begin
  if not exists (select 1 from public.kv where key = 'vitrine_reembed_v1') then
    update public.kakera set embedding = null where embedding is not null;
    insert into public.kv (user_id, key, value)
    select id, 'vitrine_reembed_v1', 'true'::jsonb from auth.users;
  end if;
end $$;
alter table public.kakera add column if not exists filed_at timestamptz;   -- 箱に納め直した

-- 1) 書庫の場所：棚 > 階層 > 箱（並びはアプリの library.js が決めて、足りない場所を足す）
create table if not exists public.nodes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  shelf      text not null check (shelf in ('kanki', 'kamoku', 'eigo', 'hon', 'genba', 'nichijo')),
  key        text not null,                 -- 例 kanki/2/240（場所の名前。変えない）
  parent_key text,
  title      text not null,
  sort       text not null,
  is_box     boolean not null default false,
  opened_at  timestamptz,                   -- 最近開いた箱
  created_at timestamptz not null default now(),
  unique (user_id, key)
);

-- 2) 監基報の節（地図のマス）
create table if not exists public.sections (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  box_id     uuid not null references public.nodes(id) on delete cascade,
  seq        int not null,
  title      text not null,
  phase      text not null default 'kamae' check (phase in ('kamae', 'mitsukeru', 'taio', 'shimeru')),
  want       boolean not null default false,     -- 次に埋めたい
  diagram    jsonb,                              -- 図
  ok_at      timestamptz,                        -- 納得
  created_at timestamptz not null default now(),
  unique (box_id, seq)
);

-- 3) 原文の段落
create table if not exists public.paras (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  box_id     uuid not null references public.nodes(id) on delete cascade,
  section_id uuid references public.sections(id) on delete set null,
  seq        int not null,
  label      text,                               -- 段落番号（例 12、A5）
  body       text not null,
  embedding  extensions.vector(384),
  created_at timestamptz not null default now(),
  unique (box_id, seq)
);

-- 4) カード：私語訳の行（trans）・科目の行（row）・追記（note）
create table if not exists public.cards (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  box_id     uuid not null references public.nodes(id) on delete cascade,
  kind       text not null check (kind in ('trans', 'row', 'note')),
  section_id uuid references public.sections(id) on delete cascade,
  seq        int not null default 0,
  body       text not null,
  axis       text check (axis in ('jitsuzai', 'moura', 'kikan', 'hyoka', 'hyoji', 'tosei')),
  labels     text[] not null default '{}',       -- abunai / tashikameru / hani / genba
  para_ids   uuid[] not null default '{}',       -- 原文の段落
  tags       uuid[] not null default '{}',       -- 追記を一緒に出す箱
  ok_at      timestamptz,                        -- 納得（科目の行）
  embedding  extensions.vector(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cards_box on public.cards (box_id, kind, seq);
create index if not exists cards_tags on public.cards using gin (tags);

-- 5) 付箋
create table if not exists public.stickies (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body       text not null,
  hint_box   uuid references public.nodes(id) on delete set null,   -- 貼ったときに見つけた近い箱
  embedding  extensions.vector(384),
  created_at timestamptz not null default now()
);

-- 6) 自分でつないだ箱どうし
create table if not exists public.links (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  a          uuid not null references public.nodes(id) on delete cascade,
  b          uuid not null references public.nodes(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, a, b)
);

-- 7) どれも自分の行だけ
do $$
declare t text;
begin
  foreach t in array array['nodes', 'sections', 'paras', 'cards', 'stickies', 'links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- 8) 探す：キーワードが入っているものを先に、そのあと意味の近い順。カード・原文・付箋・まだ納めていないかけら
create or replace function public.vsearch(q text, q_emb extensions.vector(384), n int default 40)
returns table (src text, id uuid, box_id uuid, section_id uuid, body text, created_at timestamptz, sim float, literal boolean)
language sql stable security invoker set search_path = public, extensions as $$
  with h as (
    select 'card'::text src, c.id, c.box_id, c.section_id, c.body, c.created_at, c.embedding from public.cards c
    union all select 'para', p.id, p.box_id, p.section_id, p.body, p.created_at, p.embedding from public.paras p
    union all select 'sticky', s.id, s.hint_box, null, s.body, s.created_at, s.embedding from public.stickies s
    union all select 'kakera', k.id, null, null, k.body, k.created_at, k.embedding from public.kakera k where k.filed_at is null
  )
  select h.src, h.id, h.box_id, h.section_id, h.body, h.created_at,
         case when h.embedding is null or q_emb is null then 0 else 1 - (h.embedding <=> q_emb) end,
         length(q) > 0 and strpos(lower(h.body), lower(q)) > 0
  from h
  where (length(q) > 0 and strpos(lower(h.body), lower(q)) > 0) or (h.embedding is not null and q_emb is not null)
  order by (length(q) > 0 and strpos(lower(h.body), lower(q)) > 0) desc,
           case when h.embedding is null or q_emb is null then 0 else 1 - (h.embedding <=> q_emb) end desc
  limit least(n, 100);
$$;

-- 9) 箱どうしの意味の近さ（自動の点線）：その箱のカード・原文と、ほかの箱のカード・原文（近い3組の平均）
create or replace function public.near_boxes(box uuid, n int default 4)
returns table (box_id uuid, sim float)
language sql stable security invoker set search_path = public, extensions as $$
  with mine as (
    select embedding from public.cards where box_id = box and embedding is not null
    union all select embedding from public.paras where box_id = box and embedding is not null
    limit 60
  ), other as (
    select c.box_id, c.embedding from public.cards c where c.box_id <> box and c.embedding is not null
    union all select p.box_id, p.embedding from public.paras p where p.box_id <> box and p.embedding is not null
  )
  -- 1組だけ似ていても点線にならないよう、近い3組の平均で見る
  select x.box_id, avg(x.s) sim from (
    select o.box_id, 1 - (o.embedding <=> m.embedding) s,
           row_number() over (partition by o.box_id order by o.embedding <=> m.embedding) rn
    from other o cross join mine m
  ) x where x.rn <= 3
  group by x.box_id order by sim desc limit least(n, 20);
$$;

revoke execute on function public.vsearch(text, extensions.vector, int) from anon, public;
revoke execute on function public.near_boxes(uuid, int) from anon, public;
grant execute on function public.vsearch(text, extensions.vector, int) to authenticated;
grant execute on function public.near_boxes(uuid, int) to authenticated;

-- 10) 付箋の受け口（iPhone のショートカットから。アプリを開かずに）
--     付箋専用の鍵で、付箋を足すことだけができる。鍵の発行は README の手順で（label を 'sticky' にする）
--     貼った直後に、言葉の重なり（2文字ずつ）でいちばん近い箱を探して返す
create or replace function public.add_sticky(token text, body text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; sid uuid; q text := btrim(coalesce(body, '')); bgs text[]; nq int; hb uuid; hs float;
begin
  select t.user_id into uid from kakera_private.ingest_tokens t
  where t.token_hash = encode(extensions.digest(token, 'sha256'), 'hex') and t.label = 'sticky';
  if uid is null then raise exception 'bad token' using errcode = '28000'; end if;
  if length(q) = 0 or length(q) > 2000 then raise exception 'empty or too long'; end if;

  bgs := array(select distinct substr(q, i, 2) from generate_series(1, greatest(length(q) - 1, 1)) i
               where substr(q, i, 2) !~ '[[:space:][:punct:]、。！？「」（）・ー〜]');
  nq := greatest(coalesce(array_length(bgs, 1), 0), 1);

  select x.box_id, x.s into hb, hs from (
    select c.box_id, (select count(*) from unnest(bgs) b where strpos(c.body, b) > 0)::float / nq s
    from public.cards c where c.user_id = uid
    union all
    select n.id, case when length(regexp_replace(n.title, '^[0-9]+\s*', '')) >= 2
                       and strpos(q, regexp_replace(n.title, '^[0-9]+\s*', '')) > 0 then 0.9 else 0 end
    from public.nodes n where n.user_id = uid and n.is_box
  ) x order by x.s desc limit 1;

  if hs is null or hs < 0.45 then hb := null; end if;
  insert into public.stickies (user_id, body, hint_box) values (uid, q, hb) returning id into sid;
  if hb is null then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', true, 'box_id', hb, 'box', (select title from public.nodes where id = hb));
end $$;
revoke execute on function public.add_sticky(text, text) from public;
grant execute on function public.add_sticky(text, text) to anon, authenticated;
