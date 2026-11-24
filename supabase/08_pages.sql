-- かけらの泉：ページ（研修・本）。SQL Editor に丸ごと貼って Run（何度実行しても大丈夫）
-- 本のテーブル（books）を、研修も入る「ページ」として使う。かけらの book_id がそのページ
-- kind      … book（本）/ training（研修）
-- opened_at … 最後に開いた時刻（トップには最近開いた3つだけ出す）
-- status    … reading（開いている）/ done（研修おわり・読了。底に沈む）

alter table public.books add column if not exists kind text not null default 'book';
alter table public.books drop constraint if exists books_kind_check;
alter table public.books add constraint books_kind_check check (kind in ('book', 'training'));

alter table public.books add column if not exists opened_at timestamptz;
update public.books set opened_at = started_at where opened_at is null;
alter table public.books alter column opened_at set default now();
alter table public.books alter column opened_at set not null;

create index if not exists books_opened on public.books (user_id, opened_at desc);
-- 「同じときに投げたもの」で前後30分を引くため
create index if not exists kakera_user_created on public.kakera (user_id, created_at);

-- 前の「いま読んでる本をセット」の状態はもう使わない
delete from public.kv where key = 'book';
