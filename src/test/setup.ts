import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom에는 ResizeObserver가 없다. layout이 없으니 알릴 크기 변화도 없다.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom에는 scrollIntoView가 없다. 스크롤할 layout도 없으니 아무것도 하지 않는다.
Element.prototype.scrollIntoView ??= function () {};

afterEach(cleanup);
