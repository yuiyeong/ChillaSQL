import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/**
 * 값을 묻는 동안 문서의 `:name` 자리를 표시한다. 빈 배열이면 지운다. 표시는 편집을 따라 옮겨 간다.
 */
export const setParameterMarks =
  StateEffect.define<{ from: number; to: number }[]>();

const mark = Decoration.mark({ class: "cm-parameterMark" });

export const parameterMarksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value;
    for (const effect of tr.effects) {
      if (!effect.is(setParameterMarks)) continue;
      next = Decoration.set(
        effect.value
          .filter(({ from, to }) => from < to)
          .map(({ from, to }) => mark.range(from, to)),
        true,
      );
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
