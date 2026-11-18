import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { change } from "../../test/change";
import { click } from "../../test/click";
import { deferred } from "../../test/deferred";
import { expectNoTextCorrection } from "../../test/textCorrection";

vi.mock("../../shared/api/commands");

import {
  hasPassword,
  saveConnection,
  testConnection,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { Connection, Project } from "../../shared/api/types";
import { ConnectionForm } from "./ConnectionForm";

const saved: Project = { name: "demo", dir: "/p", connections: [] };

const original: Connection = {
  name: "local",
  host: "localhost",
  port: 5432,
  database: "app",
  user: "chilla",
  sslmode: "disable",
  sslrootcert: null,
  tunnel: "bastion",
  color: "#ff0000",
};

const warning =
  "Changing the connection target deletes the saved password. Enter the password again";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasPassword).mockResolvedValue(false);
  vi.mocked(saveConnection).mockResolvedValue(saved);
  vi.mocked(testConnection).mockResolvedValue(undefined);
});

function renderForm(
  connection: Connection | null = null,
  existingNames: string[] = [],
) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ConnectionForm
      original={connection}
      existingNames={existingNames}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
  return { onSaved, onClose };
}

test("제목이 새 접속과 수정을 가른다", () => {
  renderForm();
  expect(
    screen.getByRole("form", { name: "New Connection" }),
  ).toBeInTheDocument();
});

test("수정 form의 제목은 Edit Connection이다", () => {
  renderForm(original);
  expect(
    screen.getByRole("form", { name: "Edit Connection" }),
  ).toBeInTheDocument();
});

function fillNew() {
  change(screen.getByLabelText("name"), "local");
  change(screen.getByLabelText("host"), "localhost");
  change(screen.getByLabelText("database"), "app");
  change(screen.getByLabelText("user"), "chilla");
}

const saveButton = () => screen.getByRole("button", { name: "Save" });
const testButton = () => screen.getByRole("button", { name: "Test" });

test("새 접속을 저장하면 saveConnection에 입력한 비밀번호를 넘기고 onSaved를 부른다", async () => {
  const { onSaved } = renderForm();
  fillNew();
  change(screen.getByLabelText("password"), "secret");

  await click(saveButton());

  expect(saveConnection).toHaveBeenCalledWith(
    {
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
    "secret",
  );
  expect(onSaved).toHaveBeenCalledWith(saved);
  expect(screen.getByLabelText("password")).toHaveValue("");
});

test("비밀번호를 비워 두면 null을 넘긴다", async () => {
  renderForm();
  fillNew();

  await click(saveButton());
  expect(saveConnection).toHaveBeenLastCalledWith(expect.anything(), null);

  await click(testButton());
  expect(testConnection).toHaveBeenLastCalledWith(expect.anything(), null);
});

test("수정은 이름을 고칠 수 없고 저장된 비밀번호가 있으면 placeholder로 알린다", async () => {
  vi.mocked(hasPassword).mockResolvedValue(true);
  renderForm(original);

  expect(screen.getByLabelText("name")).toBeDisabled();
  expect(screen.getByLabelText("name")).toHaveValue("local");
  expect(await screen.findByPlaceholderText("Keep saved password")).toBe(
    screen.getByLabelText("password"),
  );
  expect(hasPassword).toHaveBeenCalledTimes(1);
  expect(hasPassword).toHaveBeenCalledWith("local");
});

test("저장된 비밀번호가 없으면 placeholder가 없다", async () => {
  renderForm(original);

  await screen.findByLabelText("password");
  await vi.waitFor(() => expect(hasPassword).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("password")).not.toHaveAttribute("placeholder");
});

test("hasPassword가 실패하면 placeholder 없이 둔다", async () => {
  vi.mocked(hasPassword).mockRejectedValue(
    new CommandError("keychain_error", "키체인을 읽지 못했습니다"),
  );
  renderForm(original);

  await vi.waitFor(() => expect(hasPassword).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("password")).not.toHaveAttribute("placeholder");
});

test("새 접속은 hasPassword를 부르지 않는다", () => {
  renderForm();

  expect(hasPassword).not.toHaveBeenCalled();
});

test("수정은 original의 tunnel과 color를 그대로 저장한다", async () => {
  renderForm(original);

  await click(saveButton());

  expect(saveConnection).toHaveBeenCalledWith(original, null);
});

test("테스트는 성공과 실패를 문구로 보여 준다", async () => {
  renderForm();
  fillNew();
  change(screen.getByLabelText("password"), "secret");

  await click(testButton());
  expect(testConnection).toHaveBeenCalledWith(
    expect.objectContaining({ name: "local", host: "localhost" }),
    "secret",
  );
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(saveConnection).not.toHaveBeenCalled();

  vi.mocked(testConnection).mockRejectedValue(
    new CommandError("auth_failed", "비밀번호가 맞지 않습니다"),
  );
  await click(testButton());
  expect(screen.getByText("비밀번호가 맞지 않습니다")).toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
});

test("저장이 실패하면 message를 보여 주고 닫지 않는다", async () => {
  vi.mocked(saveConnection).mockRejectedValue(
    new CommandError("io_error", "chilla.toml을 쓰지 못했습니다"),
  );
  const { onSaved, onClose } = renderForm();
  fillNew();
  change(screen.getByLabelText("password"), "secret");

  await click(saveButton());

  expect(screen.getByText("chilla.toml을 쓰지 못했습니다")).toBeInTheDocument();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText("host")).toHaveValue("localhost");
  expect(screen.getByLabelText("password")).toHaveValue("secret");
});

