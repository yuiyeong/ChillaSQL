import { useEffect, useId, useRef, useState } from "react";
import {
  hasPassword,
  saveConnection,
  testConnection,
} from "../../shared/api/commands";
import { pickFile } from "../../shared/api/dialog";
import { CommandError, messageOf } from "../../shared/api/errors";
import type {
  Connection,
  ConnectionColor,
  Project,
  SslMode,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ErrorIcon,
  LockIcon,
} from "../../shared/ui/icons";
import { noTextCorrection } from "../../shared/ui/noTextCorrection";
import { Pre } from "./CommandOutput";
import { CONNECTION_COLORS, connectionColor } from "./colors";
import {
  initialValues,
  targetChanged,
  toConnection,
  type FormValues,
} from "./connectionValues";
import { t } from "../../shared/i18n/t";

/** 입력 칸과 textarea가 같이 쓰는 모양. */
const fieldClass =
  "border-line-2 bg-bg-0 text-fg placeholder:text-fg-3 focus-visible:outline-accent rounded-control text-small w-full border px-2.5 font-mono focus-visible:outline-2 focus-visible:-outline-offset-1 disabled:text-fg-3 disabled:opacity-60";
const inputClass = `${fieldClass} h-8`;
const textareaClass = `${fieldClass} resize-none py-2 leading-normal`;

const groupClass = "border-line-1 flex flex-col gap-2.5 border-t pt-3.5";

const sslmodes: SslMode[] = ["disable", "require", "verify-full"];

/** 테스트 결과. 성공은 걸린 시간, 실패는 message와 터널 명령의 stderr. */
type Notice =
  | { kind: "ok"; elapsedMs: number }
  | { kind: "error"; text: string; output: string | null };

/** 이름표 한 줄과 입력 칸. 오른쪽 설명(`hint`)은 입력 칸의 설명으로 읽힌다. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (ids: {
    id: string;
    describedBy: string | undefined;
  }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="text-small flex justify-between gap-3">
        <label htmlFor={id} className="text-fg-2 font-mono">
          {label}
        </label>
        {hint !== undefined && (
          <span id={hintId} className="text-fg-3 truncate">
            {hint}
          </span>
        )}
      </div>
      {children({ id, describedBy: hint === undefined ? undefined : hintId })}
    </div>
  );
}

/**
 * 접속 색을 고르는 swatch 다섯 개. 고른 swatch를 다시 누르면 색이 없어진다.
 * 새 접속은 Name 옆에 세로로, 수정은 한 줄로 놓는다.
 */
