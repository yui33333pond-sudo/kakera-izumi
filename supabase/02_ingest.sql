-- かけらの泉：取り込み（Gmail・Yahoo・Notion）用。SQL Editor に丸ごと貼って Run（何度実行しても大丈夫）
--
-- 取り込みスクリプトには「取り込み専用の鍵」だけを持たせる。
-- この鍵でできるのは、自分の泉にかけらを足すことだけ（読む・消す・直すはできない）。
-- 鍵そのものは保存せず、ハッシュだけを外から見えない場所に置く。

create extension if not exists pgcrypto with schema extensions;

create schema if not exists kakera_private;
revoke all on schema kakera_private from public, anon, authenticated;

create table if not exists kakera_private.ingest_tokens (
  token_hash text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  label      text not null,
  created_at timestamptz not null default now()
);

-- 鍵を発行する（SQL Editor からだけ呼べる）。表示された鍵は一度しか見られない
create or replace function kakera_private.issue_ingest_token(owner_email text, label text default 'gmail')
returns text language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; tok text;
begin
  select id into uid from auth.users where lower(email) = lower(owner_email);
  if uid is null then raise exception 'そのメールアドレスのユーザーがいない'; end if;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into kakera_private.ingest_tokens (token_hash, user_id, label)
  values (encode(extensions.digest(tok, 'sha256'), 'hex'), uid, label);
  return tok;
end $$;
revoke execute on function kakera_private.issue_ingest_token(text, text) from public, anon, authenticated;

-- 鍵を取り消す： delete from kakera_private.ingest_tokens where label = 'gmail';

-- 取り込み口。同じメール（source_ref）は二度入らない。入った件数を返す
create or replace function public.ingest_kakera(token text, items jsonb)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; n int;
begin
  select t.user_id into uid from kakera_private.ingest_tokens t
  where t.token_hash = encode(extensions.digest(token, 'sha256'), 'hex');
  if uid is null then raise exception 'bad token' using errcode = '28000'; end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 300 then
    raise exception 'items must be an array of up to 300';
  end if;

  insert into public.kakera (user_id, body, group_id, seq, source, source_ref, created_at)
  select uid,
         left(i->>'body', 20000),
         coalesce((i->>'group_id')::uuid, gen_random_uuid()),
         coalesce((i->>'seq')::int, 0),
         i->>'source',
         i->>'source_ref',
         least(coalesce((i->>'created_at')::timestamptz, now()), now())
  from jsonb_array_elements(items) i
  where length(btrim(coalesce(i->>'body', ''))) > 0
    and i->>'source' in ('gmail', 'yahoo', 'notion')
    and i->>'source_ref' is not null
  on conflict (user_id, source, source_ref) where source_ref is not null do nothing;

  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.ingest_kakera(text, jsonb) from public;
grant execute on function public.ingest_kakera(text, jsonb) to anon, authenticated;
