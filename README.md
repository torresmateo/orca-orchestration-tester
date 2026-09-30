# Snip

A small URL shortener with a JSON API, built as a realistic target for testing
agent orchestration harnesses. Work is split into GitHub issues ("slices") that
an [Orca](.orca/README.md) driver dispatches to implementer and reviewer agents
in isolated worktrees.

## Quickstart

Requires [Bun](https://bun.sh) 1.3+ and Docker.

```sh
bash scripts/orca-setup.sh   # claims a port block, writes .env.local, installs deps
bun run db:up                # Postgres on $PORT_DB
bun run test                 # expect "0 skip"
bun run start                # http://localhost:$PORT_WEB
curl localhost:$(grep ^PORT_WEB .env.local | cut -d= -f2)/healthz
# {"ok":true,"db":"up"}
bun run db:down              # stop Postgres and delete its volume
```

Use `bun run test`, not bare `bun test`: the latter does not load `.env.local`
and quietly skips every database test.

## API

See [`DESIGN.md`](DESIGN.md) §Contracts. Endpoints arrive slice by slice; today
there are:

- `GET /healthz`: database liveness
- `POST /api/links` with `{"url": "https://..."}` → `201`
  `{"slug", "url", "short_url", "created_at", "expires_at"}`. Add
  `"slug": "my-link"` to choose the slug yourself (3-32 of `A-Z a-z 0-9 _ -`,
  case-sensitive, not `api` or `healthz`); a slug that is already taken →
  `409 {"error":"slug_taken"}`. Optional `"expires_at"` is an ISO-8601
  date-time with an offset, e.g. `"2030-01-01T00:00:00Z"`, and must be in the
  future. It is echoed in UTC, or `null` for a link that never expires.
- `GET /<slug>` → `302` to the link's URL, `404 {"error":"not_found"}`, or
  `410 {"error":"expired"}` once its `expires_at` has passed. Every `302` is
  recorded as a click; a `404` or `410` records nothing.
- `GET /api/links/<slug>/stats` → `200`
  `{"slug", "total_clicks", "last_clicked_at"}` (`last_clicked_at` is ISO-8601
  UTC, or `null` if never followed), or `404 {"error":"not_found"}`

Every `/api/*` request needs an API key; without a valid one it gets `401`
`{"error":"unauthorized"}`. `GET /healthz` and `GET /<slug>` stay public.

```sh
KEY=$(bun run keys:create my-laptop)   # prints the key once; only its hash is stored
PORT_WEB=$(grep ^PORT_WEB .env.local | cut -d= -f2)
curl -si -X POST localhost:$PORT_WEB/api/links -H "Authorization: Bearer $KEY" \
  -d '{"url":"https://example.com"}'
# HTTP/1.1 201 Created ... {"slug":"aB3dE9x","url":"https://example.com",...}
curl -si localhost:$PORT_WEB/aB3dE9x
# HTTP/1.1 302 Found ... Location: https://example.com
curl -s localhost:$PORT_WEB/api/links/aB3dE9x/stats -H "Authorization: Bearer $KEY"
# {"slug":"aB3dE9x","total_clicks":1,"last_clicked_at":"2026-09-28T21:20:00.000Z"}
```

## Orchestration

- [`.orca/README.md`](.orca/README.md): how the driver, implementers and
  reviewers work together
- [`.orca/SETUP.md`](.orca/SETUP.md): wiring this repo into Orca
- [`.orca/project.md`](.orca/project.md): what workers need to know about Snip
- Slices: [issues labelled `slice`](../../issues?q=label%3Aslice)
