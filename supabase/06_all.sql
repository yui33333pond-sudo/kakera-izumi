-- かけらの泉：柱・申し送り・本・写真・情景・星座・ちょっとした設定。
-- 05_kinds.sql のあとに、SQL Editor に丸ごと貼って Run（何度実行しても大丈夫）

-- 1) かけらに足す列
alter table public.kakera add column if not exists handoff boolean not null default false;  -- 申し送り（意味で判定 or 「どうだった？」の答え）
alter table public.kakera add column if not exists handoff_done_at timestamptz;              -- 申し送りを「やった」
alter table public.kakera add column if not exists book_id uuid;                             -- 読んでいた本
alter table public.kakera add column if not exists scene text;                               -- 情景（例：雨 朝 家）
alter table public.kakera add column if not exists image_path text;                          -- 写真（Storage のパス。サムネイルは _t 付き）
alter table public.kakera add column if not exists pos_x real;                               -- 星座の位置（一度決めたら動かさない）
alter table public.kakera add column if not exists pos_y real;
create index if not exists kakera_handoff on public.kakera (user_id, created_at desc) where handoff and handoff_done_at is null;
create index if not exists kakera_book on public.kakera (book_id, created_at) where book_id is not null;

-- 2) 柱（Notion の科目メモ、または提案から作ったもの）
create table if not exists public.pillars (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  kind       text not null default 'subject',      -- subject（科目）/ standard（基準）
  sections   jsonb not null default '[]',          -- [{ "h": "1) 基礎知識", "items": ["…"] }]
  source     text not null default 'hand',         -- notion / hand
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

-- 3) 本
create table if not exists public.books (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null,
  author      text,
  isbn        text,
  cover_url   text,
  status      text not null default 'reading',     -- reading / done
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- 4) ちょっとした設定や状態（いま読んでる本、行ってくる、週1の問いかけ、家の場所の目安、一度聞いた提案…）
create table if not exists public.kv (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- 5) どれも自分の行だけ
do $$
declare t text;
begin
  foreach t in array array['pillars', 'books', 'kv'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- 6) 写真の置き場所（非公開。自分のフォルダだけ読める・書ける）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "own photos read" on storage.objects;
drop policy if exists "own photos write" on storage.objects;
drop policy if exists "own photos delete" on storage.objects;
create policy "own photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own photos write" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 7) 探す・つなぐ関数は、行をまるごと（埋め込み以外）返す形にする。列が増えても作り直さなくて済む
drop function if exists public.related_kakera(uuid, int);
drop function if exists public.match_kakera(extensions.vector, int, uuid);
drop function if exists public.search_kakera(text, extensions.vector, int, text);

create function public.match_kakera(
  q_emb extensions.vector(384),
  n int default 3,
  exclude_group uuid default null
) returns table (item jsonb, similarity float)
language sql stable security invoker set search_path = public, extensions as $$
  select to_jsonb(k) - 'embedding', 1 - (k.embedding <=> q_emb)
  from public.kakera k
  where k.embedding is not null
    and (exclude_group is null or k.group_id <> exclude_group)
  order by k.embedding <=> q_emb
  limit least(n, 100);
$$;

create function public.related_kakera(target uuid, n int default 3)
returns table (item jsonb, similarity float)
language sql stable security invoker set search_path = public, extensions as $$
  select m.* from public.kakera t,
    lateral public.match_kakera(t.embedding, n, t.group_id) m
  where t.id = target and t.embedding is not null;
$$;

create function public.search_kakera(
  q text,
  q_emb extensions.vector(384),
  n int default 12,
  lens_filter text default null
) returns table (item jsonb, similarity float, literal boolean)
language sql stable security invoker set search_path = public, extensions as $$
  with v as (
    select k.id from public.kakera k
    where k.embedding is not null and (lens_filter is null or k.lens = lens_filter)
    order by k.embedding <=> q_emb
    limit 80
  ), t as (
    select k.id from public.kakera k
    where length(q) > 0 and strpos(lower(k.body), lower(q)) > 0
      and (lens_filter is null or k.lens = lens_filter)
    order by k.created_at desc
    limit 30
  )
  select to_jsonb(k) - 'embedding',
         coalesce(1 - (k.embedding <=> q_emb), 0),
         strpos(lower(k.body), lower(q)) > 0
  from public.kakera k
  where k.id in (select id from v union select id from t)
  order by coalesce(1 - (k.embedding <=> q_emb), 0) + case when strpos(lower(k.body), lower(q)) > 0 then 0.05 else 0 end desc
  limit least(n, 80);
$$;

revoke execute on function public.match_kakera(extensions.vector, int, uuid) from anon, public;
revoke execute on function public.related_kakera(uuid, int) from anon, public;
revoke execute on function public.search_kakera(text, extensions.vector, int, text) from anon, public;
grant execute on function public.match_kakera(extensions.vector, int, uuid) to authenticated;
grant execute on function public.related_kakera(uuid, int) to authenticated;
grant execute on function public.search_kakera(text, extensions.vector, int, text) to authenticated;
