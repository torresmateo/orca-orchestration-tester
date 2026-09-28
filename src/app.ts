import { ping, type Db } from "./db";
import { authenticate } from "./keys";

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

      // The one auth check (DESIGN D5). It guards the whole prefix, so an
      // /api/* route added below is protected without its author opting in,
      // and an unknown /api/* path is 401 before it can be 404.
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const key = await authenticate(sql, req);
        if (!key) {
          return Response.json(
            { error: "unauthorized" },
            { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
          );
        }
      }

      return json({ error: "not_found" }, 404);
    },
  };
}
