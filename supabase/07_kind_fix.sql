-- かけらの泉：種類の手直し。SQL Editor に丸ごと貼って Run（何度実行しても大丈夫）
-- kind_fix     … 自分で選び直した種類（h 申し送り / u 未解決 / w 仕事 / e 英語 / d 日々）
-- kind_learned … 選び直した例から機械が学んで付けた種類
alter table public.kakera add column if not exists kind_fix text;
alter table public.kakera add column if not exists kind_learned text;

alter table public.kakera drop constraint if exists kakera_kind_fix_check;
alter table public.kakera add constraint kakera_kind_fix_check check (kind_fix in ('h', 'u', 'w', 'e', 'd'));
alter table public.kakera drop constraint if exists kakera_kind_learned_check;
alter table public.kakera add constraint kakera_kind_learned_check check (kind_learned in ('h', 'u', 'w', 'e', 'd'));

create index if not exists kakera_kind_fix on public.kakera (user_id) where kind_fix is not null;
