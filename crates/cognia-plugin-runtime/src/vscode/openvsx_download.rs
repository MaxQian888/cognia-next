//! Open VSX `.vsix` download + SHA-256 verification.
//!
//! # Why the bytes are fetched in Rust
//!
//! `proxyFetch`'s Rust backend returns `body: String`, which structurally
//! cannot carry a binary payload — so a TS-direct `.vsix` download would
//! silently bypass the user's proxy configuration. reqwest here honours it via
//! `proxy_config::current()`, the same slot every other outbound client reads.
//!
//! # Why the bytes still go back to TS instead of installing from here
//!
//! `inferPermissions` is a `@babel/parser` AST walk over the extension's main
//! bundle. If Rust installed directly the bytes would never reach JS,
//! inference would degrade to reading manifest contributions only, and it
//! would **under-report** `fs` / `child_process` / `network` — making the
//! consent dialog dishonest. So this command downloads and verifies, the
//! renderer reads the file back and runs inference, and only then calls
//! `plugin_vscode_install_vsix_from_path`.
//!
//! # What SHA-256 here does and does not prove
//!
//! The digest and the `.vsix` arrive over the same TLS session from the same
//! host family. That proves the transfer wasn't corrupted. It proves **nothing**
//! about a compromised registry, a registry insider, or a malicious publisher —
//! each of those controls both files. UI wording must not claim otherwise.
//!
//! `dead_code` is silenced module-wide for the same reason as the sibling
//! `commands` module: `tauri::generate_handler!` hides the command's callsite
//! from rustc's dead-code analyser.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use url::Url;

use super::commands::VscodeCommandError;
use super::VscodeExtensionState;

/// Byte ceiling for a **marketplace-sourced** `.vsix`.
///
/// Deliberately lower than the manual drag-drop path's 200 MB
/// (`installer::MAX_VSIX_BYTES`, unchanged): these bytes go on to the renderer,
/// where JSZip expands them 2–3× on top of the original buffer. At 200 MB that
/// peak OOMs the webview. 80 MB keeps the peak survivable and, when an
/// extension genuinely exceeds it, produces a named error instead of a crash.
pub const MAX_OPENVSX_VSIX_BYTES: u64 = 80 * 1024 * 1024;

/// The only hosts this path may talk to.
///
/// `open-vsx.org` serves the API and issues a 302 to `openvsx.eclipsecontent.org`
/// (the CDN) for the actual `.vsix` and for the digest file. Both hops are
/// checked; anything else is refused rather than followed, because the download
/// URL is supplied by the registry — untrusted input by definition.
const OPENVSX_ALLOWED_HOSTS: &[&str] = &["open-vsx.org", "openvsx.eclipsecontent.org"];

/// The digest file is 64 hex chars plus an optional `sha256sum`-style file
/// name. Anything meaningfully larger is not a digest file, and reading it
/// unbounded would let a hostile origin drive an allocation.
const MAX_DIGEST_BODY_BYTES: usize = 4096;

/// Redirect hops allowed before we call it a loop. Open VSX uses exactly one.
const MAX_REDIRECTS: usize = 5;

/// Staging directory for downloaded `.vsix` files, under the extension install
/// root.
///
/// The leading dot is what keeps it collision-free: `sanitize_plugin_id_strict`
/// escapes `.` to `_` in both id components, so no installed extension can ever
/// be named `.downloads`. Same convention as `installer.rs`'s `.staging-*` /
/// `.trash-*` working dirs, which live in the same root.
const DOWNLOADS_SUBDIR: &str = ".downloads";

/// Where downloaded `.vsix` files are staged for the renderer to read back.
pub fn downloads_dir(install_root: &Path) -> PathBuf {
    install_root.join(DOWNLOADS_SUBDIR)
}

