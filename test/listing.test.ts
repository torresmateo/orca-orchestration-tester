import { beforeEach, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { app, createTestKey, db, describeDb, request, resetDb, withKey } from "./helpers";

// Owner-scoped listing (issue #6). Every link made through POST /api/links
// belongs to the key that made it; GET /api/links shows a key only its own.

type LinkBody = { slug: string; url: string; short_url: string; created_at: string };
type Page = { links: LinkBody[]; next_cursor: string | null };

async function createLink(key: string, url: string): Promise<LinkBody> {
  const res = await app().fetch(
    request("/api/links", withKey(key, { method: "POST", body: JSON.stringify({ url }) })),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as LinkBody;
}

// Creates n links in order and returns their slugs, oldest first.
async function createLinks(key: string, n: number, tag = "l"): Promise<string[]> {
  const slugs: string[] = [];
  for (let i = 0; i < n; i++) slugs.push((await createLink(key, `https://example.com/${tag}/${i}`)).slug);
  return slugs;
}

async function list(key: string, query = ""): Promise<Response> {
  return app().fetch(request(`/api/links${query}`, withKey(key)));
}

async function page(key: string, query = ""): Promise<Page> {
  const res = await list(key, query);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

// Follows next_cursor from the first page to the end. Returns every page.
async function walk(key: string, limit?: number): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor !== null) params.set("cursor", cursor);
    const qs = params.size ? `?${params}` : "";
    const p = await page(key, qs);
    pages.push(p);
    cursor = p.next_cursor;
    if (pages.length > 100) throw new Error("next_cursor never became null");
  } while (cursor !== null);
  return pages;
}

function slugsOf(pages: Page[]): string[] {
  return pages.flatMap((p) => p.links.map((l) => l.slug));
}

