import { describe, expect, test } from "vitest";
import { connection } from "../../test/fixtures";
import type { Connection } from "../../shared/api/types";
import {
  initialValues,
  targetChanged,
  toConnection,
  type FormValues,
} from "./connectionValues";

const values: FormValues = {
  name: "local",
  host: "localhost",
  port: "5432",
  database: "app",
  user: "chilla",
  sslmode: "disable",
  sslrootcert: "",
  tunnel: "",
  tunnelTimeout: "",
  color: null,
};

const original = connection("local", {
  sslmode: "verify-full",
  sslrootcert: "/certs/ca.crt",
  tunnel: "bastion",
  color: "red",
});

test("새 접속의 초기값은 port 5432와 sslmode disable이다", () => {
  expect(initialValues(null)).toEqual({
    name: "",
    host: "",
    port: "5432",
    database: "",
    user: "",
    sslmode: "disable",
    sslrootcert: "",
    tunnel: "",
    tunnelTimeout: "",
    color: null,
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
    tunnel: "bastion",
    tunnelTimeout: "",
    color: "red",
  });
  expect(initialValues({ ...original, tunnelTimeout: 30 }).tunnelTimeout).toBe(
    "30",
  );
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
    [],
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
      tunnelTimeout: null,
      color: null,
      readOnly: false,
      statementTimeout: null,
    },
  });
});

test("빈 필수 항목은 error다", () => {
  expect(toConnection({ ...values, name: "  " }, null, [])).toEqual({
    error: "Enter name",
  });
  expect(toConnection({ ...values, host: "" }, null, [])).toEqual({
    error: "Enter host",
  });
  expect(toConnection({ ...values, database: "" }, null, [])).toEqual({
    error: "Enter database",
  });
  expect(toConnection({ ...values, user: "" }, null, [])).toEqual({
    error: "Enter user",
  });
});

test("잘못된 port는 error다", () => {
  for (const port of ["", "abc", "0", "65536", "54.3", "-1", "1e3"]) {
    expect(toConnection({ ...values, port }, null, [])).toEqual({
      error: "port must be a number from 1 to 65535",
    });
  }
  expect(toConnection({ ...values, port: "1" }, null, [])).toHaveProperty(
    "connection",
  );
  expect(toConnection({ ...values, port: "65535" }, null, [])).toHaveProperty(
    "connection",
  );
});

test("sslrootcert는 verify-full일 때만 보낸다", () => {
  const cert = " /certs/ca.crt ";

  expect(
    toConnection(
      { ...values, sslmode: "require", sslrootcert: cert },
      null,
      [],
    ),
  ).toMatchObject({ connection: { sslrootcert: null } });
  expect(
    toConnection(
      { ...values, sslmode: "disable", sslrootcert: cert },
      null,
      [],
    ),
  ).toMatchObject({ connection: { sslrootcert: null } });
  expect(
    toConnection(
      { ...values, sslmode: "verify-full", sslrootcert: cert },
      null,
      [],
    ),
  ).toMatchObject({ connection: { sslrootcert: "/certs/ca.crt" } });
  expect(
    toConnection(
      { ...values, sslmode: "verify-full", sslrootcert: "  " },
      null,
      [],
    ),
  ).toMatchObject({ connection: { sslrootcert: null } });
});

test("수정은 이름을 original에서 가져온다", () => {
  const result = toConnection(
    {
      ...values,
      name: "renamed",
      host: "db.example",
      tunnel: "bastion",
      color: "red",
    },
    original,
    [],
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
      tunnelTimeout: null,
      color: "red",
      readOnly: false,
      statementTimeout: null,
    },
  });
});

test("color_round_trips_through_the_form", () => {
  const form = initialValues(original);
  expect(form.color).toBe("red");
  expect(toConnection(form, original, [])).toMatchObject({
    connection: { color: "red" },
  });
  expect(toConnection({ ...form, color: null }, original, [])).toMatchObject({
    connection: { color: null },
  });
  expect(toConnection({ ...values, color: "blue" }, null, [])).toMatchObject({
    connection: { color: "blue" },
  });
});

test("새 접속은 이미 있는 이름을 쓸 수 없다", () => {
  expect(toConnection({ ...values, name: " local " }, null, ["local"])).toEqual(
    {
      error:
        "This name is already taken. To edit that connection, open it from the sidebar.",
    },
  );
  expect(
    toConnection({ ...values, name: "staging" }, null, ["local"]),
  ).toHaveProperty("connection");
  // 수정은 같은 이름으로 저장한다.
  expect(toConnection(values, original, ["local"])).toHaveProperty(
    "connection",
  );
});

test("tunnel은 앞뒤 공백을 빼고 비면 null이다", () => {
  expect(
    toConnection({ ...values, tunnel: "  ssh -N -L x  " }, null, []),
  ).toMatchObject({ connection: { tunnel: "ssh -N -L x" } });
  expect(toConnection({ ...values, tunnel: "  " }, null, [])).toMatchObject({
    connection: { tunnel: null },
  });
});

test("tunnel_timeout은 1부터 300까지의 정수 초다", () => {
  const withTimeout = (tunnelTimeout: string) =>
    toConnection({ ...values, tunnel: "ssh", tunnelTimeout }, null, []);
  expect(withTimeout("30")).toMatchObject({
    connection: { tunnelTimeout: 30 },
  });
  expect(withTimeout(" 300 ")).toMatchObject({
    connection: { tunnelTimeout: 300 },
  });
  expect(withTimeout("")).toMatchObject({
    connection: { tunnelTimeout: null },
  });
  for (const bad of ["0", "301", "2.5", "20s", "-1"]) {
    expect(withTimeout(bad)).toEqual({
      error: "tunnel_timeout must be a whole number of seconds from 1 to 300",
    });
  }
});

test("tunnel이 없으면 tunnel_timeout을 버린다", () => {
  expect(
    toConnection({ ...values, tunnel: "", tunnelTimeout: "30" }, null, []),
  ).toMatchObject({ connection: { tunnel: null, tunnelTimeout: null } });
});

describe("targetChanged", () => {
  test("같으면 false다", () => {
    expect(targetChanged({ ...original }, original)).toBe(false);
  });

  test("tunnelTimeout만 다르면 false다", () => {
    expect(targetChanged({ ...original, tunnelTimeout: 30 }, original)).toBe(
      false,
    );
  });

  test("changing_only_the_color_is_not_a_target_change", () => {
    expect(targetChanged({ ...original, color: "blue" }, original)).toBe(false);
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

test("수정은 form에 없는 readOnly와 statementTimeout을 original 그대로 둔다", () => {
  const result = toConnection(
    { ...values, name: "local" },
    { ...original, readOnly: true, statementTimeout: 30 },
    [],
  );

  expect(result).toMatchObject({
    connection: { readOnly: true, statementTimeout: 30 },
  });
});