test("잘못된 값이면 command를 부르지 않는다", async () => {
  const { onSaved } = renderForm();
  fillNew();
  change(screen.getByLabelText("host"), "  ");

  await click(saveButton());
  expect(screen.getByText("Enter host")).toBeInTheDocument();

  await click(testButton());
  expect(screen.getByText("Enter host")).toBeInTheDocument();

  change(screen.getByLabelText("host"), "localhost");
  change(screen.getByLabelText("port"), "70000");
  await click(saveButton());
  expect(
    screen.getByText("port must be a number from 1 to 65535"),
  ).toBeInTheDocument();

  expect(saveConnection).not.toHaveBeenCalled();
  expect(testConnection).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

test("취소는 onClose를 부른다", async () => {
  const { onClose } = renderForm();

  await click(screen.getByRole("button", { name: "Cancel" }));

  expect(onClose).toHaveBeenCalledTimes(1);
});

test("결과 줄과 경고 줄의 icon은 접속 색(conn-*)을 쓰지 않는다", async () => {
  vi.mocked(hasPassword).mockResolvedValue(true);
  renderForm(original);
  await screen.findByPlaceholderText("Keep saved password");
  change(screen.getByLabelText("host"), "db.example");
  const warningIcon = screen.getByText(warning).querySelector("svg");
  expect(warningIcon).not.toBeNull();
  expect(warningIcon?.getAttribute("class") ?? "").not.toMatch(/conn-/);

  change(screen.getByLabelText("host"), "localhost");
  await click(testButton());
  const checkIcon = (await screen.findByText("Connected")).querySelector("svg");
  expect(checkIcon).not.toBeNull();
  expect(checkIcon?.getAttribute("class") ?? "").not.toMatch(/conn-/);
});

test("연결 대상을 바꾸고 비밀번호를 비우면 지워진다고 알린다", async () => {
  vi.mocked(hasPassword).mockResolvedValue(true);
  renderForm(original);
  await screen.findByPlaceholderText("Keep saved password");
  expect(screen.queryByText(warning)).not.toBeInTheDocument();

  change(screen.getByLabelText("host"), "db.example");
  expect(screen.getByText(warning)).toBeInTheDocument();

  change(screen.getByLabelText("password"), "new-secret");
  expect(screen.queryByText(warning)).not.toBeInTheDocument();

  change(screen.getByLabelText("password"), "");
  expect(screen.getByText(warning)).toBeInTheDocument();

  change(screen.getByLabelText("host"), "localhost");
  expect(screen.queryByText(warning)).not.toBeInTheDocument();
});

test("저장된 비밀번호가 없으면 연결 대상을 바꿔도 알리지 않는다", async () => {
  renderForm(original);
  await vi.waitFor(() => expect(hasPassword).toHaveBeenCalledTimes(1));

  change(screen.getByLabelText("host"), "db.example");

  expect(screen.queryByText(warning)).not.toBeInTheDocument();
});

test("sslrootcert는 verify-full일 때만 입력할 수 있다", async () => {
  renderForm();
  fillNew();
  const cert = screen.getByLabelText("sslrootcert");
  expect(cert).toBeDisabled();

  change(screen.getByLabelText("sslmode"), "require");
  expect(cert).toBeDisabled();

  change(screen.getByLabelText("sslmode"), "verify-full");
  expect(cert).toBeEnabled();
  change(cert, "/certs/ca.crt");
  await click(saveButton());
  expect(saveConnection).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sslmode: "verify-full",
      sslrootcert: "/certs/ca.crt",
    }),
    null,
  );

  change(screen.getByLabelText("sslmode"), "require");
  await click(saveButton());
  expect(saveConnection).toHaveBeenLastCalledWith(
    expect.objectContaining({ sslmode: "require", sslrootcert: null }),
    null,
  );
});

test("password 입력은 type이 password다", () => {
  renderForm();

  expect(screen.getByLabelText("password")).toHaveAttribute("type", "password");
});

test("도는 동안 테스트와 저장 버튼은 disabled다", async () => {
  const testing = deferred<void>();
  vi.mocked(testConnection).mockReturnValue(testing.promise);
  const saving = deferred<Project>();
  vi.mocked(saveConnection).mockReturnValue(saving.promise);
  renderForm();
  fillNew();

  await click(testButton());
  expect(testButton()).toBeDisabled();
  expect(saveButton()).toBeDisabled();

  await click(saveButton());
  expect(saveConnection).not.toHaveBeenCalled();

  await act(async () => testing.resolve());
  expect(testButton()).toBeEnabled();
  expect(saveButton()).toBeEnabled();

  await click(saveButton());
  expect(testButton()).toBeDisabled();
  expect(saveButton()).toBeDisabled();

  await act(async () => saving.resolve(saved));
  expect(testButton()).toBeEnabled();
});

test("이미 있는 이름이면 저장하지 않는다", async () => {
  const { onSaved } = renderForm(null, ["local"]);
  fillNew();

  await click(saveButton());

  expect(saveConnection).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This name is already taken. To edit that connection, open it from the sidebar.",
  );
});

test("입력란은 자동 수정, 자동 대문자, 맞춤법 검사를 끈다", () => {
  renderForm();

  for (const label of [
    "name",
    "host",
    "port",
    "database",
    "user",
    "password",
    "sslrootcert",
  ]) {
    expectNoTextCorrection(screen.getByLabelText(label));
  }
});
