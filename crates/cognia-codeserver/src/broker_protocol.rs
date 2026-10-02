//! Framing and version negotiation for the managed code-server broker.
//!
//! The broker speaks JSON-RPC 2.0 carried in LSP-style `Content-Length` frames.
//! Protocol versions are `major.minor`. The hello offers every version the
//! extension speaks and the host answers with the highest major both sides
//! share ([`negotiate_protocol`]); minor differences within a major are carried
//! by capabilities, never by version comparisons.

use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

pub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_HEADER_BYTES: usize = 8 * 1024;
/// Every protocol version this host can serve, one entry per major.
pub(crate) const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["1.0"];
pub(crate) const CODE_API_VERSION: &str = "1.128.0";
pub(crate) const DEFAULT_CATALOG_HASH: &str =
    "sha256:53cf23036ed2e14693f284778d7f2b0cd7cd5802ee63bb42c573063f40f86fb3";

/// Capability names. A connection only gets the behaviour a capability names
/// when both sides offered it in the hello.
pub(crate) mod capability {
    /// `$/cancelRequest` in both directions: a request that outlives its
    /// deadline is withdrawn, not just forgotten.
    pub const CANCEL: &str = "cancel";
    /// `$/progress` from the extension against a host request id. Each report
    /// renews that request's deadline (up to [`super::MAX_PROGRESS_EXTENSION`])
    /// and is forwarded to the renderer.
    pub const PROGRESS: &str = "progress";
    pub const STRUCTURED_ERRORS: &str = "structured-errors";
    pub const CONTENT_HANDLES: &str = "content-handles";
    /// The managed-proxy activation transaction: `managedProxyHandshake`, and
    /// `restartManagedExtensionHost` to roll an activation forward or back.
    /// Proxy activation is refused on a connection without it.
    pub const CONTRIBUTION_TRANSACTIONS: &str = "contribution-transactions";
}

/// Every capability this host implements, in hello order.
pub(crate) const BROKER_CAPABILITIES: &[&str] = &[
    capability::CANCEL,
    capability::PROGRESS,
    capability::STRUCTURED_ERRORS,
    capability::CONTENT_HANDLES,
    capability::CONTRIBUTION_TRANSACTIONS,
];

/// How long the host waits for the extension to answer `method` before it
/// gives up (and, with [`capability::CANCEL`], withdraws the request). Verbs
/// that only move focus are short; verbs that write or save get longer;
/// activating a proxy extension can take a while on a cold extension host.
pub(crate) fn host_request_deadline(method: &str) -> Duration {
    match method {
        "applyEdit" | "saveAll" | "showDiff" | "runInTerminal" => Duration::from_secs(15),
        "managedProxyHandshake" => Duration::from_secs(30),
        _ => Duration::from_secs(5),
    }
}

/// The furthest progress reports can push a host request past its start.
pub(crate) const MAX_PROGRESS_EXTENSION: Duration = Duration::from_secs(120);

/// How long the extension waits for the host to answer each of its requests,
/// sent in the hello reply so the two sides never disagree. Starting a
/// protocol server spawns a process, so it gets longer than the rest.
pub(crate) fn extension_request_deadlines() -> Value {
    serde_json::json!({
        "default": 30_000,
        "cognia/protocol/start": 60_000,
    })
}

/// Pick the protocol version for a hello: the host's version for the highest
/// major that both `client` and `supported` name. Unparsable entries are
/// ignored. `None` means the two sides share no major.
///
/// Production passes [`SUPPORTED_PROTOCOL_VERSIONS`]; the two-major release
/// gate exercises this same function with a wider set.
pub(crate) fn negotiate_protocol(client: &[&str], supported: &[&str]) -> Option<String> {
    let client_majors = client
        .iter()
        .filter_map(|version| parse_version(version).map(|(major, _)| major))
        .collect::<Vec<_>>();
    supported
        .iter()
        .filter_map(|version| parse_version(version).map(|(major, _)| (major, *version)))
        .filter(|(major, _)| client_majors.contains(major))
        .max_by_key(|(major, _)| *major)
        .map(|(_, version)| version.to_string())
}

fn parse_version(version: &str) -> Option<(u32, u32)> {
    let (major, minor) = version.split_once('.')?;
    let major = major.parse::<u32>().ok()?;
    let minor = minor.parse::<u32>().ok()?;
    (major > 0).then_some((major, minor))
}

pub(crate) fn encode_content_length(value: &Value) -> Result<Vec<u8>, String> {
    let body =
        serde_json::to_vec(value).map_err(|error| format!("encode JSON-RPC body: {error}"))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "JSON-RPC frame exceeds {MAX_FRAME_BYTES} bytes: {}",
            body.len()
        ));
    }
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend(body);
    Ok(frame)
}

