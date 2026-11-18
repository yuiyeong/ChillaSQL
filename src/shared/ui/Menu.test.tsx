import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { expect, test, vi } from "vitest";
import { click } from "../../test/click";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

function setup(props: { onClose?: () => void; onSelect?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const onSelect = props.onSelect ?? vi.fn();
  const anchor = createRef<HTMLButtonElement>();
  render(
    <>
      <button ref={anchor} type="button">
        anchor
      </button>
      <button type="button">outside</button>
      <Menu open onClose={onClose} anchor={anchor} label="Actions">
        <MenuItem onSelect={onSelect}>First</MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={vi.fn()}>Second</MenuItem>
        <MenuItem onSelect={onSelect} disabled>
          Disabled
        </MenuItem>
      </Menu>
    </>,
  );
  return { onClose, onSelect };
}

test("닫혀 있으면 아무것도 그리지 않는다", () => {
  const anchor = createRef<HTMLButtonElement>();
  render(
    <Menu open={false} onClose={vi.fn()} anchor={anchor} label="Actions">
      <MenuItem onSelect={vi.fn()}>First</MenuItem>
    </Menu>,
  );
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("열리면 첫 항목에 focus가 간다", () => {
  setup();
  expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
});

test("Escape는 닫는다", () => {
  const { onClose } = setup();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "First" }), {
    key: "Escape",
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("바깥을 누르면 닫는다", () => {
  const { onClose } = setup();
  fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("menu 안을 누르면 닫지 않는다", () => {
  const { onClose } = setup();
  fireEvent.pointerDown(screen.getByRole("menuitem", { name: "First" }));
  expect(onClose).not.toHaveBeenCalled();
});

test("ArrowDown은 다음 항목으로 가고 disabled는 건너뛴다", () => {
  setup();
  const first = screen.getByRole("menuitem", { name: "First" });
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = screen.getByRole("menuitem", { name: "Second" });
  expect(second).toHaveFocus();
  fireEvent.keyDown(second, { key: "ArrowDown" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "ArrowUp" });
  expect(second).toHaveFocus();
});

test("disabled 항목은 onSelect를 부르지 않는다", async () => {
  const { onSelect, onClose } = setup();
  await click(screen.getByRole("menuitem", { name: "Disabled" }));
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("항목을 고르면 onSelect 뒤에 닫는다", async () => {
  const calls: string[] = [];
  setup({
    onSelect: () => calls.push("select"),
    onClose: () => calls.push("close"),
  });
  await click(screen.getByRole("menuitem", { name: "First" }));
  expect(calls).toEqual(["select", "close"]);
});

test("checked가 있는 항목은 menuitemradio다", () => {
  const anchor = createRef<HTMLButtonElement>();
  render(
    <Menu open onClose={vi.fn()} anchor={anchor} label="Connections">
      <MenuItem onSelect={vi.fn()} checked>
        local
      </MenuItem>
      <MenuItem onSelect={vi.fn()} checked={false}>
        prod
      </MenuItem>
    </Menu>,
  );
  expect(screen.getByRole("menuitemradio", { name: "local" })).toBeChecked();
  expect(screen.getByRole("menuitemradio", { name: "prod" })).not.toBeChecked();
});
