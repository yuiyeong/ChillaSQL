import { useEffect, useId, useRef, type RefObject } from "react";
import { Button } from "./Button";
import {
  resolveDialog,
  useDialogs,
  type DialogAction,
  type DialogItem,
  type DialogSpec,
} from "./dialogs";
import { ClockIcon, WarningIcon } from "./icons";
import { MODAL_PANEL, Scrim } from "./Modal";

const FOCUSABLE = "button:not(:disabled)";

/**
 * 확인 dialog를 그리는 자리. `ask`가 띄운 dialog를 한 번에 하나씩 보인다.
 * App에 한 번만 둔다.
 */
export function DialogHost() {
  const current = useDialogs((state) => state.current);
  return current === null ? null : <Dialog spec={current} />;
}

function Dialog({ spec }: { spec: DialogSpec }) {
  const titleId = useId();
  const bodyId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  // 열려 있는 동안만 쓰는 listener라서 dialog가 바뀌어도 다시 달지 않는다.
  useEffect(() => {
    const before = document.activeElement;
    function onKeyDown(event: KeyboardEvent) {
      // 한글 입력 중에는 key가 "Process"라서 code로 판별한다.
      if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        resolveDialog("cancel");
      } else if (event.code === "Tab") {
        keepFocusInside(event, dialog.current);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  // 처음 focus는 Cancel이다. 다음 차례의 dialog도 Cancel에서 시작한다.
  useEffect(() => cancel.current?.focus(), [spec]);

  return (
    <Scrim
      top
      // 막을 눌러도 focus가 dialog를 떠나지 않는다. dialog 안은 SQL을 선택하고 scrollbar를 끌 수 있어야 하므로 막지 않는다.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={spec.body === undefined ? undefined : bodyId}
        className={`${MODAL_PANEL} max-h-[calc(100vh-108px)]`}
      >
        <Header spec={spec} titleId={titleId} bodyId={bodyId} />
        {spec.sql !== undefined && (
          <pre className="border-line-1 bg-bg-0 text-small text-fg max-h-[188px] overflow-auto rounded-lg border px-3 py-2.5 leading-[1.6] whitespace-pre-wrap">
            {spec.sql}
          </pre>
        )}
        {spec.items !== undefined && <Items items={spec.items} />}
        {spec.note !== undefined && <p className={BODY}>{spec.note}</p>}
        <div className="flex justify-end gap-2">
          {spec.actions.map((action) => (
            <ActionButton key={action.id} action={action} cancel={cancel} />
          ))}
        </div>
      </div>
    </Scrim>
  );
}

const BODY = "text-body text-fg-2 leading-[1.55]";

function Header({
  spec,
  titleId,
  bodyId,
}: {
  spec: DialogSpec;
  titleId: string;
  bodyId: string;
}) {
  const title = (
    <h2 id={titleId} className="text-title text-fg">
      {spec.title}
    </h2>
  );
  const body = spec.body !== undefined && (
    <p id={bodyId} className={BODY}>
      {spec.body}
    </p>
  );
  if (spec.icon === undefined) {
    return (
      <>
        {title}
        {body}
      </>
    );
  }
  return (
    <div className="flex gap-3">
      <span
        data-testid="dialog-icon"
        className="bg-bg-3 text-fg flex size-8 shrink-0 items-center justify-center rounded-lg"
      >
        {spec.icon === "clock" ? (
          <ClockIcon size={16} />
        ) : (
          <WarningIcon size={16} />
        )}
      </span>
      <div className="flex flex-col gap-1">
        {title}
        {body}
      </div>
    </div>
  );
}

function Items({ items }: { items: DialogItem[] }) {
  return (
    // dialog의 높이가 모자라면 목록만 줄어들고 넘치는 줄은 목록 안에서 scroll한다.
    <ul className="border-line-1 bg-bg-0 text-small flex min-h-0 flex-col overflow-auto rounded-lg border">
      {items.map((item, index) => (
        <li
          key={index}
          className="border-line-1 flex h-[34px] shrink-0 items-center gap-2.5 border-b px-3 last:border-b-0"
        >
          {item.marker}
          <span className="text-fg truncate font-mono">{item.primary}</span>
          {item.secondary !== null && (
            <span className="text-fg-2 ml-auto shrink-0">{item.secondary}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function ActionButton({
  action,
  cancel,
}: {
  action: DialogAction;
  cancel: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <>
      {action.spaceBefore === true && <span className="flex-1" />}
      <Button
        ref={action.id === "cancel" ? cancel : undefined}
        variant={action.variant}
        className="focus:outline-accent focus:outline-2 focus:outline-offset-1"
        onClick={() => resolveDialog(action.id)}
      >
        {action.label}
      </Button>
    </>
  );
}

/** Tab이 dialog 밖으로 나가지 않게 한다. 끝에서 넘어가면 반대쪽 끝으로 돌린다. */
function keepFocusInside(event: KeyboardEvent, dialog: HTMLElement | null) {
  const buttons = Array.from(
    dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
  );
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (first === undefined || last === undefined) return;
  const focused = document.activeElement;
  const outside = !(focused instanceof Node && dialog?.contains(focused));
  if (outside || (event.shiftKey ? focused === first : focused === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
