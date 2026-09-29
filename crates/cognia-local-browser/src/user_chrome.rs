//! Find the user's own running Chrome / Edge / Brave (ADR-0201 `user-chrome`).
//!
//! Chrome 144+ lets the user turn on remote debugging for the browser they are
//! running at `chrome://inspect/#remote-debugging`. Chrome then writes
//! `DevToolsActivePort` into its user-data directory — line 1 the port, line 2
//! the browser target path — and asks the user to allow every new connection.
//! Cognia only reads that file: it never launches the user's browser with
//! debugging flags, never copies the profile, and never persists the endpoint
//! (it is resolved per `session.create` and handed straight to the runtime).

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The browsers Cognia can attach to.
pub const USER_BROWSERS: &[UserBrowser] = &[
    UserBrowser::Chrome,
    UserBrowser::ChromeBeta,
    UserBrowser::ChromeCanary,
    UserBrowser::Edge,
    UserBrowser::Brave,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UserBrowser {
    Chrome,
    ChromeBeta,
    ChromeCanary,
    Edge,
    Brave,
}

impl UserBrowser {
    pub fn id(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::ChromeBeta => "chrome-beta",
            Self::ChromeCanary => "chrome-canary",
            Self::Edge => "edge",
            Self::Brave => "brave",
        }
    }

    /// Product name (a proper noun, identical in every locale).
    pub fn label(self) -> &'static str {
        match self {
            Self::Chrome => "Google Chrome",
            Self::ChromeBeta => "Google Chrome Beta",
            Self::ChromeCanary => "Google Chrome Canary",
            Self::Edge => "Microsoft Edge",
            Self::Brave => "Brave",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        USER_BROWSERS.iter().copied().find(|browser| browser.id() == id)
    }

    /// The user-data directory relative to the platform base: macOS
    /// `~/Library/Application Support`, Windows `%LOCALAPPDATA%`, Linux
    /// `~/.config`.
    pub fn relative_user_data_dir(self, os: Os) -> &'static [&'static str] {
        match (os, self) {
            (Os::MacOs, Self::Chrome) => &["Google", "Chrome"],
            (Os::MacOs, Self::ChromeBeta) => &["Google", "Chrome Beta"],
            (Os::MacOs, Self::ChromeCanary) => &["Google", "Chrome Canary"],
            (Os::MacOs, Self::Edge) => &["Microsoft Edge"],
            (Os::MacOs, Self::Brave) => &["BraveSoftware", "Brave-Browser"],
            (Os::Windows, Self::Chrome) => &["Google", "Chrome", "User Data"],
            (Os::Windows, Self::ChromeBeta) => &["Google", "Chrome Beta", "User Data"],
            (Os::Windows, Self::ChromeCanary) => &["Google", "Chrome SxS", "User Data"],
            (Os::Windows, Self::Edge) => &["Microsoft", "Edge", "User Data"],
            (Os::Windows, Self::Brave) => &["BraveSoftware", "Brave-Browser", "User Data"],
            (Os::Linux, Self::Chrome) => &["google-chrome"],
            (Os::Linux, Self::ChromeBeta) => &["google-chrome-beta"],
            (Os::Linux, Self::ChromeCanary) => &["google-chrome-canary"],
            (Os::Linux, Self::Edge) => &["microsoft-edge"],
            (Os::Linux, Self::Brave) => &["BraveSoftware", "Brave-Browser"],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    MacOs,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// Where each OS keeps browser user data.
pub fn platform_base_dir(os: Os) -> Option<PathBuf> {
    match os {
        Os::MacOs => dirs::home_dir().map(|home| home.join("Library").join("Application Support")),
        Os::Windows => dirs::data_local_dir(),
        Os::Linux => dirs::config_dir(),
    }
}

pub fn user_data_dir(base: &Path, os: Os, browser: UserBrowser) -> PathBuf {
    browser
        .relative_user_data_dir(os)
        .iter()
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

/// Why a candidate cannot be attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    RemoteDebuggingDisabled,
    NotInstalled,
}

impl UnavailableReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::RemoteDebuggingDisabled => "remote_debugging_disabled",
            Self::NotInstalled => "not_installed",
        }
    }
}

/// One discovery row (the `UserChromeCandidate` IPC shape).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserChromeCandidate {
    pub browser: String,
    pub label: String,
    pub user_data_dir: String,
    pub available: bool,
    pub reason: Option<UnavailableReason>,
}

