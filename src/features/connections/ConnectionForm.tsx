import { useEffect, useRef, useState } from "react";
import {
  hasPassword,
  saveConnection,
  testConnection,
} from "../../shared/api/commands";
import { messageOf } from "../../shared/api/errors";
import type { Connection, Project, SslMode } from "../../shared/api/types";
import { noTextCorrection } from "../../shared/ui/noTextCorrection";
import {
  initialValues,
  targetChanged,
  toConnection,
  type FormValues,
} from "./connectionValues";
import { t } from "../../shared/i18n/t";

const buttonClass =
  "rounded bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600 focus-visible:outline-2 focus-visible:outline-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-zinc-700";
const inputClass =
  "w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:outline-zinc-400 disabled:opacity-50";

const sslmodes: SslMode[] = ["disable", "require", "verify-full"];

type Notice = { kind: "ok" | "error"; text: string };

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-zinc-300">
      {label}
      {children}
    </label>
  );
}

/** 접속을 추가하거나(`original`이 null) 고친다. 비밀번호는 이 component의 state에만 둔다. */
export function ConnectionForm({
  original,
  existingNames,
  onSaved,
  onClose,
}: {
  original: Connection | null;
  /** 프로젝트에 이미 있는 접속 이름. 새 접속이 이 이름을 쓰지 못하게 한다. */
  existingNames: string[];
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

  async function run(
    action: (connection: Connection, password: string | null) => Promise<void>,
  ) {
    if (busy) return;
    if ("error" in built) {
      setNotice({ kind: "error", text: built.error });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await action(built.connection, password === "" ? null : password);
    } catch (error) {
      setNotice({ kind: "error", text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  const test = () =>
    run(async (connection, secret) => {
      await testConnection(connection, secret);
      setNotice({ kind: "ok", text: t("connectionForm.connected") });
    });

  const save = () =>
    run(async (connection, secret) => {
      const project = await saveConnection(connection, secret);
      setPassword("");
      onSaved(project);
    });

  return (
    <form
      className="flex w-96 flex-col gap-3 rounded border border-zinc-700 bg-zinc-800 p-4 text-zinc-100"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="name">
        <input
          className={inputClass}
          {...noTextCorrection}
          value={values.name}
          disabled={original !== null}
          onChange={(e) => edit({ name: e.target.value })}
        />
      </Field>
      <Field label="host">
        <input
          className={inputClass}
          {...noTextCorrection}
          value={values.host}
          onChange={(e) => edit({ host: e.target.value })}
        />
      </Field>
      <Field label="port">
        <input
          className={inputClass}
          {...noTextCorrection}
          inputMode="numeric"
          value={values.port}
          onChange={(e) => edit({ port: e.target.value })}
        />
      </Field>
      <Field label="database">
        <input
          className={inputClass}
          {...noTextCorrection}
          value={values.database}
          onChange={(e) => edit({ database: e.target.value })}
        />
      </Field>
      <Field label="user">
        <input
          className={inputClass}
          {...noTextCorrection}
          value={values.user}
          onChange={(e) => edit({ user: e.target.value })}
        />
      </Field>
      <Field label="password">
        <input
          className={inputClass}
          {...noTextCorrection}
          type="password"
          autoComplete="off"
          value={password}
          placeholder={stored ? t("connectionForm.keepPassword") : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="sslmode">
        <select
          className={inputClass}
          value={values.sslmode}
          onChange={(e) => edit({ sslmode: e.target.value as SslMode })}
        >
          {sslmodes.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </Field>
      <Field label="sslrootcert">
        <input
          className={inputClass}
          {...noTextCorrection}
          value={values.sslrootcert}
          disabled={values.sslmode !== "verify-full"}
          onChange={(e) => edit({ sslrootcert: e.target.value })}
        />
      </Field>

      {passwordWillBeCleared && (
        <p className="text-sm text-amber-400">
          {t("connectionForm.passwordWillClear")}
        </p>
      )}
      {notice !== null && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "text-sm text-red-400"
              : "text-sm text-green-400"
          }
        >
          {notice.text}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass} onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void test()}
        >
          {t("connectionForm.test")}
        </button>
        <button type="submit" className={buttonClass} disabled={busy}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}
