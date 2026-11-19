/**
 * 화면 문구의 영어 dictionary. 화면 문구는 여기서만 정하고 `t(key)`로 쓴다.
 * key는 `<영역>.<이름>`이다. 개수에 따라 달라지는 문구는 `<이름>.one`과 `<이름>.other`를 짝으로 두고 `tc`로 쓴다.
 * PostgreSQL 오류 메시지, SQL, 설정 파일의 key, 결과 data는 여기 두지 않는다.
 */
export const en = {
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.close": "Close",

  "tunnel.starting": "Starting tunnel",
  "tunnel.seconds": "{elapsed} / {total} s",
  "tunnel.reconnecting": "Reconnecting",
  "tunnel.attempt": "{attempt}/3",
  "tunnel.failed": "Tunnel failed",
  "tunnel.external": "External tunnel",
  "tunnel.externalHint":
    "{target} was already open, so the tunnel command didn't run. ChillaSQL won't close this tunnel when it quits.",
  "tunnel.ranCommand": "Ran the tunnel command. Connects once {target} opens.",
  "tunnel.output": "Command output (stderr)",
  "tunnel.tryAgain": "Try again",
  "tunnel.editConnection": "Edit connection",
  "tunnel.restarting":
    "The tunnel process exited. Running the command again ({attempt}/3).",
  "tunnel.gaveUp": "Ran the tunnel 3 times but it didn't open, so it stopped.",

  "toolbar.label": "Query",
  "toolbar.changeConnection": "Change this tab's connection",
  "toolbar.chooseConnection": "Choose connection",
  "toolbar.connections": "Connections",
  "toolbar.addConnection": "Add connection…",
  "toolbar.runStatement": "Run statement",
  "toolbar.runSelection": "Run selection",
  "toolbar.runFile": "Run file",
  "toolbar.chooseWhatToRun": "Choose what to run",
  "toolbar.whatToRun": "What to run",

  "workspace.resizeResults": "Resize results panel",
  "status.position": "Ln {line}, Col {column}",
  "status.encoding": "UTF-8",
  "status.lineEndingLf": "LF",
  "status.lineEndingCrlf": "CRLF",

  "tabs.defaultTitle": "Query {n}",
  "tabs.list": "Open files",
  "tabs.unsaved": "Unsaved",
  "tabs.close": "Close {title}",
  "tabs.new": "New tab (Shift+Cmd+L)",
  "tabs.saveTitle": "Save {title}",
  "tabs.filePath": "Path inside the project",
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
  "run.emptySelection": "Nothing to run",
  "run.noStatementAtCursor": "No statement at the cursor",
  "run.splitFailed.title": "Couldn't find a statement",
  "run.splitFailed.detail":
    "An unclosed quote keeps the text from being split into statements. Select what to run and it is sent as is.",

  "project.open": "Open Project…",
  "project.missing": "{dir} has no chilla.toml",
  "project.create": "Create chilla.toml",
  "project.chooseAnother": "Choose another folder…",

  "sidebar.label": "Sidebar",
  "sidebar.switchProject": "Switch project",
  "sidebar.connections": "Connections",
  "sidebar.edit": "Edit connection {name}",
  "sidebar.tunnel": "Tunnel",
  "sidebar.addConnection": "Add connection",
  "sidebar.views": "Sidebar view",
  "sidebar.viewFiles": "Files",
  "sidebar.viewSchema": "Schema",
  "sidebar.viewHistory": "History",
  "sidebar.files": "SQL Files",
  "sidebar.refresh": "Refresh file list",

  "connectionForm.titleNew": "New Connection",
  "connectionForm.titleEdit": "Edit {name}",
  "connectionForm.nameFixed": "Name can't be changed",
  "connectionForm.passwordHint": "Saved in Keychain, never in chilla.toml",
  "connectionForm.tunnelHint": "Leave empty to connect directly",
  "connectionForm.tunnelPlaceholder": "ssh -N -L … or another tunnel command",
  "connectionForm.advanced": "Advanced",
  "connectionForm.tunnelTimeoutHint": "Seconds · only with tunnel",
  "connectionForm.sslrootcertHint": "Trust only this CA with verify-full",
  "connectionForm.choose": "Choose…",
  "connectionForm.elapsed": "{ms} ms",
  "connectionForm.connected": "Connected",
  "connectionForm.test": "Test",
  "connectionForm.keepPassword": "Keep saved password",
  "connectionForm.passwordWillClear":
    "You changed where this connection points. Saving deletes the password stored in Keychain. Enter a new password below to save it instead.",
  "connectionForm.required": "Enter {field}",
  "connectionForm.nameTaken":
    "This name is already taken. To edit that connection, open it from the sidebar.",
  "connectionForm.portRange": "port must be a number from 1 to 65535",
  "connectionForm.tunnelTimeoutRange":
    "tunnel_timeout must be a whole number of seconds from 1 to 300",

  "result.hintRun": "Run statement at cursor",
  "result.hintNewTab": "New tab",
  "result.reconnected": "Reconnected",
  "result.reconnectedDetail":
    "This is a new session, so session state such as SET values and temporary tables was reset.",
  "result.connecting": "Connecting…",
  "result.running": "Running {elapsed}",
  "result.waiting": "Waiting for the first row from the server",
  "result.tabs": "Result tabs",
  "result.label": "Result",
  "result.copySelected": "Copy selected cells",
  "result.rows.one": "1 row · {elapsed}",
  "result.rows.other": "{count} rows · {elapsed}",
  "result.rowsMore": "{count}+ rows · {elapsed}",
  "result.inserted.one": "1 row inserted",
  "result.inserted.other": "{count} rows inserted",
  "result.updated.one": "1 row updated",
  "result.updated.other": "{count} rows updated",
  "result.deleted.one": "1 row deleted",
  "result.deleted.other": "{count} rows deleted",
  "result.merged.one": "1 row merged",
  "result.merged.other": "{count} rows merged",
  "result.done": "Done",
  "result.errorLocation": "Ln {line}, Col {column}",
  "result.sqlstate": "SQLSTATE {code}",
  "result.copyMessage": "Copy message",
  "result.cancelled": "Cancelled",
  "result.stopped": "Stopped on the server.",
  "result.stoppedRows.one":
    "Stopped on the server. The 1 row received stays visible.",
  "result.stoppedRows.other":
    "Stopped on the server. The {count} rows received stay visible.",
  "result.discarded": "Results discarded",
  "result.discardedDetail":
    "Running the next query discarded the rows not yet fetched. Run again to see them.",
  "result.expired": "Results closed",
  "result.expiredRows.one":
    "Nothing was fetched for {minutes} minutes, so the query was closed on the database. The 1 row received stays visible.",
  "result.expiredRows.other":
    "Nothing was fetched for {minutes} minutes, so the query was closed on the database. The {count} rows received stay visible.",
  "result.connectionLost": "Connection lost",
  "result.nextRunNewSession":
    "The next run opens a new session. SET values and temp tables are gone.",
  "result.dropped": "Rows 1–{end} were dropped · run again to see them",
  "result.runAgain": "Run again",
  "result.fetchingMore": "Fetching next 500 rows",
  "result.end.one": "End · 1 row",
  "result.end.other": "End · {count} rows",
  "result.resizeColumn": "Resize {name}",

  "toast.copiedMessage": "Copied message",
  "toast.copiedCell": "Copied cell",
  "toast.copiedRows.one": "Copied 1 row (tab-separated)",
  "toast.copiedRows.other": "Copied {count} rows (tab-separated)",
} as const satisfies { [key: string]: string };

export type MessageKey = keyof typeof en;

/** `.one`으로 끝나는 key에서 `.one`을 뗀 것. `tc`가 받는다. */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.one` ? Base : never;
}[MessageKey];