/// Transport policy for a download: which origin is acceptable and how many
/// bytes may arrive.
///
/// A struct rather than hard-coded constants so the streaming, redirect and
/// ceiling behaviour can be exercised against a loopback origin. Production
/// always uses [`OPENVSX_POLICY`]; `openvsx_policy_is_pinned_to_https_open_vsx`
/// locks its values down.
#[derive(Debug, Clone, Copy)]
pub struct DownloadPolicy {
    /// Required URL scheme. `https` in production.
    pub scheme: &'static str,
    /// Exact hostnames (no suffix matching — `open-vsx.org.evil.com` must not
    /// match `open-vsx.org`).
    pub allowed_hosts: &'static [&'static str],
    /// Hard ceiling on the `.vsix` body.
    pub max_bytes: u64,
}

/// The production policy.
pub const OPENVSX_POLICY: DownloadPolicy = DownloadPolicy {
    scheme: "https",
    allowed_hosts: OPENVSX_ALLOWED_HOSTS,
    max_bytes: MAX_OPENVSX_VSIX_BYTES,
};

/// Why a digest file was unusable.
///
/// [`DigestParseError::Empty`] is the important one. `files.sha256` is a URL to
/// a digest file, and that URL **302s**. A client that does not follow the
/// redirect reads a zero-length body, and comparing a real digest against `""`
/// would silently pass as "no checksum configured". A missing digest is a hard
/// error here precisely so that bug cannot exist.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DigestParseError {
    #[error("sha256 digest file was empty — verification cannot be skipped")]
    Empty,
    #[error("sha256 digest file is not a 64-character hex digest: {0:?}")]
    Malformed(String),
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("not an allowed Open VSX URL: {0}")]
    DisallowedUrl(String),

    #[error("refused a redirect off the Open VSX hosts while fetching {url}")]
    OffsiteRedirect { url: String },

    #[error("http error fetching {url}: {source}")]
    Http { url: String, source: reqwest::Error },

    #[error("could not build http client: {0}")]
    Client(reqwest::Error),

    #[error("the .vsix declares {declared} bytes, over the {max}-byte marketplace cap")]
    DeclaredTooLarge { declared: u64, max: u64 },

    #[error("the .vsix exceeded the {max}-byte marketplace cap while downloading")]
    StreamTooLarge { max: u64 },

    #[error("{0}")]
    Digest(#[from] DigestParseError),

    #[error("sha256 mismatch: expected {expected}, downloaded {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
}

impl DownloadError {
    /// Stable machine-readable code for the renderer's error envelope.
    pub fn code(&self) -> &'static str {
        match self {
            DownloadError::DisallowedUrl(_) => "disallowed_url",
            DownloadError::OffsiteRedirect { .. } => "offsite_redirect",
            DownloadError::Http { .. } => "http_error",
            DownloadError::Client(_) => "client_error",
            DownloadError::DeclaredTooLarge { .. } | DownloadError::StreamTooLarge { .. } => {
                "vsix_too_large"
            }
            DownloadError::Digest(_) => "bad_sha256_file",
            DownloadError::ChecksumMismatch { .. } => "checksum_mismatch",
            DownloadError::Io(_) => "io_error",
        }
    }
}

impl From<DownloadError> for VscodeCommandError {
    fn from(value: DownloadError) -> Self {
        VscodeCommandError::new(value.code(), value.to_string())
    }
}

/// A verified `.vsix` staged on disk, ready for the renderer to read back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedVsix {
    pub temp_path: String,
    pub sha256_hex: String,
    pub size_bytes: u64,
}

