import { describe } from "bun:test";
import { createApp, type App } from "../src/app";
import { connect, ping, type Db } from "../src/db";
import { createKey } from "../src/keys";
import { migrate } from "../src/migrate";

// Database-backed suites use `describeDb`. When the database is unreachable
// they SKIP rather than fail, and print one line:
//
//   SKIP: database not reachable (<url>) — start it with `bun run db:up`
//
// A skipped suite is not a passing suite. Check the "skip" count in the
// summary; it must be 0 before you claim the tests pass.

const url = process.env.DATABASE_URL;
export const sql: Db | undefined = url ? connect(url) : undefined;
const reachable = sql ? await ping(sql) : false;

if (!reachable) {
  console.warn(
    `SKIP: database not reachable (${url ?? "DATABASE_URL unset"}) — start it with \`bun run db:up\``,
  );
} else {
  await migrate(sql!);
}

export const describeDb = reachable ? describe : describe.skip;

export function db(): Db {
  if (!sql || !reachable) throw new Error("db() called outside describeDb");
  return sql;
}

export function app(): App {
  return createApp(db());
}

export function request(path: string, init?: RequestInit): Request {
  return new Request(`http://snip.test${path}`, init);
}

// Creates a real API key (same code path as `bun run keys:create`) so /api/*
// tests authenticate the way a client does. Call it after resetDb(), which
// deletes every key.
export async function createTestKey(name = "test"): Promise<{ id: string; key: string }> {
  return createKey(db(), name);
}

// RequestInit with `Authorization: Bearer <key>` merged into `init.headers`.
export function withKey(key: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  return { ...init, headers };
}

// Empties every application table. Call in beforeEach so no test depends on
// rows another test (or a previous run) left behind.
export async function resetDb(): Promise<void> {
  const rows = await db()`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> 'schema_migrations'`;
  const tables = rows.map((r: { tablename: string }) => `"${r.tablename}"`);
  if (tables.length) await db().unsafe(`truncate ${tables.join(", ")} restart identity cascade`);
}
