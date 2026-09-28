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

See [`DESIGN.md`](DESIGN.md) §Contracts. The rest arrives slice by slice.

Every `/api/*` request needs an API key; without a valid one it gets `401`
`{"error":"unauthorized"}`. `GET /healthz` and `GET /<slug>` stay public.

```sh
KEY=$(bun run keys:create my-laptop)   # prints the key once; only its hash is stored
curl -H "Authorization: Bearer $KEY" localhost:$(grep ^PORT_WEB .env.local | cut -d= -f2)/api/...
```

## Orchestration

- [`.orca/README.md`](.orca/README.md): how the driver, implementers and
  reviewers work together
- [`.orca/SETUP.md`](.orca/SETUP.md): wiring this repo into Orca
- [`.orca/project.md`](.orca/project.md): what workers need to know about Snip
- Slices: [issues labelled `slice`](../../issues?q=label%3Aslice)
