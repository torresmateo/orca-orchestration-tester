import { connect } from "./db";
import { createKey } from "./keys";
import { migrate } from "./migrate";

// `bun run keys:create <name>`: creates an API key and prints it once.
// stdout carries only the key, so `KEY=$(bun run keys:create ci)` works;
// everything meant for a human goes to stderr.

const name = process.argv.slice(2).join(" ").trim();
if (!name) {
  console.error("usage: bun run keys:create <name>");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set; use `bun run keys:create`.");

const sql = connect(url);
// A fresh database has no api_keys table until migrations run. Applying them
// here keeps `db:up` then `keys:create` working without a separate step.
await migrate(sql);
const { id, key } = await createKey(sql, name);
await sql.close();

console.log(key);
console.error(`created API key ${id} ("${name}"). It is shown once; store it now.`);
