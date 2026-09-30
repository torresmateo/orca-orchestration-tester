import { afterAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createApp, type App } from "../src/app";
import { app, createTestKey, db, describeDb, request, resetDb, withKey } from "./helpers";

type Day = { date: string; clicks: number };
type Stats = { slug: string; total_clicks: number; last_clicked_at: string | null };
type DailyStats = Stats & { days: Day[] };

const DAY_MS = 86_400_000;

// /api/* needs a key (D5); GET /<slug> does not.
let key: string;

async function resetWithKey(): Promise<void> {
  await resetDb();
  key = (await createTestKey()).key;
}

async function create(url = "https://example.com"): Promise<string> {
  const res = await app().fetch(
    request("/api/links", withKey(key, { method: "POST", body: JSON.stringify({ url }) })),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { slug: string }).slug;
}

async function follow(slug: string): Promise<void> {
  expect((await app().fetch(request(`/${slug}`))).status).toBe(302);
}

async function dailyStats(slug: string, via: App = app()): Promise<DailyStats> {
  const res = await via.fetch(request(`/api/links/${slug}/stats?by=day`, withKey(key)));
  expect(res.status).toBe(200);
  return (await res.json()) as DailyStats;
}

async function setCreatedAt(slug: string, iso: string): Promise<void> {
  await db()`update links set created_at = ${iso}::timestamptz where slug = ${slug}`;
}

async function insertClicks(slug: string, isos: string[]): Promise<void> {
  for (const iso of isos) {
    await db()`
      insert into clicks (link_id, clicked_at)
      select id, ${iso}::timestamptz from links where slug = ${slug}`;
  }
}

// UTC calendar dates, computed in JS so the expectations do not share the
// handler's SQL.
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function todayUtc(): string {
  return utcDate(Date.now());
}

function daysAgo(n: number): string {
  return utcDate(Date.now() - n * DAY_MS);
}

function addDays(date: string, n: number): string {
  return utcDate(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS);
}

// Every UTC date from `first` to today inclusive.
function datesFrom(first: string): string[] {
  const dates: string[] = [];
  for (let d = first; d <= todayUtc(); d = addDays(d, 1)) dates.push(d);
  return dates;
}

function sum(days: Day[]): number {
  return days.reduce((n, d) => n + d.clicks, 0);
}

// A one-connection client whose session time zone is `tz`, and an app that
// queries through it. SET TIME ZONE is per connection, so a pool of one keeps
// the setting on every query the handler makes; nothing global changes.
const tzClients: SQL[] = [];

async function appInTimeZone(tz: string): Promise<{ app: App; client: SQL }> {
  const client = new SQL({ url: process.env.DATABASE_URL!, max: 1 });
  tzClients.push(client);
  await client.unsafe(`set time zone '${tz}'`);
  return { app: createApp(client), client };
}

async function sessionTimeZone(client: SQL): Promise<string> {
  const [row] = await client`select current_setting('TimeZone') as tz`;
  return row.tz;
}

afterAll(async () => {
  await Promise.all(tzClients.map((c) => c.close()));
});

