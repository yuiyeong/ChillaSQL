import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// docs/design/README.md 표의 값이다. test는 저장소 루트에서 실행한다.
const FONTS = {
  "D2Coding-Regular.ttf":
    "d5f2b6bf5b1826cfbf3734c70582f0cd42ea2e1d6c2636ae681b612bc9c5682f",
  "D2Coding-Bold.ttf":
    "14a0cfa4d96fbd976bc4b1a6ef81e51df353a1689d5273ebcd908c857a4f2752",
};

test.each(Object.entries(FONTS))(
  "public/fonts/%s는 디자인 원본과 같다",
  (name, sha256) => {
    const bytes = readFileSync(`public/fonts/${name}`);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  },
);

test("OFL.txt가 font와 함께 있다", () => {
  expect(existsSync("public/fonts/OFL.txt")).toBe(true);
});
