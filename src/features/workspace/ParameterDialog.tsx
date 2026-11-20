import { useId, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { rt } from "../../shared/i18n/rich";
import { t } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { Kbd } from "../../shared/ui/Kbd";
import { noTextCorrection } from "../../shared/ui/noTextCorrection";
import {
  answerParameters,
  useParameterPrompt,
  type ParameterRequest,
} from "./parameterPrompt";
import { shortcutKeys, shortcutLabel } from "./shortcuts";

/** 물음마다 입력란의 state를 새로 시작하려고 request object에 붙이는 번호 */
const serials = new WeakMap<ParameterRequest, number>();
let nextSerial = 0;

function serialOf(request: ParameterRequest): number {
  let serial = serials.get(request);
  if (serial === undefined) {
    serial = nextSerial++;
    serials.set(request, serial);
  }
  return serial;
}

/**
 * 에디터 영역 오른쪽 아래에 뜨는 파라미터 값 물음. 실행에 `:name`이 있으면 `askParameters`가 열고,
 * 에디터 영역 안(`relative`)에 둔다. 캔버스 Tools의 M9 파라미터를 따른다.
 */
export function ParameterDialog() {
  const request = useStore(useParameterPrompt, (s) => s.request);
  if (request === null) return null;
  return <Form key={serialOf(request)} request={request} />;
}

function Form({ request }: { request: ParameterRequest }) {
  const [values, setValues] = useState(request.values);
  const headingId = useId();
  // 앞의 값이 없는 이름이 있으면 그 첫 입력란에, 모두 있으면 첫 입력란에 둔다.
  const firstEmpty = Math.max(
    0,
    request.names.findIndex((name) => values[name].trim() === ""),
  );
  const complete = request.names.every((name) => values[name].trim() !== "");

  function submit() {
    if (complete) answerParameters(values);
  }

  function keyDown(event: KeyboardEvent) {
    // 한글 조합 중의 Enter와 Escape는 조합을 끝내는 key다. key가 "Process"라서 code로 판별한다.
    if (event.nativeEvent.isComposing) return;
    if (event.code === "Escape") {
      event.preventDefault();
      answerParameters(null);
    } else if (event.code === "Enter") {
      // Enter와 Cmd+Enter가 같다. 전역 Run 단축키는 물음이 떠 있는 동안 꺼져 있다.
      event.preventDefault();
      submit();
    }
  }

  return (
    <div
      role="dialog"
      aria-labelledby={headingId}
      className="border-line-2 bg-bg-2 shadow-dialog absolute right-4 bottom-4 z-10 flex w-[330px] flex-col gap-2.5 rounded-[10px] border p-3.5"
      onKeyDown={keyDown}
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