/// Download a `.vsix` from Open VSX, verify it against the registry's digest
/// file, and stage it for the renderer.
///
/// `sha256_url` is `files.sha256` from the Open VSX API — a **URL to a digest
/// file**, not a digest.
#[tauri::command]
pub async fn plugin_vscode_download_vsix(
    download_url: String,
    sha256_url: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<DownloadedVsix, VscodeCommandError> {
    let staging = downloads_dir(&state.extension_install_dir);
    download_vsix_to_temp(&OPENVSX_POLICY, &download_url, &sha256_url, &staging)
        .await
        .map_err(Into::into)
}

/// The command's body, minus Tauri state — see [`DownloadPolicy`] for why the
/// policy is injected.
pub async fn download_vsix_to_temp(
    policy: &DownloadPolicy,
    download_url: &str,
    sha256_url: &str,
    staging_dir: &Path,
) -> Result<DownloadedVsix, DownloadError> {
    let download = check_url(download_url, policy)?;
    let digest_url = check_url(sha256_url, policy)?;

    let client = build_client(policy)?;

    // The digest comes first, deliberately: a missing or malformed digest file
    // must abort before we spend up to 80 MB of the user's bandwidth on bytes
    // we would then have to throw away.
    let expected = fetch_expected_digest(&client, digest_url.as_str()).await?;

    std::fs::create_dir_all(staging_dir)?;
    let temp_path = staging_dir.join(format!("{}.vsix", uuid::Uuid::new_v4()));

    let outcome = match cognia_net::http_download::stream_to_file(
        &client,
        download.as_str(),
        &temp_path,
        Some(policy.max_bytes),
        &mut |_, _| {},
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(err) => {
            // A partial body is already on disk whenever the stream died
            // mid-flight; never leave it behind.
            let _ = std::fs::remove_file(&temp_path);
            return Err(map_stream_error(err, download.as_str()));
        }
    };

    if !outcome.sha256_hex.eq_ignore_ascii_case(&expected) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(DownloadError::ChecksumMismatch {
            expected,
            actual: outcome.sha256_hex,
        });
    }

    Ok(DownloadedVsix {
        temp_path: temp_path.to_string_lossy().into_owned(),
        sha256_hex: outcome.sha256_hex,
        size_bytes: outcome.bytes_written,
    })
}

/// Parse `raw` and assert it matches `policy`'s scheme + host allowlist.
fn check_url(raw: &str, policy: &DownloadPolicy) -> Result<Url, DownloadError> {
    let url = Url::parse(raw).map_err(|_| DownloadError::DisallowedUrl(raw.to_string()))?;
    if !url_allowed(&url, policy.scheme, policy.allowed_hosts) {
        return Err(DownloadError::DisallowedUrl(raw.to_string()));
    }
    Ok(url)
}

/// Exact scheme + exact host match. Suffix matching is intentionally absent:
/// `open-vsx.org.evil.com` ends with `open-vsx.org`.
fn url_allowed(url: &Url, scheme: &str, allowed_hosts: &[&str]) -> bool {
    if url.scheme() != scheme {
        return false;
    }
    match url.host_str() {
        Some(host) => {
            let host = host.to_ascii_lowercase();
            allowed_hosts.iter().any(|allowed| host == *allowed)
        }
        None => false,
    }
}

/// Build a client that refuses to be redirected off the allowlist, and that
/// routes through the user's proxy when one is configured.
fn build_client(policy: &DownloadPolicy) -> Result<reqwest::Client, DownloadError> {
    let scheme = policy.scheme;
    let allowed_hosts = policy.allowed_hosts;
    let redirect = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error(format!("too many redirects (>{MAX_REDIRECTS})"));
        }
        if url_allowed(attempt.url(), scheme, allowed_hosts) {
            attempt.follow()
        } else {
            let refused = format!("refusing redirect to disallowed host: {}", attempt.url());
            attempt.error(refused)
        }
    });

    let mut builder = reqwest::Client::builder()
        .user_agent("cognia-desktop")
        .redirect(redirect)
        // No total timeout: an 80 MB download over a slow link is legitimate
        // and must not be guillotined. A stalled peer is bounded by
        // read_timeout instead, which resets on every byte received.
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60));

    // Honour the user's proxy — the whole reason this download is in Rust.
    // `build_reqwest_proxy` returns a `Proxy::custom` that already applies the
    // bypass list per request, so no outer `should_bypass` check is needed.
    let proxy_cfg = cognia_net::proxy_config::current();
    if proxy_cfg.is_active() {
        if let Some(proxy) = proxy_cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }

    builder.build().map_err(DownloadError::Client)
}

