//! Browser-access configuration for the desktop Companion server.
//!
//! # Why this exists
//!
//! A paired *mobile* client trusts the desktop by pinning the SHA-256 of its
//! self-signed certificate's SubjectPublicKeyInfo — pinning it does at the
//! native layer, outside any TLS trust store. A *browser* cannot do that: it
//! validates against the system roots and refuses a self-signed peer outright,
//! with no JavaScript escape hatch. So the HTTPS listener on
//! `https://<host>:27890`, which every mobile pairing uses, is unreachable
//! from a browser tab unless the user manually clicks through a certificate
//! interstitial — and re-does it whenever the cert rotates.
//!
//! The way out is the one origin a browser trusts without a certificate:
//! **loopback**. `http://127.0.0.1` is "potentially trustworthy" per the
//! Secure Contexts spec, so it is exempt from mixed-content blocking and needs
//! no chain at all. This module configures a second, *plaintext, loopback-only*
//! listener for exactly that case.
//!
//! # Why it is off by default
//!
//! The plaintext listener carries the same device plane as the HTTPS one, and
//! plaintext on loopback is readable by any other process on the machine that
//! can bind or sniff loopback. Every request still needs a DPoP-bound device
//! access token, so this widens *exposure*, not *authority* — but it is a real
//! widening, and an install that never opens the web client should not pay it.
//! It stays off until the user turns it on in Settings → Companion.
//!
//! The allowed origins are the same list the CORS policy enforces, so enabling
//! browser access and naming the browser that may use it is one decision, not
//! two that can drift.
//!
//! Config file: `<data_dir>/cognia/browser-access.json`

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "browser-access.json";
const CONFIG_SUBDIR: &str = "cognia";

/// Loopback port for the plaintext browser listener.
///
/// One above the HTTPS `DEFAULT_PORT` (27890) and, like it, outside the 789x
/// range a local Clash/mixed proxy claims.
pub const DEFAULT_BROWSER_PORT: u16 = 27891;

/// Origins offered as the starting point in Settings — the ports `pnpm dev`
/// and `pnpm start` serve the web client on. Never applied implicitly: an
/// origin only takes effect once it is in the saved config.
pub const SUGGESTED_ORIGINS: [&str; 2] = ["http://localhost:3000", "http://127.0.0.1:3000"];

/// Whether this Host is currently accepting browser submissions.
///
/// A process-global for the same reason the advertised port is one: the axum
/// router holds a [`crate::companion_api::SharedState`], which has no data
/// directory and therefore cannot re-read the config file — but the RPC
/// dispatch is where a submission has to be refused.
///
/// It exists because `enabled` used to be read exactly once, at startup, when
/// it decided whether to bind the listener. Switching browser access off left
/// the already-bound listener accepting submissions until the server restarted,
/// which is not the switch ADR-0154 describes. Mirroring it here is what makes
/// turning it off take effect on the next request.
///
/// Starts `false`: this Host has not been told browser access is on, and the
/// default for browser access is off.
static SUBMISSIONS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Mirror the saved switch. Called on server start, on save, and on stop.
pub fn set_submissions_enabled(enabled: bool) {
    SUBMISSIONS_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Whether a browser submission may be accepted right now.
///
/// Reads only. The listener stays bound until the server restarts, and the
/// panel's reads keep answering on it — a browser that already started tasks
/// must still be able to see them and open them in Cognia.
pub fn submissions_enabled() -> bool {
    SUBMISSIONS_ENABLED.load(Ordering::Relaxed)
}

/// On-disk shape. Absent file == the default, which is "off".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAccessConfig {
    /// Whether to bind the plaintext loopback listener at all.
    pub enabled: bool,
    /// Exact browser origins allowed to reach this Host (scheme + host + port).
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Loopback port for the plaintext listener.
    #[serde(default = "default_browser_port")]
    pub port: u16,
}

fn default_browser_port() -> u16 {
    DEFAULT_BROWSER_PORT
}

impl Default for BrowserAccessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            allowed_origins: Vec::new(),
            port: DEFAULT_BROWSER_PORT,
        }
    }
}

