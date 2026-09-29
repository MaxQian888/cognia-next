//! Every browser an import can read, where each one keeps its profiles on
//! macOS, Windows and Linux, and which of those profiles hold cookies or saved
//! passwords.
//!
//! Profile ids are the directory names the browser itself uses (`Default`,
//! `Profile 1`, a Firefox `profiles.ini` path). Resolving an id back to a
//! directory only ever accepts an id discovery could have produced, so a
//! renderer-supplied id can never name an arbitrary path.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Browser {
    Chrome,
    Edge,
    Brave,
    Chromium,
    Arc,
    Vivaldi,
    Opera,
    Firefox,
    Safari,
}

pub const ALL_BROWSERS: [Browser; 9] = [
    Browser::Chrome,
    Browser::Edge,
    Browser::Brave,
    Browser::Chromium,
    Browser::Arc,
    Browser::Vivaldi,
    Browser::Opera,
    Browser::Firefox,
    Browser::Safari,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserKind {
    Chromium,
    Firefox,
    Safari,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    MacOs,
    Windows,
    Linux,
    Other,
}

impl Os {
    pub fn current() -> Self {
        Self::from_name(std::env::consts::OS)
    }

    pub fn from_name(name: &str) -> Self {
        match name {
            "macos" => Self::MacOs,
            "windows" => Self::Windows,
            "linux" => Self::Linux,
            _ => Self::Other,
        }
    }
}

impl Browser {
    pub fn id(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Edge => "edge",
            Self::Brave => "brave",
            Self::Chromium => "chromium",
            Self::Arc => "arc",
            Self::Vivaldi => "vivaldi",
            Self::Opera => "opera",
            Self::Firefox => "firefox",
            Self::Safari => "safari",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        ALL_BROWSERS.into_iter().find(|browser| browser.id() == id)
    }

    pub fn kind(self) -> BrowserKind {
        match self {
            Self::Firefox => BrowserKind::Firefox,
            Self::Safari => BrowserKind::Safari,
            _ => BrowserKind::Chromium,
        }
    }

    /// The product name. Brand names are not translated.
    pub fn label(self) -> &'static str {
        match self {
            Self::Chrome => "Google Chrome",
            Self::Edge => "Microsoft Edge",
            Self::Brave => "Brave",
            Self::Chromium => "Chromium",
            Self::Arc => "Arc",
            Self::Vivaldi => "Vivaldi",
            Self::Opera => "Opera",
            Self::Firefox => "Firefox",
            Self::Safari => "Safari",
        }
    }

    /// The macOS Keychain generic password (service, account) holding the
    /// browser's Safe Storage passphrase.
    pub fn mac_safe_storage(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::Chrome => Some(("Chrome Safe Storage", "Chrome")),
            Self::Edge => Some(("Microsoft Edge Safe Storage", "Microsoft Edge")),
            Self::Brave => Some(("Brave Safe Storage", "Brave")),
            Self::Chromium => Some(("Chromium Safe Storage", "Chromium")),
            Self::Arc => Some(("Arc Safe Storage", "Arc")),
            Self::Vivaldi => Some(("Vivaldi Safe Storage", "Vivaldi")),
            Self::Opera => Some(("Opera Safe Storage", "Opera")),
            Self::Firefox | Self::Safari => None,
        }
    }

    /// The `application` attribute of the browser's libsecret item on Linux
    /// (`chrome_libsecret_os_crypt_password_v2`).
    pub fn linux_secret_application(self) -> Option<&'static str> {
        match self {
            Self::Chrome => Some("chrome"),
            Self::Edge => Some("microsoft-edge"),
            Self::Brave => Some("brave"),
            Self::Chromium => Some("chromium"),
            Self::Vivaldi => Some("vivaldi"),
            Self::Opera => Some("opera"),
            Self::Arc | Self::Firefox | Self::Safari => None,
        }
    }

    /// Whether the browser ships for `os` at all.
    pub fn exists_on(self, os: Os) -> bool {
        match (self, os) {
            (_, Os::Other) => false,
            (Self::Safari, os) => os == Os::MacOs,
            (Self::Arc, os) => os != Os::Linux,
            _ => true,
        }
    }
}

