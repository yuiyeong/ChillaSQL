import { afterEach, expect, test } from "vitest";
import { setLanguage } from "../i18n/t";
import { CommandError, messageOf, toCommandError } from "./errors";

afterEach(() => setLanguage("en"));

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

test("message of a command error is translated", () => {
  const error = toCommandError({
    kind: "project_not_found",
    message: "/p/chilla.toml was not found",
    params: { path: "/p/chilla.toml" },
  });
  expect(messageOf(error)).toBe("/p/chilla.toml was not found");

  setLanguage("ko");
  expect(messageOf(error)).toBe("/p/chilla.toml 파일이 없습니다");
});

test("unknown kind keeps the rust message", () => {
  setLanguage("ko");
  expect(messageOf(new CommandError("internal", "boom"))).toBe("boom");
  expect(messageOf(new Error("plain"))).toBe("plain");
  expect(messageOf("text")).toBe("text");
});

test("a kind whose params are missing keeps the rust message", () => {
  setLanguage("ko");
  expect(
    messageOf(new CommandError("project_not_found", "chilla.toml is gone")),
  ).toBe("chilla.toml is gone");
});

test("a kind without params is translated", () => {
  setLanguage("ko");
  expect(
    messageOf(new CommandError("no_project", "Open a project first")),
  ).toBe("프로젝트를 먼저 여십시오");
});
