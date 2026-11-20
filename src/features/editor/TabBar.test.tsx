import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import { change } from "../../test/change";
import { click } from "../../test/click";
import { connection, openProjectWith } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";
import { expectNoTextCorrection } from "../../test/textCorrection";
import { TabBar } from "./TabBar";
import { useTabs } from "./tabsStore";
import { useTunnels } from "../connections/tunnelsStore";
import { useRuns } from "../query/runsStore";
import { DEFAULT_KEYMAP, setKeymap } from "../workspace/shortcuts";

beforeEach(async () => {
  await resetStores();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderBar() {
  const handlers = { onClose: vi.fn(), onNew: vi.fn(), onName: vi.fn() };
  render(<TabBar {...handlers} />);
  return handlers;
}

function lastContext(spy: { mock: { contexts: unknown[] } }): HTMLElement {
  return spy.mock.contexts[spy.mock.contexts.length - 1] as HTMLElement;
}

function tab(title: string) {
  return screen.getByRole("tab", { name: title });
}

/** jsdom은 var()를 뜻으로 풀지 못해서 style attribute를 그대로 읽는다. */
function dotOf(title: string): HTMLElement {
  const dot = within(tab(title)).getByTestId("tab-dot");
  return dot;
}

test("탭 제목을 그리고 누르면 활성으로 한다", async () => {
  const a = useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  renderBar();

  expect(screen.getByRole("tablist", { name: "Open files" })).toBeVisible();
  expect(tab("Query 1")).toHaveAttribute("aria-selected", "false");
  expect(tab("Query 2")).toHaveAttribute("aria-selected", "true");
  expect(useTabs.getState().activeId).toBe(b);

  await click(tab("Query 1"));

  expect(useTabs.getState().activeId).toBe(a);
  expect(tab("Query 1")).toHaveAttribute("aria-selected", "true");
});

test("탭의 dot은 접속 색이다", () => {
  openProjectWith([
    connection("local", { color: "green" }),
    connection("plain"),
  ]);
  const a = useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  const c = useTabs.getState().newTab();
  useTabs.getState().setConnection(a, "local");
  useTabs.getState().setConnection(b, "plain");
  renderBar();

  expect(dotOf("Query 1").style.background).toBe("var(--color-conn-green)");
  expect(dotOf("Query 2").style.background).toBe("var(--color-line-2)");
  // 접속이 없는 탭은 속이 빈 원이다.
  expect(dotOf("Query 3").style.background).toBe("");
  expect(dotOf("Query 3")).toHaveClass("border-fg-3");
  expect(
    useTabs.getState().tabs.find((x) => x.id === c)?.connection,
  ).toBeNull();
});

test("닫기와 새 탭 버튼이 handler를 부른다", async () => {
  useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  const { onClose, onNew } = renderBar();

  await click(screen.getByRole("button", { name: "Close Query 2" }));
  expect(onClose).toHaveBeenCalledWith(b);
  expect(onClose).toHaveBeenCalledTimes(1);

  await click(screen.getByRole("button", { name: "New tab (Shift+Cmd+L)" }));
  expect(onNew).toHaveBeenCalledTimes(1);
});

test("new_tab_button_label_follows_the_keymap", () => {
  setKeymap([
    ...DEFAULT_KEYMAP.filter((b) => b.command !== "newTab"),
    { command: "newTab", code: "KeyT", shift: false, alt: false, ctrl: false },
  ]);
  renderBar();

  expect(
    screen.getByRole("button", { name: "New tab (Cmd+T)" }),
  ).toBeInTheDocument();
});

test("dirty 탭은 Unsaved 표시를 갖고 닫기도 할 수 있다", async () => {
  const a = useTabs.getState().newTab();
  useTabs.getState().newTab();
  useTabs.getState().markDirty(a);
  const { onClose } = renderBar();

  expect(screen.getAllByLabelText("Unsaved")).toHaveLength(1);

  await click(screen.getByRole("button", { name: "Close Query 1" }));
  expect(onClose).toHaveBeenCalledWith(a);
});

test("빈 자리와 줄 자체는 창을 끄는 자리고 탭은 아니다", () => {
  useTabs.getState().newTab();
  renderBar();

  const row = screen.getByTestId("tab-row");
  expect(row).toHaveAttribute("data-tauri-drag-region");
  expect(screen.getByTestId("tab-row-spacer")).toHaveAttribute(
    "data-tauri-drag-region",
  );
  expect(tab("Query 1")).not.toHaveAttribute("data-tauri-drag-region");
});

test("탭이 많으면 탭 목록이 스크롤되고 새 탭 버튼과 빈 자리는 그 밖에 있다", () => {
  for (let i = 0; i < 20; i += 1) useTabs.getState().newTab();
  renderBar();

  const scroller = screen.getByTestId("tab-scroller");
  expect(scroller).toHaveClass("overflow-x-auto");
  expect(
    within(scroller).getByRole("tablist", { name: "Open files" }),
  ).toBeInTheDocument();
  expect(
    within(scroller).queryByRole("button", { name: "New tab (Shift+Cmd+L)" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "New tab (Shift+Cmd+L)" }),
  ).toBeVisible();
  // 탭은 줄어들지 않아서 제목이 읽히는 너비를 지킨다.
  expect(tab("Query 1").parentElement).toHaveClass("shrink-0");
  expect(screen.getByTestId("tab-row-spacer")).not.toBe(scroller);
  expect(scroller).not.toContainElement(screen.getByTestId("tab-row-spacer"));
});

test("활성 탭이 바뀌면 그 탭을 보이는 자리로 스크롤한다", async () => {
  const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
  onTestFinished(() => scrollIntoView.mockRestore());
  const a = useTabs.getState().newTab();
  useTabs.getState().newTab();
  renderBar();
  const last = lastContext(scrollIntoView);
  expect(last).toContainElement(tab("Query 2"));
  expect(scrollIntoView).toHaveBeenLastCalledWith({
    inline: "nearest",
    block: "nearest",
  });

  await click(tab("Query 1"));

  const moved = lastContext(scrollIntoView);
  expect(moved).toContainElement(tab("Query 1"));
  expect(useTabs.getState().activeId).toBe(a);
});

test("탭의 왼쪽 여백도 탭을 누르는 자리다", () => {
  useTabs.getState().newTab();
  renderBar();

  // 여백이 탭 button 안에 있어서 눌러도 활성이 된다. 닫기 button은 button 밖이다.
  const button = tab("Query 1");
  expect(button).toHaveClass("pl-3");
  expect(button).toHaveClass("h-full");
  expect(button.parentElement).not.toHaveClass("pl-3");
  expect(button).not.toContainElement(
    screen.getByRole("button", { name: "Close Query 1" }),
  );
});

test("이름을 묻는 중이면 Save dialog를 띄운다", async () => {
  const id = useTabs.getState().newTab();
  const { onName } = renderBar();
  expect(screen.queryByRole("dialog")).toBeNull();

  act(() => useTabs.getState().requestName(id));
  const dialog = screen.getByRole("dialog", { name: "Save Query 1" });
  const input = within(dialog).getByLabelText("Path inside the project");
  expect(input).toHaveAttribute("placeholder", "queries/name.sql");
  change(input, "queries/a");
  await click(within(dialog).getByRole("button", { name: "Save" }));

  expect(onName).toHaveBeenCalledWith("queries/a");
});

test("Cancel과 Escape는 이름 묻기를 그만둔다", async () => {
  const id = useTabs.getState().newTab();
  renderBar();
  act(() => useTabs.getState().requestName(id));
  const input = screen.getByLabelText("Path inside the project");

  // 한글 입력 중에도 key가 아닌 code로 판별한다.
  fireEvent.keyDown(input, { code: "Escape", key: "Process" });
  expect(useTabs.getState().naming).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();

  act(() => useTabs.getState().requestName(id));
  await click(screen.getByRole("button", { name: "Cancel" }));
  expect(useTabs.getState().naming).toBeNull();
});

test("경로 입력은 자동 수정, 자동 대문자, 맞춤법 검사를 끈다", () => {
  const id = useTabs.getState().newTab();
  renderBar();
  act(() => useTabs.getState().requestName(id));

  expectNoTextCorrection(screen.getByLabelText("Path inside the project"));
});

test("naming이 활성이 아닌 탭이면 dialog를 그리지 않는다", () => {
  const a = useTabs.getState().newTab();
  useTabs.getState().newTab();
  useTabs.getState().requestName(a);
  renderBar();

  expect(screen.queryByRole("dialog")).toBeNull();
});

test("error가 있으면 한 줄로 보여 주고 누르면 지운다", async () => {
  useTabs.getState().newTab();
  useTabs.getState().setError("저장하지 못했습니다");
  renderBar();

  await click(screen.getByText("저장하지 못했습니다"));

  expect(useTabs.getState().error).toBeNull();
  expect(screen.queryByText("저장하지 못했습니다")).toBeNull();
});

test("탭의 접속이 앱이 띄우지 않은 터널이면 icon으로 알린다", () => {
  openProjectWith([connection("staging", { tunnel: "ssh" })]);
  const id = useTabs.getState().newTab();
  useTabs.getState().setConnection(id, "staging");
  useTunnels
    .getState()
    .apply({ connection: "staging", state: { status: "external" } });
  renderBar();

  expect(
    screen.getByRole("img", { name: "External tunnel" }),
  ).toBeInTheDocument();
  expect(tab("Query 1")).toBeInTheDocument();
});

test("shows_tx_and_elapsed_on_a_tab_with_an_open_transaction", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000);
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const a = useTabs.getState().newTab();
  useTabs.getState().newTab();
  act(() =>
    useRuns.setState({
      transactions: {
        [a]: {
          status: "open",
          statements: 2,
          openedAt: 1_000_000_000 - 192_000,
          openedBy: "app",
        },
      },
    }),
  );
  renderBar();

  const badge = screen.getByRole("img", {
    name: "Open transaction, 3:12",
  });
  expect(badge).toHaveTextContent("TX 3:12");
  expect(screen.getAllByText(/^TX/)).toHaveLength(1);
  // 탭의 이름은 그대로다.
  expect(tab("Query 1")).toBeInTheDocument();
  expect(within(tab("Query 1")).queryByRole("img")).toBeNull();

  act(() => vi.advanceTimersByTime(2000));
  expect(
    screen.getByRole("img", { name: "Open transaction, 3:14" }),
  ).toHaveTextContent("TX 3:14");
});

test("a failed transaction also shows the badge", () => {
  const a = useTabs.getState().newTab();
  act(() =>
    useRuns.setState({
      transactions: {
        [a]: {
          status: "failed",
          statements: 1,
          openedAt: Date.now(),
          openedBy: "app",
        },
      },
    }),
  );
  renderBar();

  expect(screen.getByRole("img", { name: /^Open transaction/ })).toBeVisible();
});

test("a tab without a transaction has no badge", () => {
  useTabs.getState().newTab();
  renderBar();

  expect(screen.queryByText(/^TX/)).toBeNull();
  expect(screen.queryByRole("img", { name: /transaction/ })).toBeNull();
});
