import { EditorState, StateEffect, StateField } from "@codemirror/state";
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

/**
 * 값을 묻는 동안 그 문서를 고칠 수 없게 한다. 물음에 쓴 문장의 문서 위치(`from`)가 편집으로 어긋나지
 * 않게 하려는 것이다. 커서와 선택은 움직일 수 있다. 프로젝트 전환의 잠금(`editorEditable`)과 따로이므로
 * 글자를 넣는 transaction을 걸러서 막는다.
 */
export const setParameterLock = StateEffect.define<boolean>();

export const parameterLockField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setParameterLock)) value = effect.value;
    }
    return value;
  },
  provide: (field) =>
    EditorState.transactionFilter.of((tr) =>
      tr.docChanged && tr.startState.field(field) ? [] : tr,
    ),
});