/// GET the digest file and parse it. The body is read with a hard bound rather
/// than `.bytes()`, which would be unbounded when the origin omits
/// `Content-Length`.
async fn fetch_expected_digest(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, DownloadError> {
    use futures_util::StreamExt as _;

    let http_err = |source: reqwest::Error| {
        if source.is_redirect() {
            DownloadError::OffsiteRedirect {
                url: url.to_string(),
            }
        } else {
            DownloadError::Http {
                url: url.to_string(),
                source,
            }
        }
    };

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(http_err)?
        .error_for_status()
        .map_err(http_err)?;

    let mut body: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(http_err)?;
        if body.len() + chunk.len() > MAX_DIGEST_BODY_BYTES {
            return Err(DigestParseError::Malformed(format!(
                "digest file exceeds {MAX_DIGEST_BODY_BYTES} bytes"
            ))
            .into());
        }
        body.extend_from_slice(&chunk);
    }

    Ok(parse_sha256_digest(&String::from_utf8_lossy(&body))?)
}

/// Parse a digest file body into a lowercase hex SHA-256.
///
/// Accepts a bare digest (what Open VSX serves) and the `sha256sum` layout,
/// `"<digest>  <filename>"`. Everything else — including the empty body an
/// un-followed 302 produces — is an error. There is no "no digest, carry on"
/// branch, which is exactly where `marketplace.rs:verify_download_integrity`
/// goes wrong for this path: with `checksum: None` and
/// `require_signature: false` it returns `Ok(())`.
pub fn parse_sha256_digest(body: &str) -> Result<String, DigestParseError> {
    let Some(line) = body.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return Err(DigestParseError::Empty);
    };
    // `sha256sum` format is "<digest>  <filename>"; the digest is the first
    // whitespace-separated token either way.
    let token = line
        .split_whitespace()
        .next()
        .ok_or(DigestParseError::Empty)?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(DigestParseError::Malformed(token.to_string()));
    }
    Ok(token.to_ascii_lowercase())
}

