import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { change } from "../../test/change";
import { click } from "../../test/click";
import { deferred } from "../../test/deferred";
import { connection } from "../../test/fixtures";
import { expectNoTextCorrection } from "../../test/textCorrection";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import {
  hasPassword,
  saveConnection,
  testConnection,
} from "../../shared/api/commands";
import { pickFile } from "../../shared/api/dialog";
import { CommandError } from "../../shared/api/errors";
import type { Connection, Project } from "../../shared/api/types";
import { ConnectionForm } from "./ConnectionForm";

const saved: Project = { name: "demo", dir: "/p", connections: [] };

const original = connection("local", { tunnel: "bastion", color: "red" });

const warning =
  "You changed where this connection points. Saving deletes the password stored in Keychain. Enter a new password below to save it instead.";

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

test("수정 form의 제목은 접속 이름이고 이름은 바꿀 수 없다고 알린다", () => {
  renderForm(original);
  expect(screen.getByRole("form", { name: "Edit local" })).toBeInTheDocument();
  expect(screen.getByText("Name can't be changed")).toBeInTheDocument();
  expect(screen.queryByLabelText("name")).not.toBeInTheDocument();
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
      tunnelTimeout: null,
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

  expect(screen.queryByLabelText("name")).not.toBeInTheDocument();
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

const colorGroup = () => screen.getByRole("radiogroup", { name: "color" });
const swatch = (name: string) =>
  within(colorGroup()).getByRole("radio", { name });

test("color_is_a_radiogroup_of_five", () => {
  renderForm(original);

  expect(screen.getByRole("group", { name: "color" })).toBeInTheDocument();
  const radios = within(colorGroup()).getAllByRole("radio");
  expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
    "green",
    "yellow",
    "red",
    "blue",
    "purple",
  ]);
  expect(
    radios.filter((radio) => radio.getAttribute("aria-checked") === "true"),
  ).toEqual([swatch("red")]);
});

test("the_edit_sheet_labels_the_color_row_without_a_legend", () => {
  renderForm(original);

  const group = screen.getByRole("group", { name: "color" });
  expect(group.tagName).toBe("DIV");
  expect(document.querySelector("legend")).toBeNull();
});

test("the_new_sheet_keeps_the_color_fieldset_and_legend", () => {
  renderForm();

  expect(document.querySelector("fieldset > legend")).toHaveTextContent(
    "color",
  );
});

test("clicking_an_unchecked_swatch_picks_it", async () => {
  renderForm(original);

  await click(swatch("blue"));

  expect(swatch("blue")).toHaveAttribute("aria-checked", "true");
  expect(swatch("red")).toHaveAttribute("aria-checked", "false");
});

test("clicking_the_checked_swatch_clears_the_color", async () => {
  renderForm(original);

  await click(swatch("red"));

  expect(swatch("red")).toHaveAttribute("aria-checked", "false");
  await click(saveButton());
  expect(saveConnection).toHaveBeenCalledWith(
    { ...original, color: null },
    null,
  );
});

test("new_connection_has_no_color", async () => {
  renderForm();

  for (const radio of within(colorGroup()).getAllByRole("radio")) {
    expect(radio).toHaveAttribute("aria-checked", "false");
  }
  fillNew();
  await click(saveButton());
  expect(saveConnection).toHaveBeenCalledWith(
    expect.objectContaining({ color: null }),
    null,
  );
});

test("saving_sends_the_color", async () => {
  renderForm();
  fillNew();

  await click(swatch("purple"));
  await click(saveButton());

  expect(saveConnection).toHaveBeenCalledWith(
    expect.objectContaining({ color: "purple" }),
    null,
  );
});

test("a_swatch_is_filled_with_its_connection_color_token", () => {
  renderForm(original);

  expect(swatch("green").style.background).toBe("var(--color-conn-green)");
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

const sslmode = (mode: string) => screen.getByRole("radio", { name: mode });
const advanced = () => screen.getByRole("button", { name: /^Advanced/ });

test("sslrootcert는 verify-full일 때만 입력할 수 있다", async () => {
  renderForm();
  fillNew();
  await click(advanced());
  const cert = screen.getByLabelText("sslrootcert");
  expect(cert).toBeDisabled();

  await click(sslmode("require"));
  expect(cert).toBeDisabled();

  await click(sslmode("verify-full"));
  expect(sslmode("verify-full")).toHaveAttribute("aria-checked", "true");
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

  await click(sslmode("require"));
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

test("입력란은 자동 수정, 자동 대문자, 맞춤법 검사를 끈다", async () => {
  renderForm();
  await click(advanced());

  for (const label of [
    "name",
    "host",
    "port",
    "database",
    "user",
    "password",
    "tunnel",
    "tunnel_timeout",
    "sslrootcert",
  ]) {
    expectNoTextCorrection(screen.getByLabelText(label));
  }
});

test("tunnel과 tunnel_timeout을 저장한다", async () => {
  renderForm();
  fillNew();
  change(
    screen.getByLabelText("tunnel"),
    "ssh -N -L 25432:db.internal:5432 bastion",
  );
  await click(advanced());
  change(screen.getByLabelText("tunnel_timeout"), "30");

  await click(saveButton());

  expect(saveConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      tunnel: "ssh -N -L 25432:db.internal:5432 bastion",
      tunnelTimeout: 30,
    }),
    null,
  );
});

test("tunnel이 비면 tunnel_timeout은 disabled다", async () => {
  renderForm();
  await click(advanced());
  expect(screen.getByLabelText("tunnel_timeout")).toBeDisabled();
  change(screen.getByLabelText("tunnel"), "ssh");
  expect(screen.getByLabelText("tunnel_timeout")).toBeEnabled();
});

test("Advanced는 tunnel_timeout이나 sslrootcert가 있으면 펼쳐서 연다", () => {
  renderForm(connection("local", { tunnel: "ssh", tunnelTimeout: 30 }));
  expect(advanced()).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByLabelText("tunnel_timeout")).toHaveValue("30");
});

test("테스트가 터널에서 실패하면 명령의 출력을 보여 준다", async () => {
  vi.mocked(testConnection).mockRejectedValue(
    new CommandError(
      "tunnel_timeout",
      "localhost:25432 didn't open within 20 seconds",
      "Unauthorized. Please login",
    ),
  );
  renderForm();
  fillNew();

  await click(testButton());

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "localhost:25432 didn't open within 20 seconds",
  );
  expect(alert).toHaveTextContent("Unauthorized. Please login");
});

