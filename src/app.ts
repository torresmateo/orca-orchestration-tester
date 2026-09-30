import { SQL } from "bun";
import { ping, type Db } from "./db";
import { authenticate, type ApiKey } from "./keys";
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

// GET /api/links page size: the default, and the largest ?limit= accepted.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type LinkRow = { slug: string; target_url: string; created_at: Date };

// A position in one key's listing: the (created_at, slug) of the last link
// on the previous page. created_at is kept at the database's microsecond
// precision as UTC text, since a JS Date would round it to milliseconds and
// the next page could repeat or skip a link.
type Cursor = { createdAt: string; slug: string };

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function invalidRequest(): Response {
  return json({ error: "invalid_request" }, 400);
}

function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

function slugTaken(): Response {
  return json({ error: "slug_taken" }, 409);
}

// Custom slugs (D2): 3-32 of [A-Za-z0-9_-], never a reserved word. Validated,
// never trimmed or case-folded: the stored slug is exactly what was sent.
// `undefined` means generate one; an explicit null counts as absent (D10).
const CUSTOM_SLUG = /^[A-Za-z0-9_-]{3,32}$/;

function parseCustomSlug(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !CUSTOM_SLUG.test(value) || RESERVED_SLUGS.has(value)) {
    return null;
  }
  return value;
}

function isSlugConflict(err: unknown): boolean {
  return (
    err instanceof SQL.PostgresError && err.errno === "23505" && err.constraint === "links_slug_key"
  );
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

// The cursor is opaque to clients: base64url of JSON. Anything that does not
// decode to a well-formed position is null, so the caller answers 400
// instead of letting a bad timestamp reach the database.
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.slug])).toString("base64url");
}

function decodeCursor(value: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [createdAt, slug] = parsed;
  if (typeof createdAt !== "string" || !CURSOR_TIMESTAMP.test(createdAt)) return null;
  if (typeof slug !== "string" || slug === "") return null;
  // The regex admits 2026-13-45; a real instant survives a round trip.
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== createdAt.slice(0, 19)) {
    return null;
  }
  return { createdAt, slug };
}

