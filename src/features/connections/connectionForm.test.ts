import { describe, expect, test } from "vitest";
import type { Connection } from "../../shared/api/types";
import {
  initialValues,
  targetChanged,
  toConnection,
  type FormValues,
} from "./connectionForm.ts";

const values: FormValues = {
  name: "local",
  host: "localhost",
  port: "5432",
  database: "app",
  user: "chilla",
  sslmode: "disable",
  sslrootcert: "",
};

const original: Connection = {
  name: "local",
  host: "localhost",
  port: 5432,
  database: "app",
  user: "chilla",
  sslmode: "verify-full",
  sslrootcert: "/certs/ca.crt",
  tunnel: "bastion",
  color: "#ff0000",
};

test("새 접속의 초기값은 port 5432와 sslmode disable이다", () => {
  expect(initialValues(null)).toEqual({
    name: "",
    host: "",
    port: "5432",
    database: "",
    user: "",
    sslmode: "disable",
    sslrootcert: "",
  });
});

test("수정의 초기값은 original에서 온다", () => {
  expect(initialValues(original)).toEqual({
    name: "local",
    host: "localhost",
    port: "5432",
    database: "app",
    user: "chilla",
    sslmode: "verify-full",
    sslrootcert: "/certs/ca.crt",
  });
  expect(initialValues({ ...original, sslrootcert: null }).sslrootcert).toBe(
    "",
  );
});

test("값의 앞뒤 공백을 빼고 port를 숫자로 바꾼다", () => {
  const result = toConnection(
    {
      ...values,
      name: " local ",
      host: " localhost ",
      port: " 5432 ",
      database: " app ",
      user: " chilla ",
    },
    null,
  );

  expect(result).toEqual({
    connection: {
      name: "local",
      host: "localhost",
      port: 5432,
      database: "app",
      user: "chilla",
      sslmode: "disable",
      sslrootcert: null,
      tunnel: null,
      color: null,
    },
  });
});

test("빈 필수 항목은 error다", () => {
  expect(toConnection({ ...values, name: "  " }, null)).toEqual({
    error: "name을 입력하세요",
  });
  expect(toConnection({ ...values, host: "" }, null)).toEqual({
    error: "host를 입력하세요",
  });
  expect(toConnection({ ...values, database: "" }, null)).toEqual({
    error: "database를 입력하세요",
  });
  expect(toConnection({ ...values, user: "" }, null)).toEqual({
    error: "user를 입력하세요",
  });
});

test("잘못된 port는 error다", () => {
  for (const port of ["", "abc", "0", "65536", "54.3", "-1", "1e3"]) {
    expect(toConnection({ ...values, port }, null)).toEqual({
      error: "port는 1~65535의 숫자여야 합니다",
    });
  }
  expect(toConnection({ ...values, port: "1" }, null)).toHaveProperty(
    "connection",
  );
  expect(toConnection({ ...values, port: "65535" }, null)).toHaveProperty(
    "connection",
  );
});

test("sslrootcert는 verify-full일 때만 보낸다", () => {
  const cert = " /certs/ca.crt ";

  expect(
    toConnection({ ...values, sslmode: "require", sslrootcert: cert }, null),
  ).toMatchObject({ connection: { sslrootcert: null } });
  expect(
    toConnection({ ...values, sslmode: "disable", sslrootcert: cert }, null),
  ).toMatchObject({ connection: { sslrootcert: null } });
  expect(
    toConnection(
      { ...values, sslmode: "verify-full", sslrootcert: cert },
      null,
    ),
  ).toMatchObject({ connection: { sslrootcert: "/certs/ca.crt" } });
  expect(
    toConnection(
      { ...values, sslmode: "verify-full", sslrootcert: "  " },
      null,
    ),
  ).toMatchObject({ connection: { sslrootcert: null } });
});

test("수정은 이름, tunnel, color를 original에서 가져온다", () => {
  const result = toConnection(
    { ...values, name: "renamed", host: "db.example" },
    original,
  );

  expect(result).toEqual({
    connection: {
      name: "local",
      host: "db.example",
      port: 5432,
      database: "app",
      user: "chilla",
      sslmode: "disable",
      sslrootcert: null,
      tunnel: "bastion",
      color: "#ff0000",
    },
  });
});

describe("targetChanged", () => {
  test("같으면 false다", () => {
    expect(targetChanged({ ...original }, original)).toBe(false);
  });

  test("color만 다르면 false다", () => {
    expect(targetChanged({ ...original, color: "#00ff00" }, original)).toBe(
      false,
    );
    expect(targetChanged({ ...original, color: null }, original)).toBe(false);
  });

  test.each<[string, Partial<Connection>]>([
    ["host", { host: "other" }],
    ["port", { port: 5433 }],
    ["database", { database: "other" }],
    ["user", { user: "other" }],
    ["sslmode", { sslmode: "require" }],
    ["sslrootcert", { sslrootcert: "/certs/other.crt" }],
    ["sslrootcert를 비움", { sslrootcert: null }],
    ["tunnel", { tunnel: "other" }],
    ["tunnel을 비움", { tunnel: null }],
  ])("%s가 다르면 true다", (_, patch) => {
    expect(targetChanged({ ...original, ...patch }, original)).toBe(true);
  });
});