/// The per-user directories browsers keep their profiles under.
#[derive(Clone, Debug, Default)]
pub struct HostDirs {
    pub home: Option<PathBuf>,
    /// `%LOCALAPPDATA%` on Windows.
    pub local_app_data: Option<PathBuf>,
    /// `%APPDATA%` on Windows.
    pub roaming_app_data: Option<PathBuf>,
    /// `$XDG_CONFIG_HOME` (`~/.config`) on Linux.
    pub config: Option<PathBuf>,
}

impl HostDirs {
    pub fn detect() -> Self {
        Self {
            home: dirs::home_dir(),
            local_app_data: dirs::data_local_dir(),
            roaming_app_data: dirs::data_dir(),
            config: dirs::config_dir(),
        }
    }

    /// Everything derived from one home directory, laid out like each OS
    /// does by default. Used by tests and by hosts that only know `$HOME`.
    pub fn from_home(home: &Path, os: Os) -> Self {
        match os {
            Os::Windows => Self {
                home: Some(home.to_path_buf()),
                local_app_data: Some(home.join("AppData/Local")),
                roaming_app_data: Some(home.join("AppData/Roaming")),
                config: None,
            },
            Os::Linux => Self {
                home: Some(home.to_path_buf()),
                local_app_data: None,
                roaming_app_data: None,
                config: Some(home.join(".config")),
            },
            Os::MacOs | Os::Other => Self {
                home: Some(home.to_path_buf()),
                local_app_data: None,
                roaming_app_data: None,
                config: None,
            },
        }
    }
}

fn chromium_candidates(browser: Browser, os: Os, dirs: &HostDirs) -> Vec<PathBuf> {
    match os {
        Os::MacOs => {
            let Some(home) = &dirs.home else {
                return Vec::new();
            };
            let support = home.join("Library/Application Support");
            let relative = match browser {
                Browser::Chrome => "Google/Chrome",
                Browser::Edge => "Microsoft Edge",
                Browser::Brave => "BraveSoftware/Brave-Browser",
                Browser::Chromium => "Chromium",
                Browser::Arc => "Arc/User Data",
                Browser::Vivaldi => "Vivaldi",
                Browser::Opera => "com.operasoftware.Opera",
                Browser::Firefox | Browser::Safari => return Vec::new(),
            };
            vec![support.join(relative)]
        }
        Os::Windows => {
            let local = dirs.local_app_data.clone();
            let roaming = dirs.roaming_app_data.clone();
            match browser {
                Browser::Chrome => local
                    .map(|dir| dir.join("Google/Chrome/User Data"))
                    .into_iter()
                    .collect(),
                Browser::Edge => local
                    .map(|dir| dir.join("Microsoft/Edge/User Data"))
                    .into_iter()
                    .collect(),
                Browser::Brave => local
                    .map(|dir| dir.join("BraveSoftware/Brave-Browser/User Data"))
                    .into_iter()
                    .collect(),
                Browser::Chromium => local
                    .map(|dir| dir.join("Chromium/User Data"))
                    .into_iter()
                    .collect(),
                Browser::Vivaldi => local
                    .map(|dir| dir.join("Vivaldi/User Data"))
                    .into_iter()
                    .collect(),
                Browser::Opera => roaming
                    .map(|dir| dir.join("Opera Software/Opera Stable"))
                    .into_iter()
                    .collect(),
                Browser::Arc => local
                    .map(|dir| arc_windows_candidates(&dir.join("Packages")))
                    .unwrap_or_default(),
                Browser::Firefox | Browser::Safari => Vec::new(),
            }
        }
        Os::Linux => {
            let config = dirs
                .config
                .clone()
                .or_else(|| dirs.home.as_ref().map(|home| home.join(".config")));
            let Some(config) = config else {
                return Vec::new();
            };
            let mut candidates = match browser {
                Browser::Chrome => vec![config.join("google-chrome")],
                Browser::Edge => vec![config.join("microsoft-edge")],
                Browser::Brave => vec![config.join("BraveSoftware/Brave-Browser")],
                Browser::Chromium => vec![config.join("chromium")],
                Browser::Vivaldi => vec![config.join("vivaldi")],
                Browser::Opera => vec![config.join("opera")],
                Browser::Arc | Browser::Firefox | Browser::Safari => Vec::new(),
            };
            if browser == Browser::Chromium {
                if let Some(home) = &dirs.home {
                    candidates.push(home.join("snap/chromium/common/chromium"));
                }
            }
            candidates
        }
        Os::Other => Vec::new(),
    }
}