/// Translate the shared streaming helper's errors into this module's vocabulary.
fn map_stream_error(err: cognia_net::http_download::DownloadError, url: &str) -> DownloadError {
    use cognia_net::http_download::DownloadError as HttpDownloadError;
    match err {
        HttpDownloadError::DeclaredTooLarge { declared, max } => {
            DownloadError::DeclaredTooLarge { declared, max }
        }
        HttpDownloadError::StreamTooLarge { max } => DownloadError::StreamTooLarge { max },
        HttpDownloadError::Io(e) => DownloadError::Io(e),
        HttpDownloadError::Http(source) => {
            // A custom redirect policy that calls `attempt.error(..)` surfaces
            // as a redirect-kind reqwest error — that's our offsite refusal.
            if source.is_redirect() {
                DownloadError::OffsiteRedirect {
                    url: url.to_string(),
                }
            } else {
                DownloadError::Http {
                    url: url.to_string(),
                    source,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    fn test_policy(max_bytes: u64) -> DownloadPolicy {
        DownloadPolicy {
            scheme: "http",
            allowed_hosts: &["127.0.0.1"],
            max_bytes,
        }
    }

    fn sha256_of(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(bytes))
    }

    /// Every response closes its connection. `serve` handles one request per
    /// socket, so without this the client pools the socket, reuses it for the
    /// next request (these tests fetch the digest *then* the .vsix from the
    /// same origin) and races a peer that has already hung up.
    fn ok_response(body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// HTTP/1.1 response with no `Content-Length` — body runs to close.
    fn ok_response_unsized(body: &[u8]) -> Vec<u8> {
        let mut out = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        out.extend_from_slice(body);
        out
    }

    fn redirect_response(location: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    /// Minimal HTTP/1.1 origin routing on request path. Serves every
    /// connection for the life of the test.
    async fn serve(routes: Vec<(&'static str, Vec<u8>)>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let routes = Arc::new(routes);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let routes = Arc::clone(&routes);
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let response = routes
                        .iter()
                        .find(|(p, _)| *p == path)
                        .map(|(_, r)| r.clone())
                        .unwrap_or_else(|| {
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec()
                        });
                    let _ = sock.write_all(&response).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        addr
    }

    fn staged_files(dir: &Path) -> Vec<PathBuf> {
        match std::fs::read_dir(dir) {
            Ok(entries) => entries.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
            Err(_) => Vec::new(),
        }
    }

    // ---- digest parsing -------------------------------------------------

    #[test]
    fn parses_bare_digest() {
        let digest = "d959f4bbd157fa7d37092476d41b35aca2f7df83b99df6b9546c9435fc85cac7";
        assert_eq!(parse_sha256_digest(digest).unwrap(), digest);
        assert_eq!(
            parse_sha256_digest(&format!("  {digest}\n")).unwrap(),
            digest
        );
    }

    #[test]
    fn parses_sha256sum_two_column_format() {
        let digest = "d959f4bbd157fa7d37092476d41b35aca2f7df83b99df6b9546c9435fc85cac7";
        assert_eq!(
            parse_sha256_digest(&format!(
                "{digest}  rust-lang.rust-analyzer-0.4.2973.vsix\n"
            ))
            .unwrap(),
            digest
        );
    }

    #[test]
    fn uppercase_digest_is_normalized_to_lowercase() {
        let digest = "D959F4BBD157FA7D37092476D41B35ACA2F7DF83B99DF6B9546C9435FC85CAC7";
        assert_eq!(parse_sha256_digest(digest).unwrap(), digest.to_lowercase());
    }

    /// The un-followed-302 shape: `status=302 size=0` leaves the client holding
    /// an empty string. It must never read as "nothing to verify".
    #[test]
    fn empty_digest_body_is_an_error_not_an_empty_digest() {
        assert_eq!(parse_sha256_digest(""), Err(DigestParseError::Empty));
        assert_eq!(
            parse_sha256_digest("   \n\n  "),
            Err(DigestParseError::Empty)
        );
    }

    #[test]
    fn malformed_digests_are_rejected() {
        // Too short.
        assert!(matches!(
            parse_sha256_digest("d959f4bb"),
            Err(DigestParseError::Malformed(_))
        ));
        // 64 chars but not hex.
        assert!(matches!(
            parse_sha256_digest(&"z".repeat(64)),
            Err(DigestParseError::Malformed(_))
        ));
        // An HTML error page, which is what a misrouted request returns.
        assert!(matches!(
            parse_sha256_digest("<html><body>404</body></html>"),
            Err(DigestParseError::Malformed(_))
        ));
    }

    // ---- url / policy guards --------------------------------------------

    #[test]
    fn openvsx_policy_is_pinned_to_https_open_vsx() {
        assert_eq!(OPENVSX_POLICY.scheme, "https");
        assert_eq!(
            OPENVSX_POLICY.allowed_hosts,
            &["open-vsx.org", "openvsx.eclipsecontent.org"]
        );
        assert_eq!(OPENVSX_POLICY.max_bytes, 80 * 1024 * 1024);
    }

    /// The manual drag-drop path keeps its own, larger cap. Tying the two
    /// together would silently change that unrelated behaviour.
    #[test]
    fn marketplace_cap_is_stricter_than_the_manual_vsix_cap() {
        assert!(MAX_OPENVSX_VSIX_BYTES < 200 * 1024 * 1024);
    }

    #[test]
    fn allows_the_two_open_vsx_hosts_over_https() {
        for url in [
            "https://open-vsx.org/api/rust-lang/rust-analyzer/file/x.vsix",
            "https://openvsx.eclipsecontent.org/api/rust-lang/rust-analyzer/file/x.vsix",
            // Host comparison is case-insensitive.
            "https://OPEN-VSX.ORG/api/x/y/file/z.vsix",
        ] {
            assert!(
                check_url(url, &OPENVSX_POLICY).is_ok(),
                "should allow {url}"
            );
        }
    }

    #[test]
    fn rejects_offsite_hosts_lookalikes_and_plain_http() {
        for url in [
            "https://evil.example.com/x.vsix",
            // Suffix match would let this through.
            "https://open-vsx.org.evil.example.com/x.vsix",
            // Prefix match would let this through.
            "https://open-vsx.org.attacker.net/x.vsix",
            // Downgrade.
            "http://open-vsx.org/x.vsix",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(
                matches!(
                    check_url(url, &OPENVSX_POLICY),
                    Err(DownloadError::DisallowedUrl(_))
                ),
                "should reject {url}"
            );
        }
    }

    // ---- download orchestration -----------------------------------------

    #[tokio::test]
    async fn downloads_verifies_and_stages_the_vsix() {
        let body = b"vsix-bytes";
        let digest = sha256_of(body);
        let addr = serve(vec![
            ("/x.vsix", ok_response(body)),
            ("/x.sha256", ok_response(digest.as_bytes())),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        let result = download_vsix_to_temp(
            &test_policy(1024),
            &format!("http://{addr}/x.vsix"),
            &format!("http://{addr}/x.sha256"),
            &staging,
        )
        .await
        .unwrap();

        assert_eq!(result.sha256_hex, digest);
        assert_eq!(result.size_bytes, body.len() as u64);
        assert_eq!(std::fs::read(&result.temp_path).unwrap(), body);
        assert!(result.temp_path.ends_with(".vsix"));
    }

    /// THE regression test for the `files.sha256` 302. The digest URL redirects
    /// (to an allowed host); following it yields the real digest. A client that
    /// did not follow would read `""` and — without the hard-error rule — skip
    /// verification entirely.
    #[tokio::test]
    async fn follows_the_sha256_redirect_instead_of_reading_an_empty_body() {
        let body = b"vsix-bytes";
        let digest = sha256_of(body);
        let addr = serve(vec![
            ("/x.vsix", ok_response(body)),
            ("/x.sha256", redirect_response("/cdn/x.sha256")),
            ("/cdn/x.sha256", ok_response(digest.as_bytes())),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();

        let result = download_vsix_to_temp(
            &test_policy(1024),
            &format!("http://{addr}/x.vsix"),
            &format!("http://{addr}/x.sha256"),
            &dir.path().join(DOWNLOADS_SUBDIR),
        )
        .await
        .unwrap();

        assert_eq!(result.sha256_hex, digest);
    }

    /// The un-followed-302 outcome, simulated: the digest endpoint answers with
    /// an empty body. That must be a hard error, never "no checksum, proceed".
    #[tokio::test]
    async fn missing_or_empty_sha256_is_hard_error() {
        let addr = serve(vec![
            ("/x.vsix", ok_response(b"vsix-bytes")),
            ("/empty.sha256", ok_response(b"")),
            ("/blank.sha256", ok_response(b"   \n")),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        for path in ["/empty.sha256", "/blank.sha256"] {
            let err = download_vsix_to_temp(
                &test_policy(1024),
                &format!("http://{addr}/x.vsix"),
                &format!("http://{addr}{path}"),
                &staging,
            )
            .await
            .unwrap_err();

            assert!(
                matches!(err, DownloadError::Digest(DigestParseError::Empty)),
                "expected Digest(Empty) for {path}, got {err:?}"
            );
            assert_eq!(err.code(), "bad_sha256_file");
        }
        // The digest is fetched first, so nothing was ever downloaded.
        assert!(staged_files(&staging).is_empty());
    }

    #[tokio::test]
    async fn malformed_digest_file_is_rejected() {
        let addr = serve(vec![
            ("/x.vsix", ok_response(b"vsix-bytes")),
            ("/bad.sha256", ok_response(b"<html>not a digest</html>")),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        let err = download_vsix_to_temp(
            &test_policy(1024),
            &format!("http://{addr}/x.vsix"),
            &format!("http://{addr}/bad.sha256"),
            &staging,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, DownloadError::Digest(DigestParseError::Malformed(_))),
            "expected Digest(Malformed), got {err:?}"
        );
        assert!(staged_files(&staging).is_empty());
    }

    /// An over-large digest file must not drive an unbounded allocation.
    #[tokio::test]
    async fn oversized_digest_file_is_rejected() {
        let addr = serve(vec![
            ("/x.vsix", ok_response(b"vsix-bytes")),
            (
                "/huge.sha256",
                ok_response_unsized(&vec![b'a'; MAX_DIGEST_BODY_BYTES * 2]),
            ),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();

        let err = download_vsix_to_temp(
            &test_policy(1024),
            &format!("http://{addr}/x.vsix"),
            &format!("http://{addr}/huge.sha256"),
            &dir.path().join(DOWNLOADS_SUBDIR),
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, DownloadError::Digest(DigestParseError::Malformed(_))),
            "expected Digest(Malformed), got {err:?}"
        );
    }

    #[tokio::test]
    async fn checksum_mismatch_deletes_temp_file() {
        let body = b"vsix-bytes";
        let wrong = "0".repeat(64);
        let addr = serve(vec![
            ("/x.vsix", ok_response(body)),
            ("/x.sha256", ok_response(wrong.as_bytes())),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        let err = download_vsix_to_temp(
            &test_policy(1024),
            &format!("http://{addr}/x.vsix"),
            &format!("http://{addr}/x.sha256"),
            &staging,
        )
        .await
        .unwrap_err();

        match &err {
            DownloadError::ChecksumMismatch { expected, actual } => {
                assert_eq!(expected, &wrong);
                assert_eq!(actual, &sha256_of(body));
            }
            other => panic!("expected ChecksumMismatch, got {other:?}"),
        }
        assert_eq!(err.code(), "checksum_mismatch");
        assert!(
            staged_files(&staging).is_empty(),
            "a rejected .vsix must not stay on disk: {:?}",
            staged_files(&staging)
        );
    }

    /// Declared `Content-Length` over the cap: refused before the body is read.
    #[tokio::test]
    async fn download_aborts_past_byte_ceiling() {
        let body = vec![b'a'; 4096];
        let digest = sha256_of(&body);
        let addr = serve(vec![
            ("/big.vsix", ok_response(&body)),
            ("/big.sha256", ok_response(digest.as_bytes())),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        let err = download_vsix_to_temp(
            &test_policy(16),
            &format!("http://{addr}/big.vsix"),
            &format!("http://{addr}/big.sha256"),
            &staging,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(
                err,
                DownloadError::DeclaredTooLarge {
                    declared: 4096,
                    max: 16
                }
            ),
            "expected DeclaredTooLarge, got {err:?}"
        );
        assert_eq!(err.code(), "vsix_too_large");
        assert!(staged_files(&staging).is_empty());
    }

    /// `Content-Length` is a claim. With it omitted the up-front check cannot
    /// fire, so the per-chunk ceiling has to stop the stream — and the partial
    /// file must not survive.
    #[tokio::test]
    async fn download_aborts_past_byte_ceiling_when_content_length_is_absent() {
        let body = vec![b'a'; 4096];
        let digest = sha256_of(&body);
        let addr = serve(vec![
            ("/big.vsix", ok_response_unsized(&body)),
            ("/big.sha256", ok_response(digest.as_bytes())),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        let err = download_vsix_to_temp(
            &test_policy(16),
            &format!("http://{addr}/big.vsix"),
            &format!("http://{addr}/big.sha256"),
            &staging,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, DownloadError::StreamTooLarge { max: 16 }),
            "expected StreamTooLarge, got {err:?}"
        );
        assert_eq!(err.code(), "vsix_too_large");
        assert!(
            staged_files(&staging).is_empty(),
            "the partial download must be deleted: {:?}",
            staged_files(&staging)
        );
    }

    /// The registry supplies the download URL, so a redirect off the allowlist
    /// is an attacker-controlled fetch. Refuse rather than follow.
    #[tokio::test]
    async fn rejects_offsite_redirect() {
        let digest = sha256_of(b"vsix-bytes");
        let addr = serve(vec![
            (
                "/x.vsix",
                redirect_response("http://evil.example.com/payload.vsix"),
            ),
            ("/x.sha256", ok_response(digest.as_bytes())),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        let err = download_vsix_to_temp(
            &test_policy(1024),
            &format!("http://{addr}/x.vsix"),
            &format!("http://{addr}/x.sha256"),
            &staging,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, DownloadError::OffsiteRedirect { .. }),
            "expected OffsiteRedirect, got {err:?}"
        );
        assert_eq!(err.code(), "offsite_redirect");
        assert!(staged_files(&staging).is_empty());
    }

    /// The same guard on the digest hop — a redirected digest fetch must not
    /// land on an attacker's "expected" value either.
    #[tokio::test]
    async fn rejects_offsite_redirect_on_the_digest_url() {
        let addr = serve(vec![(
            "/x.sha256",
            redirect_response("http://evil.example.com/x.sha256"),
        )])
        .await;
        let dir = tempfile::tempdir().unwrap();

        let err = download_vsix_to_temp(
            &test_policy(1024),
            &format!("http://{addr}/x.vsix"),
            &format!("http://{addr}/x.sha256"),
            &dir.path().join(DOWNLOADS_SUBDIR),
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, DownloadError::OffsiteRedirect { .. }),
            "expected OffsiteRedirect, got {err:?}"
        );
    }

    /// An unreachable/erroring origin must not leave a zero-byte `.vsix` in the
    /// staging dir for the renderer to pick up.
    #[tokio::test]
    async fn http_error_on_the_vsix_leaves_no_staged_file() {
        let digest = sha256_of(b"vsix-bytes");
        let addr = serve(vec![("/x.sha256", ok_response(digest.as_bytes()))]).await;
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        let err = download_vsix_to_temp(
            &test_policy(1024),
            &format!("http://{addr}/missing.vsix"), // 404
            &format!("http://{addr}/x.sha256"),
            &staging,
        )
        .await
        .unwrap_err();

        assert!(matches!(err, DownloadError::Http { .. }), "got {err:?}");
        assert!(staged_files(&staging).is_empty());
    }

    /// The URL check runs before the client is even built, so a hostile URL
    /// costs no connection and creates no staging dir.
    #[tokio::test]
    async fn disallowed_url_is_rejected_before_any_request() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(DOWNLOADS_SUBDIR);

        let err = download_vsix_to_temp(
            &test_policy(1024),
            "https://evil.example.com/x.vsix",
            "http://127.0.0.1/x.sha256",
            &staging,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, DownloadError::DisallowedUrl(_)),
            "got {err:?}"
        );
        assert_eq!(err.code(), "disallowed_url");
        assert!(!staging.exists());
    }

    #[test]
    fn downloads_dir_is_a_dot_prefixed_child_of_the_install_root() {
        let root = Path::new("/tmp/vscode-extensions");
        let dir = downloads_dir(root);
        assert_eq!(dir, root.join(".downloads"));
        // Dot-prefixed, so no `publisher.name` id can ever collide with it —
        // the strict id sanitizer escapes `.` in both components.
        assert!(dir.file_name().unwrap().to_string_lossy().starts_with('.'));
    }

    #[test]
    fn download_result_serializes_camel_case() {
        let payload = DownloadedVsix {
            temp_path: "/tmp/x.vsix".into(),
            sha256_hex: sha256_of(b"vsix-bytes"),
            size_bytes: 10,
        };
        let value = serde_json::to_value(&payload).unwrap();
        assert!(value.get("tempPath").is_some());
        assert!(value.get("sha256Hex").is_some());
        assert!(value.get("sizeBytes").is_some());
    }
}
