//! Streaming Server-Sent Events GET — parse a `text/event-stream` body frame
//! by frame and hand each event to a callback as it arrives.
//!
//! Third sibling of [`crate::http_download`] and [`crate::ndjson_stream`]: same
//! "stream the body, report as you go" shape, a third sink. `http_download`
//! writes bytes to a file, `ndjson_stream` reassembles newline-delimited JSON,
//! this one reassembles SSE frames.
//!
//! It exists for the same reason `ndjson_stream` does: the renderer's
//! general-purpose HTTP escape hatch, the `proxy_http_request` Tauri command,
//! returns a fully-buffered body. An SSE stream never completes, so a buffered
//! transport does not merely delay the events — it delivers nothing, ever. The
//! Ops Controller's `/v1/events` endpoint (ADR-0059) is exactly that shape, and
//! a renderer `fetch` cannot reach a user-supplied controller host at all under
//! the desktop CSP, so the native side has to own the whole stream.
//!
//! A browser `EventSource` is not an option even on the web: the controller
//! authenticates with `Authorization: Bearer`, and `EventSource` cannot set
//! request headers.
//!
//! Deliberately *not* a policy layer: allowlists, proxy selection, auth and
//! timeouts belong to the [`reqwest::Client`] the caller passes in.

/// One decoded SSE frame.
///
/// Comment-only frames (the `:keep-alive` the controller emits every 15s) are
/// swallowed by the parser and never surface here — a keep-alive is transport
/// liveness, not an event, and a caller that treated it as one would advance
/// its cursor past nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct SseEvent {
    /// `id:` — the stream cursor. Echoed back as `Last-Event-ID` on reconnect.
    pub id: Option<String>,
    /// `event:` — the event name. Absent means the default `message` type.
    pub event: Option<String>,
    /// `data:` — every data line of the frame, joined with `\n`.
    pub data: String,
    /// `retry:` — the server's reconnect hint, in milliseconds.
    pub retry: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum SseError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("server returned {status}: {body}")]
    Status { status: u16, body: String },

    /// One un-terminated frame outgrew the ceiling. Guards against a peer that
    /// never sends a frame boundary, which would otherwise grow `buffer`
    /// without bound.
    #[error("a single SSE frame exceeded the {max}-byte cap")]
    FrameTooLong { max: usize },
}

/// Cap for one un-terminated frame. Operation events are a few hundred bytes;
/// a megabyte without a blank line means the peer is not speaking SSE, and
/// buffering more of it only helps it exhaust our memory.
const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// GET `url` and invoke `on_event` for every SSE frame the server sends, as it
/// arrives. Returns the number of events delivered once the stream ends.
///
/// The future resolves only when the server closes the body or the caller drops
/// it — an SSE stream is unbounded by design, so callers run this inside a task
/// they can abort.
///
/// `on_event` carries a `Send` bound so the returned future stays `Send`, which
/// Tauri's command macro requires of any `async` command body awaiting this.
pub async fn stream_sse_get(
    client: &reqwest::Client,
    url: &str,
    headers: reqwest::header::HeaderMap,
    on_event: &mut (dyn FnMut(SseEvent) + Send),
) -> Result<u64, SseError> {
    use futures_util::StreamExt as _;

    let response = client
        .get(url)
        .headers(headers)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await?;

    // Surface the controller's own error body rather than a bare status: it
    // answers with `{"code":"insufficient_scope",…}`, and that code is the
    // whole value of the failure to the renderer.
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(SseError::Status {
            status: status.as_u16(),
            body,
        });
    }

    let mut delivered: u64 = 0;
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        // Chunk boundaries fall wherever the network puts them, so a chunk
        // routinely splits a frame — and may split a multi-byte UTF-8 sequence.
        // Lossy decoding of a chunk in isolation would corrupt that character;
        // a replacement char inside a log message is preferable to dropping a
        // live operation stream.
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some((frame, rest)) = split_frame(&buffer) {
            let frame = frame.to_owned();
            buffer = rest.to_owned();
            if let Some(event) = parse_frame(&frame) {
                on_event(event);
                delivered = delivered.saturating_add(1);
            }
        }

        if buffer.len() > MAX_FRAME_BYTES {
            return Err(SseError::FrameTooLong {
                max: MAX_FRAME_BYTES,
            });
        }
    }

    // A final frame without its trailing blank line is still a frame — servers
    // that close mid-flush would otherwise drop their last event.
    if let Some(event) = parse_frame(&buffer) {
        on_event(event);
        delivered = delivered.saturating_add(1);
    }

    Ok(delivered)
}