impl BrowserAccessConfig {
    /// Reject anything that cannot be an exact browser origin.
    ///
    /// Canonicalizes each entry to the exact string a browser puts in `Origin`
    /// (default port dropped, scheme and host lowercased, IDN host in
    /// punycode), drops duplicates, and holds every entry to the browser
    /// plane's admission rule: HTTPS anywhere, HTTP only on loopback, or a
    /// Cognia `chrome-extension://<id>` origin. An origin that survives here is
    /// one the CORS layer will echo verbatim, so a wildcard, a path, or
    /// credentials in the URL must never get this far.
    pub fn sanitized(mut self) -> Result<Self, String> {
        self.allowed_origins = canonicalize_origins(self.allowed_origins.drain(..), |raw| {
            Err(format!(
                "`{raw}` is not an exact browser origin \u{2014} use \
                 https://host, http://localhost or http://127.0.0.1 with a port, or the \
                 chrome-extension://<id> origin the extension shows on its connection screen"
            ))
        })?;
        if self.port == 0 {
            self.port = DEFAULT_BROWSER_PORT;
        }
        if self.enabled && self.allowed_origins.is_empty() {
            return Err("at least one browser origin is required to enable browser access".into());
        }
        Ok(self)
    }

    /// Read-side repair: keep every entry that is still an exact origin, drop
    /// the ones that are not.
    ///
    /// [`Self::sanitized`] refuses the whole config on the first bad entry,
    /// which is right on save — the user typed it and has to be told. It is
    /// wrong on load, where there is nobody to tell: one stale entry (an origin
    /// shape a later release stopped admitting, a hand-edited file) sent the
    /// entire config to [`Default`] — access off, the port reset, and every
    /// other still-valid origin gone, with nothing in Settings to explain it.
    ///
    /// Dropping only the unusable entry cannot widen anything: what survives
    /// went through the same normalizer, and `listener_enabled` already refuses
    /// to bind an empty list.
    fn repaired(mut self) -> Self {
        self.allowed_origins = canonicalize_origins(self.allowed_origins.drain(..), |raw| {
            log::warn!(
                "browser access: dropping saved origin `{raw}`, which is no longer an exact browser origin"
            );
            Ok::<(), std::convert::Infallible>(())
        })
        // The closure never returns `Err`, and `Infallible` has no value to
        // match, so this arm is the type system agreeing rather than a fallback.
        .unwrap_or_else(|never| match never {});
        if self.port == 0 {
            self.port = DEFAULT_BROWSER_PORT;
        }
        // Nothing survived: there is no browser access to have, so say so on
        // the flag too rather than leaving a switch that reads "on" over an
        // empty list. This is the one case where the old whole-file rejection
        // and this repair agree, and it keeps `enabled` from ever meaning
        // something `listener_enabled` would contradict.
        if self.allowed_origins.is_empty() {
            self.enabled = false;
        }
        self
    }

    /// Whether the plaintext listener should be bound.
    pub fn listener_enabled(&self) -> bool {
        self.enabled && !self.allowed_origins.is_empty()
    }

    /// The origin a "pair in browser" link should target.
    ///
    /// The first configured **web** origin. There is no cleverness to add
    /// beyond that: the list is ordered by the user, and a Host with several
    /// allowed browsers has no way to know which one is in front of them right
    /// now. But an extension origin can sit in this list too — the Browser
    /// Companion flow tells users to put one there — and `chrome-extension://`
    /// names a page inside an extension that no navigation can open, so it is
    /// not a candidate for a link no matter where the user ordered it.
    pub fn primary_origin(&self) -> Option<&str> {
        self.allowed_origins
            .iter()
            .find(|origin| super::extension_origin::normalize_web_origin(origin).is_some())
            .map(String::as_str)
    }
}

/// Canonicalize a list of origins and drop duplicates, deciding what to do
/// about a rejected entry at the call site.
///
/// The two callers differ in exactly one way and agree on everything else, so
/// the loop lives here and the difference is the closure: on save
/// ([`BrowserAccessConfig::sanitized`]) a bad entry returns `Err` and the whole
/// config is refused, because the user just typed it and has to be told; on
/// load ([`BrowserAccessConfig::repaired`]) it logs and returns `Ok`, dropping
/// only that entry, because there is nobody to tell. Sharing the loop is what
/// keeps the two from drifting on the parts that must not differ — which
/// normalizer runs, and that dedupe happens on the canonical form rather than
/// the raw one.
fn canonicalize_origins<E>(
    raw: impl IntoIterator<Item = String>,
    mut on_reject: impl FnMut(&str) -> Result<(), E>,
) -> Result<Vec<String>, E> {
    let mut seen: Vec<String> = Vec::new();
    for entry in raw {
        match normalize_origin(&entry) {
            Some(normalized) => {
                if !seen.contains(&normalized) {
                    seen.push(normalized);
                }
            }
            None => on_reject(&entry)?,
        }
    }
    Ok(seen)
}

/// Normalize one origin, or `None` when it cannot be one.
///
/// Delegates to `extension_origin`, which owns the browser plane's admission
/// rule: the transport predicate, or a Cognia browser-extension origin. The
/// two call sites must not drift — an origin the user can save here but the
/// request path refuses reads, from inside a tab, as an unexplained 403.
pub fn normalize_origin(raw: &str) -> Option<String> {
    super::extension_origin::normalize_browser_plane_origin(raw)
}

