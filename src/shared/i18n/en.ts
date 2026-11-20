/**
 * 화면 문구의 영어 dictionary. 화면 문구는 여기서만 정하고 `t(key)`로 쓴다.
 * key는 `<영역>.<이름>`이다. 개수에 따라 달라지는 문구는 `<이름>.one`과 `<이름>.other`를 짝으로 두고 `tc`로 쓴다.
 * 0개일 때 다른 문구가 필요하면 `<이름>.none`을 더한다.
 * PostgreSQL 오류 메시지, SQL, 설정 파일의 key, 결과 data는 여기 두지 않는다.
 * `error.<kind>`는 Rust `CommandError`의 kind별 문구다. 영어는 Rust message와 같고, 빈칸 이름은
 * `errorKinds.json`의 param 이름이다. 한 kind가 여러 message를 묶으면 `{message}`가 message 전체다.
 */
export const en = {
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.close": "Close",
  "common.ok": "OK",
  "common.readOnly": "Read-only",

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
  "toolbar.reformat": "Reformat (Opt+Cmd+L)",
  "toolbar.explain": "Explain plan (EXPLAIN ANALYZE)",

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

  "params.title": "Parameter values",
  "params.note":
    "Values are inserted as SQL. Quote strings. {cast} is a cast, not a parameter.",
  "params.run": "Run",
  "params.cancel": "Cancel",

  "dialog.closeTab.title": "Save changes to {title}?",
  "dialog.closeTab.body": "Your changes will be lost if you don't save them.",
  "dialog.closeTab.discard": "Don't save",
  "dialog.switchProject.title.one": "1 tab has unsaved changes",
  "dialog.switchProject.title.other": "{count} tabs have unsaved changes",
  "dialog.switchProject.note":
    "Switching projects discards these changes and closes every tab's session.",
  "dialog.switchProject.confirm": "Switch without saving",
  "dialog.tx.oneTab.title": "This tab has an open transaction",
  "dialog.tx.close.body":
    "Closing {title} closes the {connection} session. {question}",
  "dialog.tx.switchConnection.body":
    "Switching to {target} closes the {connection} session. {question}",
  "dialog.tx.switchMode.title": "End the transaction before switching to Auto",
  "dialog.tx.saveTarget.title":
    "A tab using this connection has an open transaction",
  "dialog.tx.saveTarget.body":
    "Saving a new target closes the sessions of tabs using {connection}. {question}",
  "dialog.tx.switchProject.title": "A tab has an open transaction",
  "dialog.tx.switchProject.body":
    "Switching projects closes every tab's session. {question}",
  "dialog.tx.question.one":
    "What should happen to the 1 uncommitted statement?",
  "dialog.tx.question.other":
    "What should happen to the {count} uncommitted statements?",
  "dialog.tx.question.none": "What should happen to the open transaction?",
  "dialog.tx.questionIn.one":
    "What should happen to the 1 uncommitted statement in {title}?",
  "dialog.tx.questionIn.other":
    "What should happen to the {count} uncommitted statements in {title}?",
  "dialog.tx.questionIn.none":
    "What should happen to the open transaction in {title}?",
  "dialog.tx.manyTabs.title.one": "1 tab has an open transaction",
  "dialog.tx.manyTabs.title.other": "{count} tabs have open transactions",
  "dialog.tx.manyTabs.item": "{connection} · {statements} · {elapsed}",
  "dialog.tx.manyTabs.note":
    "To decide tab by tab, cancel and use Commit or Rollback in each tab.",
  "dialog.tx.rollback.close": "Roll back and close",
  "dialog.tx.rollback.switch": "Roll back and switch",
  "dialog.tx.rollback.save": "Roll back and save",
  "dialog.tx.commit.close": "Commit and close",
  "dialog.tx.commit.switch": "Commit and switch",
  "dialog.tx.commit.save": "Commit and save",
  "dialog.tx.rollbackAll.close": "Roll back all and close",
  "dialog.tx.rollbackAll.switch": "Roll back all and switch",
  "dialog.tx.rollbackAll.save": "Roll back all and save",
  "dialog.tx.rollbackAll.quit": "Roll back all and quit",
  "dialog.danger.title.withoutWhere": "Run {verb} without {where}?",
  "dialog.danger.title.drop": "Run {drop}?",
  "dialog.danger.title.truncate": "Run {truncate}?",
  "dialog.danger.first.delete":
    "This deletes every row in {tables} on {connection}.",
  "dialog.danger.first.update":
    "This updates every row in {tables} on {connection}.",
  "dialog.danger.first.drop": "This drops {names} on {connection}.",
  "dialog.danger.first.dropOwned":
    "This drops every object owned by {names} on {connection}.",
  "dialog.danger.second.reversible":
    "You're inside an open transaction, so you can roll it back until you commit.",
  "dialog.danger.second.final":
    "Auto mode commits it immediately, and {emphasis}.",
  "dialog.danger.second.final.emphasis": "it can't be undone",
  "dialog.danger.body": "{first} {second}",
  "dialog.danger.run": "Run",
  "dialog.fileChanged.title": "{path} changed on disk",
  "dialog.fileChanged.body":
    "Another program edited this file after you opened it. Overwriting discards those changes.",
  "dialog.fileChanged.confirm": "Overwrite",
  "dialog.fileDeleted.title": "{path} was deleted",
  "dialog.fileDeleted.body":
    "It was deleted from disk after you opened it. Recreate it with this tab's contents?",
  "dialog.fileDeleted.confirm": "Recreate",

  "run.noConnection": "Choose a connection to run queries.",
  "run.emptySelection": "Nothing to run",
  "run.emptyFile": "Nothing to run",
  "run.noStatementAtCursor": "No statement at the cursor",
  "run.explainOneStatement":
    "Explain runs one statement. Select a single statement.",
  "run.splitFailed.title": "Couldn't find a statement",
  "run.splitFailed.detail":
    "An unclosed quote keeps the text from being split into statements. Select what to run and it is sent as is.",

  "project.openShortcut": "Open Project…",
  "project.recent": "Recent Projects",
  "project.recentShort": "Recent",
  "project.missingTitle": "{dir} has no chilla.toml",
  "project.missingBody":
    "Create a chilla.toml with only [project] and open the folder as a project. Add connections after it opens.",
  "project.create": "Create chilla.toml",
  "project.chooseAnother": "Choose another folder…",
  "when.justNow": "Just now",
  "when.today": "Today",
  "when.yesterday": "Yesterday",

  "sidebar.label": "Sidebar",
  "sidebar.switchProject": "Switch project",
  "sidebar.projects": "Projects",
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
  "history.label": "Query history",
  "history.search": "Search history",
  "history.openInEditor": "Open in editor",
  "history.empty": "Queries you run appear here",
  "history.noMatch": "No queries match",
  "schema.label": "Schema",
  "schema.refresh": "Refresh schema",
  "schema.noConnection": "No connection in this tab",
  "schema.chooseConnection": "Choose connection",
  "schema.loading": "Loading",
  "schema.retry": "Retry",
  "schema.empty": "None",
  "schema.group.tables": "Tables",
  "schema.group.views": "Views",
  "schema.group.columns": "Columns",
  "schema.group.indexes": "Indexes",
  "schema.group.constraints": "Constraints",
  "schema.unique": "unique",
  "schema.materialized": "materialized",
  "schema.menu.selectFirstRows": "Select first rows",
  "schema.menu.doubleClick": "Double-click",
  "schema.menu.showDdl": "Show DDL",
  "schema.menu.copyName": "Copy name",
  "schema.copied": "Copied {name}",
  "completion.view": "view",
  "completion.insert": "Insert",
  "completion.close": "Close",
  "completion.legend": "s schema · c column · t table · f function · k keyword",

  "connectionForm.titleNew": "New Connection",
  "connectionForm.titleEdit": "Edit {name}",
  "connectionForm.nameFixed": "Name can't be changed",
  "connectionForm.passwordHint": "Saved in Keychain, never in chilla.toml",
  "connectionForm.tunnelHint": "Leave empty to connect directly",
  "connectionForm.tunnelPlaceholder": "ssh -N -L … or another tunnel command",
  "connectionForm.readOnlyHint":
    "Opens sessions read-only so the database rejects writes",
  "connectionForm.advanced": "Advanced",
  "connectionForm.advancedKeys":
    "statement_timeout · tunnel_timeout · sslrootcert",
  "connectionForm.statementTimeoutHint": "Seconds. Empty means none",
  "connectionForm.tunnelTimeoutHint": "Seconds · only with tunnel",
  "connectionForm.sslrootcertHint": "Trust only this CA with verify-full",
  "connectionForm.choose": "Choose…",
  "connectionForm.elapsed": "{ms} ms",
  "connectionForm.connectedVersion": "Connected · PostgreSQL {version}",
  "connectionForm.test": "Test",
  "connectionForm.keepPassword": "Keep saved password",
  "connectionForm.passwordWillClear":
    "You changed where this connection points. Saving deletes the password stored in Keychain. Enter a new password below to save it instead.",
  "connectionForm.savedButNotApplied":
    "Saved to chilla.toml, but the commit failed. Tabs using this connection stay on the previous target until you save again.",
  "connectionForm.required": "Enter {field}",
  "connectionForm.nameTaken":
    "This name is already taken. To edit that connection, open it from the sidebar.",
  "connectionForm.portRange": "port must be a number from 1 to 65535",
  "connectionForm.statementTimeoutRange":
    "statement_timeout must be 1 to 86400 seconds",
  "connectionForm.tunnelTimeoutRange":
    "tunnel_timeout must be a whole number of seconds from 1 to 300",

  "result.hintRun": "Run statement at cursor",
  "result.hintNewTab": "New tab",
  "result.hintReformat": "Reformat",
  "result.reconnected": "Reconnected",
  "result.reconnectedDetail":
    "This is a new session, so session state such as SET values and temporary tables was reset.",
  "result.connecting": "Connecting…",
  "result.running": "Running {elapsed}",
  "result.waiting": "Waiting for the first row from the server",
  "result.tabs": "Result tabs",
  "result.label": "Result",
  "result.notRun": "Not run",
  "result.errorTab": "Error",
  "result.stoppedAt": "Stopped at statement {n}.",
  "result.notRunRest.one": "Statement {first} was not run.",
  "result.notRunRest.other": "Statements {first}–{last} were not run.",
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
  "result.timedOut": "Timed out",
  "result.timeoutDetail": "This connection's statement_timeout is {secs}s.",
  "result.readOnlyDetail":
    "{connection} is a read-only connection, so the database rejected the write. Nothing changed.",
  "result.vectorValues": "{count} values",
  "result.goToError": "Go to error",
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
  "result.discardedByEnd":
    "Ending the transaction discarded the rows not yet fetched. Run again to see them.",
  "result.expired": "Results closed",
  "result.expiredRows.one":
    "Nothing was fetched for {minutes} minutes, so the query was closed on the database. The 1 row received stays visible.",
  "result.expiredRows.other":
    "Nothing was fetched for {minutes} minutes, so the query was closed on the database. The {count} rows received stay visible.",
  "result.expiredRowsSeconds.one":
    "Nothing was fetched for {seconds} seconds, so the query was closed on the database. The 1 row received stays visible.",
  "result.expiredRowsSeconds.other":
    "Nothing was fetched for {seconds} seconds, so the query was closed on the database. The {count} rows received stay visible.",
  "result.connectionLost": "Connection lost",
  "result.nextRunNewSession":
    "The next run opens a new session. SET values and temp tables are gone.",
  "result.dropped": "Rows 1–{end} were dropped · run again to see them",
  "result.runAgain": "Run again",
  "result.fetchingMore": "Fetching next 500 rows",
  "result.firstRowsOf": "First {shown} of {total} rows",
  "result.end.one": "End · 1 row",
  "result.end.other": "End · {count} rows",
  "result.resizeColumn": "Resize {name}",
  "result.sortAscending": "{name}, sorted ascending",
  "result.sortDescending": "{name}, sorted descending",
  "result.sortedPartial.one": "Sorted 1 received row only",
  "result.sortedPartial.other": "Sorted {count} received rows only",

  "export.button": "Export",
  "export.csv": "Save as CSV…",
  "export.json": "Save as JSON…",
  "export.saved.one": "Saved 1 row to {file}",
  "export.saved.other": "Saved {count} rows to {file}",
  "export.savedPartial.one": "Saved 1 received row to {file}",
  "export.savedPartial.other": "Saved {count} received rows to {file}",
  "export.failedTitle": "Couldn't save the file",

  "edit.changed.one": "1 cell changed",
  "edit.changed.other": "{count} cells changed",
  "edit.revert": "Revert",
  "edit.apply": "Apply",
  "edit.preview": "SQL to send on Apply",
  "edit.setNull": "Set NULL",
  "edit.revertValue": "Revert value",
  "edit.editor": "Edit {name}",
  "edit.menu": "Cell",
  "edit.updated.one": "Updated 1 row",
  "edit.updated.other": "Updated {count} rows",
  "edit.notFound":
    "Row {row} was not found. It may have been deleted or its key changed. Nothing was applied.",
  "edit.matchedMany": "Row {row} matched {count} rows. Nothing was applied.",
  "edit.failedRow": "Row {row}: {message}. Nothing was applied.",
  "edit.failedCommit": "{message}. Nothing was applied.",
  "edit.txFailed": "Roll back the failed transaction first.",
  "edit.busy":
    "Another query is still running on this session. Nothing was applied.",
  "edit.noSession":
    "This tab has no open session. Run the query again, then edit. Nothing was applied.",
  "edit.notEditable.readOnly": "Not editable: the connection is read-only.",
  "edit.notEditable.running":
    "Not editable while rows are still coming. Cancel keeps the rows received so far.",
  "edit.notEditable.noTable": "Not editable: no column comes from a table.",
  "edit.notEditable.manyTables":
    "Not editable: rows come from {count} tables ({names}).",
  "edit.notEditable.notTable": "Not editable: {name} is not a table.",
  "edit.notEditable.noPrimaryKey": "Not editable: {name} has no primary key.",
  "edit.notEditable.primaryKeyMissing":
    "Not editable: the result does not include the primary key ({columns}).",
  "edit.notEditable.gone": "Not editable: the table no longer exists.",
  "edit.notEditable.computed": "Not editable: {name} is computed.",
  "edit.notEditable.generated":
    "Not editable: {name} is generated by the database.",

  "explain.tab": "EXPLAIN",
  "explain.timings": "Execution {execution} · Planning {planning}",
  "explain.timingsExecution": "Execution {execution}",
  "explain.timingsPlanning": "Planning {planning}",
  "explain.showRaw": "Show raw",
  "explain.showTree": "Show tree",
  "explain.node": "Node",
  "explain.actualTime": "Actual time",
  "explain.rows": "Rows (est → actual)",
  "explain.loops": "Loops",
  "explain.neverExecuted": "never executed",

  "ddl.tab": "DDL {name}",
  "ddl.copy": "Copy",
  "ddl.copied": "Copied DDL",
  "ddl.openInNewTab": "Open in new tab",
  "ddl.close": "Close",
  "ddl.loading": "Loading DDL…",

  "tx.mode": "Transaction mode",
  "tx.auto": "Auto",
  "tx.manual": "Manual",
  "tx.open": "Open",
  "tx.failed": "Failed",
  "tx.statements.one": "1 statement",
  "tx.statements.other": "{count} statements",
  "tx.statements.none": "manual BEGIN",
  "tx.commit": "Commit",
  "tx.rollback": "Rollback",
  "tx.badge": "TX",
  "tx.badgeLabel": "Open transaction, {elapsed}",
  "tx.commitFailed": "Commit failed",
  "tx.rollbackFailed": "Rollback failed",
  "tx.commitRefused":
    "The transaction failed, so it can't be committed. Roll back instead.",
  "tx.failedTitle": "Transaction failed",
  "tx.failedHint":
    "An earlier error left the transaction failed. Roll back, then run again.",
  "tx.failedHintThis":
    "This error left the transaction failed. Roll back, then run again.",
  "tx.lostTitle": "Transaction lost",
  "tx.lostBody.one":
    "The connection dropped while a transaction was open. The 1 uncommitted statement was not applied. The next run opens a new session.",
  "tx.lostBody.other":
    "The connection dropped while a transaction was open. The {count} uncommitted statements were not applied. The next run opens a new session.",
  "tx.lostBody.none":
    "The connection dropped while a transaction was open. It was not applied. The next run opens a new session.",

  "viewer.label": "Value viewer",
  "viewer.copy": "Copy value",
  "viewer.close": "Close value viewer",
  "viewer.meta": "{type} · row {row}",
  "viewer.metaUntyped": "row {row}",

  "toast.copiedMessage": "Copied message",
  "toast.copiedCell": "Copied cell",
  "toast.copiedValue": "Copied value",
  "toast.copiedRows.one": "Copied 1 row (tab-separated)",
  "toast.copiedRows.other": "Copied {count} rows (tab-separated)",
  "toast.reformatFailed": "Couldn't reformat: {reason}",
  "autosave.skipped.one": "Couldn't reopen {path}",
  "autosave.skipped.other": "Couldn't reopen {count} files",

  "settings.errorTitle": "Settings were not applied",
  "settings.storeErrorTitle": "Recent projects and unsaved tabs are not kept",

  "error.no_project": "Open a project first",
  "error.project_changed":
    "The project was reopened in the meantime. Try again",
  "error.unknown_connection": "Connection '{name}' is not in the project",
  "error.unknown_session": "Session {id} does not exist",
  "error.project_not_found": "{path} was not found",
  "error.password_in_config":
    "Connection '{connection}' has a password entry. Passwords are stored in the keychain, not in the config file",
  "error.project_exists": "{path} already exists",
  "error.project_write_failed": "Could not write {path}: {message}",
  "error.project_invalid": "{message}",
  "error.invalid_connection": "{message}",
  "error.password_store": "Could not access the keychain: {message}",
  "error.split_failed": "Could not split the statements: {message}",
  "error.empty_statement": "There is no statement to run",
  "error.multiple_statements":
    "Only one statement can run at a time. This text has {count}",
  "error.query_not_active": "Query {query} has no more results to fetch",
  "error.cancel_failed": "Could not send the cancel request: {message}",
  "error.invalid_path": "{message}",
  "error.catalog_failed": "Could not read the schema: {message}",
  "error.store_failed": "Could not use the app database: {message}",
  "error.store_unavailable":
    "The app database could not be opened, so recent projects and tabs are not kept",
  "error.relation_gone":
    "The table or view no longer exists. Refresh the schema",
  "error.file_not_found": "{path} was not found",
  "error.file_exists": "{path} already exists",
  "error.file_changed": "{path} was changed on disk after it was opened",
  "error.file_too_large":
    "{path} is too large ({bytes} bytes). Files up to 16 MiB can be opened",
  "error.file_not_utf8": "{path} is not UTF-8",
  "error.file_io": "Could not access {path}: {message}",
  "error.export_failed": "Could not write {path}: {message}",
  "error.tunnel_spawn": "Could not run the tunnel command: {message}",
  "error.tunnel_exited": "{message}",
  "error.tunnel_timeout": "{host}:{port} didn't open within {secs} seconds",
  "error.tunnel_cancelled": "The tunnel start was cancelled",
  "error.unreachable": "Could not reach the server: {message}",
  "error.timeout": "The server did not respond in time",
  "error.tls_not_supported": "The server does not support SSL",
  "error.certificate": "Could not verify the server certificate: {message}",
  "error.password_required": "A password is required",
  "error.auth_failed": "Authentication failed: {message}",
  "error.database": "The server refused the connection ({code}): {message}",
  "error.other": "Connection failed: {message}",
} as const satisfies { [key: string]: string };

export type MessageKey = keyof typeof en;

/** `.one`으로 끝나는 key에서 `.one`을 뗀 것. `tc`가 받는다. */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.one` ? Base : never;
}[MessageKey];