/// Arc for Windows is an MSIX package whose directory carries a publisher
/// hash (`TheBrowserCompany.Arc_<hash>`).
fn arc_windows_candidates(packages: &Path) -> Vec<PathBuf> {
    let mut found = std::fs::read_dir(packages)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("TheBrowserCompany.Arc_"))
        })
        .map(|entry| entry.path().join("LocalCache/Local/Arc/User Data"))
        .collect::<Vec<_>>();
    found.sort();
    found
}

/// The browser's user-data directory on this machine, if it is installed
/// (has been run at least once).
pub fn chromium_user_data_dir(browser: Browser, os: Os, dirs: &HostDirs) -> Option<PathBuf> {
    chromium_candidates(browser, os, dirs)
        .into_iter()
        .find(|path| path.is_dir())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileData {
    Cookies,
    Passwords,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProfileInfo {
    pub id: String,
    pub name: String,
}

pub fn chromium_login_databases(profile_dir: &Path) -> Vec<PathBuf> {
    ["Login Data", "Login Data For Account"]
        .into_iter()
        .map(|name| profile_dir.join(name))
        .filter(|path| path.is_file())
        .collect()
}

pub fn chromium_has_data(profile_dir: &Path, data: ProfileData) -> bool {
    match data {
        ProfileData::Cookies => crate::chromium::find_cookie_database(profile_dir).is_some(),
        ProfileData::Passwords => !chromium_login_databases(profile_dir).is_empty(),
    }
}

/// The `profile.info_cache` display names from `Local State`.
fn chromium_profile_names(user_data_dir: &Path) -> std::collections::BTreeMap<String, String> {
    let Ok(raw) = std::fs::read(user_data_dir.join("Local State")) else {
        return Default::default();
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return Default::default();
    };
    json.pointer("/profile/info_cache")
        .and_then(serde_json::Value::as_object)
        .map(|cache| {
            cache
                .iter()
                .filter_map(|(id, info)| {
                    info.get("name")
                        .and_then(serde_json::Value::as_str)
                        .filter(|name| !name.trim().is_empty())
                        .map(|name| (id.clone(), name.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Id of the profile an Opera-style browser keeps directly in its user-data
/// directory (no `Default` subdirectory).
pub const ROOT_PROFILE_ID: &str = "Default";

/// Profiles under `user_data_dir` that hold `data`, sorted by id.
pub fn chromium_profiles(user_data_dir: &Path, data: ProfileData) -> Vec<ProfileInfo> {
    let names = chromium_profile_names(user_data_dir);
    let mut profiles = std::fs::read_dir(user_data_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        // A root-level profile's own `Network/Cookies` must not make its
        // `Network` directory look like a legacy-layout profile.
        .filter(|entry| entry.file_name() != "Network")
        .filter(|entry| chromium_has_data(&entry.path(), data))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .map(|id| ProfileInfo {
            name: names.get(&id).cloned().unwrap_or_else(|| id.clone()),
            id,
        })
        .collect::<Vec<_>>();
    if !user_data_dir.join(ROOT_PROFILE_ID).is_dir() && chromium_has_data(user_data_dir, data) {
        profiles.push(ProfileInfo {
            id: ROOT_PROFILE_ID.into(),
            name: names
                .get(ROOT_PROFILE_ID)
                .cloned()
                .unwrap_or_else(|| ROOT_PROFILE_ID.into()),
        });
    }
    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    profiles
}

/// One normal path component, or nothing: no absolute paths, traversal, or
/// nested segments.
pub fn single_component(profile: &str) -> Option<&std::ffi::OsStr> {
    let mut components = Path::new(profile).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) if !name.is_empty() => Some(name),
        _ => None,
    }
}

/// The directory of profile `id` under `user_data_dir`, if it holds `data`.
pub fn resolve_chromium_profile(
    user_data_dir: &Path,
    id: &str,
    data: ProfileData,
) -> Option<PathBuf> {
    let name = single_component(id)?;
    let candidate = user_data_dir.join(name);
    if candidate.is_dir() {
        return chromium_has_data(&candidate, data).then_some(candidate);
    }
    (id == ROOT_PROFILE_ID && chromium_has_data(user_data_dir, data))
        .then(|| user_data_dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_and_kinds_are_grouped() {
        for browser in ALL_BROWSERS {
            assert_eq!(Browser::parse(browser.id()), Some(browser));
            assert_eq!(
                serde_json::to_value(browser).unwrap(),
                serde_json::json!(browser.id())
            );
        }
        assert_eq!(Browser::parse("netscape"), None);
        assert_eq!(Browser::Firefox.kind(), BrowserKind::Firefox);
        assert_eq!(Browser::Safari.kind(), BrowserKind::Safari);
        assert_eq!(Browser::Arc.kind(), BrowserKind::Chromium);
        assert_eq!(Browser::Opera.label(), "Opera");
    }

    #[test]
    fn keychain_and_secret_service_names_cover_every_chromium_browser() {
        assert_eq!(
            Browser::Arc.mac_safe_storage(),
            Some(("Arc Safe Storage", "Arc"))
        );
        assert_eq!(
            Browser::Edge.mac_safe_storage(),
            Some(("Microsoft Edge Safe Storage", "Microsoft Edge"))
        );
        assert_eq!(Browser::Firefox.mac_safe_storage(), None);
        assert_eq!(Browser::Chrome.linux_secret_application(), Some("chrome"));
        assert_eq!(Browser::Arc.linux_secret_application(), None);
    }

    #[test]
    fn platform_availability_matrix() {
        assert!(Browser::Safari.exists_on(Os::MacOs));
        assert!(!Browser::Safari.exists_on(Os::Windows));
        assert!(!Browser::Arc.exists_on(Os::Linux));
        assert!(Browser::Arc.exists_on(Os::Windows));
        assert!(Browser::Firefox.exists_on(Os::Linux));
        assert!(!Browser::Chrome.exists_on(Os::Other));
        assert_eq!(Os::from_name("macos"), Os::MacOs);
        assert_eq!(Os::from_name("freebsd"), Os::Other);
    }

    fn make_profile(dir: &Path, cookies: bool, passwords: bool) {
        std::fs::create_dir_all(dir.join("Network")).unwrap();
        if cookies {
            std::fs::write(dir.join("Network/Cookies"), []).unwrap();
        }
        if passwords {
            std::fs::write(dir.join("Login Data"), []).unwrap();
        }
    }

    #[test]
    fn resolves_per_os_user_data_directories() {
        let home = tempfile::tempdir().unwrap();
        let mac = HostDirs::from_home(home.path(), Os::MacOs);
        let win = HostDirs::from_home(home.path(), Os::Windows);
        let linux = HostDirs::from_home(home.path(), Os::Linux);
        let expected = [
            (
                Browser::Vivaldi,
                Os::MacOs,
                &mac,
                "Library/Application Support/Vivaldi",
            ),
            (
                Browser::Arc,
                Os::MacOs,
                &mac,
                "Library/Application Support/Arc/User Data",
            ),
            (
                Browser::Edge,
                Os::Windows,
                &win,
                "AppData/Local/Microsoft/Edge/User Data",
            ),
            (
                Browser::Opera,
                Os::Windows,
                &win,
                "AppData/Roaming/Opera Software/Opera Stable",
            ),
            (
                Browser::Brave,
                Os::Linux,
                &linux,
                ".config/BraveSoftware/Brave-Browser",
            ),
        ];
        for (browser, os, dirs, relative) in expected {
            assert_eq!(chromium_user_data_dir(browser, os, dirs), None);
            std::fs::create_dir_all(home.path().join(relative)).unwrap();
            assert_eq!(
                chromium_user_data_dir(browser, os, dirs),
                Some(home.path().join(relative)),
                "{browser:?} on {os:?}"
            );
        }
        assert_eq!(
            chromium_user_data_dir(Browser::Arc, Os::Linux, &linux),
            None
        );
    }

    #[test]
    fn finds_arc_inside_its_windows_package() {
        let home = tempfile::tempdir().unwrap();
        let win = HostDirs::from_home(home.path(), Os::Windows);
        let data = home
            .path()
            .join("AppData/Local/Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(home.path().join("AppData/Local/Packages/Other.App_1")).unwrap();
        assert_eq!(
            chromium_user_data_dir(Browser::Arc, Os::Windows, &win),
            Some(data)
        );
    }

    #[test]
    fn falls_back_to_snap_chromium_on_linux() {
        let home = tempfile::tempdir().unwrap();
        let linux = HostDirs::from_home(home.path(), Os::Linux);
        let snap = home.path().join("snap/chromium/common/chromium");
        std::fs::create_dir_all(&snap).unwrap();
        assert_eq!(
            chromium_user_data_dir(Browser::Chromium, Os::Linux, &linux),
            Some(snap)
        );
    }

    #[test]
    fn lists_profiles_with_local_state_names_per_data_kind() {
        let root = tempfile::tempdir().unwrap();
        make_profile(&root.path().join("Default"), true, true);
        make_profile(&root.path().join("Profile 1"), true, false);
        make_profile(&root.path().join("Profile 2"), false, true);
        std::fs::create_dir_all(root.path().join("System Profile")).unwrap();
        std::fs::write(
            root.path().join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"Work"},"Profile 1":{"name":" "}}}}"#,
        )
        .unwrap();

        assert_eq!(
            chromium_profiles(root.path(), ProfileData::Cookies),
            vec![
                ProfileInfo {
                    id: "Default".into(),
                    name: "Work".into()
                },
                ProfileInfo {
                    id: "Profile 1".into(),
                    name: "Profile 1".into()
                },
            ]
        );
        assert_eq!(
            chromium_profiles(root.path(), ProfileData::Passwords)
                .into_iter()
                .map(|profile| profile.id)
                .collect::<Vec<_>>(),
            ["Default", "Profile 2"]
        );
    }

    #[test]
    fn treats_an_opera_style_root_as_the_default_profile() {
        let root = tempfile::tempdir().unwrap();
        make_profile(root.path(), true, true);
        assert_eq!(
            chromium_profiles(root.path(), ProfileData::Cookies),
            vec![ProfileInfo {
                id: "Default".into(),
                name: "Default".into()
            }]
        );
        assert_eq!(
            resolve_chromium_profile(root.path(), "Default", ProfileData::Passwords),
            Some(root.path().to_path_buf())
        );
    }

    #[test]
    fn resolving_rejects_traversal_and_profiles_without_data() {
        let root = tempfile::tempdir().unwrap();
        make_profile(&root.path().join("Default"), true, false);
        assert_eq!(
            resolve_chromium_profile(root.path(), "Default", ProfileData::Cookies),
            Some(root.path().join("Default"))
        );
        assert_eq!(
            resolve_chromium_profile(root.path(), "Default", ProfileData::Passwords),
            None
        );
        for bad in ["../Default", "Default/Network", "/etc", "", ".."] {
            assert_eq!(
                resolve_chromium_profile(root.path(), bad, ProfileData::Cookies),
                None,
                "{bad}"
            );
        }
    }

    #[test]
    fn lists_both_login_databases() {
        let dir = tempfile::tempdir().unwrap();
        assert!(chromium_login_databases(dir.path()).is_empty());
        std::fs::write(dir.path().join("Login Data For Account"), []).unwrap();
        std::fs::write(dir.path().join("Login Data"), []).unwrap();
        assert_eq!(chromium_login_databases(dir.path()).len(), 2);
    }
}
