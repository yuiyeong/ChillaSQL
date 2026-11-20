//! 서버가 보내는 byte를 지나가는 길에 읽어 트랜잭션 상태를 알아낸다.
//!
//! `tokio-postgres`는 ReadyForQuery의 상태 값을 버리고 공개하지 않는다. 그래서 `connect_raw`에
//! 넘기는 stream을 [`TxTap`]으로 감싸 backend message의 framing을 따라가며 `Z` message의
//! 상태 byte만 꺼낸다. payload는 복사하지 않고 건너뛴다.
//!
//! RowDescription(`T`)만 예외다. `tokio-postgres`의 simple query는 열의 type OID와 typmod를
//! 공개하지 않으므로, payload를 모아 [`RowTypes`]에 넣는다.
//!
//! 서버는 ErrorResponse를 먼저 flush하고 ReadyForQuery를 따로 보낸다. `tokio-postgres`는
//! ErrorResponse에서 바로 오류를 돌려주므로, 그 직후에 읽은 상태는 오류 전의 값이다.
//! [`TxStatusCell::settled`]는 ErrorResponse 뒤의 ReadyForQuery가 지나갈 때까지 기다린다.

use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::watch;

use crate::domain::TxStatus;

const HEADER_LEN: usize = 5;
const READY_FOR_QUERY: u8 = b'Z';
const ERROR_RESPONSE: u8 = b'E';
const ROW_DESCRIPTION: u8 = b'T';

/// ReadyForQuery의 상태 byte.
fn decode_status(byte: u8) -> Option<TxStatus> {
    match byte {
        b'I' => Some(TxStatus::Idle),
        b'T' => Some(TxStatus::InTransaction),
        b'E' => Some(TxStatus::Failed),
        _ => None,
    }
}

#[derive(Clone, Copy)]
struct Seen {
    /// 마지막 ReadyForQuery의 상태. 첫 ReadyForQuery 전에는 `Idle`이다.
    status: TxStatus,
    /// ErrorResponse를 봤고 그 뒤의 ReadyForQuery는 아직 못 봤다.
    error_pending: bool,
}

/// [`TxTap`]이 본 트랜잭션 상태.
#[derive(Clone)]
pub(crate) struct TxStatusCell(watch::Receiver<Seen>);

impl TxStatusCell {
    fn get(&self) -> TxStatus {
        self.0.borrow().status
    }

    /// 오류 뒤의 ReadyForQuery를 기다렸다가 상태를 돌려준다. 오류가 없었으면 바로 돌려준다.
    pub(crate) async fn settled(&self) -> TxStatus {
        let mut seen = self.0.clone();
        // tap이 drop되면(연결이 끝나면) Err다. 더 올 ReadyForQuery가 없으므로 마지막으로 본
        // 상태를 돌려준다. FATAL 오류 뒤에 연결이 닫히는 경우가 그렇다.
        let _ = seen.wait_for(|seen| !seen.error_pending).await;
        self.get()
    }
}

/// RowDescription 하나의 열별 `(type OID, typmod)`.
type FieldTypes = Vec<(u32, i32)>;

/// [`TxTap`]이 본 RowDescription의 type. 도착한 순서대로 쌓인다.
///
/// `tokio-postgres`는 byte를 읽은 뒤에 message를 내놓으므로, 쿼리 결과에서 RowDescription을
/// 받은 시점에는 그 type이 이미 들어 있다.
#[derive(Clone, Default)]
pub(crate) struct RowTypes(Arc<Mutex<VecDeque<FieldTypes>>>);

impl RowTypes {
    /// 쌓인 것을 버린다. 쿼리를 보내기 전에 부른다.
    pub(crate) fn clear(&self) {
        self.lock().clear();
    }

    /// 가장 오래된 RowDescription의 type.
    pub(crate) fn pop(&self) -> Option<FieldTypes> {
        self.lock().pop_front()
    }