pub(crate) async fn read_content_length_value<R>(reader: &mut R) -> Result<Option<Value>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut header = String::new();
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|error| format!("read JSON-RPC header: {error}"))?;
        if read == 0 {
            return if header.is_empty() {
                Ok(None)
            } else {
                Err("unexpected EOF in JSON-RPC header".to_string())
            };
        }
        if line == "\r\n" {
            break;
        }
        header.push_str(&line);
        if header.len() > MAX_HEADER_BYTES {
            return Err(format!("JSON-RPC header exceeds {MAX_HEADER_BYTES} bytes"));
        }
    }

    let content_length = parse_content_length(header.trim_end_matches("\r\n"))?;
    if content_length > MAX_FRAME_BYTES {
        return Err(format!(
            "JSON-RPC frame exceeds {MAX_FRAME_BYTES} bytes: {content_length}"
        ));
    }
    let mut body = vec![0_u8; content_length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|error| format!("read JSON-RPC body: {error}"))?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| format!("invalid JSON-RPC body: {error}"))
}

/// Whether the first bytes a peer sent open a `Content-Length` header. Only
/// the bytes already buffered are inspected, so a short prefix of the header
/// name is accepted and the frame reader decides.
pub(crate) fn is_content_length_prefix(prefix: &[u8]) -> bool {
    const HEADER: &[u8] = b"content-length:";
    let compared = prefix.len().min(HEADER.len());
    prefix[..compared].eq_ignore_ascii_case(&HEADER[..compared])
}

fn parse_content_length(header: &str) -> Result<usize, String> {
    let mut content_length = None;
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("content-length") {
            continue;
        }
        let value = value.trim();
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("invalid Content-Length: {value}"));
        }
        content_length = Some(
            value
                .parse::<usize>()
                .map_err(|_| format!("invalid Content-Length: {value}"))?,
        );
    }
    content_length.ok_or_else(|| "missing Content-Length header".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_content_length_framing_is_accepted() {
        assert!(is_content_length_prefix(b"Content-Length: 2\r\n\r\n{}"));
        assert!(is_content_length_prefix(b"content-length: 2"));
        assert!(is_content_length_prefix(b"Cont"));
        assert!(!is_content_length_prefix(br#"{"type":"hello"}"#));
        assert!(!is_content_length_prefix(b"GET / HTTP/1.1"));
    }

    #[test]
    fn deadlines_are_longer_for_verbs_that_write_or_activate() {
        assert_eq!(host_request_deadline("openFile"), Duration::from_secs(5));
        assert_eq!(host_request_deadline("readActive"), Duration::from_secs(5));
        assert_eq!(host_request_deadline("saveAll"), Duration::from_secs(15));
        assert_eq!(host_request_deadline("applyEdit"), Duration::from_secs(15));
        assert_eq!(
            host_request_deadline("managedProxyHandshake"),
            Duration::from_secs(30)
        );
        assert_eq!(host_request_deadline("unknownVerb"), Duration::from_secs(5));
        assert!(MAX_PROGRESS_EXTENSION > host_request_deadline("managedProxyHandshake"));
        let extension = extension_request_deadlines();
        assert_eq!(extension["default"], 30_000);
        assert_eq!(extension["cognia/protocol/start"], 60_000);
    }

    #[test]
    fn negotiation_picks_the_highest_shared_major() {
        assert_eq!(
            negotiate_protocol(&["1.0"], SUPPORTED_PROTOCOL_VERSIONS).as_deref(),
            Some("1.0")
        );
        // Minor differences inside a major still negotiate; capabilities carry them.
        assert_eq!(
            negotiate_protocol(&["1.3"], SUPPORTED_PROTOCOL_VERSIONS).as_deref(),
            Some("1.0")
        );
        assert_eq!(
            negotiate_protocol(&["0.2"], SUPPORTED_PROTOCOL_VERSIONS),
            None
        );
        assert_eq!(
            negotiate_protocol(&["2.0"], SUPPORTED_PROTOCOL_VERSIONS),
            None
        );
        assert_eq!(
            negotiate_protocol(&["garbage", ""], SUPPORTED_PROTOCOL_VERSIONS),
            None
        );
    }

    /// The release gate: a host serving two majors negotiates with old and new
    /// clients alike, and prefers the newer major when both are offered.
    #[test]
    fn two_major_negotiation_serves_old_and_new_clients() {
        let supported = &["1.0", "2.1"];
        assert_eq!(
            negotiate_protocol(&["1.0"], supported).as_deref(),
            Some("1.0")
        );
        assert_eq!(
            negotiate_protocol(&["2.0"], supported).as_deref(),
            Some("2.1")
        );
        assert_eq!(
            negotiate_protocol(&["1.0", "2.0"], supported).as_deref(),
            Some("2.1")
        );
        assert_eq!(
            negotiate_protocol(&["2.0", "1.0"], supported).as_deref(),
            Some("2.1")
        );
        assert_eq!(negotiate_protocol(&["3.0"], supported), None);
    }

    #[test]
    fn encoder_uses_utf8_byte_length() {
        let frame = encode_content_length(&json!({ "value": "你好" })).unwrap();
        let separator = frame
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let header = std::str::from_utf8(&frame[..separator]).unwrap();
        let declared = parse_content_length(header).unwrap();
        assert_eq!(declared, frame.len() - separator - 4);
    }
}
