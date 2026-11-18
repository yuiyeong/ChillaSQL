/**
 * 화면 문구의 영어 dictionary. 화면 문구는 여기서만 정하고 `t(key)`로 쓴다.
 * key는 `<영역>.<이름>`이다. 개수에 따라 달라지는 문구는 `<이름>.one`과 `<이름>.other`를 짝으로 두고 `tc`로 쓴다.
 * PostgreSQL 오류 메시지, SQL, 설정 파일의 key, 결과 data는 여기 두지 않는다.
 */
export const en = {
  "common.cancel": "Cancel",
  "common.save": "Save",

  "toolbar.label": "Query",
  "toolbar.connection": "Connection",
  "toolbar.noConnection": "No connection",
  "toolbar.runStatement": "Run statement",

  "workspace.emptyEditor": "Press Shift+Cmd+L for a new tab",

  "tabs.defaultTitle": "Query {n}",
  "tabs.unsaved": "Unsaved changes",
  "tabs.close": "Close {title}",
  "tabs.new": "New tab",
  "tabs.filePath": "File path",
  "tabs.filePathPlaceholder": "queries/name.sql",

  "dialog.discardTab": "Discard unsaved changes to {title}?",
  "dialog.discardForProject.one":
    "1 tab has unsaved changes. Discard it and open another project?",
  "dialog.discardForProject.other":
    "{count} tabs have unsaved changes. Discard them and open another project?",
  "dialog.fileDeleted":
    "{path} was deleted from disk after you opened it. Recreate it with this tab's contents?",
  "dialog.fileChanged":
    "{path} was edited by another program after you opened it. Overwriting discards those changes.",

  "run.noConnection": "Choose a connection to run queries.",
  "run.emptySelection": "The selection has no statement to run",
  "run.noStatementAtCursor": "Couldn't find a statement at the cursor",

  "project.open": "Open Project…",
  "project.missing": "{dir} has no chilla.toml",
  "project.create": "Create chilla.toml",
  "project.chooseAnother": "Choose another folder…",

  "sidebar.switchProject": "Switch project",
  "sidebar.connections": "Connections",
  "sidebar.edit": "Edit",
  "sidebar.addConnection": "Add connection…",
  "sidebar.files": "SQL Files",
  "sidebar.refresh": "Refresh",

  "connectionForm.connected": "Connected",
  "connectionForm.test": "Test",
  "connectionForm.keepPassword": "Keep saved password",
  "connectionForm.passwordWillClear":
    "Changing the connection target deletes the saved password. Enter the password again",
  "connectionForm.required": "Enter {field}",
  "connectionForm.nameTaken":
    "This name is already taken. To edit that connection, open it from the sidebar.",
  "connectionForm.portRange": "port must be a number from 1 to 65535",

  "result.idle": "Press Cmd+Enter to run",
  "result.connecting": "Connecting…",
  "result.running": "Running…",
  "result.shown.one": "1 row shown · more available",
  "result.shown.other": "{count} rows shown · more available",
  "result.affected.one": "1 row affected · {elapsed}",
  "result.affected.other": "{count} rows affected · {elapsed}",
  "result.rows.one": "1 row · {elapsed}",
  "result.rows.other": "{count} rows · {elapsed}",
  "result.errorLocation": "Ln {line}, Col {column}",
  "result.cancelled": "Cancelled · {elapsed}",
  "result.discarded": "Results discarded",
  "result.connectionLost": "Connection lost: {message}",
  "result.nextRunNewSession": "The next run opens a new session",
  "result.dropped": "Rows 1–{end} were dropped · run again to see them",

  "toast.copiedRows.one": "Copied 1 row (tab-separated)",
  "toast.copiedRows.other": "Copied {count} rows (tab-separated)",
} as const satisfies { [key: string]: string };

export type MessageKey = keyof typeof en;

/** `.one`으로 끝나는 key에서 `.one`을 뗀 것. `tc`가 받는다. */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.one` ? Base : never;
}[MessageKey];
