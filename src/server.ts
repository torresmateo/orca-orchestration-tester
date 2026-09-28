import { createApp } from "./app";
import { loadConfig } from "./config";
import { connect } from "./db";
import { migrate } from "./migrate";

const config = loadConfig();
const sql = connect(config.databaseUrl);

// Apply pending migrations before serving, so a fresh database is usable with
// just `bun run db:up && bun run start`. Idempotent; forward-only.
const applied = await migrate(sql);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

const app = createApp(sql);

const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`snip listening on http://localhost:${server.port}`);
