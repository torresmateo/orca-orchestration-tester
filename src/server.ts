import { createApp } from "./app";
import { loadConfig } from "./config";
import { connect } from "./db";

const config = loadConfig();
const sql = connect(config.databaseUrl);
const app = createApp(sql);

const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`snip listening on http://localhost:${server.port}`);
