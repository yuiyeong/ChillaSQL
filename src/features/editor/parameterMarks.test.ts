import { EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { expect, test } from "vitest";
import { parameterMarksField, setParameterMarks } from "./parameterMarks";

function rangesOf(set: DecorationSet): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  set.between(0, 1000, (from, to) => {
    out.push({ from, to });
  });
  return out;
}

test("marks_follow_edits_and_clear", () => {
  let state = EditorState.create({
    doc: "SELECT :id, :since",
    extensions: [parameterMarksField],
  });
  expect(state.field(parameterMarksField)).toBe(Decoration.none);

  state = state.update({
    effects: setParameterMarks.of([
      { from: 7, to: 10 },
      { from: 12, to: 18 },
    ]),
  }).state;
  expect(rangesOf(state.field(parameterMarksField))).toEqual([
    { from: 7, to: 10 },
    { from: 12, to: 18 },
  ]);

  // 앞에 글자를 넣으면 밀리고, 표시 안에서 지우면 줄어든다.
  state = state.update({ changes: { from: 0, insert: "-- x\n" } }).state;
  expect(rangesOf(state.field(parameterMarksField))).toEqual([
    { from: 12, to: 15 },
    { from: 17, to: 23 },
  ]);
  state = state.update({ changes: { from: 13, to: 14 } }).state;
  expect(rangesOf(state.field(parameterMarksField))[0]).toEqual({
    from: 12,
    to: 14,
  });

  state = state.update({ effects: setParameterMarks.of([]) }).state;
  expect(rangesOf(state.field(parameterMarksField))).toEqual([]);
});
