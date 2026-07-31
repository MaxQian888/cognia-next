//! Streaming NDJSON POST — read a newline-delimited JSON response line by
//! line and hand each parsed value to a callback as it arrives.
//!
//! Sibling of [`crate::http_download`]: same "stream the body, report as you
//! go" shape, different sink. `http_download` writes bytes to a file and
//! reports byte counts; this one reassembles lines and reports parsed JSON.
//! The pattern is shared, the code is not — a file writer and a line parser
//! have nothing useful in common below the surface.
//!
//! This exists because the app's general-purpose escape hatch for renderer
//! HTTP, the `proxy_http_request` Tauri command, returns a fully-buffered
//! `body: String`. That is fine for every request/response API, and useless for
//! a progress stream: the caller would sit silent for the whole download and
//! then receive every progress line at once, after the thing they were
//! reporting on had already finished. Ollama's `/api/pull` is exactly that
//! shape, which is why it — alone — needs a streaming command of its own.
//!
//! Deliberately *not* a policy layer: allowlists, proxy selection, auth and
//! timeouts belong to the [`reqwest::Client`] the caller passes in.

use serde::de::DeserializeOwned;

#[derive(Debug, thiserror::Error)]
pub enum NdjsonError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("server returned {status}: {body}")]
    Status { status: u16, body: String },

    /// A single line outgrew the ceiling. Guards against a server that never
    /// sends a newline, which would otherwise grow `buffer` without bound.
    #[error("a single NDJSON line exceeded the {max}-byte cap")]
    LineTooLong { max: usize },
}

