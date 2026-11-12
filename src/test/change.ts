import { fireEvent } from "@testing-library/react";

/** input, select의 값을 바꾸고 change event를 보낸다. */
export function change(element: Element, value: string): void {
  fireEvent.change(element, { target: { value } });
}
