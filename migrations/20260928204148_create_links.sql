-- C2. Links. The slug is the public identity of a link (DESIGN D2); id is
-- internal and never exposed. Later slices add columns by new migrations.
create table links (
  id bigint generated always as identity primary key,
  slug text not null unique,
  target_url text not null,
  created_at timestamptz not null default now()
);
