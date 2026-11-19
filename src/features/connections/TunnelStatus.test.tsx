import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TunnelState } from "../../shared/api/types";
import { connection, openProjectWith } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";
import { TunnelChipStatus, TunnelTabIcon } from "./TunnelStatus";
import { useTunnels } from "./tunnelsStore";

beforeEach(async () => {
  await resetStores();
  openProjectWith([connection("staging", { port: 25432, tunnel: "ssh" })]);
});

afterEach(() => {
  vi.useRealTimers();
});

function set(state: TunnelState, now = Date.now()) {
  act(() => useTunnels.getState().apply({ connection: "staging", state }, now));
}

test("시작 중이면 경과 초와 대기 시간을 센다", () => {
  vi.useFakeTimers();
  set({ status: "starting", attempt: 0, timeoutSecs: 20 });
  render(<TunnelChipStatus connection="staging" />);
  expect(screen.getByText("Starting tunnel")).toBeInTheDocument();
  expect(screen.getByText("0 / 20 s")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(3000));
  expect(screen.getByText("3 / 20 s")).toBeInTheDocument();
});

test("다시 실행 중이면 횟수를 보여 준다", () => {
  set({ status: "starting", attempt: 2, timeoutSecs: 20 });
  render(<TunnelChipStatus connection="staging" />);
  expect(screen.getByText("Reconnecting")).toBeInTheDocument();
  expect(screen.getByText("2/3")).toBeInTheDocument();
});

test("실패와 앱이 띄우지 않은 터널을 보여 주고 열린 터널은 그리지 않는다", () => {
  const { container } = render(<TunnelChipStatus connection="staging" />);
  expect(container).toBeEmptyDOMElement();

  set({ status: "ready" });
  expect(container).toBeEmptyDOMElement();

  set({ status: "failed", reason: "timeout", secs: 20, output: "" });
  expect(screen.getByText("Tunnel failed")).toBeInTheDocument();

  set({ status: "failed", reason: "cancelled" });
  expect(container).toBeEmptyDOMElement();

  set({ status: "external" });
  expect(screen.getByText("External tunnel")).toBeInTheDocument();
});

test("앱이 띄우지 않은 터널에 hover하면 설명이 보인다", () => {
  set({ status: "external" });
  render(<TunnelChipStatus connection="staging" />);
  expect(screen.queryByRole("tooltip")).toBeNull();

  fireEvent.mouseEnter(screen.getByText("External tunnel"));

  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "localhost:25432 was already open, so the tunnel command didn't run. ChillaSQL won't close this tunnel when it quits.",
  );
});

test("탭 icon은 상태를 이름으로 알린다", () => {
  const { container } = render(<TunnelTabIcon connection="staging" />);
  expect(container).toBeEmptyDOMElement();

  set({ status: "starting", attempt: 0, timeoutSecs: 20 });
  expect(
    screen.getByRole("img", { name: "Starting tunnel" }),
  ).toBeInTheDocument();
  set({ status: "starting", attempt: 1, timeoutSecs: 20 });
  expect(screen.getByRole("img", { name: "Reconnecting" })).toBeInTheDocument();
  set({ status: "failed", reason: "spawn", message: "m" });
  expect(
    screen.getByRole("img", { name: "Tunnel failed" }),
  ).toBeInTheDocument();
  set({ status: "external" });
  expect(
    screen.getByRole("img", { name: "External tunnel" }),
  ).toBeInTheDocument();
  set({ status: "ready" });
  expect(container).toBeEmptyDOMElement();
});
