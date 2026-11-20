import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { rt } from "../../shared/i18n/rich";
import { t } from "../../shared/i18n/t";
import { viewShowing } from "../editor/documents";
import { useTabs } from "../editor/tabsStore";
import { Button } from "../../shared/ui/Button";
import { isImeComposing } from "../../shared/ui/ime";
import { Kbd } from "../../shared/ui/Kbd";
import { noTextCorrection } from "../../shared/ui/noTextCorrection";
import {
  answerParameters,
  useParameterPrompt,
  type ParameterRequest,
} from "./parameterPrompt";
import { commandFor, shortcutKeys, shortcutLabel } from "./shortcuts";

/**
 * 에디터 영역 오른쪽 아래에 뜨는 파라미터 값 물음. 실행에 `:name`이 있으면 `askParameters`가 열고,
 * 에디터 영역 안(`relative`)에 둔다. 캔버스 Tools의 M9 파라미터를 따른다.
 */
export function ParameterDialog() {
  const request = useStore(useParameterPrompt, (s) => s.request);
  // 물음이 닫히면(Run, Cancel) 그 탭이 아직 활성일 때 에디터로 focus를 돌린다. 다른 물음으로 바뀐 것은
  // 닫힌 것이 아니다.
  const askedTab = useRef<string | null>(null);
  useEffect(() => {
    if (request !== null) {
      askedTab.current = request.tabId;
      return;
    }
    const tabId = askedTab.current;
    askedTab.current = null;
    if (tabId !== null && useTabs.getState().activeId === tabId) {
      viewShowing(tabId)?.focus();
    }
  }, [request]);
  if (request === null) return null;
  return <Form key={request.id} request={request} />;
}

function Form({ request }: { request: ParameterRequest }) {
  const [values, setValues] = useState(request.values);
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // 앞의 값이 없는 이름이 있으면 그 첫 입력란에, 모두 있으면 첫 입력란에 둔다.
  const firstEmpty = Math.max(
    0,
    request.names.findIndex((name) => values[name].trim() === ""),
  );
  const complete = request.names.every((name) => values[name].trim() !== "");

  // 물음이 떠 있는 동안은 focus가 어디 있든 Esc와 Run 단축키가 듣는다. Enter는 이 dialog의 입력란에서만
  // 보낸다(에디터의 Enter는 줄바꿈이고, 버튼의 Enter는 그 버튼을 누르는 것이다). 전역 단축키는 물음이
  // 떠 있는 동안 꺼져 있다.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      // 한글 조합 중의 key는 조합을 끝내는 것이다. key가 "Process"라서 code로 판별한다.
      if (isImeComposing(event)) return;
      if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        answerParameters(null);
      } else {
        const inField =
          event.code === "Enter" &&
          event.target instanceof HTMLInputElement &&
          dialogRef.current?.contains(event.target) === true;
        if (!inField && commandFor(event) !== "run") return;
        event.preventDefault();
        event.stopPropagation();
        if (complete) answerParameters(values);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [values, complete]);

  function submit() {
    if (complete) answerParameters(values);
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-labelledby={headingId}
      className="border-line-2 bg-bg-2 shadow-dialog absolute right-4 bottom-4 z-10 flex w-[330px] flex-col gap-2.5 rounded-[10px] border p-3.5"
    >
      <h2 id={headingId} className="text-body font-semibold">
        {t("params.title")}
      </h2>
      {request.names.map((name, index) => (
        <label
          key={name}
          className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2"
        >
          <span className="text-small truncate font-mono">:{name}</span>
          <input
            autoFocus={index === firstEmpty}
            {...noTextCorrection}
            className="border-line-2 bg-bg-0 text-fg focus-visible:outline-accent rounded-control text-small h-[30px] w-full border px-2.5 font-mono focus-visible:outline-2 focus-visible:-outline-offset-1"
            value={values[name]}
            onChange={(event) =>
              setValues({ ...values, [name]: event.target.value })
            }
          />
        </label>
      ))}
      <span className="text-label text-fg-2">
        {rt("params.note", {
          cast: (
            <code className="bg-bg-3 border-line-2 rounded-[4px] border px-[5px] py-px font-mono whitespace-nowrap">
              ::date
            </code>
          ),
        })}
      </span>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => answerParameters(null)}>
          {t("params.cancel")}
        </Button>
        <Button
          variant="primary"
          size="kbd"
          disabled={!complete}
          aria-keyshortcuts={shortcutKeys("run")}
          onClick={submit}
        >
          {t("params.run")}
          <Kbd>{shortcutLabel("run")}</Kbd>
        </Button>
      </div>
    </div>
  );
}
