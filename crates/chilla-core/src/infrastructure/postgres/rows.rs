//! simple query의 응답을 [`RowSource`]로 읽는다.

use std::pin::Pin;

use futures_util::StreamExt;
use tokio::task::AbortHandle;
use tokio_postgres::error::{DbError, ErrorPosition};
use tokio_postgres::{SimpleQueryMessage, SimpleQueryRow, SimpleQueryStream};

use super::error_message;
use crate::application::{QueryError, RowItem, RowSource};
use crate::domain::{Column, Row, ServerError};

const NOT_UTF8: &str = "The result contains a value that is not UTF-8. Check client_encoding";

/// 쿼리 하나의 결과. 읽는 만큼만 driver가 socket에서 가져온다.
pub struct PgRows {
    /// 다 읽었거나 연결이 끊겼으면 `None`이다. 끊긴 뒤의 stream은 같은 오류를 끝없이
    /// 돌려주고, 다 읽은 stream을 다시 poll해도 오류가 나므로 더 poll하지 않는다.
    stream: Option<Pin<Box<SimpleQueryStream>>>,
    /// 연결의 driver task. 서버 오류가 아닌 stream 오류에서 연결을 끊는 데 쓴다.
    driver: AbortHandle,
}

impl PgRows {
    pub(super) fn new(stream: SimpleQueryStream, driver: AbortHandle) -> Self {
        Self {
            stream: Some(Box::pin(stream)),
            driver,
        }
    }
}

impl RowSource for PgRows {
    async fn next(&mut self) -> Option<Result<RowItem, QueryError>> {
        loop {
            let stream = self.stream.as_mut()?;
            // await 뒤에만 상태를 바꾼다. `StreamExt::next`가 cancel-safe이므로 이 함수도 그렇다.
            let Some(message) = stream.next().await else {
                self.stream = None;
                return None;
            };
            let message = match message {
                Ok(message) => message,
                Err(error) => {
                    if let Some(db) = error.as_db_error() {
                        // 서버 오류 뒤에는 stream이 `None`으로 끝난다. 그때까지 읽어야
                        // ReadyForQuery가 지나간다.
                        return Some(Err(QueryError::Server(server_error(db))));
                    }
                    // 서버 오류가 아닌 stream 오류는 연결이 끊겼거나 protocol이 어긋난 것이다.
                    // 어긋난 연결은 살아 있어도 다음 쿼리를 받지 못하므로 driver를 멈춰 socket을
                    // 닫는다. 그래야 `ConnectionLost`가 사실이 되고 `is_closed`도 true가 된다.
                    // 이미 끝난 driver를 멈춰도 아무 일이 없으므로 오류를 가리지 않는다.
                    //
                    // 알려진 경우는 `COPY … FROM STDIN`과 `COPY … TO STDOUT`이다. 지원하지 않으며
                    // 세션을 일부러 잃는다(`COPY … FROM STDIN`은 cancel로도 멈추지 않는다).
                    self.driver.abort();
                    self.stream = None;
                    return Some(Err(QueryError::ConnectionLost {
                        message: error_message(&error),
                    }));
                }
            };
            let item = match message {
                SimpleQueryMessage::RowDescription(columns) => RowItem::Columns(
                    columns
                        .iter()
                        .map(|column| Column {
                            name: column.name().to_owned(),
                        })
                        .collect(),
                ),
                SimpleQueryMessage::Row(row) => match cells(&row) {
                    Some(cells) => RowItem::Row(cells),
                    // 그 행만 오류다. 결과는 이어지므로 `None`까지 읽어야 한다.
                    None => {
                        return Some(Err(QueryError::Client {
                            message: NOT_UTF8.into(),
                        }));
                    }
                },
                SimpleQueryMessage::CommandComplete(rows) => RowItem::Complete { rows },
                // `#[non_exhaustive]`다. 모르는 message는 건너뛴다.
                _ => continue,
            };
            return Some(Ok(item));
        }
    }
}

/// 값이 UTF-8이 아니면(SQL_ASCII DB, `SET client_encoding = 'LATIN1'` 등) `None`이다.
fn cells(row: &SimpleQueryRow) -> Option<Row> {
    (0..row.len())
        .map(|i| row.try_get(i).ok().map(|cell| cell.map(str::to_owned)))
        .collect()
}

pub(super) fn server_error(db: &DbError) -> ServerError {
    ServerError {
        code: db.code().code().to_owned(),
        message: db.message().to_owned(),
        detail: db.detail().map(str::to_owned),
        hint: db.hint().map(str::to_owned),
        // `Internal`은 서버가 만든 쿼리 안의 위치라 보낸 text와 맞지 않는다.
        position: match db.position() {
            Some(ErrorPosition::Original(position)) => Some(*position),
            _ => None,
        },
    }
}
