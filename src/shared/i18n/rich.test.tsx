import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { bold, rt, sqlCode } from "./rich";

test("rt는 문구의 {name}을 넘긴 node로 바꾼다", () => {
  const { container } = render(
    <p>{rt("dialog.closeTab.title", { title: bold("a.sql") })}</p>,
  );

  expect(container).toHaveTextContent("Save changes to a.sql?");
  expect(screen.getByText("a.sql").tagName).toBe("B");
});

test("쓰지 않는 param은 무시한다", () => {
  const { container } = render(
    <p>{rt("dialog.fileChanged.title", { path: bold("x"), other: "y" })}</p>,
  );

  expect(container).toHaveTextContent("x changed on disk");
});

test("없는 param은 {name}을 그대로 둔다", () => {
  const { container } = render(<p>{rt("dialog.closeTab.title", {})}</p>);

  expect(container).toHaveTextContent("Save changes to {title}?");
});

test("string param도 그대로 들어간다", () => {
  const { container } = render(
    <p>{rt("dialog.closeTab.title", { title: "a.sql" })}</p>,
  );

  expect(container).toHaveTextContent("Save changes to a.sql?");
});

test("sqlCode는 D2Coding code이고 keyword는 색 class를 받는다", () => {
  render(
    <p>
      {sqlCode("sessions")}
      {sqlCode("DELETE", { keyword: true })}
    </p>,
  );

  const plain = screen.getByText("sessions");
  const keyword = screen.getByText("DELETE");
  expect(plain.tagName).toBe("CODE");
  expect(plain).toHaveClass("font-mono", "bg-bg-3");
  expect(plain).not.toHaveClass("text-syntax-keyword");
  expect(keyword).toHaveClass("font-mono", "bg-bg-3", "text-syntax-keyword");
});
