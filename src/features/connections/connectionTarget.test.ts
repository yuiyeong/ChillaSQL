import { expect, test } from "vitest";
import { connection } from "../../test/fixtures";
import { connectionTarget } from "./connectionTarget";

test("접속 대상은 host:port/database다", () => {
  expect(
    connectionTarget(
      connection("prod", { host: "db.internal", port: 6432, database: "shop" }),
    ),
  ).toBe("db.internal:6432/shop");
});