/// Split off the first complete frame, returning `(frame, remainder)`.
///
/// SSE terminates a frame with a blank line, and the wire form of "blank line"
/// depends on the server's line endings — Axum writes `\n\n`, other stacks
/// write `\r\n\r\n`, and a proxy may rewrite either. Scanning for the earliest
/// of the three keeps all of them working.
fn split_frame(buffer: &str) -> Option<(&str, &str)> {
    let boundary = ["\r\n\r\n", "\n\n", "\r\r"]
        .iter()
        .filter_map(|separator| buffer.find(separator).map(|index| (index, separator.len())))
        .min_by_key(|(index, _)| *index)?;
    let (index, length) = boundary;
    Some((&buffer[..index], &buffer[index + length..]))
}

/// Decode one frame's fields. Returns `None` for a frame that carries no
/// fields at all — a keep-alive comment, or the empty remainder left behind
/// after the last boundary.
fn parse_frame(frame: &str) -> Option<SseEvent> {
    let mut event = SseEvent::default();
    let mut data_lines: Vec<&str> = Vec::new();
    let mut has_field = false;

    for line in frame.split(['\n', '\r']) {
        // A line opening with `:` is a comment. The controller's keep-alive is
        // exactly this, and treating it as an event would emit a null frame
        // every 15 seconds.
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, raw_value) = match line.split_once(':') {
            Some((field, value)) => (field, value),
            // A field name with no colon is a field with an empty value.
            None => (line, ""),
        };
        // Exactly one leading space after the colon is part of the framing,
        // not of the value.
        let value = raw_value.strip_prefix(' ').unwrap_or(raw_value);
        match field {
            "id" => {
                has_field = true;
                // The spec drops an id containing NUL; nothing else validates.
                if !value.contains('\0') {
                    event.id = Some(value.to_owned());
                }
            }
            "event" => {
                has_field = true;
                event.event = Some(value.to_owned());
            }
            "data" => {
                has_field = true;
                data_lines.push(value);
            }
            "retry" => {
                has_field = true;
                event.retry = value.parse::<u64>().ok();
            }
            // Unknown fields are ignored by the spec, but their presence still
            // makes this a real frame rather than a comment.
            _ => has_field = true,
        }
    }

    if !has_field {
        return None;
    }
    event.data = data_lines.join("\n");
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_operation_frame() {
        let event = parse_frame("id: 42\nevent: operation\ndata: {\"id\":42}").unwrap();
        assert_eq!(event.id.as_deref(), Some("42"));
        assert_eq!(event.event.as_deref(), Some("operation"));
        assert_eq!(event.data, "{\"id\":42}");
    }

    #[test]
    fn joins_multiple_data_lines_with_newlines() {
        let event = parse_frame("data: first\ndata: second").unwrap();
        assert_eq!(event.data, "first\nsecond");
    }

    #[test]
    fn strips_exactly_one_leading_space() {
        let event = parse_frame("data:  padded").unwrap();
        assert_eq!(event.data, " padded");
    }

    #[test]
    fn treats_a_comment_only_frame_as_no_event() {
        // The controller's 15-second keep-alive. Surfacing it would advance a
        // caller's cursor past an event that does not exist.
        assert!(parse_frame(":keep-alive").is_none());
        assert!(parse_frame("").is_none());
    }

    #[test]
    fn reads_a_field_with_no_colon_as_an_empty_value() {
        let event = parse_frame("data").unwrap();
        assert_eq!(event.data, "");
    }

    #[test]
    fn parses_retry_hints_and_ignores_unparsable_ones() {
        assert_eq!(parse_frame("retry: 2500").unwrap().retry, Some(2500));
        assert_eq!(parse_frame("retry: soon").unwrap().retry, None);
    }

    #[test]
    fn splits_on_lf_crlf_and_cr_boundaries() {
        assert_eq!(split_frame("a\n\nb"), Some(("a", "b")));
        assert_eq!(split_frame("a\r\n\r\nb"), Some(("a", "b")));
        assert_eq!(split_frame("a\r\rb"), Some(("a", "b")));
        assert_eq!(split_frame("a\nb"), None);
    }

    #[test]
    fn splits_at_the_earliest_boundary_when_forms_are_mixed() {
        // A CRLF stream whose payload contains a bare LF pair must still break
        // at the first real boundary, not at whichever form is checked first.
        assert_eq!(split_frame("a\n\nb\r\n\r\nc"), Some(("a", "b\r\n\r\nc")));
    }

    #[tokio::test]
    async fn streams_frames_as_they_arrive_and_reports_error_bodies() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        // A hand-rolled origin rather than a mock: the point of this test is
        // the chunk-boundary reassembly, and only a real socket produces the
        // split reads that the parser exists to survive.
        async fn respond(listener: &tokio::net::TcpListener, response: &[u8]) {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket.write_all(response).await.unwrap();
            // Half-close instead of dropping: a bare drop with unread bytes in
            // the kernel buffer sends RST on macOS, and reqwest reports that as
            // a decode error rather than end of stream.
            socket.shutdown().await.unwrap();
            let mut drain = Vec::new();
            let _ = socket.read_to_end(&mut drain).await;
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            // A healthy stream that ends without a trailing blank line, so the
            // tail-flush path is exercised too. No Content-Length: end of body
            // is end of connection, which is also how an aborted SSE stream
            // reaches us in production.
            respond(
                &listener,
                concat!(
                    "HTTP/1.1 200 OK\r\n",
                    "Content-Type: text/event-stream\r\n",
                    "Connection: close\r\n\r\n",
                    ":keep-alive\n\n",
                    "id: 1\nevent: operation\ndata: one\n\n",
                    "id: 2\ndata: two",
                )
                .as_bytes(),
            )
            .await;

            // A rejected subscription whose body carries the controller code.
            respond(
                &listener,
                concat!(
                    "HTTP/1.1 403 Forbidden\r\n",
                    "Connection: close\r\n\r\n",
                    r#"{"code":"insufficient_scope"}"#,
                )
                .as_bytes(),
            )
            .await;
        });

        let client = reqwest::Client::new();
        let url = format!("http://{address}/v1/events");
        let mut seen: Vec<SseEvent> = Vec::new();
        let delivered = stream_sse_get(
            &client,
            &url,
            reqwest::header::HeaderMap::new(),
            &mut |event| seen.push(event),
        )
        .await
        .unwrap();

        assert_eq!(
            delivered, 2,
            "the keep-alive comment must not count: {seen:?}"
        );
        assert_eq!(seen[0].id.as_deref(), Some("1"));
        assert_eq!(seen[0].event.as_deref(), Some("operation"));
        assert_eq!(seen[0].data, "one");
        assert_eq!(seen[1].id.as_deref(), Some("2"));
        assert_eq!(seen[1].data, "two");

        let error = stream_sse_get(
            &client,
            &url,
            reqwest::header::HeaderMap::new(),
            &mut |_| {},
        )
        .await
        .unwrap_err();
        match error {
            SseError::Status { status, body } => {
                assert_eq!(status, 403);
                assert!(body.contains("insufficient_scope"), "body was {body}");
            }
            other => panic!("expected a status error, got {other:?}"),
        }
    }
}
