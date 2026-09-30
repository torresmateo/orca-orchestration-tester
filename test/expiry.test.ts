import { beforeEach, expect, test } from "bun:test";
import { app, createTestKey, db, describeDb, request, resetDb, withKey } from "./helpers";

// Issue #5: optional expires_at on POST /api/links; 410 expired from GET /:slug
// once it has passed. Expiry is judged by the database clock, so these tests
// move expires_at in the database instead of sleeping.

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HOUR = 3_600_000;

type LinkBody = { slug: string; url: string; created_at: string; expires_at: string | null };
type Stats = { slug: string; total_clicks: number; last_clicked_at: string | null };

// /api/* needs a key (D5); GET /<slug> is public, so follows never send one.
let key: string;

async function resetWithKey(): Promise<void> {
  await resetDb();
  key = (await createTestKey()).key;
}

function post(body: unknown): Request {
  return request(
    "/api/links",
    withKey(key, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function create(body: Record<string, unknown>): Promise<LinkBody> {
  const res = await app().fetch(post({ url: "https://example.com/x", ...body }));
  expect(res.status).toBe(201);
  return (await res.json()) as LinkBody;
}

async function storedExpiry(slug: string): Promise<Date | null> {
  const [row] = await db()`select expires_at from links where slug = ${slug}`;
  return row.expires_at;
}

async function linkCount(): Promise<number> {
  const [row] = await db()`select count(*)::int as n from links`;
  return row.n;
}

async function clickCount(): Promise<number> {
  const [row] = await db()`select count(*)::int as n from clicks`;
  return row.n;
}

async function stats(slug: string): Promise<Stats> {
  const res = await app().fetch(request(`/api/links/${slug}/stats`, withKey(key)));
  expect(res.status).toBe(200);
  return (await res.json()) as Stats;
}

describeDb("POST /api/links with expires_at", () => {
  beforeEach(resetWithKey);

  test("stores a future expires_at and echoes it as ISO-8601 UTC with Z (D8)", async () => {
    const expiresAt = new Date(Date.now() + 24 * HOUR).toISOString();
    const body = await create({ expires_at: expiresAt });

    expect(body.expires_at).toMatch(ISO_UTC);
    expect(body.expires_at).toBe(expiresAt);
    expect((await storedExpiry(body.slug))?.toISOString()).toBe(expiresAt);
  });

  test("normalises an offset to the same instant in UTC", async () => {
    const body = await create({ expires_at: "2099-06-01T09:30:00+02:00" });
    expect(body.expires_at).toBe("2099-06-01T07:30:00.000Z");
    expect((await storedExpiry(body.slug))?.toISOString()).toBe("2099-06-01T07:30:00.000Z");

    const west = await create({ expires_at: "2099-06-01T09:30:00-05:45" });
    expect(west.expires_at).toBe("2099-06-01T15:15:00.000Z");
  });

  test("accepts fractional seconds and a leap day", async () => {
    expect((await create({ expires_at: "2099-01-01T00:00:00.5Z" })).expires_at).toBe(
      "2099-01-01T00:00:00.500Z",
    );
    expect((await create({ expires_at: "2099-01-01T00:00:00.123456Z" })).expires_at).toBe(
      "2099-01-01T00:00:00.123Z",
    );
    expect((await create({ expires_at: "2028-02-29T12:00:00Z" })).expires_at).toBe(
      "2028-02-29T12:00:00.000Z",
    );
  });

  test("without expires_at the response carries expires_at: null and nothing is stored", async () => {
    const body = await create({});
    expect(body).toHaveProperty("expires_at", null);
    expect(await storedExpiry(body.slug)).toBeNull();
  });

  test("an explicit null is the same as leaving it out: 201, null, never expires (D10)", async () => {
    const body = await create({ expires_at: null });
    expect(body).toHaveProperty("expires_at", null);
    expect(await storedExpiry(body.slug)).toBeNull();

    await db()`update links set created_at = now() - interval '100 years' where slug = ${body.slug}`;
    const res = await app().fetch(request(`/${body.slug}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/x");
  });

  test("rejects an expires_at already in the past with 400 and stores nothing", async () => {
    for (const expiresAt of [
      new Date(Date.now() - 1000).toISOString(),
      "2020-01-01T00:00:00Z",
      "0000-02-29T00:00:00Z",
    ]) {
      const res = await app().fetch(post({ url: "https://example.com", expires_at: expiresAt }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect(await linkCount()).toBe(0);
  });

  const invalid: [string, unknown][] = [
    ["a non-date string", "not a timestamp"],
    ["an empty string", ""],
    ["a number (epoch ms)", Date.now() + HOUR],
    ["a boolean", true],
    ["an object", { at: "2099-01-01T00:00:00Z" }],
    ["a date with no time", "2099-01-01"],
    ["a date-time with no offset", "2099-01-01T00:00:00"],
    ["a date-time with a space instead of T", "2099-01-01 00:00:00Z"],
    ["a non-ISO date Date.parse would accept", "March 7, 2099"],
    ["an RFC 2822 date", "Wed, 01 Jan 2099 00:00:00 GMT"],
    ["February 30th", "2099-02-30T00:00:00Z"],
    ["February 29th in a non-leap year", "2099-02-29T00:00:00Z"],
    ["month 13", "2099-13-01T00:00:00Z"],
    ["day 00", "2099-01-00T00:00:00Z"],
    ["hour 24", "2099-01-01T24:00:00Z"],
    ["second 60", "2099-01-01T00:00:60Z"],
    ["an offset of +24:00", "2099-01-01T00:00:00+24:00"],
    ["an offset without a colon", "2099-01-01T00:00:00+0200"],
  ];
  for (const [name, expiresAt] of invalid) {
    test(`rejects ${name} with 400 invalid_request and stores nothing`, async () => {
      const res = await app().fetch(post({ url: "https://example.com", expires_at: expiresAt }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
      expect(await linkCount()).toBe(0);
    });
  }

  test("a bad url is still rejected when expires_at is valid", async () => {
    const res = await app().fetch(post({ url: "ftp://x", expires_at: "2099-01-01T00:00:00Z" }));
    expect(res.status).toBe(400);
    expect(await linkCount()).toBe(0);
  });
});

describeDb("GET /:slug with expiry", () => {
  beforeEach(resetWithKey);

  test("a link whose expires_at is in the future redirects 302", async () => {
    const { slug } = await create({ expires_at: new Date(Date.now() + HOUR).toISOString() });
    const res = await app().fetch(request(`/${slug}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/x");
  });

  test("once expires_at has passed the link answers 410 expired, not a redirect", async () => {
    const { slug } = await create({ expires_at: new Date(Date.now() + HOUR).toISOString() });
    expect((await app().fetch(request(`/${slug}`))).status).toBe(302);

    await db()`update links set expires_at = now() - interval '1 second' where slug = ${slug}`;

    const res = await app().fetch(request(`/${slug}`));
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toEqual({ error: "expired" });
  });

  test("the database clock decides: one hour ahead is live, one hour behind is expired", async () => {
    const { slug } = await create({ expires_at: "2099-01-01T00:00:00Z" });

    await db()`update links set expires_at = now() + interval '1 hour' where slug = ${slug}`;
    expect((await app().fetch(request(`/${slug}`))).status).toBe(302);

    await db()`update links set expires_at = now() - interval '1 hour' where slug = ${slug}`;
    expect((await app().fetch(request(`/${slug}`))).status).toBe(410);
  });

  test("expiring one link leaves the others alone", async () => {
    const soon = await create({ expires_at: "2099-01-01T00:00:00Z" });
    const later = await create({ expires_at: "2099-01-01T00:00:00Z" });
    const never = await create({});

    await db()`update links set expires_at = now() - interval '1 second' where slug = ${soon.slug}`;

    expect((await app().fetch(request(`/${soon.slug}`))).status).toBe(410);
    expect((await app().fetch(request(`/${later.slug}`))).status).toBe(302);
    expect((await app().fetch(request(`/${never.slug}`))).status).toBe(302);
  });

  test("a link created without expires_at never expires, even when very old", async () => {
    const { slug } = await create({});
    await db()`update links set created_at = now() - interval '100 years' where slug = ${slug}`;

    const res = await app().fetch(request(`/${slug}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/x");
  });

  test("following an expired link records no click; stats keep only the earlier clicks (C3)", async () => {
    const { slug } = await create({ expires_at: "2099-01-01T00:00:00Z" });
    for (let i = 0; i < 2; i++) expect((await app().fetch(request(`/${slug}`))).status).toBe(302);
    expect(await clickCount()).toBe(2);
    const before = await stats(slug);
    expect(before.total_clicks).toBe(2);
    expect(before.last_clicked_at).not.toBeNull();

    await db()`update links set expires_at = now() - interval '1 second' where slug = ${slug}`;

    for (let i = 0; i < 3; i++) {
      const res = await app().fetch(request(`/${slug}`));
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "expired" });
    }
    expect(await clickCount()).toBe(2);
    const rows = await db()`select l.slug from clicks c join links l on l.id = c.link_id`;
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual([slug, slug]);
    expect(await stats(slug)).toEqual({
      slug,
      total_clicks: 2,
      last_clicked_at: before.last_clicked_at,
    });
  });

  test("an unknown slug is still 404, not 410", async () => {
    const res = await app().fetch(request("/doesNotExist"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
