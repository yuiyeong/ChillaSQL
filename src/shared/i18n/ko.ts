import type { MessageKey } from "./en";

/**
 * 화면 문구의 한국어 dictionary. key와 `{name}`은 `en`과 같다.
 * Commit, Rollback, Auto, Manual, SQL keyword, 설정 key, 단축키는 영어 그대로 둔다.
 * 버튼, label, 짧은 상태는 명사형("저장", "연결 끊김", "복사됨")으로, 문장은 "~습니다"로 쓴다.
 * 복수형 key는 같은 문구를 둔다.
 */
export const ko: Record<MessageKey, string> = {
  "common.cancel": "취소",
  "common.save": "저장",
  "common.close": "닫기",
  "common.ok": "확인",
  "common.readOnly": "Read-only",

  "tunnel.starting": "터널 시작 중",
  "tunnel.seconds": "{elapsed} / {total}초",
  "tunnel.reconnecting": "다시 연결 중",
  "tunnel.attempt": "{attempt}/3",
  "tunnel.failed": "터널 실패",
  "tunnel.external": "외부 터널",
  "tunnel.externalHint":
    "{target}에 이미 연결할 수 있어 터널 명령을 실행하지 않았습니다. ChillaSQL을 종료해도 이 터널은 닫지 않습니다.",
  "tunnel.ranCommand":
    "터널 명령을 실행했습니다. {target}에 연결할 수 있게 되면 연결합니다.",
  "tunnel.output": "명령 출력 (stderr)",
  "tunnel.tryAgain": "다시 시도",
  "tunnel.editConnection": "접속 편집",
  "tunnel.restarting":
    "터널 프로세스가 끝났습니다. 명령을 다시 실행합니다 ({attempt}/3).",
  "tunnel.gaveUp": "터널을 3번 실행했지만 열리지 않아 멈췄습니다.",

  "toolbar.label": "쿼리",
  "toolbar.changeConnection": "이 탭의 접속 바꾸기",
  "toolbar.chooseConnection": "접속 선택",
  "toolbar.connections": "접속",
  "toolbar.addConnection": "접속 추가…",
  "toolbar.runStatement": "문장 실행",
  "toolbar.runSelection": "선택 영역 실행",
  "toolbar.runFile": "파일 실행",
  "toolbar.chooseWhatToRun": "실행할 범위 선택",
  "toolbar.whatToRun": "실행할 범위",
  "toolbar.reformat": "Reformat (Opt+Cmd+L)",
  "toolbar.explain": "실행 계획 (EXPLAIN ANALYZE)",

  "workspace.resizeResults": "결과 패널 크기 조절",
  "status.position": "줄 {line}, 열 {column}",
  "status.encoding": "UTF-8",
  "status.lineEndingLf": "LF",
  "status.lineEndingCrlf": "CRLF",

  "tabs.defaultTitle": "쿼리 {n}",
  "tabs.list": "열린 파일",
  "tabs.unsaved": "저장 안 됨",
  "tabs.close": "{title} 닫기",
  "tabs.new": "새 탭 (Shift+Cmd+L)",
  "tabs.saveTitle": "{title} 저장",
  "tabs.filePath": "프로젝트 안의 경로",
  "tabs.filePathPlaceholder": "queries/name.sql",

  "params.title": "파라미터 값",
  "params.note":
    "값은 SQL 그대로 들어갑니다. 문자열은 따옴표로 감싸세요. {cast}는 형변환이지 파라미터가 아닙니다.",
  "params.run": "실행",
  "params.cancel": "취소",

  "dialog.closeTab.title": "{title}의 변경 사항을 저장하겠습니까?",
  "dialog.closeTab.body": "저장하지 않으면 변경 사항이 사라집니다.",
  "dialog.closeTab.discard": "저장 안 함",
  "dialog.switchProject.title.one":
    "탭 1개에 저장하지 않은 변경 사항이 있습니다",
  "dialog.switchProject.title.other":
    "탭 {count}개에 저장하지 않은 변경 사항이 있습니다",
  "dialog.switchProject.note":
    "프로젝트를 바꾸면 이 변경 사항은 사라지고 모든 탭의 세션이 닫힙니다.",
  "dialog.switchProject.confirm": "저장하지 않고 바꾸기",
  "dialog.tx.oneTab.title": "이 탭에 열린 트랜잭션이 있습니다",
  "dialog.tx.close.body":
    "{title} 탭을 닫으면 {connection} 세션이 닫힙니다. {question}",
  "dialog.tx.switchConnection.body":
    "{target} 접속으로 바꾸면 {connection} 세션이 닫힙니다. {question}",
  "dialog.tx.switchMode.title": "Auto로 바꾸기 전에 트랜잭션을 끝내야 합니다",
  "dialog.tx.saveTarget.title": "이 접속을 쓰는 탭에 열린 트랜잭션이 있습니다",
  "dialog.tx.saveTarget.body":
    "새 대상을 저장하면 {connection} 접속을 쓰는 탭의 세션이 닫힙니다. {question}",
  "dialog.tx.switchProject.title": "열린 트랜잭션이 있는 탭이 있습니다",
  "dialog.tx.switchProject.body":
    "프로젝트를 바꾸면 모든 탭의 세션이 닫힙니다. {question}",
  "dialog.tx.question.one": "Commit하지 않은 문장 1개를 어떻게 처리하겠습니까?",
  "dialog.tx.question.other":
    "Commit하지 않은 문장 {count}개를 어떻게 처리하겠습니까?",
  "dialog.tx.question.none": "열린 트랜잭션을 어떻게 처리하겠습니까?",
  "dialog.tx.questionIn.one":
    "{title} 탭에서 Commit하지 않은 문장 1개를 어떻게 처리하겠습니까?",
  "dialog.tx.questionIn.other":
    "{title} 탭에서 Commit하지 않은 문장 {count}개를 어떻게 처리하겠습니까?",
  "dialog.tx.questionIn.none":
    "{title} 탭의 열린 트랜잭션을 어떻게 처리하겠습니까?",
  "dialog.tx.manyTabs.title.one": "탭 1개에 열린 트랜잭션이 있습니다",
  "dialog.tx.manyTabs.title.other": "탭 {count}개에 열린 트랜잭션이 있습니다",
  "dialog.tx.manyTabs.item": "{connection} · {statements} · {elapsed}",
  "dialog.tx.manyTabs.note":
    "탭마다 정하려면 취소하고 각 탭에서 Commit이나 Rollback을 하십시오.",
  "dialog.tx.rollback.close": "Rollback하고 닫기",
  "dialog.tx.rollback.switch": "Rollback하고 바꾸기",
  "dialog.tx.rollback.save": "Rollback하고 저장",
  "dialog.tx.commit.close": "Commit하고 닫기",
  "dialog.tx.commit.switch": "Commit하고 바꾸기",
  "dialog.tx.commit.save": "Commit하고 저장",
  "dialog.tx.rollbackAll.close": "모두 Rollback하고 닫기",
  "dialog.tx.rollbackAll.switch": "모두 Rollback하고 바꾸기",
  "dialog.tx.rollbackAll.save": "모두 Rollback하고 저장",
  "dialog.tx.rollbackAll.quit": "모두 Rollback하고 종료",
  "dialog.danger.title.withoutWhere":
    "{where} 없이 {verb} 문을 실행하겠습니까?",
  "dialog.danger.title.drop": "{drop} 문을 실행하겠습니까?",
  "dialog.danger.title.truncate": "{truncate} 문을 실행하겠습니까?",
  "dialog.danger.first.delete":
    "{connection}의 {tables}에서 모든 행을 삭제합니다.",
  "dialog.danger.first.update":
    "{connection}의 {tables}에서 모든 행을 변경합니다.",
  "dialog.danger.first.drop": "{connection}에서 {names}을(를) 삭제합니다.",
  "dialog.danger.first.dropOwned":
    "{connection}에서 {names} 소유의 모든 객체를 삭제합니다.",
  "dialog.danger.second.reversible":
    "열린 트랜잭션 안이므로 Commit하기 전까지 Rollback할 수 있습니다.",
  "dialog.danger.second.final": "Auto 모드에서는 바로 Commit되어 {emphasis}.",
  "dialog.danger.second.final.emphasis": "되돌릴 수 없습니다",
  "dialog.danger.body": "{first} {second}",
  "dialog.danger.run": "실행",
  "dialog.fileChanged.title": "디스크의 {path} 파일이 바뀌었습니다",
  "dialog.fileChanged.body":
    "파일을 연 뒤 다른 프로그램이 이 파일을 고쳤습니다. 덮어쓰면 그 변경 사항이 사라집니다.",
  "dialog.fileChanged.confirm": "덮어쓰기",
  "dialog.fileDeleted.title": "{path} 파일이 삭제되었습니다",
  "dialog.fileDeleted.body":
    "파일을 연 뒤 디스크에서 삭제되었습니다. 이 탭의 내용으로 다시 만들겠습니까?",
  "dialog.fileDeleted.confirm": "다시 만들기",

  "run.noConnection": "쿼리를 실행하려면 접속을 선택하십시오.",
  "run.emptySelection": "실행할 내용 없음",
  "run.emptyFile": "실행할 문장 없음",
  "run.noStatementAtCursor": "커서 위치에 문장 없음",
  "run.explainOneStatement":
    "Explain은 문장 하나만 실행합니다. 문장 하나를 선택하십시오.",
  "run.splitFailed.title": "문장을 찾을 수 없습니다",
  "run.splitFailed.detail":
    "닫히지 않은 따옴표 때문에 문장을 나눌 수 없습니다. 실행할 부분을 선택하면 그대로 보냅니다.",

  "project.openShortcut": "프로젝트 열기…",
  "project.recent": "최근 프로젝트",
  "project.recentShort": "최근",
  "project.missingTitle": "{dir}에 chilla.toml이 없습니다",
  "project.missingBody":
    "[project]만 있는 chilla.toml을 만들어 이 폴더를 프로젝트로 엽니다. 접속은 연 뒤에 추가하십시오.",
  "project.create": "chilla.toml 만들기",
  "project.chooseAnother": "다른 폴더 선택…",
  "when.justNow": "방금",
  "when.today": "오늘",
  "when.yesterday": "어제",

  "sidebar.label": "사이드바",
  "sidebar.switchProject": "프로젝트 바꾸기",
  "sidebar.projects": "프로젝트",
  "sidebar.connections": "접속",
  "sidebar.edit": "{name} 접속 편집",
  "sidebar.tunnel": "터널",
  "sidebar.addConnection": "접속 추가",
  "sidebar.views": "사이드바 보기",
  "sidebar.viewFiles": "파일",
  "sidebar.viewSchema": "스키마",
  "sidebar.viewHistory": "기록",
  "sidebar.files": "SQL 파일",
  "sidebar.refresh": "파일 목록 새로 고침",
  "history.label": "쿼리 기록",
  "history.search": "기록 검색",
  "history.openInEditor": "에디터에서 열기",
  "history.empty": "실행한 쿼리가 여기에 나타납니다",
  "history.noMatch": "일치하는 쿼리가 없습니다",
  "schema.label": "스키마",
  "schema.refresh": "스키마 새로 고침",
  "schema.noConnection": "이 탭에 접속 없음",
  "schema.chooseConnection": "접속 선택",
  "schema.loading": "불러오는 중",
  "schema.retry": "다시 시도",
  "schema.empty": "없음",
  "schema.group.tables": "테이블",
  "schema.group.views": "뷰",
  "schema.group.columns": "컬럼",
  "schema.group.indexes": "인덱스",
  "schema.group.constraints": "제약 조건",
  "schema.unique": "unique",
  "schema.materialized": "materialized",
  "schema.menu.selectFirstRows": "처음 행 조회",
  "schema.menu.doubleClick": "더블클릭",
  "schema.menu.showDdl": "DDL 보기",
  "schema.menu.copyName": "이름 복사",
  "schema.copied": "{name} 복사됨",
  "completion.view": "뷰",
  "completion.insert": "삽입",
  "completion.close": "닫기",
  "completion.legend": "s 스키마 · c 컬럼 · t 테이블 · f 함수 · k 키워드",

  "connectionForm.titleNew": "새 접속",
  "connectionForm.titleEdit": "{name} 편집",
  "connectionForm.nameFixed": "이름은 바꿀 수 없습니다",
  "connectionForm.passwordHint":
    "키체인에 저장하며 chilla.toml에는 저장하지 않습니다",
  "connectionForm.tunnelHint": "비워 두면 직접 연결합니다",
  "connectionForm.tunnelPlaceholder": "ssh -N -L … 또는 다른 터널 명령",
  "connectionForm.readOnlyHint":
    "세션을 read-only로 열어 데이터베이스가 쓰기를 거절합니다",
  "connectionForm.advanced": "고급",
  "connectionForm.advancedKeys":
    "statement_timeout · tunnel_timeout · sslrootcert",
  "connectionForm.statementTimeoutHint": "초. 비우면 제한 없음",
  "connectionForm.tunnelTimeoutHint": "초 · tunnel이 있을 때만",
  "connectionForm.sslrootcertHint": "verify-full에서 이 CA만 신뢰합니다",
  "connectionForm.choose": "선택…",
  "connectionForm.elapsed": "{ms} ms",
  "connectionForm.connectedVersion": "연결됨 · PostgreSQL {version}",
  "connectionForm.test": "테스트",
  "connectionForm.keepPassword": "저장된 비밀번호 유지",
  "connectionForm.passwordWillClear":
    "이 접속의 대상을 바꿨습니다. 저장하면 키체인에 저장된 비밀번호를 삭제합니다. 대신 저장하려면 아래에 새 비밀번호를 입력하십시오.",
  "connectionForm.savedButNotApplied":
    "chilla.toml에 저장했지만 Commit이 실패했습니다. 다시 저장할 때까지 이 접속을 쓰는 탭은 이전 대상을 계속 씁니다.",
  "connectionForm.required": "{field} 값을 입력하십시오",
  "connectionForm.nameTaken":
    "이미 쓰고 있는 이름입니다. 그 접속을 편집하려면 사이드바에서 여십시오.",
  "connectionForm.portRange": "port는 1부터 65535까지의 숫자여야 합니다",
  "connectionForm.statementTimeoutRange":
    "statement_timeout은 1부터 86400까지의 초여야 합니다",
  "connectionForm.tunnelTimeoutRange":
    "tunnel_timeout은 1부터 300까지의 정수 초여야 합니다",

  "result.hintRun": "커서 위치의 문장 실행",
  "result.hintNewTab": "새 탭",
  "result.hintReformat": "Reformat",
  "result.reconnected": "다시 연결됨",
  "result.reconnectedDetail":
    "새 세션이라 SET 값과 임시 테이블 같은 세션 상태가 초기화되었습니다.",
  "result.connecting": "연결 중…",
  "result.running": "실행 중 {elapsed}",
  "result.waiting": "서버의 첫 행을 기다리는 중",
  "result.tabs": "결과 탭",
  "result.label": "결과",
  "result.notRun": "실행 안 함",
  "result.errorTab": "오류",
  "result.stoppedAt": "{n}번째 문장에서 멈췄습니다.",
  "result.notRunRest.one": "{first}번째 문장은 실행하지 않았습니다.",
  "result.notRunRest.other": "{first}–{last}번째 문장은 실행하지 않았습니다.",
  "result.copySelected": "선택한 셀 복사",
  "result.rows.one": "1행 · {elapsed}",
  "result.rows.other": "{count}행 · {elapsed}",
  "result.rowsMore": "{count}+행 · {elapsed}",
  "result.inserted.one": "1행 삽입됨",
  "result.inserted.other": "{count}행 삽입됨",
  "result.updated.one": "1행 변경됨",
  "result.updated.other": "{count}행 변경됨",
  "result.deleted.one": "1행 삭제됨",
  "result.deleted.other": "{count}행 삭제됨",
  "result.merged.one": "1행 병합됨",
  "result.merged.other": "{count}행 병합됨",
  "result.done": "완료",
  "result.errorLocation": "줄 {line}, 열 {column}",
  "result.sqlstate": "SQLSTATE {code}",
  "result.timedOut": "시간 초과",
  "result.timeoutDetail": "이 접속의 statement_timeout은 {secs}초입니다.",
  "result.readOnlyDetail":
    "{connection}은 읽기 전용 접속이라 데이터베이스가 쓰기를 거절했습니다. 바뀐 것은 없습니다.",
  "result.vectorValues": "{count}개 값",
  "result.goToError": "오류 위치로 이동",
  "result.copyMessage": "메시지 복사",
  "result.cancelled": "취소됨",
  "result.stopped": "서버에서 멈췄습니다.",
  "result.stoppedRows.one": "서버에서 멈췄습니다. 받은 1행은 그대로 보입니다.",
  "result.stoppedRows.other":
    "서버에서 멈췄습니다. 받은 {count}행은 그대로 보입니다.",
  "result.discarded": "결과 버려짐",
  "result.discardedDetail":
    "다음 쿼리를 실행해 아직 가져오지 않은 행을 버렸습니다. 다시 실행하면 볼 수 있습니다.",
  "result.discardedByEnd":
    "트랜잭션을 끝내 아직 가져오지 않은 행을 버렸습니다. 다시 실행하면 볼 수 있습니다.",
  "result.expired": "결과 닫힘",
  "result.expiredRows.one":
    "{minutes}분 동안 가져오지 않아 데이터베이스에서 쿼리를 닫았습니다. 받은 1행은 그대로 보입니다.",
  "result.expiredRows.other":
    "{minutes}분 동안 가져오지 않아 데이터베이스에서 쿼리를 닫았습니다. 받은 {count}행은 그대로 보입니다.",
  "result.expiredRowsSeconds.one":
    "{seconds}초 동안 가져오지 않아 데이터베이스에서 쿼리를 닫았습니다. 받은 1행은 그대로 보입니다.",
  "result.expiredRowsSeconds.other":
    "{seconds}초 동안 가져오지 않아 데이터베이스에서 쿼리를 닫았습니다. 받은 {count}행은 그대로 보입니다.",
  "result.connectionLost": "연결 끊김",
  "result.nextRunNewSession":
    "다음 실행은 새 세션을 엽니다. SET 값과 임시 테이블은 사라졌습니다.",
  "result.dropped": "1–{end}행은 버렸습니다 · 다시 실행하면 볼 수 있습니다",
  "result.runAgain": "다시 실행",
  "result.fetchingMore": "다음 500행 가져오는 중",
  "result.firstRowsOf": "{total}행 중 처음 {shown}행",
  "result.end.one": "끝 · 1행",
  "result.end.other": "끝 · {count}행",
  "result.resizeColumn": "{name} 크기 조절",

  "edit.notEditable.readOnly": "편집할 수 없습니다: 읽기 전용 접속입니다.",
  "edit.notEditable.running":
    "행을 받는 중에는 편집할 수 없습니다. 취소하면 지금까지 받은 행은 남습니다.",
  "edit.notEditable.noTable":
    "편집할 수 없습니다: 테이블에서 온 열이 없습니다.",
  "edit.notEditable.manyTables":
    "편집할 수 없습니다: 행이 테이블 {count}개({names})에서 왔습니다.",
  "edit.notEditable.notTable":
    "편집할 수 없습니다: {name}은(는) 테이블이 아닙니다.",
  "edit.notEditable.noPrimaryKey":
    "편집할 수 없습니다: {name}에 primary key가 없습니다.",
  "edit.notEditable.primaryKeyMissing":
    "편집할 수 없습니다: 결과에 primary key({columns})가 없습니다.",
  "edit.notEditable.gone": "편집할 수 없습니다: 테이블이 더 이상 없습니다.",
  "edit.notEditable.computed":
    "편집할 수 없습니다: {name}은(는) 계산한 값입니다.",
  "edit.notEditable.generated":
    "편집할 수 없습니다: {name}은(는) 데이터베이스가 만드는 값입니다.",

  "explain.tab": "EXPLAIN",
  "explain.timings": "실행 {execution} · 계획 {planning}",
  "explain.timingsExecution": "실행 {execution}",
  "explain.timingsPlanning": "계획 {planning}",
  "explain.showRaw": "원문 보기",
  "explain.showTree": "Tree 보기",
  "explain.node": "Node",
  "explain.actualTime": "실제 시간",
  "explain.rows": "행 (추정 → 실제)",
  "explain.loops": "Loops",
  "explain.neverExecuted": "never executed",

  "ddl.tab": "DDL {name}",
  "ddl.copy": "복사",
  "ddl.copied": "DDL 복사됨",
  "ddl.openInNewTab": "새 탭에서 열기",
  "ddl.close": "닫기",
  "ddl.loading": "DDL을 읽는 중…",

  "tx.mode": "트랜잭션 모드",
  "tx.auto": "Auto",
  "tx.manual": "Manual",
  "tx.open": "열림",
  "tx.failed": "실패",
  "tx.statements.one": "문장 1개",
  "tx.statements.other": "문장 {count}개",
  "tx.statements.none": "직접 실행한 BEGIN",
  "tx.commit": "Commit",
  "tx.rollback": "Rollback",
  "tx.badge": "TX",
  "tx.badgeLabel": "열린 트랜잭션, {elapsed}",
  "tx.commitFailed": "Commit 실패",
  "tx.rollbackFailed": "Rollback 실패",
  "tx.commitRefused":
    "트랜잭션이 실패해 Commit할 수 없습니다. 대신 Rollback하십시오.",
  "tx.failedTitle": "트랜잭션 실패",
  "tx.failedHint":
    "앞의 오류로 트랜잭션이 실패했습니다. Rollback한 뒤 다시 실행하십시오.",
  "tx.failedHintThis":
    "이 오류로 트랜잭션이 실패했습니다. Rollback한 뒤 다시 실행하십시오.",
  "tx.lostTitle": "트랜잭션 유실",
  "tx.lostBody.one":
    "트랜잭션이 열린 동안 연결이 끊겼습니다. Commit하지 않은 문장 1개는 반영되지 않았습니다. 다음 실행은 새 세션을 엽니다.",
  "tx.lostBody.other":
    "트랜잭션이 열린 동안 연결이 끊겼습니다. Commit하지 않은 문장 {count}개는 반영되지 않았습니다. 다음 실행은 새 세션을 엽니다.",
  "tx.lostBody.none":
    "트랜잭션이 열린 동안 연결이 끊겼습니다. 트랜잭션은 반영되지 않았습니다. 다음 실행은 새 세션을 엽니다.",

  "viewer.label": "값 보기",
  "viewer.copy": "값 복사",
  "viewer.close": "값 보기 닫기",
  "viewer.meta": "{type} · {row}행",
  "viewer.metaUntyped": "{row}행",

  "toast.copiedMessage": "메시지 복사됨",
  "toast.copiedCell": "셀 복사됨",
  "toast.copiedValue": "값 복사됨",
  "toast.copiedRows.one": "1행 복사됨 (탭으로 구분)",
  "toast.copiedRows.other": "{count}행 복사됨 (탭으로 구분)",
  "toast.reformatFailed": "Reformat하지 못했습니다: {reason}",
  "autosave.skipped.one": "{path} 파일을 다시 열지 못했습니다",
  "autosave.skipped.other": "파일 {count}개를 다시 열지 못했습니다",

  "settings.errorTitle": "설정을 적용하지 못했습니다",
  "settings.storeErrorTitle":
    "최근 프로젝트와 저장하지 않은 탭을 보관할 수 없습니다",

  "error.no_project": "프로젝트를 먼저 여십시오",
  "error.project_changed":
    "그 사이에 프로젝트가 다시 열렸습니다. 다시 시도하십시오",
  "error.unknown_connection": "프로젝트에 '{name}' 접속이 없습니다",
  "error.unknown_session": "{id}번 세션이 없습니다",
  "error.project_not_found": "{path} 파일이 없습니다",
  "error.password_in_config":
    "'{connection}' 접속에 password 항목이 있습니다. 비밀번호는 설정 파일이 아니라 키체인에 저장합니다",
  "error.project_exists": "{path} 파일이 이미 있습니다",
  "error.project_write_failed": "{path} 파일을 쓸 수 없습니다: {message}",
  "error.project_invalid": "{message}",
  "error.invalid_connection": "{message}",
  "error.password_store": "키체인에 접근할 수 없습니다: {message}",
  "error.split_failed": "문장을 나눌 수 없습니다: {message}",
  "error.empty_statement": "실행할 문장이 없습니다",
  "error.multiple_statements":
    "한 번에 한 문장만 실행할 수 있습니다. 이 텍스트에는 문장이 {count}개 있습니다",
  "error.query_not_active": "{query}번 쿼리에서 더 가져올 결과가 없습니다",
  "error.cancel_failed": "취소 요청을 보낼 수 없습니다: {message}",
  "error.invalid_path": "{message}",
  "error.catalog_failed": "스키마를 읽을 수 없습니다: {message}",
  "error.store_failed": "앱 데이터베이스를 사용할 수 없습니다: {message}",
  "error.store_unavailable":
    "앱 데이터베이스를 열 수 없어 최근 프로젝트와 탭을 보관할 수 없습니다",
  "error.relation_gone":
    "테이블이나 뷰가 더 이상 없습니다. 스키마를 새로 고치세요",
  "error.file_not_found": "{path} 파일이 없습니다",
  "error.file_exists": "{path} 파일이 이미 있습니다",
  "error.file_changed": "{path} 파일을 연 뒤 디스크에서 바뀌었습니다",
  "error.file_too_large":
    "{path} 파일이 너무 큽니다({bytes}바이트). 16 MiB까지 열 수 있습니다",
  "error.file_not_utf8": "{path} 파일이 UTF-8이 아닙니다",
  "error.file_io": "{path}에 접근할 수 없습니다: {message}",
  "error.tunnel_spawn": "터널 명령을 실행할 수 없습니다: {message}",
  "error.tunnel_exited": "{message}",
  "error.tunnel_timeout":
    "{secs}초 안에 {host}:{port} 포트가 열리지 않았습니다",
  "error.tunnel_cancelled": "터널 시작을 취소했습니다",
  "error.unreachable": "서버에 연결할 수 없습니다: {message}",
  "error.timeout": "서버가 제시간에 응답하지 않았습니다",
  "error.tls_not_supported": "서버가 SSL을 지원하지 않습니다",
  "error.certificate": "서버 인증서를 확인할 수 없습니다: {message}",
  "error.password_required": "비밀번호가 필요합니다",
  "error.auth_failed": "인증에 실패했습니다: {message}",
  "error.database": "서버가 연결을 거부했습니다 ({code}): {message}",
  "error.other": "연결에 실패했습니다: {message}",
};
