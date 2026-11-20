import {
  type Extension,
  StateEffect,
  StateField,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { splitStatements } from "../../shared/api/commands";
import { isCommandError } from "../../shared/api/errors";
import type { StatementSpan } from "../../shared/api/types";
import { statementAt } from "./statementAt";

/** 마지막 문서 변경 뒤 문장을 다시 나누기까지 기다리는 시간. */
const RESPLIT_DELAY_MS = 150;

export interface StatementSpans {
  /** 나눈 문장. 문장을 나눌 수 없으면(닫히지 않은 따옴표) null이다. */
  spans: StatementSpan[] | null;
  /** spans가 지금 문서에 맞는다. false면 마지막으로 나눈 뒤의 편집을 따라 옮긴 값이다. */
  fresh: boolean;
}

/** 문서가 `spans`로 나뉜다고(null은 나눌 수 없다고) 알린다. 나눈 문서가 아직 그대로일 때만 보낸다. */
export const setStatementSpans = StateEffect.define<StatementSpan[] | null>();

/**
 * 문서의 문장 범위. 커서를 옮길 때마다 나누지 않으려고 문서에 두고, 편집하면 위치만 옮겨서
 * (`fresh: false`) 새로 나눈 결과가 올 때까지 쓴다. Rust로 문서 전체를 보내는 IPC라서 10k줄에 40ms쯤 든다.
 */
export const statementSpansField = StateField.define<StatementSpans>({
  create: () => ({ spans: null, fresh: false }),
  update(value, tr) {
    if (tr.docChanged) {
      // 문장 앞에서 입력하면 문장이 밀리고, 끝에서 입력하면 문장이 늘어난다.
      const spans =
        value.spans?.map((s) => ({
          start: tr.changes.mapPos(s.start, 1),
          end: tr.changes.mapPos(s.end, 1),
        })) ?? null;
      return { spans, fresh: false };
    }
    for (const effect of tr.effects) {
      if (effect.is(setStatementSpans)) {
        return { spans: effect.value, fresh: true };
      }
    }
    return value;
  },
});

/**
 * 마지막 문서 변경 150ms 뒤에 문장을 나눠 field에 넣는다. 나누는 동안 문서가 바뀌었으면 결과를
 * 버린다. 보이는 문서에서만 돈다. 탭을 바꿔 보이면 plugin이 새로 만들어지므로, 그때 field가
 * fresh가 아니면(문서를 처음 열 때) 바로 나눈다.
 */
export const statementSpansPlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      if (!view.state.field(statementSpansField).fresh) void this.split();
    }

    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.split(), RESPLIT_DELAY_MS);
    }

    destroy() {
      this.destroyed = true;
      if (this.timer !== null) clearTimeout(this.timer);
    }

    private async split() {
      this.timer = null;
      const doc = this.view.state.doc;
      let spans: StatementSpan[] | null;
      try {
        spans = await splitStatements(doc.toString());
      } catch (error) {
        // 나눌 수 없는 문서만 spans를 비운다. 그 밖의 오류는 옮긴 span을 그대로 둔다.
        if (!isCommandError(error, "split_failed")) return;
        spans = null;
      }
      if (this.destroyed || this.view.state.doc !== doc) return;
      this.view.dispatch({ effects: setStatementSpans.of(spans) });
    }
  },
);

/** 선택 영역이 없을 때, 커서 문장이 걸친 줄을 강조한다. 실행하면 이 범위가 실행된다. */
export const runRangeHighlight: Extension = EditorView.decorations.compute(
  [statementSpansField, "selection"],
  (state) => {
    const { spans } = state.field(statementSpansField);
    const { from, to, head } = state.selection.main;
    if (spans === null || from !== to) return Decoration.none;
    const span = statementAt(state.doc, spans, head);
    if (span === null) return Decoration.none;
    const mark = Decoration.line({ class: "cm-runRange" });
    const lines: Range<Decoration>[] = [];
    const last = state.doc.lineAt(span.end).number;
    for (let n = state.doc.lineAt(span.start).number; n <= last; n++) {
      lines.push(mark.range(state.doc.line(n).from));
    }
    return Decoration.set(lines);
  },
);