fn config_path(data_dir: Option<&Path>) -> PathBuf {
    match data_dir {
        Some(dir) => dir.join(CONFIG_SUBDIR).join(CONFIG_FILE),
        None => std::env::temp_dir().join(CONFIG_SUBDIR).join(CONFIG_FILE),
    }
}

/// Read the config. A missing OR unreadable file yields the default.
///
/// Failing closed on a corrupt file is deliberate: the default is "no browser
/// access", so the worst case of an unparseable config is a feature that stays
/// off, never one that silently opens.
///
/// A file that *parses* is repaired rather than discarded — see
/// [`BrowserAccessConfig::repaired`]. Sending a whole config to the default
/// because one origin in it stopped being admissible is not failing closed, it
/// is losing the user's settings.
pub fn load(data_dir: Option<&Path>) -> BrowserAccessConfig {
    let path = config_path(data_dir);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return BrowserAccessConfig::default();
    };
    serde_json::from_str::<BrowserAccessConfig>(&raw)
        .map(BrowserAccessConfig::repaired)
        .unwrap_or_default()
}

/// Persist the config after validating it.
pub fn save(
    data_dir: Option<&Path>,
    config: BrowserAccessConfig,
) -> Result<BrowserAccessConfig, String> {
    let sanitized = config.sanitized()?;
    let path = config_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(&sanitized).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = std::fs::metadata(&path).map(|m| m.permissions()) {
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }
    Ok(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cognia-browser-access-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn default_is_off_with_no_origins() {
        let config = BrowserAccessConfig::default();
        assert!(!config.enabled);
        assert!(!config.listener_enabled());
        assert_eq!(config.port, DEFAULT_BROWSER_PORT);
        assert_eq!(config.primary_origin(), None);
    }

    #[test]
    fn sanitize_normalizes_and_dedupes() {
        let config = BrowserAccessConfig {
            enabled: true,
            allowed_origins: vec![
                "http://localhost:3000/".into(),
                "http://localhost:3000".into(),
                "https://web.example".into(),
            ],
            port: 0,
        }
        .sanitized()
        .unwrap();
        assert_eq!(
            config.allowed_origins,
            vec!["http://localhost:3000", "https://web.example"]
        );
        assert_eq!(config.port, DEFAULT_BROWSER_PORT);
        assert_eq!(config.primary_origin(), Some("http://localhost:3000"));
    }

    #[test]
    fn sanitize_canonicalizes_to_what_the_browser_will_send() {
        // Each of these is a valid origin a user could type, and each used to
        // be stored verbatim and then never match the `Origin` header — an
        // entry that looks saved and 403s forever.
        let config = BrowserAccessConfig {
            enabled: true,
            allowed_origins: vec![
                "https://web.example:443".into(),
                "HTTPS://Web.Example".into(),
                "http://127.0.0.1:3000/".into(),
            ],
            port: DEFAULT_BROWSER_PORT,
        }
        .sanitized()
        .unwrap();
        // The first two collapse onto one canonical entry, so the dedupe that
        // could not see them as equal before now can.
        assert_eq!(
            config.allowed_origins,
            vec!["https://web.example", "http://127.0.0.1:3000"]
        );
    }

    #[test]
    fn an_extension_origin_is_allowed_but_is_never_the_pair_in_browser_target() {
        let config = BrowserAccessConfig {
            enabled: true,
            allowed_origins: vec![
                // Ordered first, as the Browser Companion flow will tend to
                // leave it when the user adds it last-in-first-position.
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop".into(),
                "http://localhost:3000".into(),
            ],
            port: DEFAULT_BROWSER_PORT,
        }
        .sanitized()
        .unwrap();
        assert_eq!(
            config.allowed_origins,
            vec![
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                "http://localhost:3000"
            ]
        );
        // It reaches the Host — but `chrome-extension://` names a page inside
        // an extension that no navigation can open, so a link must not aim there.
        assert_eq!(config.primary_origin(), Some("http://localhost:3000"));
    }

    #[test]
    fn an_allowlist_of_only_extension_origins_offers_no_link_target() {
        let config = BrowserAccessConfig {
            enabled: true,
            allowed_origins: vec!["chrome-extension://abcdefghijklmnopabcdefghijklmnop".into()],
            port: DEFAULT_BROWSER_PORT,
        }
        .sanitized()
        .unwrap();
        assert!(config.listener_enabled());
        assert_eq!(config.primary_origin(), None);
    }

    #[test]
    fn sanitize_rejects_anything_that_is_not_an_exact_origin() {
        for bad in [
            "http://web.example",          // plaintext off-loopback
            "https://web.example/path",    // path
            "https://web.example/?a=b",    // query
            "https://user:pw@web.example", // credentials
            "*",
            "not a url",
        ] {
            let result = BrowserAccessConfig {
                enabled: true,
                allowed_origins: vec![bad.into()],
                port: DEFAULT_BROWSER_PORT,
            }
            .sanitized();
            assert!(result.is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn enabling_without_an_origin_is_refused() {
        // An enabled listener with an empty allowlist would bind a plaintext
        // port that answers nothing — all cost, no capability.
        assert!(BrowserAccessConfig {
            enabled: true,
            allowed_origins: Vec::new(),
            port: DEFAULT_BROWSER_PORT,
        }
        .sanitized()
        .is_err());
    }

    #[test]
    fn disabled_config_may_keep_its_origins_for_the_next_enable() {
        let config = BrowserAccessConfig {
            enabled: false,
            allowed_origins: vec!["http://localhost:3000".into()],
            port: DEFAULT_BROWSER_PORT,
        }
        .sanitized()
        .unwrap();
        assert!(!config.listener_enabled());
        assert_eq!(config.primary_origin(), Some("http://localhost:3000"));
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = temp_dir("round-trip");
        let saved = save(
            Some(&dir),
            BrowserAccessConfig {
                enabled: true,
                allowed_origins: vec!["http://127.0.0.1:3000/".into()],
                port: 27891,
            },
        )
        .unwrap();
        assert_eq!(saved.allowed_origins, vec!["http://127.0.0.1:3000"]);
        let loaded = load(Some(&dir));
        assert!(loaded.listener_enabled());
        assert_eq!(loaded.allowed_origins, vec!["http://127.0.0.1:3000"]);
    }

    #[test]
    fn a_corrupt_config_reads_as_off_rather_than_open() {
        let dir = temp_dir("corrupt");
        let path = dir.join(CONFIG_SUBDIR).join(CONFIG_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(!load(Some(&dir)).enabled);

        // Valid JSON that would enable a wildcard must also fail closed.
        std::fs::write(
            &path,
            r#"{"enabled":true,"allowedOrigins":["*"],"port":27891}"#,
        )
        .unwrap();
        assert!(!load(Some(&dir)).enabled);
    }

    #[test]
    fn one_unusable_saved_origin_does_not_take_the_rest_of_the_config_with_it() {
        // `extension://<id>` was admitted by an earlier release and written to
        // real config files. Refusing the whole file over it reset browser
        // access to off, reset the port, and dropped every other origin — with
        // nothing in Settings to explain where they went.
        let dir = temp_dir("partial-repair");
        let path = dir.join(CONFIG_SUBDIR).join(CONFIG_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"enabled":true,"allowedOrigins":["extension://abcdefghijklmnopabcdefghijklmnop","http://127.0.0.1:3000","https://web.example:443"],"port":27999}"#,
        )
        .unwrap();

        let loaded = load(Some(&dir));
        assert!(loaded.listener_enabled());
        assert_eq!(loaded.port, 27999);
        // The stale entry is gone; the survivors are canonicalized as usual.
        assert_eq!(
            loaded.allowed_origins,
            vec!["http://127.0.0.1:3000", "https://web.example"]
        );
    }

    #[test]
    fn submissions_start_refused_and_follow_the_listener_predicate() {
        // Fail closed: nothing has told this process that browser access is on.
        // The default for browser access is off, and a global that started
        // `true` would accept submissions on a Host that never enabled it.
        assert!(!submissions_enabled());

        // `listener_enabled()`, not the raw `enabled` flag — a config whose
        // origin list is empty binds no listener, and a switch that reads "on"
        // over an empty allowlist must not accept submissions either.
        let no_origins = BrowserAccessConfig {
            enabled: true,
            allowed_origins: vec![],
            port: DEFAULT_BROWSER_PORT,
        };
        set_submissions_enabled(no_origins.listener_enabled());
        assert!(!submissions_enabled());

        let usable = BrowserAccessConfig {
            enabled: true,
            allowed_origins: vec!["http://localhost:3000".to_string()],
            port: DEFAULT_BROWSER_PORT,
        };
        set_submissions_enabled(usable.listener_enabled());
        assert!(submissions_enabled());

        // Turning it off takes effect here, not at the next restart. That is
        // the whole reason this mirror exists.
        set_submissions_enabled(false);
        assert!(!submissions_enabled());
    }

    #[test]
    fn missing_file_is_the_default() {
        let dir = temp_dir("missing");
        assert!(!load(Some(&dir)).enabled);
    }
}
