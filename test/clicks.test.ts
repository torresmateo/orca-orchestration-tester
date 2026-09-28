import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { app, db, describeDb, request, resetDb } from "./helpers";

type Stats = { slug: string; total_clicks: number; last_clicked_at: string | null };

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function create(url = "https://example.com"): Promise<string> {
  const res = await app().fetch(
    new Request("http://snip.test/api/links", { method: "POST", body: JSON.stringify({ url }) }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { slug: string }).slug;
}

async function follow(slug: string): Promise<Response> {
  return app().fetch(request(`/${slug}`));
}

async function stats(slug: string): Promise<Response> {
  return app().fetch(request(`/api/links/${slug}/stats`));
}

async function clickCount(): Promise<number> {
  const [row] = await db()`select count(*)::int as n from clicks`;
  return row.n;
}

describeDb("click recording", () => {
  beforeEach(resetDb);

  test("following a link 5 times reads back total_clicks 5", async () => {
    const slug = await create();
    const before = Date.now();
    for (let i = 0; i < 5; i++) {
      const res = await follow(slug);
      expect(res.status).toBe(302);
    }

    const res = await stats(slug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Stats;
    expect(Object.keys(body).sort()).toEqual(["last_clicked_at", "slug", "total_clicks"]);
    expect(body.slug).toBe(slug);
    expect(body.total_clicks).toBe(5);
    // D8: ISO-8601 UTC, and a real recent time rather than an epoch or default.
    expect(body.last_clicked_at).toMatch(ISO_UTC);
    expect(Math.abs(Date.parse(body.last_clicked_at!) - before)).toBeLessThan(60_000);

    // The rows exist and belong to this link, not just a count that happens to match.
    const rows = await db()`
      select l.slug from clicks c join links l on l.id = c.link_id`;
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual([slug, slug, slug, slug, slug]);
  });

  test("a link never followed is 200 with zero clicks and a null last_clicked_at", async () => {
    const slug = await create();
    const res = await stats(slug);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug, total_clicks: 0, last_clicked_at: null });
  });

  test("stats for an unknown slug are 404 not_found", async () => {
    const res = await stats("doesNotExist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("stats count only the requested link's clicks", async () => {
    const a = await create("https://a.example");
    const b = await create("https://b.example");
    for (let i = 0; i < 3; i++) await follow(a);
    await follow(b);

    expect(((await (await stats(a)).json()) as Stats).total_clicks).toBe(3);
    expect(((await (await stats(b)).json()) as Stats).total_clicks).toBe(1);
  });

  test("last_clicked_at is the latest click, in UTC", async () => {
    const slug = await create();
    // Straddle midnight UTC, inserted out of order, with a non-UTC offset on input.
    await db()`
      insert into clicks (link_id, clicked_at)
      select id, t::timestamptz from links,
        unnest(array[
          '2026-03-01T23:59:59.500Z',
          '2026-03-02T01:30:00.250+02:00',
          '2026-03-01T12:00:00.000Z'
        ]) as t
      where slug = ${slug}`;

    expect(await (await stats(slug)).json()).toEqual({
      slug,
      total_clicks: 3,
      last_clicked_at: "2026-03-01T23:59:59.500Z",
    });
  });

  test("an unknown slug records nothing", async () => {
    const slug = await create();
    await follow(slug);
    expect(await clickCount()).toBe(1);

    const res = await follow("doesNotExist");
    expect(res.status).toBe(404);
    expect(await clickCount()).toBe(1);
  });

  test("only a GET that redirects records a click", async () => {
    const slug = await create();
    expect((await app().fetch(request(`/${slug}`, { method: "POST" }))).status).toBe(404);
    expect(await clickCount()).toBe(0);
  });

  test("deleting a link deletes its clicks", async () => {
    const slug = await create();
    await follow(slug);
    await db()`delete from links where slug = ${slug}`;
    expect(await clickCount()).toBe(0);
  });
});

describeDb("click recording failure (D4)", () => {
  beforeEach(resetDb);

  // The test hides the clicks table; put it back even if an assertion fails,
  // or every later suite in this database breaks.
  afterEach(async () => {
    await db().unsafe(`
      do $$ begin
        if to_regclass('clicks_hidden') is not null then
          alter table clicks_hidden rename to clicks;
        end if;
      end $$`);
  });

  test("the redirect still returns 302 and the failure is logged to stderr", async () => {
    const slug = await create("https://example.com/a?b=1");
    // Prove the recorder works first, so the failure below is the table, not the code.
    expect((await follow(slug)).status).toBe(302);
    expect(await clickCount()).toBe(1);

    await db()`alter table clicks rename to clicks_hidden`;
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await follow(slug);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://example.com/a?b=1");
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]![0])).toContain(`click not recorded for /${slug}`);
      expect(String(stderr.mock.calls[0]![1])).toContain("clicks");
    } finally {
      stderr.mockRestore();
    }

    await db()`alter table clicks_hidden rename to clicks`;
    expect(await clickCount()).toBe(1);

    // Once the table is back, recording resumes.
    expect((await follow(slug)).status).toBe(302);
    expect(await clickCount()).toBe(2);
  });
});
