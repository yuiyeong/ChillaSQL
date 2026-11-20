import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { noTextCorrection } from "../../shared/ui/noTextCorrection";

interface CellEditorProps {
  /** `aria-label` */
  label: string;
  /** 처음 값. 줄이지 않은 전체 값이다(NULL은 빈 문자열). */
  value: string;
  /** 셀과 같은 left, top, width. 높이는 행 높이다. */
  style: CSSProperties;
  onCommit(value: string): void;
  onCancel(): void;
}

/**
 * 결과 표의 셀 위에 겹쳐 그리는 editor(캔버스 Tools M10의 셀 편집). `Enter`는 확정, `Opt+Enter`는
 * 줄바꿈, `Esc`는 취소, 바깥을 누르면(blur) 확정이다. 고치는 값은 이 element가 들고 있어서
 * 가상 스크롤이 그 행을 지워도 남는다.
 */
export function CellEditor({
  label,
  value,
  style,
  onCommit,
  onCancel,
}: CellEditorProps) {
  // 확정이나 취소는 한 번만이다. 취소한 뒤 focus가 표로 가며 오는 blur는 확정이 아니다.
  const done = useRef(false);

  const finish = (commit: boolean, element: HTMLTextAreaElement) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(element.value);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중의 Enter는 조합을 끝낼 뿐이다. WKWebView는 조합을 끝내는 Enter에 isComposing을
    // false로 보내므로 keyCode 229도 본다(ParameterDialog와 같다).
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    const element = event.currentTarget;
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.altKey) {
        element.setRangeText(
          "\n",
          element.selectionStart,
          element.selectionEnd,
          "end",
        );
      } else {
        finish(true, element);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      // 값 보기 panel을 닫는 Escape가 아니다.
      event.stopPropagation();
      finish(false, element);
    }
  };

  return (
    <textarea
      aria-label={label}
      defaultValue={value}
      autoFocus
      rows={1}
      {...noTextCorrection}
      className="bg-bg-0 text-small text-fg absolute m-0 box-border h-[26px] resize-none border-0 px-2.5 font-mono leading-[25px] shadow-[inset_0_0_0_1.5px_var(--color-accent)] outline-none select-text"
      style={style}
      onKeyDown={onKeyDown}
      onBlur={(event) => finish(true, event.currentTarget)}
    />
  );
}
