//! 세션이 가진 쿼리 하나: 상태, batch 만들기, 걸린 시간.

use std::time::Duration;

use tokio::time::Instant;

use super::QuerySink;
use crate::application::{QueryError, RowItem, RowSource};
use crate::domain::{QueryEvent, QueryId, QueryLimits, QueryOutcome, Row, RowBatch, ServerError};

/// 남은 결과를 버리는 이유. `Finished`의 outcome이 된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DrainReason {
    Cancelled,
    Discarded,
}

impl DrainReason {
    fn outcome(self) -> QueryOutcome {
        match self {
            Self::Cancelled => QueryOutcome::Cancelled,
            Self::Discarded => QueryOutcome::Discarded,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// 행을 읽는 중.
    Reading,
    /// batch를 보내고 `fetch_more`를 기다린다. 결과를 읽지 않으므로 서버가 기다린다.
    Paused,
    /// 남은 결과를 버리는 중.
    Draining(DrainReason),
}

/// 결과가 끝난 방식.
enum End {
    /// `None`까지 읽었다.
    Done,
    ConnectionLost {
        message: String,
    },
}

/// 아직 시작하지 않은 쿼리. 세션이 앞 쿼리를 버리는 동안 기다린다.
pub(super) struct Pending {
    pub(super) id: QueryId,
    pub(super) sql: String,
    pub(super) sink: QuerySink,
}

impl Pending {
    /// 시작하지 않고 버린다.
    pub(super) fn discard(mut self) {
        (self.sink)(QueryEvent::Finished {
            outcome: QueryOutcome::Discarded,
            elapsed: Duration::ZERO,
        });
    }
}

/// `Paused`인 동안은 멈추는 시계.
struct Clock {
    running_since: Option<Instant>,
    counted: Duration,
}

impl Clock {
    fn start(now: Instant) -> Self {
        Self {
            running_since: Some(now),
            counted: Duration::ZERO,
        }
    }

    fn pause(&mut self) {
        if let Some(since) = self.running_since.take() {
            self.counted += since.elapsed();
        }
    }

    fn resume(&mut self) {
        self.running_since.get_or_insert_with(Instant::now);
    }

    fn elapsed(&self) -> Duration {
        self.counted
            + self
                .running_since
                .map_or(Duration::ZERO, |since| since.elapsed())
    }
}

/// 시작한 쿼리 하나와 그 결과.
pub(super) struct Query<R> {
    pub(super) id: QueryId,
    sink: QuerySink,
    rows: R,
    phase: Phase,
    clock: Clock,
    limits: QueryLimits,
    /// 아직 보내지 않은 행.
    batch: Vec<Row>,
    batch_bytes: usize,
    /// 지금까지 batch로 보낸 행 수. 다음 batch의 첫 행 번호다.
    sent_rows: u64,
    /// batch를 보낸 뒤 항목을 하나 더 읽는 중이다. 행이 오면 `Paused`가 된다.
    look_ahead: bool,
    /// 마지막 `Complete`의 행 수.
    completed: Option<u64>,
    /// 처음 받은 서버 오류.
    error: Option<ServerError>,
    end: Option<End>,
}

impl<R: RowSource> Query<R> {
    /// `started`는 문장을 보내기 직전의 시각이다.
    pub(super) fn new(pending: Pending, rows: R, started: Instant, limits: QueryLimits) -> Self {
        Self {
            id: pending.id,
            sink: pending.sink,
            rows,
            phase: Phase::Reading,
            clock: Clock::start(started),
            limits,
            batch: Vec::new(),
            batch_bytes: 0,
            sent_rows: 0,
            look_ahead: false,
            completed: None,
            error: None,
            end: None,
        }
    }

    /// 지금 읽어야 하는 결과. `Paused`이거나 결과가 끝났으면 `None`이다.
    pub(super) fn rows_to_read(&mut self) -> Option<&mut R> {
        // 끝난 결과는 다시 poll하지 않는다. `None` 뒤의 poll은 port가 정하지 않았다.
        let reads = self.end.is_none() && self.phase != Phase::Paused;
        reads.then_some(&mut self.rows)
    }

    /// 결과가 끝났다(`None` 또는 `ConnectionLost`).
    pub(super) fn is_over(&self) -> bool {
        self.end.is_some()
    }

    fn is_draining(&self) -> bool {
        matches!(self.phase, Phase::Draining(_))
    }

    /// 결과에서 읽은 항목 하나를 처리한다.
    pub(super) fn receive(&mut self, item: Option<Result<RowItem, QueryError>>) {
        match item {
            None => self.end = Some(End::Done),
            Some(Err(QueryError::ConnectionLost { message })) => {
                self.end = Some(End::ConnectionLost { message });
            }
            // 버리는 중에는 끝났는지만 본다.
            Some(_) if self.is_draining() => {}
            Some(Ok(RowItem::Columns(columns))) => self.emit(QueryEvent::Columns(columns)),
            Some(Ok(RowItem::Row(row))) => self.push(row),
            Some(Ok(RowItem::Complete { rows })) => self.completed = Some(rows),
            Some(Err(QueryError::Server(error))) => {
                self.error.get_or_insert(error);
            }
        }
    }

    fn push(&mut self, row: Row) {
        self.batch_bytes += row.iter().flatten().map(String::len).sum::<usize>();
        self.batch.push(row);
        if self.look_ahead {
            // 다음 batch의 첫 행이다. 서버를 기다리게 한다.
            self.look_ahead = false;
            self.phase = Phase::Paused;
            self.clock.pause();
        } else if self.batch_is_full() {
            self.send_batch();
            self.look_ahead = true;
        }
    }

    fn batch_is_full(&self) -> bool {
        self.batch.len() >= self.limits.batch_rows || self.batch_bytes >= self.limits.batch_bytes
    }

    fn send_batch(&mut self) {
        let rows = std::mem::take(&mut self.batch);
        self.batch_bytes = 0;
        let first_row = self.sent_rows;
        self.sent_rows += rows.len() as u64;
        let batch = RowBatch {
            first_row,
            rows,
            retained_from: self.limits.retained_from(self.sent_rows),
            elapsed: self.clock.elapsed(),
        };
        self.emit(QueryEvent::Rows(batch));
    }

    /// `fetch_more`. 다음 batch를 읽게 했으면 true다.
    pub(super) fn fetch_more(&mut self) -> bool {
        match self.phase {
            Phase::Paused => {
                self.phase = Phase::Reading;
                self.clock.resume();
                // look-ahead 행 하나로 batch가 찼으면 더 읽지 않고 보낸다.
                if self.batch_is_full() {
                    self.send_batch();
                    self.look_ahead = true;
                }
                true
            }
            Phase::Reading => {
                // 보낸 batch의 look-ahead가 아직 끝나지 않았다. 다음 행에서 멈추지 않는다.
                self.look_ahead = false;
                true
            }
            Phase::Draining(_) => false,
        }
    }

    /// 남은 결과를 버리기 시작한다. 이미 버리는 중이면 아무것도 하지 않고 false다.
    pub(super) fn drain(&mut self, reason: DrainReason) -> bool {
        if self.is_draining() {
            return false;
        }
        self.phase = Phase::Draining(reason);
        self.clock.resume();
        self.batch = Vec::new();
        self.batch_bytes = 0;
        self.look_ahead = false;
        true
    }

    /// 결과가 끝날 때까지 버린다.
    pub(super) async fn drain_to_end(&mut self) {
        while self.end.is_none() {
            let item = self.rows.next().await;
            self.receive(item);
        }
    }

    /// 끝난 결과의 남은 batch와 `Finished`를 보낸다. 연결이 끊겨서 끝났으면 true다.
    pub(super) fn finish(mut self) -> bool {
        let end = self.end.take().expect("결과가 끝난 쿼리만 마친다");
        let lost = matches!(end, End::ConnectionLost { .. });
        let outcome = match (self.phase, end) {
            (Phase::Draining(_), End::ConnectionLost { message }) => {
                QueryOutcome::ConnectionLost { message }
            }
            (Phase::Draining(reason), End::Done) => reason.outcome(),
            (_, end) => {
                if !self.batch.is_empty() {
                    self.send_batch();
                }
                match (self.error.take(), end) {
                    (Some(error), _) => QueryOutcome::Failed(error),
                    (None, End::ConnectionLost { message }) => {
                        QueryOutcome::ConnectionLost { message }
                    }
                    (None, End::Done) => QueryOutcome::Completed {
                        rows: self.completed.unwrap_or(0),
                    },
                }
            }
        };
        self.emit_finished(outcome);
        lost
    }

    /// 세션을 닫으며 마친다. 결과가 어떻게 끝났든 버린 것으로 본다.
    pub(super) fn finish_closed(mut self) {
        let outcome = match self.phase {
            Phase::Draining(reason) => reason.outcome(),
            _ => QueryOutcome::Discarded,
        };
        self.emit_finished(outcome);
    }

    fn emit_finished(&mut self, outcome: QueryOutcome) {
        let elapsed = self.clock.elapsed();
        self.emit(QueryEvent::Finished { outcome, elapsed });
    }

    fn emit(&mut self, event: QueryEvent) {
        (self.sink)(event);
    }
}
