import { ping, type Db } from "./db";

// The whole HTTP surface. Tests call `app.fetch(new Request(...))` directly,
// so routes are exercised through the same entry point the server uses.

export type App = { fetch: (req: Request) => Promise<Response> };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function createApp(sql: Db): App {
  return {
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/healthz") {
        const up = await ping(sql);
        return json({ ok: up, db: up ? "up" : "down" }, up ? 200 : 503);
      }

      return json({ error: "not_found" }, 404);
    },
  };
}
