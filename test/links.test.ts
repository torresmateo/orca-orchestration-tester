import { beforeEach, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { generateSlug } from "../src/slug";
import { app, createTestKey, db, describeDb, request, resetDb, withKey } from "./helpers";

const SLUG = /^[A-Za-z0-9]{7}$/;

// /api/* requires a key (D5). Each suite empties the database and creates a
// fresh key before every test, so no test relies on another's key.
let key: string;

async function resetWithKey(): Promise<void> {
  await resetDb();
  key = (await createTestKey()).key;
}

function post(body: string, origin = "http://snip.test"): Request {
  return new Request(
    `${origin}/api/links`,
    withKey(key, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

function postUrl(url: unknown): Request {
  return post(JSON.stringify({ url }));
}

// Yields the given slugs in order, then fails loudly if asked for more.
function slugsFrom(...slugs: string[]): () => string {
  return () => {
    const next = slugs.shift();
    if (next === undefined) throw new Error("slug sequence exhausted");
    return next;
  };
}

type LinkBody = { slug: string; url: string; short_url: string; created_at: string };

async function linkBody(res: Response): Promise<LinkBody> {
  return (await res.json()) as LinkBody;
}

async function linkCount(): Promise<number> {
  const [row] = await db()`select count(*)::int as n from links`;
  return row.n;
}

describeDb("POST /api/links", () => {
  beforeEach(resetWithKey);

  test("creates a link and returns exactly slug, url, short_url, created_at", async () => {
    const before = Date.now();
    const res = await app().fetch(postUrl("https://example.com/a?b=1"));
    expect(res.status).toBe(201);

    const body = await linkBody(res);
    expect(Object.keys(body).sort()).toEqual(["created_at", "short_url", "slug", "url"]);
    expect(body.slug).toMatch(SLUG);
    expect(body.url).toBe("https://example.com/a?b=1");
    expect(body.short_url).toBe(`http://snip.test/${body.slug}`);
    // D8: ISO-8601 in UTC, and a real "now", not a default or epoch.
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(body.created_at) - before)).toBeLessThan(60_000);
  });

  test("short_url uses the request's origin", async () => {
    const res = await app().fetch(
      post(JSON.stringify({ url: "https://example.com" }), "https://sn.ip:8443"),
    );
    const body = await linkBody(res);
    expect(body.short_url).toBe(`https://sn.ip:8443/${body.slug}`);
  });

  test("does not require a JSON content-type (curl -d sends form-urlencoded)", async () => {
    const res = await app().fetch(
      new Request(
        "http://snip.test/api/links",
        withKey(key, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: '{"url":"https://example.com"}',
        }),
      ),
    );
    expect(res.status).toBe(201);
  });

  test("the stored slug is the returned slug (D2)", async () => {
    const res = await app().fetch(postUrl("https://example.com/a?b=1"));
    const body = await linkBody(res);

    const rows = await db()`select slug, target_url from links`;
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe(body.slug);
    expect(rows[0].target_url).toBe("https://example.com/a?b=1");
  });

  test("two links to the same URL get different slugs", async () => {
    const a = await linkBody(await app().fetch(postUrl("https://example.com")));
    const b = await linkBody(await app().fetch(postUrl("https://example.com")));
    expect(a.slug).not.toBe(b.slug);
    expect(await linkCount()).toBe(2);
  });

  test("retries a colliding slug without touching the existing link", async () => {
    await db()`insert into links (slug, target_url) values ('Taken01', 'https://first.example')`;

    const res = await createApp(db(), { generateSlug: slugsFrom("Taken01", "Fresh02") }).fetch(
      postUrl("https://second.example"),
    );
    expect(res.status).toBe(201);
    expect((await linkBody(res)).slug).toBe("Fresh02");

    const rows = await db()`select slug, target_url from links order by id`;
    expect(rows.map((r: { slug: string; target_url: string }) => [r.slug, r.target_url])).toEqual([
      ["Taken01", "https://first.example"],
      ["Fresh02", "https://second.example"],
    ]);
  });

  test("never hands out a reserved slug", async () => {
    const res = await createApp(db(), {
      generateSlug: slugsFrom("healthz", "api", "Okay123"),
    }).fetch(postUrl("https://example.com"));
    expect((await linkBody(res)).slug).toBe("Okay123");

    const rows = await db()`select slug from links`;
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(["Okay123"]);

    // /healthz still reaches the health check, not a link.
    const health = await app().fetch(request("/healthz"));
    expect(await health.json()).toEqual({ ok: true, db: "up" });
  });

  const invalid: [string, string][] = [
    ["a non-JSON body", "url=https://example.com"],
    ["an empty body", ""],
    ["a JSON array", '["https://example.com"]'],
    ["JSON null", "null"],
    ["a missing url", "{}"],
    ["a non-string url", '{"url":42}'],
    ["an ftp:// url", '{"url":"ftp://x"}'],
    ["a url of 'not a url'", '{"url":"not a url"}'],
    ["a relative url", '{"url":"/a/b"}'],
    ["a url with no authority", '{"url":"http:example.com"}'],
    ["a javascript: url", '{"url":"javascript:alert(1)"}'],
  ];
  for (const [name, body] of invalid) {
    test(`rejects ${name} with 400 invalid_request and stores nothing`, async () => {
      const res = await app().fetch(post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
      expect(await linkCount()).toBe(0);
    });
  }
});

describeDb("GET /:slug", () => {
  beforeEach(resetWithKey);

  async function create(url: string, options = {}): Promise<string> {
    const res = await createApp(db(), options).fetch(postUrl(url));
    expect(res.status).toBe(201);
    return (await linkBody(res)).slug;
  }

  test("redirects 302 to the target byte-for-byte, query string included", async () => {
    const slug = await create("https://example.com/a?b=1");
    const res = await app().fetch(request(`/${slug}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/a?b=1");
  });

  test("does not normalise the target (no added trailing slash, case kept)", async () => {
    const slug = await create("https://Example.com");
    const res = await app().fetch(request(`/${slug}`));
    expect(res.headers.get("location")).toBe("https://Example.com");
  });

  test("redirects a non-ASCII target to its encoded form instead of failing", async () => {
    const slug = await create("https://例え.jp/ü?q=ö");
    const res = await app().fetch(request(`/${slug}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://xn--r8jz45g.jp/%C3%BC?q=%C3%B6");
  });

  test("slugs are case-sensitive", async () => {
    const slug = await create("https://example.com", { generateSlug: slugsFrom("AbCdEfG") });
    expect((await app().fetch(request(`/${slug}`))).status).toBe(302);

    const res = await app().fetch(request("/abcdefg"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("an unknown slug is 404 not_found", async () => {
    const res = await app().fetch(request("/doesNotExist"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("only GET follows a link", async () => {
    const slug = await create("https://example.com");
    const res = await app().fetch(request(`/${slug}`, { method: "POST" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

test("generated slugs are 7 characters from [A-Za-z0-9] and cover the alphabet", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const slug = generateSlug();
    expect(slug).toMatch(SLUG);
    for (const c of slug) seen.add(c);
  }
  // 14,000 draws from 62 characters: every one should appear.
  expect(seen.size).toBe(62);
});
