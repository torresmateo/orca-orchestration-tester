import { beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { app, createTestKey, db, describeDb, request, resetDb, withKey } from "./helpers";

// Every /api/* route that exists, plus paths no route handles. The guard is a
// prefix check (DESIGN D5), so the unknown paths must be refused exactly like
// the real ones. Add each new /api/* route here, with a body a valid caller
// would send and the status that caller gets.
type ApiRoute = { method: string; path: string; body?: string; okStatus: number };
const API_ROUTES: ApiRoute[] = [
  { method: "POST", path: "/api/links", body: '{"url":"https://example.com"}', okStatus: 201 },
  { method: "GET", path: "/api/links", okStatus: 200 },
  { method: "GET", path: "/api/links?limit=5", okStatus: 200 },
  // No link exists in this suite, so a valid caller gets not_found.
  { method: "GET", path: "/api/links/abc1234/stats", okStatus: 404 },
  { method: "GET", path: "/api/nope", okStatus: 404 },
  { method: "POST", path: "/api/nope", okStatus: 404 },
  { method: "GET", path: "/api", okStatus: 404 },
];

async function linkCount(): Promise<number> {
  const [row] = await db()`select count(*)::int as n from links`;
  return row.n;
}

// Independent of src/keys.ts, so the stored hash is checked against SHA-256
// itself rather than against the code under test.
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

describeDb("API key auth on /api/*", () => {
  let valid: string;
  let revoked: string;
  let revokedHash: string;

  beforeEach(async () => {
    await resetDb();
    valid = (await createTestKey("valid")).key;
    const r = await createTestKey("revoked");
    revoked = r.key;
    await db()`update api_keys set revoked_at = now() where id = ${r.id}`;
    [{ key_hash: revokedHash }] = await db()`select key_hash from api_keys where id = ${r.id}`;
  });

  const badAuth: Array<[label: string, header: () => string | undefined]> = [
    ["no header", () => undefined],
    ["empty bearer token", () => "Bearer "],
    ["bare Bearer scheme", () => "Bearer"],
    ["random key", () => `Bearer snip_${crypto.randomUUID()}`],
    ["revoked key", () => `Bearer ${revoked}`],
    ["the stored hash sent as the key", () => `Bearer ${revokedHash}`],
    ["Basic scheme", () => `Basic ${btoa("user:pass")}`],
    ["Basic scheme carrying a valid key", () => `Basic ${valid}`],
    ["valid key with trailing junk", () => `Bearer ${valid} extra`],
  ];

  for (const { method, path, body, okStatus } of API_ROUTES) {
    for (const [label, header] of badAuth) {
      // Sends the same well-formed body a valid caller would, so the 401 comes
      // from the key and nothing else. A refused request writes nothing.
      test(`${method} ${path} with ${label} is 401 unauthorized`, async () => {
        const h = header();
        const res = await app().fetch(
          request(path, { method, body, headers: h === undefined ? {} : { authorization: h } }),
        );
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
        expect(await linkCount()).toBe(0);
      });
    }

    test(`${method} ${path} with a valid key is ${okStatus}`, async () => {
      const res = await app().fetch(request(path, withKey(valid, { method, body })));
      expect(res.status).toBe(okStatus);
    });
  }

  test("the scheme name is case-insensitive", async () => {
    const res = await app().fetch(
      request("/api/nope", { headers: { authorization: `bearer ${valid}` } }),
    );
    expect(res.status).toBe(404);
  });

  test("the guard covers paths no route handles: /api/nope is 401 without a key, 404 with one", async () => {
    const without = await app().fetch(request("/api/nope"));
    expect(without.status).toBe(401);
    expect(await without.json()).toEqual({ error: "unauthorized" });

    const withValid = await app().fetch(request("/api/nope", withKey(valid)));
    expect(withValid.status).toBe(404);
    expect(await withValid.json()).toEqual({ error: "not_found" });
  });

  test("revoking a key that worked makes it 401", async () => {
    const { id, key } = await createTestKey("soon-revoked");
    expect((await app().fetch(request("/api/nope", withKey(key)))).status).toBe(404);
    await db()`update api_keys set revoked_at = now() where id = ${id}`;
    expect((await app().fetch(request("/api/nope", withKey(key)))).status).toBe(401);
  });

  test("GET /healthz is public, with no header or a bad one", async () => {
    for (const headers of [{}, { authorization: "Bearer nope" }] as Record<string, string>[]) {
      const res = await app().fetch(request("/healthz", { headers }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, db: "up" });
    }
  });

  test("GET /<slug> is public: a link created with a key redirects with no header", async () => {
    const created = await app().fetch(
      request(
        "/api/links",
        withKey(valid, { method: "POST", body: '{"url":"https://example.com/x"}' }),
      ),
    );
    expect(created.status).toBe(201);
    const { slug } = (await created.json()) as { slug: string };

    const res = await app().fetch(request(`/${slug}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/x");
  });

  test("GET /<slug> is public: an unknown slug is 404 with no header, never 401", async () => {
    for (const path of ["/abc1234", "/apix", "/API/nope"]) {
      const res = await app().fetch(request(path));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

describeDb("bun run keys:create", () => {
  beforeEach(resetDb);

  async function run(...args: string[]) {
    const proc = Bun.spawn(["bun", "run", "keys:create", ...args], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  test("prints a key once, stores only its SHA-256 hex, and the key authenticates", async () => {
    const { stdout, stderr, code } = await run("ci");
    expect(code).toBe(0);

    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const key = lines[0]!;
    expect(key).toMatch(/^snip_[A-Za-z0-9_-]{43}$/);
    expect(stderr).not.toContain(key);

    const rows = await db()`select name, key_hash, revoked_at from api_keys`;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("ci");
    expect(rows[0].key_hash).toBe(await sha256Hex(key));
    expect(rows[0].revoked_at).toBeNull();

    // No column of any application table holds the raw key.
    const tables = await db()`
      select tablename from pg_tables where schemaname = 'public'`;
    expect(tables.map((t: { tablename: string }) => t.tablename)).toContain("api_keys");
    for (const { tablename } of tables) {
      const all = await db().unsafe(`select * from "${tablename}"`);
      expect(JSON.stringify(all)).not.toContain(key);
    }

    const res = await app().fetch(request("/api/nope", withKey(key)));
    expect(res.status).toBe(404);
  });

  test("each run creates a different key", async () => {
    const a = await run("a");
    const b = await run("b");
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout.trim()).not.toBe(b.stdout.trim());
    const [{ count }] = await db()`select count(*)::int as count from api_keys`;
    expect(count).toBe(2);
  });

  test("without a name it exits non-zero and creates nothing", async () => {
    const { stdout, stderr, code } = await run();
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage: bun run keys:create <name>");
    const [{ count }] = await db()`select count(*)::int as count from api_keys`;
    expect(count).toBe(0);
  });
});
