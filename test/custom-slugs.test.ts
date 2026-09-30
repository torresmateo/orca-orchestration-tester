import { beforeEach, expect, test } from "bun:test";
import { app, createTestKey, db, describeDb, request, resetDb, withKey } from "./helpers";

// /api/* requires a key (D5). Each test empties the database and creates a
// fresh key, so no test relies on another's key.
let key: string;

async function resetWithKey(): Promise<void> {
  await resetDb();
  key = (await createTestKey()).key;
}

function post(body: unknown, authed = true): Request {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  return new Request("http://snip.test/api/links", authed ? withKey(key, init) : init);
}

type LinkBody = {
  slug: string;
  url: string;
  short_url: string;
  created_at: string;
  expires_at: string | null;
};

async function create(body: unknown, authed = true): Promise<Response> {
  return app().fetch(post(body, authed));
}

async function storedLinks(): Promise<[string, string][]> {
  const rows = await db()`select slug, target_url from links order by id`;
  return rows.map((r: { slug: string; target_url: string }) => [r.slug, r.target_url]);
}

describeDb("POST /api/links with a custom slug", () => {
  beforeEach(resetWithKey);

  test("stores and returns the slug as given, and it redirects", async () => {
    const res = await create({ url: "https://example.com", slug: "my-Link_1" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as LinkBody;
    expect(Object.keys(body).sort()).toEqual([
      "created_at",
      "expires_at",
      "short_url",
      "slug",
      "url",
    ]);
    expect(body.slug).toBe("my-Link_1");
    expect(body.url).toBe("https://example.com");
    expect(body.short_url).toBe("http://snip.test/my-Link_1");
    expect(await storedLinks()).toEqual([["my-Link_1", "https://example.com"]]);

    const redirect = await app().fetch(request("/my-Link_1"));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://example.com");
  });

  test("accepts the length bounds, 3 and 32 characters", async () => {
    for (const slug of ["abc", "a".repeat(32)]) {
      const res = await create({ url: "https://example.com", slug });
      expect(res.status).toBe(201);
      expect(((await res.json()) as LinkBody).slug).toBe(slug);
    }
  });

  test("a taken slug is 409 slug_taken and the first link is untouched", async () => {
    const first = await create({ url: "https://first.example", slug: "my-Link_1" });
    expect(first.status).toBe(201);

    const second = await create({ url: "https://second.example", slug: "my-Link_1" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "slug_taken" });

    expect(await storedLinks()).toEqual([["my-Link_1", "https://first.example"]]);
    const redirect = await app().fetch(request("/my-Link_1"));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://first.example");
  });

  test("a custom slug that equals an existing generated slug is 409", async () => {
    const generated = (await (await create({ url: "https://first.example" })).json()) as LinkBody;

    const res = await create({ url: "https://second.example", slug: generated.slug });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "slug_taken" });
    expect(await storedLinks()).toEqual([[generated.slug, "https://first.example"]]);
  });

  test("slugs differing only in case are distinct links (D2)", async () => {
    const lower = await create({ url: "https://lower.example", slug: "my-link_1" });
    const mixed = await create({ url: "https://mixed.example", slug: "my-Link_1" });
    expect(lower.status).toBe(201);
    expect(mixed.status).toBe(201);
    expect(((await lower.json()) as LinkBody).slug).toBe("my-link_1");
    expect(((await mixed.json()) as LinkBody).slug).toBe("my-Link_1");

    const a = await app().fetch(request("/my-link_1"));
    const b = await app().fetch(request("/my-Link_1"));
    expect(a.headers.get("location")).toBe("https://lower.example");
    expect(b.headers.get("location")).toBe("https://mixed.example");
  });

  for (const n of [2, 8]) {
    test(`${n} concurrent creates of one slug: exactly one 201, the rest 409`, async () => {
      // No pre-check exists, so only the unique constraint can decide the race.
      const responses = await Promise.all(
        Array.from({ length: n }, (_, i) => create({ url: `https://race${i}.example`, slug: "raced" })),
      );
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, ...Array<number>(n - 1).fill(409)]);

      const winner = responses.find((r) => r.status === 201)!;
      const winnerUrl = ((await winner.json()) as LinkBody).url;
      for (const r of responses.filter((r) => r.status === 409)) {
        expect(await r.json()).toEqual({ error: "slug_taken" });
      }
      expect(await storedLinks()).toEqual([["raced", winnerUrl]]);
    });
  }

  test("an explicit null slug generates one, as if omitted (D10)", async () => {
    const res = await create({ url: "https://example.com", slug: null });
    expect(res.status).toBe(201);
    const body = (await res.json()) as LinkBody;
    expect(body.slug).toMatch(/^[A-Za-z0-9]{7}$/);
    expect(await storedLinks()).toEqual([[body.slug, "https://example.com"]]);
  });

  const invalid: [string, unknown][] = [
    ["too short (ab)", "ab"],
    ["33 characters", "a".repeat(33)],
    ["a space (has space)", "has space"],
    ["non-ASCII (émoji)", "émoji"],
    ["an actual emoji", "abc😀"],
    ["the reserved word api", "api"],
    ["the reserved word healthz", "healthz"],
    ["a slash", "a/b/c"],
    ["a dot", "a.b.c"],
    ["leading whitespace (not trimmed)", " abc"],
    ["trailing newline (not trimmed)", "abc\n"],
    ["an empty string", ""],
    ["a number", 42],
    ["a boolean", true],
    ["an object", { slug: "abc" }],
    ["an array", ["abc"]],
  ];
  for (const [name, slug] of invalid) {
    test(`rejects a slug that is ${name} with 400 invalid_request and stores nothing`, async () => {
      const res = await create({ url: "https://example.com", slug });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
      expect(await storedLinks()).toEqual([]);
    });
  }

  test("a valid slug with an invalid url is still 400 and stores nothing", async () => {
    const res = await create({ url: "ftp://x", slug: "good-slug" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(await storedLinks()).toEqual([]);
  });

  test("/healthz and /api stay reserved after rejected attempts to claim them", async () => {
    await create({ url: "https://example.com", slug: "healthz" });
    await create({ url: "https://example.com", slug: "api" });
    const health = await app().fetch(request("/healthz"));
    expect(await health.json()).toEqual({ ok: true, db: "up" });
    expect((await app().fetch(request("/api", withKey(key)))).status).toBe(404);
  });

  test("without a key, a custom slug is 401, stores nothing, and stays free", async () => {
    const res = await create({ url: "https://example.com", slug: "my-Link_1" }, false);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await storedLinks()).toEqual([]);
    expect((await app().fetch(request("/my-Link_1"))).status).toBe(404);

    const retry = await create({ url: "https://example.com", slug: "my-Link_1" });
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as LinkBody).slug).toBe("my-Link_1");
  });
});
