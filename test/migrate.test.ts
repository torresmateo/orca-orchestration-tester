import { expect, test } from "bun:test";
import { migrate } from "../src/migrate";
import { db, describeDb } from "./helpers";

describeDb("migrations", () => {
  test("re-running is a no-op", async () => {
    expect(await migrate(db())).toEqual([]);
  });
});