/// Cap for one un-terminated line. Ollama's progress objects are well under a
/// kilobyte; a megabyte without a newline means the peer is not speaking
/// NDJSON, and buffering more of it only helps it exhaust our memory.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// POST `json_body` to `url` and invoke `on_line` for every NDJSON line the
/// server sends, as it arrives.
///
/// Lines that fail to parse as `T` are SKIPPED, not fatal. Ollama interleaves
/// shapes on one stream (`{"status":"pulling manifest"}` carries no byte
/// counts at all), and a strict parse would abort a running download over a
/// line the caller did not even need.
///
/// `on_line` carries a `Send` bound so the returned future stays `Send`, which
/// Tauri's command macro requires of any `async` command body awaiting this.
///
/// Returns the number of lines successfully parsed and delivered.
pub async fn stream_ndjson_post<T, B>(
    client: &reqwest::Client,
    url: &str,
    json_body: &B,
    on_line: &mut (dyn FnMut(T) + Send),
) -> Result<u64, NdjsonError>
where
    T: DeserializeOwned,
    B: serde::Serialize + ?Sized,
{
    use futures_util::StreamExt as _;

    let resp = client.post(url).json(json_body).send().await?;

    // Surface the server's own error text rather than a bare status: Ollama
    // explains itself here ("model not found", …) and that message is the
    // whole value of the failure to a user.
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(NdjsonError::Status {
            status: status.as_u16(),
            body,
        });
    }

    let mut delivered: u64 = 0;
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        // Chunk boundaries fall wherever the network puts them, so a chunk
        // routinely splits a line — and may split a multi-byte UTF-8 sequence.
        // Lossy decoding of a chunk in isolation would corrupt that character;
        // in practice Ollama's payloads are ASCII, and a replacement char in a
        // status string is preferable to dropping the stream.
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim().to_string();
            buffer.drain(..=newline);
            if line.is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<T>(&line) {
                on_line(parsed);
                delivered = delivered.saturating_add(1);
            }
        }

        if buffer.len() > MAX_LINE_BYTES {
            return Err(NdjsonError::LineTooLong {
                max: MAX_LINE_BYTES,
            });
        }
    }

    // A final line without a trailing newline is still a line.
    let tail = buffer.trim();
    if !tail.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<T>(tail) {
            on_line(parsed);
            delivered = delivered.saturating_add(1);
        }
    }

    Ok(delivered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    #[derive(Debug, Deserialize, PartialEq)]
    struct Progress {
        status: String,
        #[serde(default)]
        completed: u64,
    }

    /// Serve one canned HTTP response and shut down. `chunks` are written with
    /// a flush between each so the client observes real streaming boundaries
    /// rather than one coalesced buffer.
    async fn serve_once(status_line: &'static str, chunks: Vec<&'static str>) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut discard = [0u8; 2048];
            let _ = sock.read(&mut discard).await;
            sock.write_all(status_line.as_bytes()).await.unwrap();
            for chunk in chunks {
                sock.write_all(chunk.as_bytes()).await.unwrap();
                sock.flush().await.unwrap();
            }
            let _ = sock.shutdown().await;
        });
        addr
    }

    const OK_HEADERS: &str =
        "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n";

    #[tokio::test]
    async fn delivers_each_line_as_it_arrives() {
        let addr = serve_once(
            OK_HEADERS,
            vec![
                "{\"status\":\"pulling\",\"completed\":1}\n",
                "{\"status\":\"verifying\",\"completed\":2}\n",
            ],
        )
        .await;

        let mut seen: Vec<Progress> = Vec::new();
        let n = stream_ndjson_post(
            &reqwest::Client::new(),
            &format!("http://{addr}/api/pull"),
            &serde_json::json!({ "name": "m" }),
            &mut |p: Progress| seen.push(p),
        )
        .await
        .unwrap();

        assert_eq!(n, 2);
        assert_eq!(seen[0].status, "pulling");
        assert_eq!(seen[1].completed, 2);
    }

    /// The load-bearing case: the network splits lines wherever it likes, so a
    /// JSON object routinely spans two chunks. Parsing per-chunk would drop it.
    #[tokio::test]
    async fn reassembles_a_line_split_across_chunks() {
        let addr = serve_once(
            OK_HEADERS,
            vec!["{\"status\":\"pul", "ling\",\"completed\":7}\n"],
        )
        .await;

        let mut seen: Vec<Progress> = Vec::new();
        stream_ndjson_post(
            &reqwest::Client::new(),
            &format!("http://{addr}/api/pull"),
            &serde_json::json!({}),
            &mut |p: Progress| seen.push(p),
        )
        .await
        .unwrap();

        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].completed, 7);
    }

    /// Ollama's own stream mixes shapes — a malformed or simply different line
    /// must not abort a download that is otherwise progressing.
    #[tokio::test]
    async fn skips_unparsable_lines_without_failing_the_stream() {
        let addr = serve_once(
            OK_HEADERS,
            vec!["not-json\n", "{\"status\":\"ok\",\"completed\":3}\n", "\n"],
        )
        .await;

        let mut seen: Vec<Progress> = Vec::new();
        let n = stream_ndjson_post(
            &reqwest::Client::new(),
            &format!("http://{addr}/api/pull"),
            &serde_json::json!({}),
            &mut |p: Progress| seen.push(p),
        )
        .await
        .unwrap();

        assert_eq!(n, 1);
        assert_eq!(seen[0].status, "ok");
    }

    #[tokio::test]
    async fn delivers_a_final_line_that_has_no_trailing_newline() {
        let addr = serve_once(OK_HEADERS, vec!["{\"status\":\"done\",\"completed\":9}"]).await;

        let mut seen: Vec<Progress> = Vec::new();
        stream_ndjson_post(
            &reqwest::Client::new(),
            &format!("http://{addr}/api/pull"),
            &serde_json::json!({}),
            &mut |p: Progress| seen.push(p),
        )
        .await
        .unwrap();

        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].status, "done");
    }

    /// A peer that never sends a newline would otherwise grow `buffer` for as
    /// long as it keeps writing. The cap turns that into a bounded error.
    #[tokio::test]
    async fn refuses_a_single_line_that_blows_the_size_cap() {
        // 2 MiB of newline-free bytes — twice MAX_LINE_BYTES.
        let flood: &'static str = Box::leak(
            std::iter::repeat('x')
                .take(2 * 1024 * 1024)
                .collect::<String>()
                .into_boxed_str(),
        );
        let addr = serve_once(OK_HEADERS, vec![flood]).await;

        let err = stream_ndjson_post(
            &reqwest::Client::new(),
            &format!("http://{addr}/api/pull"),
            &serde_json::json!({}),
            &mut |_p: Progress| {},
        )
        .await
        .unwrap_err();

        match err {
            NdjsonError::LineTooLong { max } => assert_eq!(max, MAX_LINE_BYTES),
            other => panic!("expected LineTooLong, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn surfaces_the_servers_error_text_not_just_the_status() {
        // No Content-Length: the body is delimited by EOF via `Connection:
        // close`. A hand-counted length here is just a chance to miscount.
        let addr = serve_once(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            vec!["{\"error\":\"model not found\"}\n"],
        )
        .await;

        let err = stream_ndjson_post(
            &reqwest::Client::new(),
            &format!("http://{addr}/api/pull"),
            &serde_json::json!({}),
            &mut |_p: Progress| {},
        )
        .await
        .unwrap_err();

        match err {
            NdjsonError::Status { status, body } => {
                assert_eq!(status, 404);
                assert!(body.contains("model not found"), "body was: {body}");
            }
            other => panic!("expected Status, got {other:?}"),
        }
    }
}
