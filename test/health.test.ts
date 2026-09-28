import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { connect } from "../src/db";
import { app, describeDb, request } from "./helpers";

describeDb("GET /healthz with a database", () => {
  test("reports the database as up", async () => {
    const res = await app().fetch(request("/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });
});

test("GET /healthz reports 503 when the database is down", async () => {
  // Port 1 is never a Postgres server; the ping must fail, not hang.
  const dead = connect("postgres://nobody:nobody@127.0.0.1:1/none");
  const res = await createApp(dead).fetch(request("/healthz"));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false, db: "down" });
});

test("unknown routes are 404", async () => {
  // A multi-segment path: a single segment is a slug lookup and needs the DB.
  const dead = connect("postgres://nobody:nobody@127.0.0.1:1/none");
  const res = await createApp(dead).fetch(request("/no/such/route"));
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