describeDb("daily stats (?by=day)", () => {
  beforeEach(resetWithKey);

  for (const tz of ["UTC", "America/Los_Angeles"]) {
    test(`clicks either side of midnight UTC land on their own UTC day (session time zone ${tz})`, async () => {
      const { app: tzApp, client } = await appInTimeZone(tz);
      const slug = await create();
      const d = daysAgo(5);
      // 00:30Z on D is still D-1 in Los Angeles, so a session-zone bucket puts
      // the first day a day early.
      await setCreatedAt(slug, `${d}T00:30:00Z`);
      await insertClicks(slug, [
        `${d}T23:59:59Z`,
        `${addDays(d, 1)}T00:00:01Z`,
        `${addDays(d, 3)}T12:00:00Z`,
        `${addDays(d, 3)}T12:00:00.500Z`,
      ]);
      await follow(slug); // a real click today, through the redirect

      const body = await dailyStats(slug, tzApp);
      // The request really ran in the zone under test.
      expect(await sessionTimeZone(client)).toBe(tz);

      expect(body.days).toEqual([
        { date: d, clicks: 1 },
        { date: addDays(d, 1), clicks: 1 },
        { date: addDays(d, 2), clicks: 0 },
        { date: addDays(d, 3), clicks: 2 },
        { date: addDays(d, 4), clicks: 0 },
        { date: todayUtc(), clicks: 1 },
      ]);
      expect(body.total_clicks).toBe(5);
      expect(sum(body.days)).toBe(body.total_clicks);
    });

    test(`the array runs from the creation day to today with no gaps or duplicates (session time zone ${tz})`, async () => {
      const { app: tzApp } = await appInTimeZone(tz);
      const slug = await create();
      // 250 days back always spans at least one US daylight-saving change.
      const created = daysAgo(250);
      await setCreatedAt(slug, `${created}T03:00:00Z`);
      await insertClicks(slug, [
        `${created}T03:00:01Z`,
        `${daysAgo(200)}T07:59:59Z`,
        `${daysAgo(100)}T08:00:00Z`,
        `${daysAgo(1)}T23:59:59.999Z`,
      ]);

      const body = await dailyStats(slug, tzApp);
      const dates = body.days.map((day) => day.date);
      expect(dates).toEqual(datesFrom(created));
      expect(dates.length).toBe(251);
      expect(new Set(dates).size).toBe(dates.length);
      expect(body.days.filter((day) => day.clicks > 0)).toEqual([
        { date: created, clicks: 1 },
        { date: daysAgo(200), clicks: 1 },
        { date: daysAgo(100), clicks: 1 },
        { date: daysAgo(1), clicks: 1 },
      ]);
      expect(body.days.filter((day) => day.clicks === 0).length).toBe(247);
      expect(sum(body.days)).toBe(4);
      expect(body.total_clicks).toBe(4);
    });
  }

  test("a link created today with no clicks has one zero day, not an empty array", async () => {
    const slug = await create();
    expect(await dailyStats(slug)).toEqual({
      slug,
      total_clicks: 0,
      last_clicked_at: null,
      days: [{ date: todayUtc(), clicks: 0 }],
    });
  });

  test("followed N times over HTTP, today's bucket and the total both read N", async () => {
    const slug = await create();
    for (let i = 0; i < 4; i++) await follow(slug);

    const body = await dailyStats(slug);
    expect(body.days).toEqual([{ date: todayUtc(), clicks: 4 }]);
    expect(body.total_clicks).toBe(4);
    expect(sum(body.days)).toBe(body.total_clicks);
  });

  test("days count only the requested link's clicks", async () => {
    const a = await create("https://a.example");
    const b = await create("https://b.example");
    for (let i = 0; i < 3; i++) await follow(a);
    await follow(b);

    expect((await dailyStats(a)).days).toEqual([{ date: todayUtc(), clicks: 3 }]);
    expect((await dailyStats(b)).days).toEqual([{ date: todayUtc(), clicks: 1 }]);
  });

  test("?by=day adds days after the #3 fields and changes none of them", async () => {
    const slug = await create();
    await setCreatedAt(slug, `${daysAgo(2)}T10:00:00Z`);
    await insertClicks(slug, [`${daysAgo(1)}T23:59:59.500Z`]);
    await follow(slug);

    const plainRes = await app().fetch(request(`/api/links/${slug}/stats`, withKey(key)));
    expect(plainRes.status).toBe(200);
    const plainText = await plainRes.text();
    const plain = JSON.parse(plainText) as Stats;
    // Without ?by=day: exactly the #3 body, field for field and byte for byte.
    expect(plainText).toBe(
      JSON.stringify({
        slug: plain.slug,
        total_clicks: plain.total_clicks,
        last_clicked_at: plain.last_clicked_at,
      }),
    );
    expect(Object.keys(plain)).toEqual(["slug", "total_clicks", "last_clicked_at"]);
    expect(plain.total_clicks).toBe(2);

    const daily = await dailyStats(slug);
    expect(Object.keys(daily)).toEqual(["slug", "total_clicks", "last_clicked_at", "days"]);
    const { days, ...rest } = daily;
    expect(rest).toEqual(plain);
    expect(days.length).toBe(3);
  });

  test("?by=day for an unknown slug is 404 not_found", async () => {
    const res = await app().fetch(request("/api/links/doesNotExist/stats?by=day", withKey(key)));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("?by=day without a valid key is 401 unauthorized", async () => {
    const slug = await create();
    const res = await app().fetch(request(`/api/links/${slug}/stats?by=day`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
