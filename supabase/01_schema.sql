-- かけらの泉：Supabase の SQL Editor に丸ごと貼って「Run」する（何度実行しても大丈夫）

-- 1) ベクトル検索の拡張
create extension if not exists vector with schema extensions;

-- 2) かけら本体
create table if not exists public.kakera (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body        text not null check (length(body) between 1 and 20000),
  group_id    uuid not null default gen_random_uuid(),  -- 長文を段落に分けたとき同じ値
  seq         int  not null default 0,                  -- 段落の順番
  source      text not null default 'hand',             -- hand / gmail / yahoo / notion
  source_ref  text,                                     -- 取り込みの重複よけ（メールIDなど）
  created_at  timestamptz not null default now(),
  embedding   extensions.vector(384)                    -- paraphrase-multilingual-MiniLM-L12-v2
);

create index if not exists kakera_user_created on public.kakera (user_id, created_at desc);
create index if not exists kakera_group on public.kakera (group_id, seq);
create index if not exists kakera_embedding on public.kakera
  using hnsw (embedding extensions.vector_cosine_ops);
create unique index if not exists kakera_source_ref
  on public.kakera (user_id, source, source_ref) where source_ref is not null;

-- 3) 自分のかけらしか見えない・触れない（RLS）
alter table public.kakera enable row level security;

drop policy if exists "own select" on public.kakera;
drop policy if exists "own insert" on public.kakera;
drop policy if exists "own update" on public.kakera;
drop policy if exists "own delete" on public.kakera;
create policy "own select" on public.kakera for select to authenticated using (user_id = (select auth.uid()));
create policy "own insert" on public.kakera for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own update" on public.kakera for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own delete" on public.kakera for delete to authenticated using (user_id = (select auth.uid()));

-- ログインしていない人には一切渡さない
revoke all on public.kakera from anon;
grant select, insert, update, delete on public.kakera to authenticated;

-- 4) 近いかけらを探す（波紋・糸の先）。security invoker なので RLS がそのまま効く
create or replace function public.match_kakera(
  q_emb extensions.vector(384),
  n int default 3,
  exclude_group uuid default null
) returns table (id uuid, body text, created_at timestamptz, group_id uuid, seq int, similarity float)
language sql stable security invoker set search_path = public, extensions as $$
  select k.id, k.body, k.created_at, k.group_id, k.seq, 1 - (k.embedding <=> q_emb) as similarity
  from public.kakera k
  where k.embedding is not null
    and (exclude_group is null or k.group_id <> exclude_group)
  order by k.embedding <=> q_emb
  limit least(n, 50);
$$;

-- 4b) かけらを開いたときの糸の先（同じ投げ込みの段落は除く）
create or replace function public.related_kakera(
  target uuid,
  n int default 3
) returns table (id uuid, body text, created_at timestamptz, group_id uuid, seq int, similarity float)
language sql stable security invoker set search_path = public, extensions as $$
  select m.* from public.kakera t,
    lateral public.match_kakera(t.embedding, n, t.group_id) m
  where t.id = target and t.embedding is not null;
$$;

-- 5) 泉を探す：意味の近さ＋文字がそのまま含まれていたら少し上に
create or replace function public.search_kakera(
  q text,
  q_emb extensions.vector(384),
  n int default 12
) returns table (id uuid, body text, created_at timestamptz, group_id uuid, seq int, similarity float, literal boolean)
language sql stable security invoker set search_path = public, extensions as $$
  with v as (
    select k.id from public.kakera k
    where k.embedding is not null
    order by k.embedding <=> q_emb
    limit 60
  ), t as (
    select k.id from public.kakera k
    where length(q) > 0 and strpos(lower(k.body), lower(q)) > 0
    order by k.created_at desc
    limit 30
  )
  select k.id, k.body, k.created_at, k.group_id, k.seq,
         coalesce(1 - (k.embedding <=> q_emb), 0) as similarity,
         strpos(lower(k.body), lower(q)) > 0 as literal
  from public.kakera k
  where k.id in (select id from v union select id from t)
  order by coalesce(1 - (k.embedding <=> q_emb), 0) + case when strpos(lower(k.body), lower(q)) > 0 then 0.05 else 0 end desc
  limit least(n, 50);
$$;

revoke execute on function public.match_kakera(extensions.vector, int, uuid) from anon, public;
revoke execute on function public.related_kakera(uuid, int) from anon, public;
revoke execute on function public.search_kakera(text, extensions.vector, int) from anon, public;
grant execute on function public.match_kakera(extensions.vector, int, uuid) to authenticated;
grant execute on function public.related_kakera(uuid, int) to authenticated;
grant execute on function public.search_kakera(text, extensions.vector, int) to authenticated;
