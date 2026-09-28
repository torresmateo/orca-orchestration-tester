import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { connect, type Db } from "./db";

// Forward-only SQL migrations. Files in migrations/ are applied in lexical
// order and recorded in schema_migrations. Never edit an applied migration:
// add a new file. Rewriting one silently diverges every existing database.

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export async function migrate(sql: Db): Promise<string[]> {
  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set(
    (await sql`select name from schema_migrations`).map((r: { name: string }) => r.name),
  );

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await Bun.file(join(MIGRATIONS_DIR, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    applied.push(file);
  }
  return applied;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; use `bun run migrate`.");
  const sql = connect(url);
  const applied = await migrate(sql);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "migrations: up to date");
  await sql.close();
}