// ?limit= is a whole number from 1 to MAX_PAGE_SIZE; absent means the default.
function parseLimit(value: string | null): number | null {
  if (value === null) return DEFAULT_PAGE_SIZE;
  if (!/^\d{1,3}$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= MAX_PAGE_SIZE ? limit : null;
}

// One shape for a link wherever the API returns one: the POST response and
// every GET /api/links item are built here, so they cannot drift apart.
function linkJson(link: LinkRow, origin: string) {
  return {
    slug: link.slug,
    url: link.target_url,
    short_url: `${origin}/${link.slug}`,
    created_at: link.created_at.toISOString(),
  };
}

// Header values must be printable ASCII. A target with spaces or non-ASCII
// characters is redirected to its WHATWG serialisation (punycode host,
// percent-encoded path), which names the same resource.
function locationFor(targetUrl: string): string {
  return /^[\x21-\x7e]+$/.test(targetUrl) ? targetUrl : new URL(targetUrl).href;
}

export function createApp(sql: Db, options: AppOptions = {}): App {
  const nextSlug = options.generateSlug ?? generateSlug;

  async function insertLink(targetUrl: string, owner: ApiKey): Promise<LinkRow> {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = nextSlug();
      if (RESERVED_SLUGS.has(slug)) continue;
      const rows: LinkRow[] = await sql`
        insert into links (slug, target_url, api_key_id) values (${slug}, ${targetUrl}, ${owner.id})
        on conflict (slug) do nothing
        returning slug, target_url, created_at`;
      if (rows[0]) return rows[0];
    }
    throw new Error(`no free slug after ${MAX_SLUG_ATTEMPTS} attempts`);
  }

  // Uniqueness is the database's job: the unique constraint on links.slug
  // decides races, so there is no pre-check. Returns null if the slug is taken.
  async function insertCustomLink(
    slug: string,
    targetUrl: string,
    owner: ApiKey,
  ): Promise<LinkRow | null> {
    try {
      const rows: LinkRow[] = await sql`
        insert into links (slug, target_url, api_key_id) values (${slug}, ${targetUrl}, ${owner.id})
        returning slug, target_url, created_at`;
      return rows[0]!;
    } catch (err) {
      if (isSlugConflict(err)) return null;
      throw err;
    }
  }

  async function createLink(req: Request, origin: string, owner: ApiKey): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return invalidRequest();
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return invalidRequest();

    const targetUrl = parseTargetUrl((body as Record<string, unknown>).url);
    if (targetUrl === null) return invalidRequest();
    const customSlug = parseCustomSlug((body as Record<string, unknown>).slug);
    if (customSlug === null) return invalidRequest();

    const link =
      customSlug === undefined
        ? await insertLink(targetUrl, owner)
        : await insertCustomLink(customSlug, targetUrl, owner);
    if (link === null) return slugTaken();
    return json(linkJson(link, origin), 201);
  }

  // The caller's own links, newest first. Keyset pagination on
  // (created_at, slug), which is unique, so a link inserted while a client
  // pages lands before its cursor and never shifts or repeats a later page.
  // Links with no owner (created before links.api_key_id existed) match no
  // key and are listed for nobody.
  async function listLinks(url: URL, owner: ApiKey): Promise<Response> {
    const limit = parseLimit(url.searchParams.get("limit"));
    if (limit === null) return invalidRequest();
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
    if (rawCursor !== null && cursor === null) return invalidRequest();

    type PageRow = LinkRow & { cursor_ts: string };
    const cursorTs = sql`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    // One row past the page says whether there is a next one.
    const rows: PageRow[] = cursor
      ? await sql`
          select slug, target_url, created_at, ${cursorTs} as cursor_ts
          from links
          where api_key_id = ${owner.id}
            and (created_at, slug) < (${cursor.createdAt}::timestamptz, ${cursor.slug})
          order by created_at desc, slug desc
          limit ${limit + 1}`
      : await sql`
          select slug, target_url, created_at, ${cursorTs} as cursor_ts
          from links
          where api_key_id = ${owner.id}
          order by created_at desc, slug desc
          limit ${limit + 1}`;

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ createdAt: last.cursor_ts, slug: last.slug }) : null;
    return json({ links: page.map((link) => linkJson(link, url.origin)), next_cursor: nextCursor });
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

  // The one ownership lookup for every per-link /api route: the link's id
  // if `key` owns it, otherwise null. Another key's link, an unknown slug and
  // a link with no owner (api_key_id null, D12) all look the same, so the
  // caller answers 404 not_found and never 403 (D7).
  async function ownedLinkId(slug: string, key: ApiKey): Promise<string | null> {
    const rows: { id: string }[] = await sql`
      select id from links where slug = ${slug} and api_key_id = ${key.id}`;
    return rows[0]?.id ?? null;
  }

  async function linkStats(slug: string, key: ApiKey): Promise<Response> {
    const linkId = await ownedLinkId(slug, key);
    if (linkId === null) return notFound();
    const rows: { slug: string; total_clicks: number; last_clicked_at: Date | null }[] = await sql`
      select l.slug, count(c.id)::int as total_clicks, max(c.clicked_at) as last_clicked_at
      from links l left join clicks c on c.link_id = l.id
      where l.id = ${linkId}
      group by l.id`;
    const stats = rows[0];
    if (!stats) return notFound();
    return json({
      slug: stats.slug,
      total_clicks: stats.total_clicks,
      last_clicked_at: stats.last_clicked_at?.toISOString() ?? null,
    });
  }

  // Every /api/* route, reached only with an authenticated key. Anything a
  // key reads or changes is scoped to that key: a link it does not own is
  // 404 not_found, never 403, so no caller can probe which slugs exist (D7).
  async function api(req: Request, url: URL, key: ApiKey): Promise<Response> {
    if (url.pathname === "/api/links") {
      if (req.method === "POST") return createLink(req, url.origin, key);
      if (req.method === "GET") return listLinks(url, key);
    }
    const statsMatch = url.pathname.match(/^\/api\/links\/([^/]+)\/stats$/);
    if (req.method === "GET" && statsMatch) return linkStats(statsMatch[1]!, key);
    return notFound();
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
        return api(req, url, key);
      }

      // Any other single path segment is a slug. /api and /api/* returned
      // above and never get here; /api and /healthz are reserved (D2), so no
      // stored slug can shadow them. The owner plays no part: redirects are
      // public, including for links that have no owner.
      const slugMatch = url.pathname.match(/^\/([^/]+)$/);
      if (req.method === "GET" && slugMatch) {
        return followLink(slugMatch[1]!);
      }

      return notFound();
    },
  };
}
