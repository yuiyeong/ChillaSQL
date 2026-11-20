//! 앱 내부 저장소. `<app_data_dir>/chilla.sqlite3` 한 파일이다.
//!
//! schema 버전은 `PRAGMA user_version`에 둔다. 0이면 새 파일이라 table을 만들고 2로 올린다.
//! 1(M8)이면 쿼리 기록 table만 더해 2로 올린다.
//! 모르는 버전이면 열지 않는다(더 새 앱이 만든 파일을 옛 앱이 고치지 않게).

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};

use crate::application::{AppStore, HistoryEntry, NewHistoryEntry, RecentProject, StoreError};

const SCHEMA_VERSION: i64 = 2;
const MAX_RECENT: i64 = 10;
/// 프로젝트마다 남기는 쿼리 기록의 수.
const MAX_HISTORY: i64 = 10_000;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct SqliteAppStore {
    connection: Mutex<Connection>,
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self {
            message: error.to_string(),
        }
    }
}

impl SqliteAppStore {
    /// 파일이 없으면 만든다. 디렉토리는 있어야 한다.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let mut connection = Connection::open(path)?;
        // 다른 process가 파일을 쥐고 있으면 바로 실패하지 않고 잠시 기다린다.
        connection.busy_timeout(BUSY_TIMEOUT)?;
        migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn connection(&self) -> MutexGuard<'_, Connection> {
        // 한 문장씩 실행하고 transaction은 guard로 닫혀서 poison돼도 connection은 온전하다.
        self.connection.lock().unwrap_or_else(|e| e.into_inner())
    }
}

const RECENT_AND_WORKSPACES: &str = "CREATE TABLE IF NOT EXISTS recent_projects (
         dir TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         opened_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS workspaces (
         dir TEXT PRIMARY KEY,
         snapshot TEXT NOT NULL,
         saved_at INTEGER NOT NULL
     );";

const QUERY_HISTORY: &str = "CREATE TABLE IF NOT EXISTS query_history (
         id INTEGER PRIMARY KEY,
         project_dir TEXT NOT NULL,
         connection TEXT NOT NULL,
         sql TEXT NOT NULL,
         executed_at INTEGER NOT NULL,
         elapsed_micros INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS query_history_project ON query_history (project_dir, id);";

fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let tables: &[&str] = match version {
        0 => &[RECENT_AND_WORKSPACES, QUERY_HISTORY],
        1 => &[QUERY_HISTORY],
        SCHEMA_VERSION => return Ok(()),
        other => {
            return Err(StoreError {
                message: format!(
                    "the file has schema version {other}, but this app reads version {SCHEMA_VERSION}"
                ),
            });
        }
    };
    let tx = connection.transaction()?;
    for sql in tables {
        tx.execute_batch(sql)?;
    }
    // `PRAGMA`는 bind parameter를 받지 않는다.
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    Ok(tx.commit()?)
}

/// `LIKE` 패턴에서 `\`, `%`, `_`를 글자 그대로 찾도록 `\`를 앞에 붙인다.
fn escape_like(word: &str) -> String {
    let mut escaped = String::with_capacity(word.len());
    for c in word.chars() {
        if matches!(c, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

fn key(dir: &Path) -> String {
    dir.to_string_lossy().into_owned()
}

impl AppStore for SqliteAppStore {
    fn recent_projects(&self) -> Result<Vec<RecentProject>, StoreError> {
        let connection = self.connection();
        // 같은 초에 기록한 것은 나중에 넣은 행(rowid가 큰 쪽)이 위다.
        let mut statement = connection.prepare(
            "SELECT dir, name, opened_at FROM recent_projects
             ORDER BY opened_at DESC, rowid DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([MAX_RECENT], |row| {
            Ok(RecentProject {
                dir: row.get::<_, String>(0)?.into(),
                name: row.get(1)?,
                opened_at: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn record_project(&self, project: &RecentProject) -> Result<(), StoreError> {
        let mut connection = self.connection();
        let tx = connection.transaction()?;
        // REPLACE는 행을 지우고 다시 넣어 rowid가 새로 붙는다. 같은 초의 순서가 이것으로 정해진다.
        tx.execute(
            "INSERT OR REPLACE INTO recent_projects (dir, name, opened_at) VALUES (?1, ?2, ?3)",
            params![key(&project.dir), project.name, project.opened_at],
        )?;
        tx.execute(
            "DELETE FROM recent_projects WHERE dir NOT IN (
                 SELECT dir FROM recent_projects ORDER BY opened_at DESC, rowid DESC LIMIT ?1
             )",
            [MAX_RECENT],
        )?;
        Ok(tx.commit()?)
    }

    fn load_workspace(&self, dir: &Path) -> Result<Option<String>, StoreError> {
        self.connection()
            .query_row(
                "SELECT snapshot FROM workspaces WHERE dir = ?1",
                [key(dir)],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn save_workspace(&self, dir: &Path, snapshot: &str, saved_at: i64) -> Result<(), StoreError> {
        self.connection().execute(
            "INSERT OR REPLACE INTO workspaces (dir, snapshot, saved_at) VALUES (?1, ?2, ?3)",
            params![key(dir), snapshot, saved_at],
        )?;
        Ok(())
    }

    fn record_query(&self, dir: &Path, entry: &NewHistoryEntry) -> Result<(), StoreError> {
        let mut connection = self.connection();
        let tx = connection.transaction()?;
        tx.execute(
            "INSERT INTO query_history (project_dir, connection, sql, executed_at, elapsed_micros)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                key(dir),
                entry.connection,
                entry.sql,
                entry.executed_at,
                entry.elapsed_micros
            ],
        )?;
        // 최근 10,000개 밖(id 내림차순으로 10,001번째와 그보다 오래된 것)을 지운다.
        tx.execute(
            "DELETE FROM query_history WHERE project_dir = ?1 AND id <= (
                 SELECT id FROM query_history WHERE project_dir = ?1
                 ORDER BY id DESC LIMIT 1 OFFSET ?2
             )",
            params![key(dir), MAX_HISTORY],
        )?;
        Ok(tx.commit()?)
    }

    fn search_history(
        &self,
        dir: &Path,
        words: &[String],
        limit: usize,
    ) -> Result<Vec<HistoryEntry>, StoreError> {
        // ?1은 project_dir, ?2는 limit, 단어는 ?3부터다.
        let mut sql = String::from(
            "SELECT id, connection, sql, executed_at, elapsed_micros FROM query_history
             WHERE project_dir = ?1",
        );
        for i in 0..words.len() {
            sql.push_str(&format!(
                " AND sql LIKE '%' || ?{} || '%' ESCAPE '\\'",
                i + 3
            ));
        }
        sql.push_str(" ORDER BY id DESC LIMIT ?2");

        let mut values: Vec<rusqlite::types::Value> = vec![
            key(dir).into(),
            i64::try_from(limit).unwrap_or(i64::MAX).into(),
        ];
        values.extend(words.iter().map(|w| escape_like(w).into()));

        let connection = self.connection();
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(values), |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                connection: row.get(1)?,
                sql: row.get(2)?,
                executed_at: row.get(3)?,
                elapsed_micros: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}