/// A parsed `DevToolsActivePort`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivePort {
    pub port: u16,
    pub path: String,
}

impl ActivePort {
    pub fn websocket_url(&self) -> String {
        format!("ws://127.0.0.1:{}{}", self.port, self.path)
    }
}

/// Parse `DevToolsActivePort`: a non-zero port on line 1 and the
/// `/devtools/browser/<id>` target on line 2.
pub fn parse_devtools_active_port(contents: &str) -> Option<ActivePort> {
    let mut lines = contents.lines().map(str::trim);
    let port = lines.next()?.parse::<u16>().ok().filter(|port| *port != 0)?;
    let path = lines.next()?;
    let valid_path = path.starts_with("/devtools/browser/")
        && path.len() > "/devtools/browser/".len()
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_'));
    valid_path.then(|| ActivePort {
        port,
        path: path.to_string(),
    })
}

fn read_active_port(user_data_dir: &Path) -> Option<ActivePort> {
    let contents = std::fs::read_to_string(user_data_dir.join("DevToolsActivePort")).ok()?;
    parse_devtools_active_port(&contents)
}

/// Inspect one browser under `base`.
pub fn candidate(base: &Path, os: Os, browser: UserBrowser) -> UserChromeCandidate {
    let dir = user_data_dir(base, os, browser);
    let reason = if !dir.is_dir() {
        Some(UnavailableReason::NotInstalled)
    } else if read_active_port(&dir).is_none() {
        Some(UnavailableReason::RemoteDebuggingDisabled)
    } else {
        None
    };
    UserChromeCandidate {
        browser: browser.id().to_string(),
        label: browser.label().to_string(),
        user_data_dir: dir.to_string_lossy().into_owned(),
        available: reason.is_none(),
        reason,
    }
}

/// Every supported browser under an explicit base (testable form).
pub fn discover_in(base: &Path, os: Os) -> Vec<UserChromeCandidate> {
    USER_BROWSERS
        .iter()
        .map(|browser| candidate(base, os, *browser))
        .collect()
}

/// Every supported browser on this machine.
pub fn discover() -> Vec<UserChromeCandidate> {
    let os = Os::current();
    match platform_base_dir(os) {
        Some(base) => discover_in(&base, os),
        None => USER_BROWSERS
            .iter()
            .map(|browser| UserChromeCandidate {
                browser: browser.id().to_string(),
                label: browser.label().to_string(),
                user_data_dir: String::new(),
                available: false,
                reason: Some(UnavailableReason::NotInstalled),
            })
            .collect(),
    }
}

/// Resolution failure: an unknown browser id or an unavailable browser.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ResolveError {
    #[error("unknown_browser: {0} is not a supported browser")]
    UnknownBrowser(String),
    #[error("{}: {browser} cannot be attached", reason.code())]
    Unavailable {
        browser: String,
        reason: UnavailableReason,
    },
}

impl ResolveError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownBrowser(_) => "unknown_browser",
            Self::Unavailable { reason, .. } => reason.code(),
        }
    }
}

/// The `ws://` endpoint of `browser` under `base` (testable form).
pub fn resolve_endpoint_in(base: &Path, os: Os, browser: &str) -> Result<String, ResolveError> {
    let parsed =
        UserBrowser::parse(browser).ok_or_else(|| ResolveError::UnknownBrowser(browser.into()))?;
    let dir = user_data_dir(base, os, parsed);
    if !dir.is_dir() {
        return Err(ResolveError::Unavailable {
            browser: browser.into(),
            reason: UnavailableReason::NotInstalled,
        });
    }
    read_active_port(&dir)
        .map(|port| port.websocket_url())
        .ok_or_else(|| ResolveError::Unavailable {
            browser: browser.into(),
            reason: UnavailableReason::RemoteDebuggingDisabled,
        })
}

