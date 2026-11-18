import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { change } from "../../test/change";
import { click } from "../../test/click";
import { expectNoTextCorrection } from "../../test/textCorrection";
import { TabBar } from "./TabBar";
import { useTabs } from "./tabsStore";

beforeEach(() => {
  useTabs.getState().reset();
});

function renderBar() {
  const handlers = { onClose: vi.fn(), onNew: vi.fn(), onName: vi.fn() };
  render(<TabBar {...handlers} />);
  return handlers;
}

function tabButton(title: string) {
  return screen.getByRole("button", {
    name: (name) => name.startsWith(title) && !name.startsWith("Close "),
  });
}

test("탭 제목과 dirty 표시를 그리고 누르면 활성으로 한다", async () => {
  const a = useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  useTabs.getState().markDirty(a);
  renderBar();

  expect(tabButton("Query 1")).toHaveTextContent("●");
  expect(tabButton("Query 2")).not.toHaveTextContent("●");
  expect(useTabs.getState().activeId).toBe(b);

  await click(tabButton("Query 1"));

  expect(useTabs.getState().activeId).toBe(a);
});

test("닫기와 새 탭 버튼이 handler를 부른다", async () => {
  useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  const { onClose, onNew } = renderBar();

  await click(screen.getByRole("button", { name: "Close Query 2" }));
  expect(onClose).toHaveBeenCalledWith(b);
  expect(onClose).toHaveBeenCalledTimes(1);

  await click(screen.getByRole("button", { name: "New tab" }));
  expect(onNew).toHaveBeenCalledTimes(1);
});

test("naming인 탭은 경로 입력을 그리고 제출하면 onName을 부른다", async () => {
  const id = useTabs.getState().newTab();
  const { onName } = renderBar();
  expect(screen.queryByPlaceholderText("queries/name.sql")).toBeNull();

  act(() => useTabs.getState().requestName(id));
  const input = screen.getByPlaceholderText("queries/name.sql");
  change(input, "queries/a");
  await click(screen.getByRole("button", { name: "Save" }));

  expect(onName).toHaveBeenCalledWith("queries/a");
});

test("naming 입력에서 Escape를 누르면 naming이 null이다", () => {
  const id = useTabs.getState().newTab();
  renderBar();
  act(() => useTabs.getState().requestName(id));
  const input = screen.getByPlaceholderText("queries/name.sql");

  // 한글 입력 중에도 key가 아닌 code로 판별한다.
  fireEvent.keyDown(input, { code: "Escape", key: "Process" });

  expect(useTabs.getState().naming).toBeNull();
  expect(screen.queryByPlaceholderText("queries/name.sql")).toBeNull();
});

test("경로 입력은 자동 수정, 자동 대문자, 맞춤법 검사를 끈다", () => {
  const id = useTabs.getState().newTab();
  renderBar();
  act(() => useTabs.getState().requestName(id));

  expectNoTextCorrection(screen.getByPlaceholderText("queries/name.sql"));
});

test("naming이 활성이 아닌 탭이면 입력을 그리지 않는다", () => {
  const a = useTabs.getState().newTab();
  useTabs.getState().newTab();
  useTabs.getState().requestName(a);
  renderBar();

  expect(screen.queryByPlaceholderText("queries/name.sql")).toBeNull();
});

test("error가 있으면 한 줄로 보여 주고 누르면 지운다", async () => {
  useTabs.getState().newTab();
  useTabs.getState().setError("저장하지 못했습니다");
  renderBar();

  await click(screen.getByText("저장하지 못했습니다"));

  expect(useTabs.getState().error).toBeNull();
  expect(screen.queryByText("저장하지 못했습니다")).toBeNull();
});
