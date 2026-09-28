# Project context for workers

Implementers and reviewers read this file right after the issue and `DESIGN.md`.
The role prompts are project-agnostic; **everything a worker needs to know about
this codebase goes here.** Update it whenever a worker trips on something it
should have been told.

---

## What this project is

Snip is a small URL shortener with a JSON HTTP API: `POST /api/links` creates a
short link, `GET /:slug` redirects to it, and stats endpoints report how often
it was followed. It is Bun + TypeScript + Postgres, with no web framework and no
UI. "Working" from the outside means: the API returns the status codes and JSON
shapes in `DESIGN.md` §Contracts, redirects land on the right URL, click counts
match the number of redirects actually served, and `/api/*` refuses callers
without a valid key once auth exists. Changes to a contract in `DESIGN.md` are
never cosmetic; changes to log wording are.

## Fresh-worktree quickstart

`scripts/orca-setup.sh` has already run `bun install --frozen-lockfile` and
written `.env.local` (ports, `COMPOSE_PROJECT_NAME`, `DATABASE_URL`) by the
time a worker starts.

```sh
bun install --frozen-lockfile   # already done by the setup hook
bun run db:up                   # Postgres on $PORT_DB, namespaced by COMPOSE_PROJECT_NAME
bun run test                    # must say "0 skip"; migrations apply automatically
bun run typecheck               # tsc --noEmit, must be clean
bun run start                   # serves on $PORT_WEB; curl localhost:$PORT_WEB/healthz
bun run db:down                 # stops Postgres AND deletes this worktree's volume
```

## Environment facts that will bite you otherwise

- **Your worktree owns a port block.** `.env.local` carries `PORT_BASE`,
  `PORT_WEB`, `PORT_DB`, `COMPOSE_PROJECT_NAME` and `DATABASE_URL`, written by
  `scripts/orca-setup.sh`. Never hard-code a port, a database URL or a project
  name, including in tests.
- **Bare `bun test` does NOT load `.env.local`.** Bun skips `.env.local` when
  `NODE_ENV=test`, which `bun test` sets. Bare `bun test` therefore sees no
  `DATABASE_URL` and skips every database suite while still exiting 0. Always
  use `bun run test` (it passes `--env-file=.env.local`). The same applies to
  running a single file: `bun --env-file=.env.local test test/links.test.ts`.
- **`bun run` scripts and `bun src/file.ts` do load `.env.local`**, which is why
  `start`, `dev` and `migrate` work. Do not add a second env-loading mechanism.
- **Compose does not read `.env.local`.** Use `bun run db:up` / `db:down`, or
  `docker compose --env-file .env.local ...`. Without it, `compose.yaml` fails
  on the unset `PORT_DB`. That failure is intentional; do not add a default.
- **Suites that skip instead of fail.** Every suite built with `describeDb`
  from `test/helpers.ts` skips when the database is unreachable and prints:
  `SKIP: database not reachable (...) — start it with \`bun run db:up\``.
  The summary then shows `N skip` and still exits 0. Quote the pass/skip/fail
  line as evidence; `0 skip` is required.
- **Tests share one database per worktree.** Call `resetDb()` from
  `test/helpers.ts` in `beforeEach` for any suite that writes rows. A test that
  passes only because an earlier test inserted a row is broken.
- **Migrations.** New file per change, named `YYYYMMDDHHMMSS_snake_name.sql` (UTC,
  DESIGN D3). Never edit a migration that exists on `main`. Tests apply
  migrations on startup; `bun run migrate` applies them to the dev database.
- **Generated files.** `bun.lock` is generated: change dependencies with
  `bun add` / `bun remove`, never by hand. There are no other generated files.
- **Gitignored data the tests must not depend on.** Your worktree's Postgres
  volume. `bun run db:down` deletes it; tests must pass on an empty database.
- **Keys and identity.** `links.slug` is the public identity of a link
  (DESIGN D2) and is never rewritten. `api_keys.key_hash` identifies a key;
  the raw key is never stored or logged.

## What this project fails at

The reviewer weights its attention by this list.

- **Green suite, zero database tests.** `bun test` instead of `bun run test`,
  or a stopped database, turns every `describeDb` suite into a skip and still
  exits 0. Evidence it did not happen: the summary line from `bun run test`
  with `0 skip`, and a count that grew by the number of tests the slice added.
- **Clicks that silently are not counted.** The redirect deliberately swallows
  click-recording errors (DESIGN D4), so a broken recorder shows `0` clicks and
  a working redirect. Evidence: a test that follows a link N times over HTTP
  and reads exactly N back from the stats endpoint; an excerpt of rows from
  `clicks`.
- **A zero that means "broken", not "none".** Stats with no clicks must be
  distinguishable from stats for a link that does not exist (`404`) and from a
  query that matched nothing because of a time-zone or bucketing bug. Day
  buckets are UTC (D8); test with clicks near midnight UTC.
- **Auth that fails open.** A new `/api/*` route that bypasses the prefix guard
  (D5), a check that accepts an empty or revoked key, or a key compared in raw
  form. Evidence: `401` responses for no header, `Bearer ` with nothing after
  it, a random key, and a revoked key, on every `/api/*` route.
- **Ownership leaks.** Another key's link returning `403` (reveals it exists)
  or `200` instead of `404` (D7). Evidence: two keys, one link, the non-owner
  gets `404` on every per-link endpoint.
- **Slug identity drift.** Case folding, trimming, or regenerating a slug on
  retry so the returned slug is not the stored one. Evidence: the slug from
  the `201` response redirects.
- **Migration collisions and edits.** Two slices adding migrations that sort
  wrongly, or an edited merged migration that works on a fresh database and
  breaks an existing one. Evidence: `git diff main --stat -- migrations/` shows
  only added files.

## Non-negotiables

Gate through the human regardless of slice:

- Any change to a contract in `DESIGN.md` §Contracts (C1-C4): status codes,
  error codes, JSON field names, table columns other slices use.
- Anything touching `/api/*` authentication or link ownership.
- Editing or deleting a migration that exists on `main`.
- Adding a runtime dependency (anything in `dependencies`, not
  `devDependencies`).
- Changing `compose.yaml`, `scripts/orca-*.sh`, or the package scripts every
  worker relies on.

## Where things live

- `src/app.ts` — `createApp(sql)`: all routing and handlers
- `src/server.ts` — `Bun.serve` entry point
- `src/config.ts` — required env vars, no defaults
- `src/db.ts` — Postgres client (`Bun.SQL`) and `ping`
- `src/migrate.ts` — migration runner; `bun run migrate`
- `migrations/` — forward-only SQL, `YYYYMMDDHHMMSS_snake_name.sql`
- `test/helpers.ts` — `describeDb`, `resetDb`, `app()`, `request()`
- `test/*.test.ts` — behaviour tests through `app.fetch`
- `compose.yaml` — Postgres for dev and tests
- `DESIGN.md` — contracts and decisions