/// The `ws://` endpoint of the user's running `browser`. Never persisted.
pub fn resolve_endpoint(browser: &str) -> Result<String, ResolveError> {
    let os = Os::current();
    let base = platform_base_dir(os).ok_or_else(|| ResolveError::Unavailable {
        browser: browser.into(),
        reason: UnavailableReason::NotInstalled,
    })?;
    resolve_endpoint_in(&base, os, browser)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_devtools_active_port() {
        let parsed =
            parse_devtools_active_port("9222\n/devtools/browser/0b1f-4c2e_a\n").unwrap();
        assert_eq!(parsed.port, 9222);
        assert_eq!(
            parsed.websocket_url(),
            "ws://127.0.0.1:9222/devtools/browser/0b1f-4c2e_a"
        );
        // CRLF endings (Windows) parse too.
        assert!(parse_devtools_active_port("9222\r\n/devtools/browser/abc\r\n").is_some());
    }

    #[test]
    fn rejects_malformed_active_port_files() {
        for bad in [
            "",
            "9222",
            "0\n/devtools/browser/abc",
            "70000\n/devtools/browser/abc",
            "port\n/devtools/browser/abc",
            "9222\n/json/version",
            "9222\n/devtools/browser/",
            "9222\n/devtools/browser/abc?x=@evil",
        ] {
            assert!(parse_devtools_active_port(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn user_data_dirs_follow_each_platform() {
        let base = Path::new("/base");
        assert_eq!(
            user_data_dir(base, Os::MacOs, UserBrowser::Chrome),
            base.join("Google").join("Chrome")
        );
        assert_eq!(
            user_data_dir(base, Os::Windows, UserBrowser::ChromeCanary),
            base.join("Google").join("Chrome SxS").join("User Data")
        );
        assert_eq!(
            user_data_dir(base, Os::Windows, UserBrowser::Edge),
            base.join("Microsoft").join("Edge").join("User Data")
        );
        assert_eq!(
            user_data_dir(base, Os::Linux, UserBrowser::Brave),
            base.join("BraveSoftware").join("Brave-Browser")
        );
        assert_eq!(
            user_data_dir(base, Os::Linux, UserBrowser::ChromeBeta),
            base.join("google-chrome-beta")
        );
    }

    #[test]
    fn browser_ids_round_trip() {
        for browser in USER_BROWSERS {
            assert_eq!(UserBrowser::parse(browser.id()), Some(*browser));
        }
        assert_eq!(UserBrowser::parse("firefox"), None);
    }

    #[test]
    fn discovery_reports_reasons() {
        let base = tempfile::tempdir().unwrap();
        let chrome = user_data_dir(base.path(), Os::MacOs, UserBrowser::Chrome);
        std::fs::create_dir_all(&chrome).unwrap();
        std::fs::write(
            chrome.join("DevToolsActivePort"),
            "9333\n/devtools/browser/abc\n",
        )
        .unwrap();
        let edge = user_data_dir(base.path(), Os::MacOs, UserBrowser::Edge);
        std::fs::create_dir_all(&edge).unwrap();

        let found = discover_in(base.path(), Os::MacOs);
        assert_eq!(found.len(), USER_BROWSERS.len());
        let by_id = |id: &str| found.iter().find(|row| row.browser == id).unwrap();
        assert!(by_id("chrome").available);
        assert_eq!(by_id("chrome").reason, None);
        assert_eq!(by_id("chrome").label, "Google Chrome");
        assert_eq!(
            by_id("edge").reason,
            Some(UnavailableReason::RemoteDebuggingDisabled)
        );
        assert_eq!(by_id("brave").reason, Some(UnavailableReason::NotInstalled));

        let json = serde_json::to_value(by_id("edge")).unwrap();
        assert_eq!(json["reason"], "remote_debugging_disabled");
        assert_eq!(json["userDataDir"], edge.to_string_lossy().as_ref());
        // The endpoint is never part of a discovery row.
        assert!(!serde_json::to_string(&found).unwrap().contains("ws://"));
    }

    #[test]
    fn resolves_endpoints_with_typed_errors() {
        let base = tempfile::tempdir().unwrap();
        let chrome = user_data_dir(base.path(), Os::Linux, UserBrowser::Chrome);
        std::fs::create_dir_all(&chrome).unwrap();
        assert_eq!(
            resolve_endpoint_in(base.path(), Os::Linux, "chrome")
                .unwrap_err()
                .code(),
            "remote_debugging_disabled"
        );
        std::fs::write(chrome.join("DevToolsActivePort"), "9444\n/devtools/browser/x1\n").unwrap();
        assert_eq!(
            resolve_endpoint_in(base.path(), Os::Linux, "chrome").unwrap(),
            "ws://127.0.0.1:9444/devtools/browser/x1"
        );
        assert_eq!(
            resolve_endpoint_in(base.path(), Os::Linux, "brave")
                .unwrap_err()
                .code(),
            "not_installed"
        );
        let unknown = resolve_endpoint_in(base.path(), Os::Linux, "safari").unwrap_err();
        assert_eq!(unknown.code(), "unknown_browser");
        assert!(unknown.to_string().starts_with("unknown_browser"));
    }
}
