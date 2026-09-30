-- C3. Clicks. One row per successful redirect (a GET /:slug that returned
-- 302); nothing else writes here. The index serves per-link stats.
create table clicks (
  id bigint generated always as identity primary key,
  link_id bigint not null references links(id) on delete cascade,
  clicked_at timestamptz not null default now()
);

create index clicks_link_id_clicked_at_idx on clicks (link_id, clicked_at);
