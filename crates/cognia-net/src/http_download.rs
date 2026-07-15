//! Streaming HTTP download with an incremental SHA-256 and a hard byte
//! ceiling.
//!
//! Extracted from `src-tauri/src/codeserver/download.rs`, where the same loop
//! lived as a private fn, so the Open VSX `.vsix` fetch in
//! `cognia-plugin-runtime` reuses one audited implementation instead of
//! growing a second copy. It lands here rather than in `cognia-core` because
//! it needs reqwest, and core is deliberately dependency-free.
//!
//! Deliberately *not* a policy layer: host allowlists, redirect rules, proxy
//! selection, auth and user-agent all belong to the [`reqwest::Client`] the
//! caller hands in. This module owns exactly one thing — get the bytes onto
//! disk, hash them on the way past, and refuse to exceed a cap.

use std::path::Path;

use sha2::{Digest, Sha256};

/// What a completed download produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadOutcome {
    /// Lowercase hex SHA-256 of exactly the bytes written to `dest`.
    pub sha256_hex: String,
    /// Bytes written. Authoritative — unlike `Content-Length`, which is a
    /// claim by the server.
    pub bytes_written: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// `Content-Length` already exceeds the ceiling — refused before reading a
    /// single body byte, so an oversized asset costs no bandwidth and no
    /// memory.
    #[error("response declares {declared} bytes, over the {max}-byte cap")]
    DeclaredTooLarge { declared: u64, max: u64 },

    /// The body outgrew the ceiling mid-stream. `Content-Length` is only a
    /// claim: a hostile or broken server can under-report it or omit it
    /// entirely, so the cap is re-checked on every chunk.
    #[error("response body exceeded the {max}-byte cap")]
    StreamTooLarge { max: u64 },
}

/// GET `url` with `client`, stream the body into `dest`, and return the
/// lowercase hex SHA-256 of what was written.
///
/// `max_bytes` bounds the body twice: up-front against `Content-Length`, and
/// again per chunk against the bytes actually seen. Both are needed — see
/// [`DownloadError::StreamTooLarge`].
///
/// `on_progress` is called after every chunk with `(bytes_done, bytes_total)`;
/// `bytes_total` is 0 when the server sends no `Content-Length`. It carries a
/// `Send` bound so the returned future stays `Send` — Tauri's command macro
/// requires that of every `async` command body that awaits this.
///
/// On error `dest` may exist as a partial file. Cleanup is the caller's job,
/// because only the caller knows whether a resumable `.partial` is wanted or
/// whether the file must not survive at all.
pub async fn stream_to_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    max_bytes: Option<u64>,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<DownloadOutcome, DownloadError> {
    use futures_util::StreamExt as _;
    use tokio::io::AsyncWriteExt as _;

    let resp = client.get(url).send().await?.error_for_status()?;

    let declared = resp.content_length();
    if let (Some(max), Some(declared)) = (max_bytes, declared) {
        if declared > max {
            return Err(DownloadError::DeclaredTooLarge { declared, max });
        }
    }
    let bytes_total = declared.unwrap_or(0);

    let mut hasher = Sha256::new();
    let mut bytes_done: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(dest).await?;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        bytes_done = bytes_done.saturating_add(chunk.len() as u64);
        // Check before writing: an over-cap chunk must not reach the disk.
        if let Some(max) = max_bytes {
            if bytes_done > max {
                return Err(DownloadError::StreamTooLarge { max });
            }
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        on_progress(bytes_done, bytes_total);
    }
    file.flush().await?;

    Ok(DownloadOutcome {
        sha256_hex: hex::encode(hasher.finalize()),
        bytes_written: bytes_done,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    /// SHA-256 of `b"hello"`.
    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    /// Minimal single-shot HTTP/1.1 origin: read the request head, write
    /// `response` verbatim, close. Enough to drive the streaming loop for real
    /// without pulling a server framework into a foundation crate.
    async fn serve_once(response: Vec<u8>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(&response).await;
                let _ = sock.shutdown().await;
            }
        });
        addr
    }

    fn with_content_length(body: &[u8]) -> Vec<u8> {
        let mut out =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// HTTP/1.1 response with **no** `Content-Length` — the body runs to
    /// connection close. This is how a server omits the size entirely.
    fn without_content_length(body: &[u8]) -> Vec<u8> {
        let mut out = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        out.extend_from_slice(body);
        out
    }

    #[tokio::test]
    async fn streams_body_to_disk_and_returns_its_sha256() {
        let addr = serve_once(with_content_length(b"hello")).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.bin");

        let outcome = stream_to_file(
            &reqwest::Client::new(),
            &format!("http://{addr}/x"),
            &dest,
            Some(1024),
            &mut |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(outcome.sha256_hex, HELLO_SHA256);
        assert_eq!(outcome.bytes_written, 5);
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    }

    #[tokio::test]
    async fn reports_progress_with_declared_total() {
        let addr = serve_once(with_content_length(b"hello")).await;
        let dir = tempfile::tempdir().unwrap();
        let mut seen: Vec<(u64, u64)> = Vec::new();

        stream_to_file(
            &reqwest::Client::new(),
            &format!("http://{addr}/x"),
            &dir.path().join("out.bin"),
            None,
            &mut |done, total| seen.push((done, total)),
        )
        .await
        .unwrap();

        assert_eq!(seen.last(), Some(&(5, 5)));
    }

    /// The cheap guard: an oversized `Content-Length` is refused before the
    /// body is read at all.
    #[tokio::test]
    async fn declared_content_length_over_cap_is_refused_up_front() {
        let addr = serve_once(with_content_length(b"hello")).await;
        let dir = tempfile::tempdir().unwrap();

        let err = stream_to_file(
            &reqwest::Client::new(),
            &format!("http://{addr}/x"),
            &dir.path().join("out.bin"),
            Some(2),
            &mut |_, _| {},
        )
        .await
        .unwrap_err();

        assert!(
            matches!(
                err,
                DownloadError::DeclaredTooLarge {
                    declared: 5,
                    max: 2
                }
            ),
            "expected DeclaredTooLarge, got {err:?}"
        );
    }

    /// The guard that matters: with no `Content-Length` the up-front check
    /// cannot fire, so the per-chunk ceiling has to stop the stream.
    #[tokio::test]
    async fn body_over_cap_without_content_length_aborts_mid_stream() {
        let addr = serve_once(without_content_length(&vec![b'a'; 4096])).await;
        let dir = tempfile::tempdir().unwrap();

        let err = stream_to_file(
            &reqwest::Client::new(),
            &format!("http://{addr}/x"),
            &dir.path().join("out.bin"),
            Some(16),
            &mut |_, _| {},
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, DownloadError::StreamTooLarge { max: 16 }),
            "expected StreamTooLarge, got {err:?}"
        );
    }

    #[tokio::test]
    async fn error_status_is_surfaced_not_written_to_disk() {
        let addr = serve_once(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec()).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.bin");

        let err = stream_to_file(
            &reqwest::Client::new(),
            &format!("http://{addr}/x"),
            &dest,
            None,
            &mut |_, _| {},
        )
        .await
        .unwrap_err();

        assert!(matches!(err, DownloadError::Http(_)), "got {err:?}");
        assert!(!dest.exists(), "a failed request must not create the file");
    }
}
