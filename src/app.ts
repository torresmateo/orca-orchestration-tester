import { SQL } from "bun";
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

type LinkRow = { slug: string; target_url: string; created_at: Date; expires_at: Date | null };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function invalidRequest(): Response {
  return json({ error: "invalid_request" }, 400);
}

function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

function expired(): Response {
  return json({ error: "expired" }, 410);
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

// An ISO-8601 date-time with an explicit offset, e.g. 2027-01-01T00:00:00Z or
// 2027-01-01T09:30:00+02:00. Without an offset the instant would depend on
// whose clock reads it (D8), so date-only and offset-less values are refused.
// Sub-millisecond digits are truncated, since a JS Date holds milliseconds.
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

// A missing or null expires_at means the link never expires. Returns
// "invalid" for anything that is not a real instant: Date.parse would roll
// 2027-02-30 over to March 2, so every field is range-checked here instead.
function parseExpiresAt(value: unknown): Date | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const m = value.match(ISO_DATE_TIME);
  if (!m) return "invalid";

  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as number[];
  const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHours = m[8] ? 0 : Number(m[10]);
  const offsetMinutes = m[8] ? 0 : Number(m[11]);
  if (hour! > 23 || minute! > 59 || second! > 59 || offsetHours > 23 || offsetMinutes > 59) {
    return "invalid";
  }

  // setUTCFullYear rather than Date.UTC, which maps years 0-99 to 1900-1999.
  const wall = new Date(0);
  wall.setUTCFullYear(year!, month! - 1, day!);
  wall.setUTCHours(hour!, minute!, second!, ms);
  if (wall.getUTCMonth() !== month! - 1 || wall.getUTCDate() !== day) return "invalid";

  const sign = m[9] === "-" ? -1 : 1;
  const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return new Date(wall.getTime() - offsetMs);
}

// Header values must be printable ASCII. A target with spaces or non-ASCII
// characters is redirected to its WHATWG serialisation (punycode host,
// percent-encoded path), which names the same resource.
function locationFor(targetUrl: string): string {
  return /^[\x21-\x7e]+$/.test(targetUrl) ? targetUrl : new URL(targetUrl).href;
}

export function createApp(sql: Db, options: AppOptions = {}): App {
  const nextSlug = options.generateSlug ?? generateSlug;

  async function insertLink(targetUrl: string, expiresAt: Date | null): Promise<LinkRow> {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = nextSlug();
      if (RESERVED_SLUGS.has(slug)) continue;
      const rows: LinkRow[] = await sql`
        insert into links (slug, target_url, expires_at)
        values (${slug}, ${targetUrl}, ${expiresAt})
        on conflict (slug) do nothing
        returning slug, target_url, created_at, expires_at`;
      if (rows[0]) return rows[0];
    }
    throw new Error(`no free slug after ${MAX_SLUG_ATTEMPTS} attempts`);
  }

  // Uniqueness is the database's job: the unique constraint on links.slug
  // decides races, so there is no pre-check. Returns null if the slug is taken.
  async function insertCustomLink(
    slug: string,
    targetUrl: string,
    expiresAt: Date | null,
  ): Promise<LinkRow | null> {
    try {
      const rows: LinkRow[] = await sql`
        insert into links (slug, target_url, expires_at)
        values (${slug}, ${targetUrl}, ${expiresAt})
        returning slug, target_url, created_at, expires_at`;
      return rows[0]!;
    } catch (err) {
      if (isSlugConflict(err)) return null;
      throw err;
    }
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
    const customSlug = parseCustomSlug((body as Record<string, unknown>).slug);
    if (customSlug === null) return invalidRequest();

    const expiresAt = parseExpiresAt((body as Record<string, unknown>).expires_at);
    if (expiresAt === "invalid") return invalidRequest();
    // A link that is already expired could never be followed.
    if (expiresAt !== null && expiresAt.getTime() <= Date.now()) return invalidRequest();

    const link =
      customSlug === undefined
        ? await insertLink(targetUrl, expiresAt)
        : await insertCustomLink(customSlug, targetUrl, expiresAt);
    if (link === null) return slugTaken();
    return json(
      {
        slug: link.slug,
        url: link.target_url,
        short_url: `${origin}/${link.slug}`,
        created_at: link.created_at.toISOString(),
        expires_at: link.expires_at?.toISOString() ?? null,
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
    // Expiry is judged by the database clock, so tests can expire a link by
    // moving expires_at instead of sleeping.
    const rows: { id: string; target_url: string; expired: boolean }[] = await sql`
      select id, target_url, coalesce(expires_at <= now(), false) as expired
      from links where slug = ${slug}`;
    const link = rows[0];
    if (!link) return notFound();
    if (link.expired) return expired();
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
