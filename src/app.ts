import { ping, type Db } from "./db";
import { authenticate } from "./keys";
import { generateSlug, RESERVED_SLUGS } from "./slug";

// The whole HTTP surface. Tests call `app.fetch(new Request(...))` directly,
// so routes are exercised through the same entry point the server uses.

export type App = { fetch: (req: Request) => Promise<Response> };

export type AppOptions = {
  // Source of candidate slugs. Tests inject one to force collisions and
  // reserved words; production uses the random generator.
  generateSlug?: () => string;
};

// A fresh random slug colliding this many times in a row means something is
// wrong (a broken generator, a full keyspace), not bad luck.
const MAX_SLUG_ATTEMPTS = 10;

type LinkRow = { slug: string; target_url: string; created_at: Date };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function invalidRequest(): Response {
  return json({ error: "invalid_request" }, 400);
}

function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

// An absolute http(s) URL with an authority. The string is stored exactly as
// given, so what the caller sent is what the redirect returns.
function parseTargetUrl(value: unknown): string | null {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

// Header values must be printable ASCII. A target with spaces or non-ASCII
// characters is redirected to its WHATWG serialisation (punycode host,
// percent-encoded path), which names the same resource.
function locationFor(targetUrl: string): string {
  return /^[\x21-\x7e]+$/.test(targetUrl) ? targetUrl : new URL(targetUrl).href;
}

export function createApp(sql: Db, options: AppOptions = {}): App {
  const nextSlug = options.generateSlug ?? generateSlug;

  async function insertLink(targetUrl: string): Promise<LinkRow> {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = nextSlug();
      if (RESERVED_SLUGS.has(slug)) continue;
      const rows: LinkRow[] = await sql`
        insert into links (slug, target_url) values (${slug}, ${targetUrl})
        on conflict (slug) do nothing
        returning slug, target_url, created_at`;
      if (rows[0]) return rows[0];
    }
    throw new Error(`no free slug after ${MAX_SLUG_ATTEMPTS} attempts`);
  }

  async function createLink(req: Request, origin: string): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return invalidRequest();
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return invalidRequest();

    const targetUrl = parseTargetUrl((body as Record<string, unknown>).url);
    if (targetUrl === null) return invalidRequest();

    const link = await insertLink(targetUrl);
    return json(
      {
        slug: link.slug,
        url: link.target_url,
        short_url: `${origin}/${link.slug}`,
        created_at: link.created_at.toISOString(),
      },
      201,
    );
  }

  // D4: analytics never fail a redirect. A failed insert is logged and the
  // 302 still goes out, so a broken recorder reads as zero clicks.
  async function recordClick(linkId: string, slug: string): Promise<void> {
    try {
      await sql`insert into clicks (link_id) values (${linkId})`;
    } catch (err) {
      console.error(`click not recorded for /${slug}:`, err);
    }
  }

  async function followLink(slug: string): Promise<Response> {
    const rows: { id: string; target_url: string }[] = await sql`
      select id, target_url from links where slug = ${slug}`;
    const link = rows[0];
    if (!link) return notFound();
    // C3: one row per 302. Keep this immediately before the redirect, after
    // every check that can refuse it.
    await recordClick(link.id, slug);
    return new Response(null, { status: 302, headers: { Location: locationFor(link.target_url) } });
  }

  async function linkStats(slug: string): Promise<Response> {
    const rows: { slug: string; total_clicks: number; last_clicked_at: Date | null }[] = await sql`
      select l.slug, count(c.id)::int as total_clicks, max(c.clicked_at) as last_clicked_at
      from links l left join clicks c on c.link_id = l.id
      where l.slug = ${slug}
      group by l.id`;
    const stats = rows[0];
    if (!stats) return notFound();
    return json({
      slug: stats.slug,
      total_clicks: stats.total_clicks,
      last_clicked_at: stats.last_clicked_at?.toISOString() ?? null,
    });
  }

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

      if (req.method === "POST" && url.pathname === "/api/links") {
        return createLink(req, url.origin);
      }

      const statsMatch = url.pathname.match(/^\/api\/links\/([^/]+)\/stats$/);
      if (req.method === "GET" && statsMatch) {
        return linkStats(statsMatch[1]!);
      }

      // Any other single path segment is a slug. /api/* has a second segment
      // and never gets here; bare /api and /healthz are reserved (D2), so no
      // stored slug can shadow them.
      const slugMatch = url.pathname.match(/^\/([^/]+)$/);
      if (req.method === "GET" && slugMatch) {
        return followLink(slugMatch[1]!);
      }

      return notFound();
    },
  };
}
