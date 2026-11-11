//! 서버가 보내는 byte를 지나가는 길에 읽어 트랜잭션 상태를 알아낸다.
//!
//! `tokio-postgres`는 ReadyForQuery의 상태 값을 버리고 공개하지 않는다. 그래서 `connect_raw`에
//! 넘기는 stream을 [`TxTap`]으로 감싸 backend message의 framing을 따라가며 `Z` message의
//! 상태 byte만 꺼낸다. payload는 복사하지 않고 건너뛴다.
//!
//! 서버는 ErrorResponse를 먼저 flush하고 ReadyForQuery를 따로 보낸다. `tokio-postgres`는
//! ErrorResponse에서 바로 오류를 돌려주므로, 그 직후에 읽은 상태는 오류 전의 값이다.
//! [`TxStatusCell::settled`]는 ErrorResponse 뒤의 ReadyForQuery가 지나갈 때까지 기다린다.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;

use crate::domain::TxStatus;

const HEADER_LEN: usize = 5;
const READY_FOR_QUERY: u8 = b'Z';
const ERROR_RESPONSE: u8 = b'E';

struct Shared {
    /// 마지막 ReadyForQuery의 상태 byte.
    status: AtomicU8,
    /// ErrorResponse를 봤고 그 뒤의 ReadyForQuery는 아직 못 봤다.
    error_pending: AtomicBool,
    /// 서버 쪽 stream이 끝났다. 더 올 ReadyForQuery가 없다.
    ended: AtomicBool,
    changed: Notify,
}

/// [`TxTap`]이 본 트랜잭션 상태.
#[derive(Clone)]
pub(crate) struct TxStatusCell(Arc<Shared>);

impl TxStatusCell {
    /// 마지막 ReadyForQuery의 상태. 첫 ReadyForQuery 전에는 `Idle`이다.
    fn get(&self) -> TxStatus {
        TxStatus::from_wire(self.0.status.load(Ordering::Acquire)).unwrap_or(TxStatus::Idle)
    }

    /// 오류 뒤의 ReadyForQuery를 기다렸다가 상태를 돌려준다. 오류가 없었으면 바로 돌려준다.
    /// 연결이 끝나 ReadyForQuery가 오지 않을 때는 마지막으로 본 상태를 돌려준다.
    pub(crate) async fn settled(&self) -> TxStatus {
        loop {
            // 확인과 대기 사이에 온 알림을 놓치지 않도록 먼저 등록한다.
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let waiting = self.0.error_pending.load(Ordering::Acquire)
                && !self.0.ended.load(Ordering::Acquire);
            if !waiting {
                return self.get();
            }
            changed.await;
        }
    }
}

pub(crate) struct TxTap<S> {
    inner: S,
    shared: Arc<Shared>,
    /// 모으는 중인 message header (type 1 byte + 길이 4 byte).
    header: [u8; HEADER_LEN],
    header_filled: usize,
    /// 다음 byte가 ReadyForQuery의 상태 byte다.
    status_next: bool,
    /// 건너뛸 payload의 남은 길이.
    skip: usize,
}

impl<S> TxTap<S> {
    pub(crate) fn new(inner: S) -> (Self, TxStatusCell) {
        let shared = Arc::new(Shared {
            status: AtomicU8::new(b'I'),
            error_pending: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            changed: Notify::new(),
        });
        let tap = Self {
            inner,
            shared: shared.clone(),
            header: [0; HEADER_LEN],
            header_filled: 0,
            status_next: false,
            skip: 0,
        };
        (tap, TxStatusCell(shared))
    }

    /// 서버에서 읽은 byte를 순서대로 넘긴다. 어디서 끊겨 와도 된다.
    fn observe(&mut self, mut bytes: &[u8]) {
        while let Some(&first) = bytes.first() {
            if self.status_next {
                self.status_next = false;
                if TxStatus::from_wire(first).is_some() {
                    self.shared.status.store(first, Ordering::Release);
                }
                self.shared.error_pending.store(false, Ordering::Release);
                self.shared.changed.notify_waiters();
                bytes = &bytes[1..];
            } else if self.skip > 0 {
                let n = self.skip.min(bytes.len());
                self.skip -= n;
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
        } else {
            if ty == ERROR_RESPONSE {
                self.shared.error_pending.store(true, Ordering::Release);
            }
            self.skip = payload;
        }
    }

    fn end(&self) {
        self.shared.ended.store(true, Ordering::Release);
        self.shared.changed.notify_waiters();
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
        let had_room = buf.remaining() > 0;
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        match &result {
            Poll::Ready(Ok(())) => {
                let read = &buf.filled()[before..];
                if read.is_empty() && had_room {
                    this.end(); // EOF
                } else {
                    this.observe(read);
                }
            }
            Poll::Ready(Err(_)) => this.end(),
            Poll::Pending => {}
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
        TxTap::new(())
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
        let (mut tap, cell) = TxTap::new(client);
        server.write_all(&msg(b'E', b"SFATAL\0\0")).await.unwrap();
        drop(server);

        let mut sink = Vec::new();
        tap.read_to_end(&mut sink).await.unwrap();

        assert_eq!(settled_now(&cell).await, Some(TxStatus::Idle));
    }

    #[tokio::test]
    async fn observes_what_the_reader_reads_and_passes_writes_through() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (client, mut server) = tokio::io::duplex(64);
        let (mut tap, cell) = TxTap::new(client);

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
