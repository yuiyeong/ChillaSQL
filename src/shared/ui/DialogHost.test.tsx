import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetStores } from "../../test/resetStores";
import { DialogHost } from "./DialogHost";
import { ask, isDialogOpen, type DialogSpec } from "./dialogs";

const spec: DialogSpec = {
  title: "Save changes to a.sql?",
  body: "Your changes will be lost.",
  actions: [
    { id: "discard", label: "Don't save", variant: "ghost" },
    { id: "cancel", label: "Cancel", spaceBefore: true },
    { id: "save", label: "Save", variant: "primary" },
  ],
};

beforeEach(async () => {
  await resetStores();
});

/** ask를 부르고 답을 받을 promise를 돌려준다. */
function open(next: DialogSpec): Promise<string> {
  let answer!: Promise<string>;
  act(() => {
    answer = ask(next);
  });
  return answer;
}

function press(code: string, shiftKey = false): boolean {
  return fireEvent.keyDown(window, { code, shiftKey });
}

test("spec을 alertdialog로 그린다", () => {
  render(<DialogHost />);
  expect(screen.queryByRole("alertdialog")).toBeNull();

  void open(spec);

  const dialog = screen.getByRole("alertdialog", {
    name: "Save changes to a.sql?",
  });
  expect(dialog).toHaveAccessibleDescription("Your changes will be lost.");
  expect(
    within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Don't save", "Cancel", "Save"]);
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  expect(isDialogOpen()).toBe(true);
});

test("sql, 목록, note, icon을 그린다", () => {
  render(<DialogHost />);
  void open({
    title: "Run DELETE without WHERE?",
    sql: "DELETE FROM sessions;",
    items: [
      { primary: "first.sql", secondary: null },
      { primary: "Query 1", secondary: "3 statements" },
    ],
    note: "Rolled back on quit.",
    icon: "warning",
    actions: [{ id: "cancel", label: "Cancel" }],
  });

  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText("DELETE FROM sessions;").tagName).toBe("PRE");
  expect(screen.getByText("first.sql")).toBeInTheDocument();
  expect(screen.getByText("3 statements")).toBeInTheDocument();
  expect(screen.getByText("Rolled back on quit.")).toBeInTheDocument();
  const icon = within(dialog).getByTestId("dialog-icon");
  expect(icon.querySelector("circle")).toBeNull();
});

test("clock icon과 목록 줄 앞의 marker를 그린다", () => {
  render(<DialogHost />);
  void open({
    title: "This tab has an open transaction",
    icon: "clock",
    items: [
      {
        marker: <span data-testid="marker" />,
        primary: "first.sql",
        secondary: "local · 1 statement · 0:42",
      },
    ],
    actions: [{ id: "cancel", label: "Cancel" }],
  });

  const icon = screen.getByTestId("dialog-icon");
  // 시계는 원, 경고는 삼각형 path다.
  expect(icon.querySelector("circle")).not.toBeNull();
  const row = screen.getByRole("listitem");
  expect(row.firstElementChild).toBe(screen.getByTestId("marker"));
});

test("긴 목록은 그 안에서 scroll하고 버튼 줄을 밀어내지 않는다", () => {
  render(<DialogHost />);
  void open({
    title: "12 tabs have open transactions",
    items: Array.from({ length: 12 }, (_, index) => ({
      primary: `Query ${index + 1}`,
      secondary: null,
    })),
    actions: [{ id: "cancel", label: "Cancel" }],
  });

  const list = screen.getByRole("list");
  // dialog는 max-h가 있는 flex column이다. 목록만 줄어들고 넘치는 줄은 목록 안에서 scroll한다.
  expect(list).toHaveClass("min-h-0", "overflow-auto");
  for (const item of within(list).getAllByRole("listitem")) {
    expect(item).toHaveClass("shrink-0");
  }
});

test("Escape는 cancel로 답한다", async () => {
  render(<DialogHost />);
  const answer = open(spec);

  act(() => {
    press("Escape");
  });

  expect(await answer).toBe("cancel");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(isDialogOpen()).toBe(false);
});

test("action을 누르면 그 id로 답한다", async () => {
  render(<DialogHost />);
  const answer = open(spec);

  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await answer).toBe("save");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("두 번째 ask는 첫 답 뒤에 보인다", async () => {
  render(<DialogHost />);
  const first = open(spec);
  const second = open({ ...spec, title: "Second?" });

  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
    "Save changes to a.sql?",
  );

  fireEvent.click(screen.getByRole("button", { name: "Don't save" }));
  expect(await first).toBe("discard");

  expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Second?");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await second).toBe("save");
});

test("Tab과 Shift+Tab은 dialog 안에 머문다", () => {
  render(<DialogHost />);
  void open(spec);
  const [discard, , save] = screen.getAllByRole("button");

  save.focus();
  expect(press("Tab")).toBe(false);
  expect(discard).toHaveFocus();

  expect(press("Tab", true)).toBe(false);
  expect(save).toHaveFocus();

  // 가운데에서는 browser가 옮기게 둔다.
  screen.getByRole("button", { name: "Cancel" }).focus();
  expect(press("Tab")).toBe(true);
});

test("focus가 dialog 밖에 있어도 Tab은 dialog 안으로 돌아온다", () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    render(<DialogHost />);
    void open(spec);
    outside.focus();

    expect(press("Tab")).toBe(false);
    expect(screen.getByRole("button", { name: "Don't save" })).toHaveFocus();
  } finally {
    outside.remove();
  }
});

test("닫으면 focus를 열기 전의 자리로 돌려 준다", async () => {
  const before = document.createElement("button");
  document.body.append(before);
  try {
    before.focus();
    render(<DialogHost />);
    const answer = open(spec);
    expect(before).not.toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await answer;

    expect(before).toHaveFocus();
  } finally {
    before.remove();
  }
});

test("막을 누르면 focus를 지키려고 막지만 dialog 안을 누르는 것은 막지 않는다", () => {
  render(<DialogHost />);
  void open({ ...spec, sql: "DELETE FROM sessions;" });

  const dialog = screen.getByRole("alertdialog");
  // SQL을 선택하거나 scrollbar를 끌 수 있어야 한다.
  expect(fireEvent.mouseDown(screen.getByText("DELETE FROM sessions;"))).toBe(
    true,
  );
  expect(fireEvent.mouseDown(dialog)).toBe(true);
  // 막(dialog 밖)은 focus가 dialog를 떠나지 않게 막는다.
  expect(fireEvent.mouseDown(dialog.parentElement as HTMLElement)).toBe(false);
});