test("테스트가 성공하면 걸린 시간을 보여 준다", async () => {
  let clock = 1000;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.mocked(testConnection).mockImplementation(async () => {
    clock += 41.4;
  });
  renderForm();
  fillNew();

  await click(testButton());

  expect(await screen.findByText("41 ms")).toBeInTheDocument();
  now.mockRestore();
});

test("Choose…는 고른 파일을 sslrootcert에 넣는다", async () => {
  vi.mocked(pickFile).mockResolvedValue("/certs/ca.pem");
  renderForm();
  fillNew();
  await click(sslmode("verify-full"));
  await click(advanced());

  await click(screen.getByRole("button", { name: "Choose…" }));

  expect(pickFile).toHaveBeenCalledWith(["pem", "crt"]);
  expect(screen.getByLabelText("sslrootcert")).toHaveValue("/certs/ca.pem");
});

test("save_stops_when_before_save_says_no", async () => {
  const settle = vi.fn(async () => true);
  const beforeSave = vi.fn<
    (connection: Connection) => Promise<(() => Promise<boolean>) | null>
  >(async () => null);
  const onSaved = vi.fn();
  render(
    <ConnectionForm
      original={original}
      existingNames={["local"]}
      beforeSave={beforeSave}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );

  change(screen.getByLabelText("host"), "db.example");
  await click(saveButton());

  expect(beforeSave).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "local", host: "db.example" }),
  );
  expect(saveConnection).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  expect(saveButton()).toBeEnabled();

  beforeSave.mockResolvedValue(settle);
  await click(saveButton());
  expect(saveConnection).toHaveBeenCalledOnce();
  // 고른 끝내기는 저장한 뒤에 한다.
  expect(settle).toHaveBeenCalledOnce();
  expect(vi.mocked(saveConnection).mock.invocationCallOrder[0]).toBeLessThan(
    settle.mock.invocationCallOrder[0],
  );
  expect(onSaved).toHaveBeenCalledWith(saved);
});

test("a_save_that_fails_does_not_end_the_transaction", async () => {
  const settle = vi.fn(async () => true);
  const onSaved = vi.fn();
  vi.mocked(saveConnection).mockRejectedValue(
    new CommandError("io", "chilla.toml을 쓸 수 없습니다"),
  );
  render(
    <ConnectionForm
      original={original}
      existingNames={["local"]}
      beforeSave={async () => settle}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );

  change(screen.getByLabelText("host"), "db.example");
  await click(saveButton());

  expect(settle).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "chilla.toml을 쓸 수 없습니다",
  );
});

test("a_commit_that_fails_after_saving_keeps_the_form_and_says_so", async () => {
  const onSaved = vi.fn();
  const onSavedNotApplied = vi.fn();
  render(
    <ConnectionForm
      original={original}
      existingNames={["local"]}
      beforeSave={async () => async () => false}
      onSaved={onSaved}
      onSavedNotApplied={onSavedNotApplied}
      onClose={vi.fn()}
    />,
  );

  change(screen.getByLabelText("host"), "db.example");
  await click(saveButton());

  expect(saveConnection).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onSavedNotApplied).toHaveBeenCalledExactlyOnceWith(saved);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Saved to chilla.toml, but the commit failed. Tabs using this connection stay on the previous target until you save again.",
  );
  expect(saveButton()).toBeEnabled();
});

test("before_save_compares_the_target_with_the_connection_in_use", async () => {
  const beforeSave = vi.fn(async () => async () => true);
  render(
    <ConnectionForm
      original={original}
      inUse={{ ...original, host: "old.example" }}
      existingNames={["local"]}
      beforeSave={beforeSave}
      onSaved={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await click(saveButton());

  expect(beforeSave).toHaveBeenCalledExactlyOnceWith(original);
  expect(saveConnection).toHaveBeenCalledOnce();
  // 지울지는 파일의 값(original)과 비교한다.
  expect(screen.queryByText(warning)).toBeNull();
});

test("before_save_is_asked_only_when_the_target_changes", async () => {
  const beforeSave = vi.fn(async () => async () => true);
  render(
    <ConnectionForm
      original={original}
      existingNames={["local"]}
      beforeSave={beforeSave}
      onSaved={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await click(saveButton());

  expect(beforeSave).not.toHaveBeenCalled();
  expect(saveConnection).toHaveBeenCalledOnce();
});
