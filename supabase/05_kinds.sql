-- かけらの泉：種類の表示（未解決の「解決した」）と、探した結果にも種類を載せる。
-- SQL Editor に丸ごと貼って Run（何度実行しても大丈夫）

alter table public.kakera add column if not exists resolved_at timestamptz;

-- 返す列が増えるので作り直す
drop function if exists public.related_kakera(uuid, int);
drop function if exists public.match_kakera(extensions.vector, int, uuid);
drop function if exists public.search_kakera(text, extensions.vector, int, text);

create function public.match_kakera(
  q_emb extensions.vector(384),
  n int default 3,
  exclude_group uuid default null
) returns table (id uuid, body text, created_at timestamptz, group_id uuid, seq int,
                 source text, lens text, pinned_at timestamptz, resolved_at timestamptz, similarity float)
language sql stable security invoker set search_path = public, extensions as $$
  select k.id, k.body, k.created_at, k.group_id, k.seq, k.source, k.lens, k.pinned_at, k.resolved_at,
         1 - (k.embedding <=> q_emb) as similarity
  from public.kakera k
  where k.embedding is not null
    and (exclude_group is null or k.group_id <> exclude_group)
  order by k.embedding <=> q_emb
  limit least(n, 50);
$$;

create function public.related_kakera(target uuid, n int default 3)
returns table (id uuid, body text, created_at timestamptz, group_id uuid, seq int,
               source text, lens text, pinned_at timestamptz, resolved_at timestamptz, similarity float)
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
) returns table (id uuid, body text, created_at timestamptz, group_id uuid, seq int,
                 source text, lens text, pinned_at timestamptz, resolved_at timestamptz,
                 similarity float, literal boolean)
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
  select k.id, k.body, k.created_at, k.group_id, k.seq, k.source, k.lens, k.pinned_at, k.resolved_at,
         coalesce(1 - (k.embedding <=> q_emb), 0) as similarity,
         strpos(lower(k.body), lower(q)) > 0 as literal
  from public.kakera k
  where k.id in (select id from v union select id from t)
  order by coalesce(1 - (k.embedding <=> q_emb), 0) + case when strpos(lower(k.body), lower(q)) > 0 then 0.05 else 0 end desc
  limit least(n, 50);
$$;

revoke execute on function public.match_kakera(extensions.vector, int, uuid) from anon, public;
revoke execute on function public.related_kakera(uuid, int) from anon, public;
revoke execute on function public.search_kakera(text, extensions.vector, int, text) from anon, public;
grant execute on function public.match_kakera(extensions.vector, int, uuid) to authenticated;
grant execute on function public.related_kakera(uuid, int) to authenticated;
grant execute on function public.search_kakera(text, extensions.vector, int, text) to authenticated;
