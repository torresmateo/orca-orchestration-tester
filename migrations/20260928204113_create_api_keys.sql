-- API keys (DESIGN C4). Only the SHA-256 hex of a key is stored; the raw key
-- is shown once by `bun run keys:create <name>` and never persisted.
create table api_keys (
  id bigint generated always as identity primary key,
  name text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