function ColorField({
  value,
  inline,
  onChange,
}: {
  value: ConnectionColor | null;
  inline: boolean;
  onChange(color: ConnectionColor | null): void;
}) {
  return (
    <fieldset
      className={
        inline ? "m-0 flex items-center gap-3 border-0 p-0" : "m-0 border-0 p-0"
      }
    >
      <legend
        className={[
          "text-small text-fg-2 p-0 font-mono",
          inline ? "float-left w-16" : "mb-1.5",
        ].join(" ")}
      >
        color
      </legend>
      <div
        role="radiogroup"
        aria-label="color"
        className={["flex items-center gap-1.5", inline ? "" : "h-8"].join(" ")}
      >
        {CONNECTION_COLORS.map((color) => {
          const checked = value === color;
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={color}
              className="border-bg-2 focus-visible:outline-accent size-[22px] cursor-pointer rounded-full border-2 p-0 focus-visible:outline-2"
              style={{
                background: connectionColor(color),
                boxShadow: checked
                  ? `0 0 0 2px ${connectionColor(color)}`
                  : undefined,
              }}
              onClick={() => onChange(checked ? null : color)}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

/** 접속을 추가하거나(`original`이 null) 고친다. 비밀번호는 이 component의 state에만 둔다. */
export function ConnectionForm({
  original,
  existingNames,
  beforeSave,
  onSaved,
  onClose,
}: {
  original: Connection | null;
  /** 프로젝트에 이미 있는 접속 이름. 새 접속이 이 이름을 쓰지 못하게 한다. */
  existingNames: string[];
  /** 연결 대상을 바꾼 수정을 저장하기 전에 묻는다. false면 저장하지 않는다. */
  beforeSave?(connection: Connection): Promise<boolean>;
  onSaved(project: Project): void;
  onClose(): void;
}) {
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(original),
  );
  const [password, setPassword] = useState("");
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [advanced, setAdvanced] = useState(
    () =>
      original !== null &&
      (original.tunnelTimeout !== null || original.sslrootcert !== null),
  );
  const headingId = useId();
  const sslmodeId = useId();

  // StrictMode가 effect를 두 번 돌려도 hasPassword는 한 번만 부른다.
  const asked = useRef(false);
  useEffect(() => {
    if (original === null || asked.current) return;
    asked.current = true;
    hasPassword(original.name).then(setStored, () => setStored(false));
  }, [original]);

  function edit(patch: Partial<FormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setNotice(null);
  }

  const built = toConnection(values, original, existingNames);
  const passwordWillBeCleared =
    original !== null &&
    stored &&
    password === "" &&
    "connection" in built &&
    targetChanged(built.connection, original);
  const hasTunnel = values.tunnel.trim() !== "";

  async function run(
    action: (connection: Connection, password: string | null) => Promise<void>,
  ) {
    if (busy) return;
    if ("error" in built) {
      setNotice({ kind: "error", text: built.error, output: null });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await action(built.connection, password === "" ? null : password);
    } catch (error) {
      setNotice({
        kind: "error",
        text: messageOf(error),
        output: error instanceof CommandError ? error.output : null,
      });
    } finally {
      setBusy(false);
    }
  }

  const test = () =>
    run(async (connection, secret) => {
      const started = performance.now();
      await testConnection(connection, secret);
      setNotice({
        kind: "ok",
        elapsedMs: Math.round(performance.now() - started),
      });
    });

  const save = () =>
    run(async (connection, secret) => {
      const retargeted =
        original !== null && targetChanged(connection, original);
      if (retargeted && beforeSave && !(await beforeSave(connection))) return;
      const project = await saveConnection(connection, secret);
      setPassword("");
      onSaved(project);
    });

  async function chooseRootCert() {
    const path = await pickFile(["pem", "crt"]);
    if (path !== null) edit({ sslrootcert: path });
  }

  return (
    <form
      aria-labelledby={headingId}
      className="border-line-2 bg-bg-2 text-fg shadow-dialog flex max-h-full w-[600px] flex-col overflow-y-auto rounded-b-[12px] border border-t-0"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="flex items-baseline gap-2.5 px-6 pt-[18px] pb-2.5">
        <h2 id={headingId} className="text-title">
          {original === null
            ? t("connectionForm.titleNew")
            : t("connectionForm.titleEdit", { name: original.name })}
        </h2>
        {original !== null && (
          <span className="text-small text-fg-3">
            {t("connectionForm.nameFixed")}
          </span>
        )}
      </header>

      <div className="flex flex-col gap-3.5 px-6 pt-1 pb-[18px]">
        {original === null ? (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
            <Field label="name">
              {({ id }) => (
                <input
                  id={id}
                  className={inputClass}
                  {...noTextCorrection}
                  value={values.name}
                  onChange={(e) => edit({ name: e.target.value })}
                />
              )}
            </Field>
            <ColorField
              value={values.color}
              inline={false}
              onChange={(color) => edit({ color })}
            />
          </div>
        ) : (
          <ColorField
            value={values.color}
            inline
            onChange={(color) => edit({ color })}
          />
        )}

        <div className={groupClass}>
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2.5">
            <Field label="host">
              {({ id }) => (
                <input
                  id={id}
                  className={inputClass}
                  {...noTextCorrection}
                  value={values.host}
                  onChange={(e) => edit({ host: e.target.value })}
                />
              )}
            </Field>
            <Field label="port">
              {({ id }) => (
                <input
                  id={id}
                  className={inputClass}
                  {...noTextCorrection}
                  inputMode="numeric"
                  value={values.port}
                  onChange={(e) => edit({ port: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="database">
              {({ id }) => (
                <input
                  id={id}
                  className={inputClass}
                  {...noTextCorrection}
                  value={values.database}
                  onChange={(e) => edit({ database: e.target.value })}
                />
              )}
            </Field>
            <Field label="user">
              {({ id }) => (
                <input
                  id={id}
                  className={inputClass}
                  {...noTextCorrection}
                  value={values.user}
                  onChange={(e) => edit({ user: e.target.value })}
                />
              )}
            </Field>
          </div>
          {passwordWillBeCleared && (
            <p
              role="status"
              className="border-line-2 text-small flex items-start gap-2.5 rounded-[8px] border px-3 py-2.5"
            >
              <LockIcon className="mt-px shrink-0" />
              {t("connectionForm.passwordWillClear")}
            </p>
          )}
          <Field label="password" hint={t("connectionForm.passwordHint")}>
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                className={inputClass}
                {...noTextCorrection}
                type="password"
                autoComplete="off"
                value={password}
                placeholder={
                  stored ? t("connectionForm.keepPassword") : undefined
                }
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className={`${groupClass} flex-row items-center gap-3`}>
          <span id={sslmodeId} className="text-small text-fg-2 w-16 font-mono">
            sslmode
          </span>
          <div
            role="radiogroup"
            aria-labelledby={sslmodeId}
            className="border-line-2 bg-bg-0 rounded-control inline-flex gap-0.5 border p-0.5"
          >
            {sslmodes.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={values.sslmode === mode}
                className={[
                  "text-small focus-visible:outline-accent h-[22px] cursor-pointer rounded-[5px] border-0 px-2.5 font-medium focus-visible:outline-2",
                  values.sslmode === mode
                    ? "bg-bg-3 text-fg"
                    : "text-fg-2 bg-transparent",
                ].join(" ")}
                onClick={() => edit({ sslmode: mode })}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div className={groupClass}>
          <Field label="tunnel" hint={t("connectionForm.tunnelHint")}>
            {({ id, describedBy }) => (
              <textarea
                id={id}
                aria-describedby={describedBy}
                className={textareaClass}
                {...noTextCorrection}
                rows={hasTunnel ? 2 : 1}
                placeholder={t("connectionForm.tunnelPlaceholder")}
                value={values.tunnel}
                onChange={(e) => edit({ tunnel: e.target.value })}
              />
            )}
          </Field>
        </div>

        <div className={groupClass}>
          <button
            type="button"
            aria-expanded={advanced}
            className="text-small text-fg-2 focus-visible:outline-accent flex cursor-pointer items-center gap-2 self-start border-0 bg-transparent p-0 focus-visible:outline-2"
            onClick={() => setAdvanced((open) => !open)}
          >
            {advanced ? <ChevronDownIcon /> : <ChevronRightIcon />}
            {t("connectionForm.advanced")}
            {!advanced && (
              <span className="text-fg-3 font-mono">
                tunnel_timeout · sslrootcert
              </span>
            )}
          </button>
          {advanced && (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <Field
                  label="tunnel_timeout"
                  hint={t("connectionForm.tunnelTimeoutHint")}
                >
                  {({ id, describedBy }) => (
                    <input
                      id={id}
                      aria-describedby={describedBy}
                      className={inputClass}
                      {...noTextCorrection}
                      inputMode="numeric"
                      placeholder="20"
                      disabled={!hasTunnel}
                      value={values.tunnelTimeout}
                      onChange={(e) => edit({ tunnelTimeout: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <Field
                label="sslrootcert"
                hint={t("connectionForm.sslrootcertHint")}
              >
                {({ id, describedBy }) => (
                  <span className="flex gap-2">
                    <input
                      id={id}
                      aria-describedby={describedBy}
                      className={inputClass}
                      {...noTextCorrection}
                      value={values.sslrootcert}
                      disabled={values.sslmode !== "verify-full"}
                      onChange={(e) => edit({ sslrootcert: e.target.value })}
                    />
                    <Button
                      className="h-8"
                      disabled={values.sslmode !== "verify-full"}
                      onClick={() => void chooseRootCert()}
                    >
                      {t("connectionForm.choose")}
                    </Button>
                  </span>
                )}
              </Field>
            </>
          )}
        </div>
      </div>

      {notice !== null &&
        (notice.kind === "ok" ? (
          <p
            role="status"
            className="border-line-2 bg-bg-0 text-small mx-6 mb-3.5 flex items-center gap-2.5 rounded-[8px] border px-3 py-2.5"
          >
            <CheckIcon className="shrink-0" size={15} />
            {t("connectionForm.connected")}
            <span className="flex-1" />
            <span className="text-fg-2 font-mono">
              {t("connectionForm.elapsed", { ms: notice.elapsedMs })}
            </span>
          </p>
        ) : (
          <div
            role="alert"
            className="border-line-2 bg-bg-0 text-small mx-6 mb-3.5 flex flex-col gap-2 rounded-[8px] border px-3 py-2.5"
          >
            <span className="text-body flex items-start gap-2 font-medium">
              <ErrorIcon className="text-fg-2 mt-1 shrink-0" size={15} />
              <span>{notice.text}</span>
            </span>
            {notice.output !== null && notice.output !== "" && (
              <Pre>{notice.output}</Pre>
            )}
          </div>
        ))}

      <footer className="border-line-1 flex items-center gap-2 border-t px-6 py-3.5">
        <Button disabled={busy} onClick={() => void test()}>
          {t("connectionForm.test")}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("common.save")}
        </Button>
      </footer>
    </form>
  );
}
