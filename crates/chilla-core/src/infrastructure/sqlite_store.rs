//! 앱 내부 저장소. `<app_data_dir>/chilla.sqlite3` 한 파일이다.
//!
//! schema 버전은 `PRAGMA user_version`에 둔다. 0이면 새 파일이라 table을 만들고 1로 올린다.
//! 모르는 버전이면 열지 않는다(더 새 앱이 만든 파일을 옛 앱이 고치지 않게).

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, params};

use crate::application::{AppStore, RecentProject, StoreError};

const SCHEMA_VERSION: i64 = 1;
const MAX_RECENT: i64 = 10;

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

fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match version {
        0 => {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS recent_projects (
                     dir TEXT PRIMARY KEY,
                     name TEXT NOT NULL,
                     opened_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS workspaces (
                     dir TEXT PRIMARY KEY,
                     snapshot TEXT NOT NULL,
                     saved_at INTEGER NOT NULL
                 );",
            )?;
            // `PRAGMA`는 bind parameter를 받지 않는다.
            tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
            tx.commit()?;
            Ok(())
        }
        SCHEMA_VERSION => Ok(()),
        other => Err(StoreError {
            message: format!(
                "the file has schema version {other}, but this app reads version {SCHEMA_VERSION}"
            ),
        }),
    }
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
        let connection = self.connection();
        let mut statement = connection.prepare("SELECT snapshot FROM workspaces WHERE dir = ?1")?;
        let mut rows = statement.query([key(dir)])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    fn save_workspace(&self, dir: &Path, snapshot: &str, saved_at: i64) -> Result<(), StoreError> {
        self.connection().execute(
            "INSERT OR REPLACE INTO workspaces (dir, snapshot, saved_at) VALUES (?1, ?2, ?3)",
            params![key(dir), snapshot, saved_at],
        )?;
        Ok(())
    }
}
