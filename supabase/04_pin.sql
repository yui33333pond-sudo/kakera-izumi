-- かけらの泉：ピン（買うもの・一時的に置いておきたいもの）。SQL Editor に貼って Run（何度実行しても大丈夫）
alter table public.kakera add column if not exists pinned_at timestamptz;
create index if not exists kakera_pinned on public.kakera (user_id, pinned_at desc) where pinned_at is not null;
