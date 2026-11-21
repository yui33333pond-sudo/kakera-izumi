-- かけらの泉：レンズと今日の英単語。SQL Editor に丸ごと貼って Run（何度実行しても大丈夫）

-- 1) レンズ（word / article / accounting / daily）。アプリが端末で見分けて書き込む
alter table public.kakera add column if not exists lens text;
create index if not exists kakera_user_lens on public.kakera (user_id, lens, created_at desc);

-- 2) 探すときにレンズで絞れるようにする（引数が増えるので作り直し）
drop function if exists public.search_kakera(text, extensions.vector, int);
create or replace function public.search_kakera(
  q text,
  q_emb extensions.vector(384),
  n int default 12,
  lens_filter text default null
) returns table (id uuid, body text, created_at timestamptz, group_id uuid, seq int, similarity float, literal boolean)
language sql stable security invoker set search_path = public, extensions as $$
  with v as (
    select k.id from public.kakera k
    where k.embedding is not null and (lens_filter is null or k.lens = lens_filter)
    order by k.embedding <=> q_emb
    limit 60
  ), t as (
    select k.id from public.kakera k
    where length(q) > 0 and strpos(lower(k.body), lower(q)) > 0
      and (lens_filter is null or k.lens = lens_filter)
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
revoke execute on function public.search_kakera(text, extensions.vector, int, text) from anon, public;
grant execute on function public.search_kakera(text, extensions.vector, int, text) to authenticated;

-- 3) 英単語
create table if not exists public.words (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  word       text not null,                       -- 小文字
  origin     text not null default 'mail',        -- mine（自分で投げた）/ mail（メルマガから拾った）
  kakera_id  uuid references public.kakera(id) on delete set null,
  freq       int  not null default 1,             -- 出てきたかけらの数
  status     text not null default 'learning',    -- learning / known（卒業）
  step       int  not null default 0,             -- 「まだ」を押した回数
  due        date not null default current_date,  -- 次に出してよい日
  last_seen  date,                                -- 最後に「今日の1語」になった日
  created_at timestamptz not null default now(),
  primary key (user_id, word)
);
create index if not exists words_pick on public.words (user_id, status, due);

alter table public.words enable row level security;
drop policy if exists "own words" on public.words;
create policy "own words" on public.words for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.words from anon;
grant select, insert, update, delete on public.words to authenticated;

-- かけら1つから拾った単語をまとめて数える（自分で投げた単語は mine が勝つ）
create or replace function public.bump_words(ws text[], src text, kid uuid)
returns void language sql security invoker set search_path = public as $$
  insert into public.words (word, origin, kakera_id)
  select distinct lower(w), case when src = 'mine' then 'mine' else 'mail' end, kid
  from unnest(ws) w
  where w ~ '^[a-zA-Z][a-zA-Z''-]{1,40}$'
  on conflict (user_id, word) do update
    set freq = public.words.freq + 1,
        origin = case when excluded.origin = 'mine' then 'mine' else public.words.origin end,
        kakera_id = case when excluded.origin = 'mine' then excluded.kakera_id
                         else coalesce(public.words.kakera_id, excluded.kakera_id) end;
$$;
revoke execute on function public.bump_words(text[], text, uuid) from anon, public;
grant execute on function public.bump_words(text[], text, uuid) to authenticated;
