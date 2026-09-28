# Snip — design record

Workers treat this file as law and never edit it. The driver records decisions
here after they are made; anything with architectural impact is gated through
the human first.

## Purpose

Snip is a small URL shortener with an HTTP API: create a short link, follow
it, see how often it was followed. It exists as a realistic target for testing
agent orchestration harnesses: small enough that a slice fits in 30-120
minutes, real enough to have a database, an access model, shared contracts
and the failure modes that come with them.

## Architecture

- **Runtime:** Bun + TypeScript, no web framework. `src/app.ts` exports
  `createApp(sql)` returning `{ fetch(req) }`; `src/server.ts` wraps it in
  `Bun.serve`. Tests call `app.fetch(new Request(...))` directly, so they go
  through the same routing the server uses.
- **Database:** Postgres 16 via `compose.yaml`, accessed with Bun's built-in
  `SQL` client (`src/db.ts`). No ORM.
- **Migrations:** plain SQL files in `migrations/`, applied in lexical order by
  `src/migrate.ts` and recorded in `schema_migrations`. Tests apply them on
  startup.
- **Config:** environment only, read in `src/config.ts`. Every value is
  required; there are no defaults (see D6).

## Contracts

Interfaces other slices inherit. Changing one is a gated decision.

### C1. HTTP errors

Every non-2xx JSON response is `{ "error": "<snake_case_code>", "message"?: string }`.
Codes are stable identifiers; tests assert on `error`, never on `message`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | body is not JSON, or a field fails validation |
| 401 | `unauthorized` | `/api/*` without a valid key |
| 404 | `not_found` | unknown route, unknown slug, or a link the caller does not own |
| 409 | `slug_taken` | custom slug already exists |
| 410 | `expired` | link exists but `expires_at` has passed |

### C2. Links

Table `links`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigint generated always as identity` | internal; never exposed |
| `slug` | `text not null unique` | public identifier; see D2 |
| `target_url` | `text not null` | absolute `http`/`https` URL |
| `created_at` | `timestamptz not null default now()` | |

Later slices add columns (`expires_at`, `api_key_id`) by new migrations, never
by editing an applied one.

API:

- `POST /api/links` body `{ "url": string }` → `201`
  `{ "slug", "url", "short_url", "created_at" }`. `short_url` is the request's
  origin plus `/<slug>`. Later slices add optional fields to both body and
  response; they never rename or remove one.
- `GET /<slug>` → `302` with `Location: <target_url>`. `404` for an unknown
  slug.

### C3. Clicks

Table `clicks(id bigint identity, link_id bigint not null references links(id)
on delete cascade, clicked_at timestamptz not null default now())`. One row
per successful redirect. Nothing else writes to it.

### C4. API keys

Table `api_keys(id bigint identity, name text not null, key_hash text not null
unique, created_at timestamptz not null default now(), revoked_at timestamptz)`.
Requests send `Authorization: Bearer <key>`. Only the SHA-256 hex of a key is
stored. Keys are created by `bun run keys:create <name>`, which prints the key
once.

## Decisions

**D1. No framework.** Routing is a handful of `if`s in `src/app.ts`. The
project is small, and a framework would add a second source of truth for how
requests flow. Revisit only if routing passes ~15 routes.

**D2. The slug is the identity of a link.** It is never rewritten after
creation. Generated slugs are 7 characters from `[A-Za-z0-9]`, from
`crypto.getRandomValues`, retried on collision. Slugs are case-sensitive.
Custom slugs match `^[A-Za-z0-9_-]{3,32}$`. The reserved words `api` and
`healthz` are never valid slugs, generated or custom.

**D3. Migration filenames are `YYYYMMDDHHMMSS_<name>.sql`** (UTC). Parallel
slices each add migrations; sequence numbers would collide at merge time and
timestamps do not. Never edit a migration that has been merged.

**D4. The redirect never fails because of analytics.** If recording a click
fails, the error is logged to stderr and the `302` is still returned. The
consequence is that a broken click recorder shows up as zero clicks, not as an
error, so the click slice must prove clicks are recorded, not merely that the
redirect works.

**D5. Auth guards the `/api/` prefix, not individual routes.** One check in
`src/app.ts` before any `/api/*` route, so a route added later is protected
without its author remembering to. `GET /<slug>` and `GET /healthz` stay
public. Missing, malformed, unknown and revoked keys all yield `401`. The auth
slice is responsible for updating any `/api/*` tests that already exist when
it lands so they authenticate.

**D6. No config defaults.** `PORT_WEB` and `DATABASE_URL` are required; a
missing one throws at startup. A plausible default would let a worktree
silently use another worktree's port or database.

**D7. Ownership hides, it does not forbid.** Once links have owners, a key
asking about a link it does not own gets `404 not_found`, never `403`, so a
caller cannot probe which slugs exist.

**D8. Time is UTC everywhere.** Stored as `timestamptz`, returned as ISO-8601
with `Z`, and day buckets are UTC days.

## Non-goals

- A web UI. API only.
- User accounts, sessions, OAuth. API keys are the whole access model.
- Editing a link's target or slug after creation.
- Rate limiting, bot filtering, unique-visitor counting.
- Deployment. Snip runs locally and in tests.

## Open questions

- Should revoking a key hide its links from listing, or only block new writes?
  Undecided; the listing slice must ask rather than pick.
