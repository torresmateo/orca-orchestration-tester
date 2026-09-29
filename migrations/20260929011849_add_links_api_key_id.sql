-- Links belong to the API key that created them (issue #6, DESIGN D7).
-- Nullable: links created before this migration have no known owner. They
-- keep redirecting (GET /<slug> never looks at the owner), and no key sees
-- them through /api. Nothing is backfilled, because the creator is unknown.
alter table links add column api_key_id bigint references api_keys(id);

-- Serves GET /api/links: one key's links, newest first, keyset-paginated on
-- (created_at, slug).
create index links_api_key_id_created_at_slug on links (api_key_id, created_at, slug);