describeDb("GET /api/links", () => {
  let key: string;
  let keyId: string;

  beforeEach(async () => {
    await resetDb();
    ({ id: keyId, key } = await createTestKey("a"));
  });

  test("POST /api/links records the calling key as the owner", async () => {
    const { slug } = await createLink(key, "https://example.com");
    const rows = await db()`select slug, api_key_id from links`;
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe(slug);
    expect(String(rows[0].api_key_id)).toBe(keyId);
  });

  test("a key with no links gets an empty page and a null cursor", async () => {
    expect(await page(key)).toEqual({ links: [], next_cursor: null });
  });

  test("each item is exactly what POST /api/links returned for it", async () => {
    const created = await createLink(key, "https://example.com/a?b=1");
    const { links, next_cursor } = await page(key);
    expect(links).toEqual([created]);
    expect(Object.keys(links[0]!).sort()).toEqual(["created_at", "short_url", "slug", "url"]);
    expect(next_cursor).toBeNull();
  });

  test("short_url uses the request's origin, as in POST", async () => {
    const { slug } = await createLink(key, "https://example.com");
    const res = await app().fetch(new Request("https://sn.ip:8443/api/links", withKey(key)));
    const body = (await res.json()) as Page;
    expect(body.links[0]!.short_url).toBe(`https://sn.ip:8443/${slug}`);
  });

  test("the default page size is 20", async () => {
    const slugs = await createLinks(key, 25);
    const first = await page(key);
    expect(first.links).toHaveLength(20);
    expect(first.links.map((l) => l.slug)).toEqual(slugs.slice(5).reverse());
    expect(first.next_cursor).toEqual(expect.any(String));
  });

  test("25 links: walking next_cursor sees each exactly once, newest first, ending on null", async () => {
    const slugs = await createLinks(key, 25);
    const newestFirst = [...slugs].reverse();

    for (const [limit, sizes] of [
      [undefined, [20, 5]],
      [7, [7, 7, 7, 4]],
      [5, [5, 5, 5, 5, 5]], // an exact multiple ends without an empty trailing page
      [1, Array(25).fill(1)],
      [100, [25]],
    ] as [number | undefined, number[]][]) {
      const pages = await walk(key, limit);
      expect(pages.map((p) => p.links.length)).toEqual(sizes);
      expect(slugsOf(pages)).toEqual(newestFirst);
      expect(pages.at(-1)!.next_cursor).toBeNull();
      for (const p of pages.slice(0, -1)) expect(p.next_cursor).toEqual(expect.any(String));
    }
  });

  test("the cursor is stable under inserts made while paging", async () => {
    const original = await createLinks(key, 25);
    const first = await page(key, "?limit=10");
    expect(first.links.map((l) => l.slug)).toEqual(original.slice(15).reverse());

    // Links created mid-walk are newer than the cursor: they must not push
    // an already-seen link onto a later page or be returned by it.
    const added = await createLinks(key, 5, "added");

    const rest: Page[] = [];
    let cursor = first.next_cursor;
    while (cursor !== null) {
      const p = await page(key, `?limit=10&cursor=${cursor}`);
      rest.push(p);
      cursor = p.next_cursor;
    }
    expect(slugsOf(rest)).toEqual(original.slice(0, 15).reverse());
    expect(slugsOf(rest).some((s) => added.includes(s))).toBe(false);

    // A fresh walk sees the new links first.
    expect(slugsOf(await walk(key)).slice(0, 5)).toEqual([...added].reverse());
  });

  test("links created in the same microsecond, or one microsecond apart, are each listed once", async () => {
    // A JS Date holds milliseconds, so a cursor built from one would skip or
    // repeat these. Ties on created_at fall back to the slug.
    await db()`
      insert into links (slug, target_url, created_at, api_key_id) values
        ('tieA', 'https://example.com/1', '2026-01-01T00:00:00.000001Z', ${keyId}),
        ('tieB', 'https://example.com/2', '2026-01-01T00:00:00.000001Z', ${keyId}),
        ('tieC', 'https://example.com/3', '2026-01-01T00:00:00.000001Z', ${keyId}),
        ('usA', 'https://example.com/4', '2026-01-01T00:00:00.000002Z', ${keyId}),
        ('usB', 'https://example.com/5', '2026-01-01T00:00:00.000003Z', ${keyId})`;
    const slugs = slugsOf(await walk(key, 1));
    expect(slugs).toEqual(["usB", "usA", "tieC", "tieB", "tieA"]);
  });

  for (const bad of ["0", "101", "-1", "1.5", "abc", "", " 5", "1e2", "0x10", "1000"]) {
    test(`?limit=${JSON.stringify(bad)} is 400 invalid_request`, async () => {
      await createLinks(key, 1);
      const res = await list(key, `?limit=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    });
  }

  test("?limit=1 and ?limit=100 are accepted", async () => {
    await createLinks(key, 2);
    expect((await page(key, "?limit=1")).links).toHaveLength(1);
    expect((await page(key, "?limit=100")).links).toHaveLength(2);
  });

  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const badCursors: [string, string][] = [
    ["empty", ""],
    ["the string null", "null"],
    ["not base64url", "!!!"],
    ["base64 of non-JSON", Buffer.from("nope").toString("base64url")],
    ["a JSON object", b64({ createdAt: "2026-01-01T00:00:00.000000Z", slug: "abc" })],
    ["a millisecond timestamp", b64(["2026-01-01T00:00:00.000Z", "abc"])],
    ["an impossible date", b64(["2026-02-30T00:00:00.000000Z", "abc"])],
    ["an empty slug", b64(["2026-01-01T00:00:00.000000Z", ""])],
    ["a non-string slug", b64(["2026-01-01T00:00:00.000000Z", 7])],
  ];
  for (const [label, cursor] of badCursors) {
    test(`a cursor that is ${label} is 400 invalid_request`, async () => {
      await createLinks(key, 1);
      const res = await list(key, `?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    });
  }
});

describeDb("ownership between keys (D7)", () => {
  let a: string;
  let b: string;

  beforeEach(async () => {
    await resetDb();
    a = (await createTestKey("a")).key;
    b = (await createTestKey("b")).key;
  });

  test("each key lists only its own links, on every page", async () => {
    const aSlugs = await createLinks(a, 23, "a");
    const bSlugs = await createLinks(b, 4, "b");

    const bSeen = slugsOf(await walk(b, 3));
    expect(bSeen).toEqual([...bSlugs].reverse());
    expect(bSeen.some((s) => aSlugs.includes(s))).toBe(false);

    const aSeen = slugsOf(await walk(a));
    expect(aSeen).toEqual([...aSlugs].reverse());
    expect(aSeen.some((s) => bSlugs.includes(s))).toBe(false);
  });

  test("a cursor from A's listing, replayed by B, still shows B only B's links", async () => {
    await createLinks(a, 3, "a");
    const bSlugs = await createLinks(b, 3, "b");
    const aCursor = (await page(a, "?limit=1")).next_cursor!;
    const bPage = await page(b, `?cursor=${aCursor}`);
    expect(bPage.links.every((l) => bSlugs.includes(l.slug))).toBe(true);
  });

  test("B gets 404 not_found, never 403, on /api/links/:slug paths for A's link", async () => {
    const { slug } = await createLink(a, "https://example.com");
    // Clicks first, so a 404 can only come from the owner check, not a
    // missing link or an empty stats row.
    for (let i = 0; i < 2; i++) expect((await app().fetch(request(`/${slug}`))).status).toBe(302);
    for (const path of [`/api/links/${slug}`, `/api/links/${slug}/stats`]) {
      const res = await app().fetch(request(path, withKey(b)));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  test("A's stats for A's link are 200, and B's for B's link", async () => {
    const aLink = await createLink(a, "https://example.com/a");
    const bLink = await createLink(b, "https://example.com/b");
    for (let i = 0; i < 3; i++) await app().fetch(request(`/${aLink.slug}`));
    await app().fetch(request(`/${bLink.slug}`));

    for (const [k, slug, clicks] of [
      [a, aLink.slug, 3],
      [b, bLink.slug, 1],
    ] as const) {
      const res = await app().fetch(request(`/api/links/${slug}/stats`, withKey(k)));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { slug: string; total_clicks: number };
      expect(body.slug).toBe(slug);
      expect(body.total_clicks).toBe(clicks);
    }
  });

  test("B asking for A's stats looks exactly like asking for a slug that does not exist", async () => {
    const { slug } = await createLink(a, "https://example.com");
    const theirs = await app().fetch(request(`/api/links/${slug}/stats`, withKey(b)));
    const unknown = await app().fetch(request("/api/links/Nope123/stats", withKey(b)));
    expect(theirs.status).toBe(unknown.status);
    expect(await theirs.text()).toBe(await unknown.text());
    expect(theirs.headers.get("content-type")).toBe(unknown.headers.get("content-type"));
  });

  test("a custom-slug link belongs to its creator like a generated one", async () => {
    const res = await app().fetch(
      request(
        "/api/links",
        withKey(a, { method: "POST", body: JSON.stringify({ url: "https://example.com/c", slug: "mine-A" }) }),
      ),
    );
    expect(res.status).toBe(201);
    expect(slugsOf(await walk(a))).toEqual(["mine-A"]);
    expect(await page(b)).toEqual({ links: [], next_cursor: null });
    expect((await app().fetch(request("/api/links/mine-A/stats", withKey(a)))).status).toBe(200);
    const theirs = await app().fetch(request("/api/links/mine-A/stats", withKey(b)));
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: "not_found" });
  });

  test("GET /<slug> redirects publicly whoever owns the link", async () => {
    const aLink = await createLink(a, "https://example.com/a");
    const bLink = await createLink(b, "https://example.com/b");
    for (const [slug, target] of [
      [aLink.slug, "https://example.com/a"],
      [bLink.slug, "https://example.com/b"],
    ] as const) {
      for (const init of [{}, withKey(a), withKey(b)]) {
        const res = await app().fetch(request(`/${slug}`, init));
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(target);
      }
    }
  });
});

describeDb("links with no owner (created before links.api_key_id)", () => {
  let key: string;

  beforeEach(async () => {
    await resetDb();
    key = (await createTestKey()).key;
    await db()`insert into links (slug, target_url) values ('Legacy1', 'https://legacy.example/x')`;
  });

  test("still redirect, with or without a key", async () => {
    for (const init of [{}, withKey(key)]) {
      const res = await app().fetch(request("/Legacy1", init));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://legacy.example/x");
    }
  });

  test("appear in no key's listing", async () => {
    const own = await createLink(key, "https://example.com");
    expect(slugsOf(await walk(key))).toEqual([own.slug]);
    const other = (await createTestKey("other")).key;
    expect(await page(other)).toEqual({ links: [], next_cursor: null });
  });

  test("are 404 not_found for every key on /api/links/:slug paths (D12)", async () => {
    const other = (await createTestKey("other")).key;
    // Followed first, so the stats 404 is not an empty-link artefact.
    expect((await app().fetch(request("/Legacy1"))).status).toBe(302);
    for (const k of [key, other]) {
      for (const path of ["/api/links/Legacy1", "/api/links/Legacy1/stats"]) {
        const res = await app().fetch(request(path, withKey(k)));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    }
  });
});

// D12: revoking a key blocks it everywhere under /api (D5 unchanged). Its
// links stay stored and keep redirecting, and no other key sees them.
describeDb("links of a revoked key", () => {
  let revokedId: string;
  let revoked: string;
  let other: string;
  let slugs: string[];

  beforeEach(async () => {
    await resetDb();
    ({ id: revokedId, key: revoked } = await createTestKey("soon-revoked"));
    other = (await createTestKey("other")).key;
    slugs = await createLinks(revoked, 3, "r");
    expect(slugsOf(await walk(revoked))).toEqual([...slugs].reverse());
    await db()`update api_keys set revoked_at = now() where id = ${revokedId}`;
  });

  test("the revoked key gets 401 on GET /api/links, with or without a cursor", async () => {
    const cursor = encodeURIComponent(
      Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000000Z", slugs[0]])).toString("base64url"),
    );
    for (const qs of ["", "?limit=1", `?cursor=${cursor}`]) {
      const res = await list(revoked, qs);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("its links stay stored and keep redirecting", async () => {
    const [{ n }] = await db()`
      select count(*)::int as n from links where api_key_id = ${revokedId}`;
    expect(n).toBe(3);
    for (const [i, slug] of slugs.entries()) {
      const res = await app().fetch(request(`/${slug}`));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`https://example.com/r/${i}`);
    }
  });

  test("another key never sees them: absent from its listing, 404 on per-link paths", async () => {
    const own = await createLink(other, "https://example.com/other");
    expect(slugsOf(await walk(other))).toEqual([own.slug]);
    for (const slug of slugs) {
      for (const path of [`/api/links/${slug}`, `/api/links/${slug}/stats`]) {
        const res = await app().fetch(request(path, withKey(other)));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    }
  });
});

describeDb("the links.api_key_id migration", () => {
  const MIGRATIONS = join(import.meta.dir, "..", "migrations");
  const OWNER_MIGRATION = "20260929011849_add_links_api_key_id.sql";

  test("adds a foreign key from links.api_key_id to api_keys(id)", async () => {
    const [col] = await db()`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'links' and column_name = 'api_key_id'`;
    expect(col.is_nullable).toBe("YES");
    const fks = await db()`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.links'::regclass and contype = 'f'`;
    expect(fks.map((r: { def: string }) => r.def)).toContain(
      "FOREIGN KEY (api_key_id) REFERENCES api_keys(id)",
    );
  });

  test("applied to a database that already has links, keeps them and their redirect target", async () => {
    // Replays the real migration files into a scratch schema: everything
    // before this migration, then a link, then this migration. Rolled back.
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain(OWNER_MIGRATION);
    const before = files.slice(0, files.indexOf(OWNER_MIGRATION));
    const rollback = new Error("rollback");

    let rows: { slug: string; target_url: string; api_key_id: unknown }[] = [];
    await db()
      .begin(async (tx) => {
        await tx.unsafe("create schema upgrade_check; set local search_path to upgrade_check");
        for (const f of before) await tx.unsafe(await Bun.file(join(MIGRATIONS, f)).text());
        await tx`insert into links (slug, target_url) values ('Old0001', 'https://old.example')`;
        await tx.unsafe(await Bun.file(join(MIGRATIONS, OWNER_MIGRATION)).text());
        rows = await tx`select slug, target_url, api_key_id from links`;
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });

    expect(rows).toEqual([{ slug: "Old0001", target_url: "https://old.example", api_key_id: null }]);
  });
});