    fn push(&self, types: FieldTypes) {
        self.lock().push_back(types);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<FieldTypes>> {
        // 잠근 채 panic하는 곳이 없다. 그래도 poison이면 값을 그대로 쓴다.
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// RowDescription payload에서 열별 type OID와 typmod를 꺼낸다. 모양이 틀리면 `None`이다.
fn parse_row_description(payload: &[u8]) -> Option<FieldTypes> {
    let (count, mut rest) = payload.split_first_chunk::<2>()?;
    let count = u16::from_be_bytes(*count) as usize;
    // 이름(NUL로 끝남) 뒤에 table OID 4, attnum 2, type OID 4, typlen 2, typmod 4, format 2.
    let mut types = Vec::with_capacity(count.min(rest.len()));
    for _ in 0..count {
        let name_end = rest.iter().position(|&byte| byte == 0)?;
        let (fixed, after) = rest[name_end + 1..].split_first_chunk::<18>()?;
        let type_oid = u32::from_be_bytes(fixed[6..10].try_into().ok()?);
        let type_modifier = i32::from_be_bytes(fixed[12..16].try_into().ok()?);
        types.push((type_oid, type_modifier));
        rest = after;
    }
    Some(types)
}

pub(crate) struct TxTap<S> {
    inner: S,
    seen: watch::Sender<Seen>,
    /// 모으는 중인 message header (type 1 byte + 길이 4 byte).
    header: [u8; HEADER_LEN],
    header_filled: usize,
    /// 다음 byte가 ReadyForQuery의 상태 byte다.
    status_next: bool,
    /// 건너뛸 payload의 남은 길이.
    skip: usize,
    /// RowDescription의 payload. 다 모이면 `types`에 넣는다.
    row_description: Option<Vec<u8>>,
    types: RowTypes,
}

impl<S> TxTap<S> {
    pub(crate) fn new(inner: S) -> (Self, TxStatusCell, RowTypes) {
        let (seen, cell) = watch::channel(Seen {
            status: TxStatus::Idle,
            error_pending: false,
        });
        let types = RowTypes::default();
        let tap = Self {
            inner,
            seen,
            header: [0; HEADER_LEN],
            header_filled: 0,
            status_next: false,
            skip: 0,
            row_description: None,
            types: types.clone(),
        };
        (tap, TxStatusCell(cell), types)
    }

    /// 서버에서 읽은 byte를 순서대로 넘긴다. 어디서 끊겨 와도 된다.
    fn observe(&mut self, mut bytes: &[u8]) {
        while let Some(&first) = bytes.first() {
            if self.status_next {
                self.status_next = false;
                self.seen.send_modify(|seen| {
                    // 모르는 상태 byte면 이전 상태를 둔다.
                    seen.status = decode_status(first).unwrap_or(seen.status);
                    seen.error_pending = false;
                });
                bytes = &bytes[1..];
            } else if self.skip > 0 {
                let n = self.skip.min(bytes.len());
                self.skip -= n;
                if let Some(payload) = &mut self.row_description {
                    payload.extend_from_slice(&bytes[..n]);
                    if self.skip == 0 {
                        self.finish_row_description();
                    }
                }
                bytes = &bytes[n..];
            } else {
                let n = (HEADER_LEN - self.header_filled).min(bytes.len());
                self.header[self.header_filled..self.header_filled + n]
                    .copy_from_slice(&bytes[..n]);
                self.header_filled += n;
                bytes = &bytes[n..];
                if self.header_filled == HEADER_LEN {
                    self.header_filled = 0;
                    self.start_payload();
                }
            }
        }
    }

    fn start_payload(&mut self) {
        let [ty, a, b, c, d] = self.header;
        // 길이는 자신의 4 byte를 포함한다.
        let payload = (u32::from_be_bytes([a, b, c, d]) as usize).saturating_sub(4);
        if ty == READY_FOR_QUERY && payload > 0 {
            self.status_next = true;
            self.skip = payload - 1;
        } else if ty == ROW_DESCRIPTION && payload > 0 {
            // 길이는 header에 있으므로 서버가 보낸 만큼만 모은다.
            self.row_description = Some(Vec::new());
            self.skip = payload;
        } else {
            if ty == ERROR_RESPONSE {
                self.seen.send_modify(|seen| seen.error_pending = true);
            }
            self.skip = payload;
        }
    }
}

impl<S> TxTap<S> {
    fn finish_row_description(&mut self) {
        let payload = self.row_description.take().unwrap_or_default();
        // 모양이 틀리면 넣지 않는다. 읽는 쪽은 type이 없는 열로 다룬다.
        if let Some(types) = parse_row_description(&payload) {
            self.types.push(types);
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for TxTap<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) {
            this.observe(&buf.filled()[before..]);
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for TxTap<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// backend message 하나: type 1 byte + 길이 4 byte(자신 포함) + payload.
    fn msg(ty: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![ty];
        bytes.extend_from_slice(&(payload.len() as u32 + 4).to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    fn new_tap() -> (TxTap<()>, TxStatusCell) {
        let (tap, cell, _types) = TxTap::new(());
        (tap, cell)
    }

    /// RowDescription의 field 하나. 이름 뒤에 table OID, attnum, type OID, typlen, typmod, format이 온다.
    fn field(name: &str, type_oid: u32, typmod: i32) -> Vec<u8> {
        let mut bytes = name.as_bytes().to_vec();
        bytes.push(0);
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&0i16.to_be_bytes());
        bytes.extend_from_slice(&type_oid.to_be_bytes());
        bytes.extend_from_slice(&(-1i16).to_be_bytes());
        bytes.extend_from_slice(&typmod.to_be_bytes());
        bytes.extend_from_slice(&0i16.to_be_bytes());
        bytes
    }

    fn row_description(fields: &[Vec<u8>]) -> Vec<u8> {
        let mut payload = (fields.len() as i16).to_be_bytes().to_vec();
        for field in fields {
            payload.extend_from_slice(field);
        }
        msg(b'T', &payload)
    }

    fn two_fields() -> Vec<u8> {
        row_description(&[field("a", 23, -1), field("b", 1043, 259)])
    }

    #[test]
    fn row_description_types_are_queued() {
        let (mut tap, _cell, types) = TxTap::new(());
        for chunk in two_fields().chunks(3) {
            tap.observe(chunk);
        }
        assert_eq!(types.pop(), Some(vec![(23, -1), (1043, 259)]));
        assert_eq!(types.pop(), None);
    }

    #[test]
    fn row_descriptions_are_queued_in_order() {
        let (mut tap, _cell, types) = TxTap::new(());
        tap.observe(&two_fields());
        tap.observe(&msg(b'D', &[7; 20]));
        tap.observe(&row_description(&[field("c", 25, -1)]));
        assert_eq!(types.pop(), Some(vec![(23, -1), (1043, 259)]));
        assert_eq!(types.pop(), Some(vec![(25, -1)]));
    }

    #[test]
    fn clear_drops_queued_types() {
        let (mut tap, _cell, types) = TxTap::new(());
        tap.observe(&two_fields());
        types.clear();
        assert_eq!(types.pop(), None);
    }

    #[test]
    fn status_is_still_read_after_a_row_description() {
        let (mut tap, cell, types) = TxTap::new(());
        let mut bytes = two_fields();
        bytes.extend(msg(b'D', &[1; 10]));
        bytes.extend(msg(b'Z', b"T"));
        tap.observe(&bytes);
        assert_eq!(cell.get(), TxStatus::InTransaction);
        assert_eq!(types.pop(), Some(vec![(23, -1), (1043, 259)]));
    }

    #[test]
    fn malformed_row_description_is_ignored() {
        let (mut tap, cell, types) = TxTap::new(());
        // field 수는 2인데 payload가 짧다.
        let mut payload = 2i16.to_be_bytes().to_vec();
        payload.extend(field("a", 23, -1));
        tap.observe(&msg(b'T', &payload));
        tap.observe(&msg(b'T', &[]));
        tap.observe(&msg(b'Z', b"E"));
        assert_eq!(types.pop(), None);
        assert_eq!(cell.get(), TxStatus::Failed);
    }

    #[test]
    fn starts_idle() {
        let (_tap, cell) = new_tap();
        assert_eq!(cell.get(), TxStatus::Idle);
    }

    #[test]
    fn reads_status_from_ready_for_query() {
        let (mut tap, cell) = new_tap();
        tap.observe(&msg(b'Z', b"T"));
        assert_eq!(cell.get(), TxStatus::InTransaction);
        tap.observe(&msg(b'Z', b"E"));
        assert_eq!(cell.get(), TxStatus::Failed);
        tap.observe(&msg(b'Z', b"I"));
        assert_eq!(cell.get(), TxStatus::Idle);
    }

    #[test]
    fn result_is_the_same_at_every_split_point() {
        let mut bytes = msg(b'R', &[0, 0, 0, 0]);
        bytes.extend(msg(b'D', &[7; 300]));
        bytes.extend(msg(b'Z', b"T"));

        for i in 0..=bytes.len() {
            let (mut tap, cell) = new_tap();
            tap.observe(&bytes[..i]);
            tap.observe(&bytes[i..]);
            assert_eq!(cell.get(), TxStatus::InTransaction, "split at {i}");
        }

        let (mut tap, cell) = new_tap();
        for byte in &bytes {
            tap.observe(std::slice::from_ref(byte));
        }
        assert_eq!(cell.get(), TxStatus::InTransaction);
    }

    #[test]
    fn payload_that_looks_like_ready_for_query_is_ignored() {
        let fake = msg(b'D', b"Z\0\0\0\x05E");

        let (mut tap, cell) = new_tap();
        tap.observe(&fake);
        assert_eq!(cell.get(), TxStatus::Idle);

        let (mut tap, cell) = new_tap();
        tap.observe(&msg(b'Z', b"T"));
        tap.observe(&fake);
        assert_eq!(cell.get(), TxStatus::InTransaction);
        tap.observe(&msg(b'Z', b"I"));
        assert_eq!(cell.get(), TxStatus::Idle);
    }

    #[test]
    fn last_status_wins_within_one_buffer() {
        let mut bytes = msg(b'Z', b"T");
        bytes.extend(msg(b'C', b"BEGIN\0"));
        bytes.extend(msg(b'Z', b"E"));
        let (mut tap, cell) = new_tap();
        tap.observe(&bytes);
        assert_eq!(cell.get(), TxStatus::Failed);
    }

    #[test]
    fn unknown_status_byte_keeps_the_previous_status() {
        let (mut tap, cell) = new_tap();
        tap.observe(&msg(b'Z', b"T"));
        tap.observe(&msg(b'Z', b"?"));
        assert_eq!(cell.get(), TxStatus::InTransaction);
        tap.observe(&msg(b'Z', b"I"));
        assert_eq!(cell.get(), TxStatus::Idle);
    }

    /// `settled()`가 지금 바로 끝나는지 본다.
    async fn settled_now(cell: &TxStatusCell) -> Option<TxStatus> {
        tokio::select! {
            biased;
            status = cell.settled() => Some(status),
            _ = tokio::task::yield_now() => None,
        }
    }

    #[tokio::test]
    async fn settled_is_immediate_without_an_error() {
        let (mut tap, cell) = new_tap();
        assert_eq!(settled_now(&cell).await, Some(TxStatus::Idle));
        tap.observe(&msg(b'Z', b"T"));
        assert_eq!(settled_now(&cell).await, Some(TxStatus::InTransaction));
    }

    /// 서버는 ErrorResponse를 먼저 flush하고 ReadyForQuery를 따로 보낸다. 그 사이에 읽은 상태는
    /// 오류 전의 값이므로 ReadyForQuery까지 기다려야 한다.
    #[tokio::test]
    async fn status_after_an_error_waits_for_ready_for_query() {
        let (mut tap, cell) = new_tap();
        tap.observe(&msg(b'Z', b"T"));
        tap.observe(&msg(b'E', b"SERROR\0\0"));
        assert_eq!(settled_now(&cell).await, None);

        let waiter = tokio::spawn({
            let cell = cell.clone();
            async move { cell.settled().await }
        });
        tokio::task::yield_now().await;
        tap.observe(&msg(b'Z', b"E"));
        assert_eq!(waiter.await.unwrap(), TxStatus::Failed);
        assert_eq!(settled_now(&cell).await, Some(TxStatus::Failed));
    }

    /// FATAL 오류 뒤에는 ReadyForQuery가 오지 않고 연결이 닫힌다. 기다리는 쪽이 멈추면 안 된다.
    #[tokio::test]
    async fn settled_does_not_hang_when_the_connection_ends_after_an_error() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (client, mut server) = tokio::io::duplex(64);
        let (mut tap, cell, _types) = TxTap::new(client);
        server.write_all(&msg(b'E', b"SFATAL\0\0")).await.unwrap();
        drop(server);

        let mut sink = Vec::new();
        tap.read_to_end(&mut sink).await.unwrap();
        assert_eq!(settled_now(&cell).await, None);

        // tokio-postgres의 connection task는 stream이 끝나면 tap을 drop한다.
        drop(tap);
        assert_eq!(settled_now(&cell).await, Some(TxStatus::Idle));
    }

    #[tokio::test]
    async fn observes_what_the_reader_reads_and_passes_writes_through() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (client, mut server) = tokio::io::duplex(64);
        let (mut tap, cell, _types) = TxTap::new(client);

        server.write_all(&msg(b'Z', b"T")).await.unwrap();
        let mut read = [0u8; 6];
        tap.read_exact(&mut read).await.unwrap();
        assert_eq!(read.to_vec(), msg(b'Z', b"T"));
        assert_eq!(cell.get(), TxStatus::InTransaction);

        tap.write_all(b"hello").await.unwrap();
        let mut written = [0u8; 5];
        server.read_exact(&mut written).await.unwrap();
        assert_eq!(&written, b"hello");
    }
}
