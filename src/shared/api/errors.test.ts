import { expect, test } from "vitest";
import { CommandError, toCommandError } from "./errors";

test("params are read from the payload", () => {
  const error = toCommandError({
    kind: "file_too_large",
    message:
      "a.sql is too large (20000000 bytes). Files up to 16 MiB can be opened",
    params: { path: "a.sql", bytes: "20000000" },
  });
  expect(error.kind).toBe("file_too_large");
  expect(error.params).toEqual({ path: "a.sql", bytes: "20000000" });
});

test("params default to an empty object", () => {
  expect(toCommandError({ kind: "no_project", message: "m" }).params).toEqual(
    {},
  );
  expect(
    toCommandError({ kind: "k", message: "m", params: "x" }).params,
  ).toEqual({});
  expect(
    toCommandError({ kind: "k", message: "m", params: null }).params,
  ).toEqual({});
  expect(toCommandError(new Error("boom")).params).toEqual({});
  expect(new CommandError("k", "m").params).toEqual({});
});

test("params keep only string values", () => {
  const error = toCommandError({
    kind: "k",
    message: "m",
    params: { a: "1", b: 2 },
  });
  expect(error.params).toEqual({ a: "1" });
});
