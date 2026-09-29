//! Firefox profiles (`profiles.ini`) and cookies (`cookies.sqlite`, stored in
//! plaintext).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::browsers::{HostDirs, Os, ProfileData, ProfileInfo};
use crate::chromium::{open_immutable, table_columns};
use crate::import::CookieBatch;
use crate::scope::ScopeFilter;
use crate::{ImportError, ImportedCookie, SameSite};

/// Every directory a Firefox install may keep `profiles.ini` in.
pub fn firefox_roots(os: Os, dirs: &HostDirs) -> Vec<PathBuf> {
    match os {
        Os::MacOs => dirs
            .home
            .iter()
            .map(|home| home.join("Library/Application Support/Firefox"))
            .collect(),
        Os::Windows => dirs
            .roaming_app_data
            .iter()
            .map(|roaming| roaming.join("Mozilla/Firefox"))
            .collect(),
        Os::Linux => dirs
            .home
            .iter()
            .flat_map(|home| {
                [
                    home.join(".mozilla/firefox"),
                    home.join("snap/firefox/common/.mozilla/firefox"),
                    home.join(".var/app/org.mozilla.firefox/.mozilla/firefox"),
                ]
            })
            .collect(),
        Os::Other => Vec::new(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IniProfile {
    pub name: String,
    pub path: String,
    pub is_relative: bool,
}

/// The `[ProfileN]` sections of a `profiles.ini`.
pub fn parse_profiles_ini(contents: &str) -> Vec<IniProfile> {
    let mut sections: Vec<(String, BTreeMap<String, String>)> = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(section) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            sections.push((section.to_owned(), BTreeMap::new()));
            continue;
        }
        if let (Some((key, value)), Some((_, entries))) =
            (line.split_once('='), sections.last_mut())
        {
            entries.insert(key.trim().to_owned(), value.trim().to_owned());
        }
    }
    sections
        .into_iter()
        .filter(|(section, _)| section.starts_with("Profile"))
        .filter_map(|(_, entries)| {
            let path = entries.get("Path")?.clone();
            if path.is_empty() {
                return None;
            }
            Some(IniProfile {
                name: entries.get("Name").cloned().unwrap_or_else(|| path.clone()),
                is_relative: entries.get("IsRelative").is_none_or(|value| value == "1"),
                path,
            })
        })
        .collect()
}

pub fn firefox_has_data(profile_dir: &Path, data: ProfileData) -> bool {
    match data {
        ProfileData::Cookies => profile_dir.join("cookies.sqlite").is_file(),
        ProfileData::Passwords => {
            profile_dir.join("logins.json").is_file() && profile_dir.join("key4.db").is_file()
        }
    }
}

fn profile_entries(os: Os, dirs: &HostDirs) -> Vec<(IniProfile, PathBuf)> {
    let mut entries = Vec::new();
    for root in firefox_roots(os, dirs) {
        let Ok(contents) = std::fs::read_to_string(root.join("profiles.ini")) else {
            continue;
        };
        for profile in parse_profiles_ini(&contents) {
            let dir = if profile.is_relative {
                root.join(&profile.path)
            } else {
                PathBuf::from(&profile.path)
            };
            entries.push((profile, dir));
        }
    }
    entries
}

/// Profiles that hold `data`, in `profiles.ini` order. The id is the
/// profile's `Path` as `profiles.ini` writes it.
pub fn firefox_profiles(os: Os, dirs: &HostDirs, data: ProfileData) -> Vec<ProfileInfo> {
    let mut seen = std::collections::BTreeSet::new();
    profile_entries(os, dirs)
        .into_iter()
        .filter(|(_, dir)| firefox_has_data(dir, data))
        .filter(|(profile, _)| seen.insert(profile.path.clone()))
        .map(|(profile, _)| ProfileInfo {
            id: profile.path,
            name: profile.name,
        })
        .collect()
}

/// The directory of the profile whose `profiles.ini` path is `id`. Only ids
/// present in a `profiles.ini` resolve.
pub fn resolve_firefox_profile(
    os: Os,
    dirs: &HostDirs,
    id: &str,
    data: ProfileData,
) -> Option<PathBuf> {
    profile_entries(os, dirs)
        .into_iter()
        .find(|(profile, dir)| profile.path == id && firefox_has_data(dir, data))
        .map(|(_, dir)| dir)
}

/// Firefox stores `expiry` in seconds, and in milliseconds since the
/// cookie-service schema moved to them; anything past year 5138 in seconds is
/// read as milliseconds.
fn firefox_expiry_to_unix(expiry: i64) -> Option<i64> {
    match expiry {
        value if value <= 0 => None,
        value if value > 100_000_000_000 => Some(value / 1_000),
        value => Some(value),
    }
}

fn same_site_from(value: i64) -> SameSite {
    match value {
        0 => SameSite::None,
        1 => SameSite::Lax,
        2 => SameSite::Strict,
        _ => SameSite::Unspecified,
    }
}

/// Admitted cookies of the default context. Rows carrying origin attributes
/// (containers, private browsing, partitioned storage) are skipped, like
/// Chromium's partitioned rows.
pub fn read_cookie_database(
    database: &Path,
    filter: &ScopeFilter,
) -> Result<CookieBatch, ImportError> {
    let connection = open_immutable(database)?;
    let columns = table_columns(&connection, "moz_cookies")?;
    if columns.is_empty() {
        return Err(ImportError::Database);
    }
    let same_site = if columns.contains("sameSite") {
        "sameSite"
    } else {
        "-1"
    };
    let origin_filter = if columns.contains("originAttributes") {
        " WHERE COALESCE(originAttributes, '') = ''"
    } else {
        ""
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, {same_site} FROM moz_cookies{origin_filter}"
        ))
        .map_err(|_| ImportError::Database)?;
    let rows = statement
        .query_map([], |row| {
            Ok(ImportedCookie {
                host_key: row.get(0)?,
                name: row.get(1)?,
                value: row.get(2)?,
                path: row.get(3)?,
                expires_unix: firefox_expiry_to_unix(row.get(4)?),
                is_secure: row.get::<_, i64>(5)? != 0,
                is_httponly: row.get::<_, i64>(6)? != 0,
                same_site: same_site_from(row.get(7)?),
            })
        })
        .map_err(|_| ImportError::Database)?;
    let mut batch = CookieBatch::default();
    for cookie in rows.filter_map(Result::ok) {
        if filter.admits(&cookie.host_key) {
            batch.cookies.push(cookie);
        }
    }
    Ok(batch)
}

/// Cookie counts per stored host, values unread.
pub fn cookie_host_counts(database: &Path) -> Result<BTreeMap<String, u32>, ImportError> {
    let connection = open_immutable(database)?;
    let columns = table_columns(&connection, "moz_cookies")?;
    if columns.is_empty() {
        return Err(ImportError::Database);
    }
    let origin_filter = if columns.contains("originAttributes") {
        " WHERE COALESCE(originAttributes, '') = ''"
    } else {
        ""
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT host, COUNT(*) FROM moz_cookies{origin_filter} GROUP BY host"
        ))
        .map_err(|_| ImportError::Database)?;
    let counts = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })
        .map_err(|_| ImportError::Database)?
        .filter_map(Result::ok)
        .collect();
    Ok(counts)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    use rusqlite::Connection;

    pub fn write_cookie_db(profile: &Path, rows: &[(&str, &str, &str, i64, &str)]) {
        let conn = Connection::open(profile.join("cookies.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE moz_cookies(id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', \
             name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, \
             creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER);",
        )
        .unwrap();
        for (host, name, value, expiry, origin) in rows {
            conn.execute(
                "INSERT INTO moz_cookies(originAttributes,name,value,host,path,expiry,isSecure,isHttpOnly,sameSite) \
                 VALUES(?1,?2,?3,?4,'/',?5,1,0,2)",
                rusqlite::params![origin, name, value, host, expiry],
            )
            .unwrap();
        }
    }

    /// A Firefox root with `profiles.ini` naming one relative and one absolute
    /// profile; returns (root, relative profile dir, absolute profile dir).
    pub fn write_root(root: &Path, absolute: &Path) -> std::path::PathBuf {
        let relative = root.join("Profiles/abc.default-release");
        std::fs::create_dir_all(&relative).unwrap();
        std::fs::create_dir_all(absolute).unwrap();
        std::fs::write(
            root.join("profiles.ini"),
            format!(
                "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n\n[Profile1]\nName=work\nIsRelative=0\nPath={}\n\n[Install4F96D1932A9F858E]\nDefault=Profiles/abc.default-release\n",
                absolute.display()
            ),
        )
        .unwrap();
        relative
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::scope::CookieScope;

    #[test]
    fn parses_profile_sections_only() {
        let profiles = parse_profiles_ini(
            "; comment\n[General]\nVersion=2\n[Profile0]\nName=a\nIsRelative=1\nPath=Profiles/a\n[Profile1]\nPath=/abs/b\nIsRelative=0\n[Profile2]\nName=empty\nPath=\n[Install1]\nDefault=x\n",
        );
        assert_eq!(
            profiles,
            vec![
                IniProfile {
                    name: "a".into(),
                    path: "Profiles/a".into(),
                    is_relative: true
                },
                IniProfile {
                    name: "/abs/b".into(),
                    path: "/abs/b".into(),
                    is_relative: false
                },
            ]
        );
    }

    #[test]
    fn roots_cover_each_os_and_linux_packagings() {
        let home = tempfile::tempdir().unwrap();
        let mac = firefox_roots(Os::MacOs, &HostDirs::from_home(home.path(), Os::MacOs));
        assert_eq!(
            mac,
            [home.path().join("Library/Application Support/Firefox")]
        );
        let win = firefox_roots(Os::Windows, &HostDirs::from_home(home.path(), Os::Windows));
        assert_eq!(win, [home.path().join("AppData/Roaming/Mozilla/Firefox")]);
        let linux = firefox_roots(Os::Linux, &HostDirs::from_home(home.path(), Os::Linux));
        assert_eq!(linux.len(), 3);
        assert!(firefox_roots(Os::Other, &HostDirs::default()).is_empty());
    }

    #[test]
    fn lists_and_resolves_profiles_with_data() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::Linux);
        let root = home.path().join(".mozilla/firefox");
        let absolute = home.path().join("elsewhere/work");
        let relative = write_root(&root, &absolute);
        write_cookie_db(&relative, &[]);
        write_cookie_db(&absolute, &[]);
        std::fs::write(absolute.join("logins.json"), "{}").unwrap();
        std::fs::write(absolute.join("key4.db"), []).unwrap();

        let cookies = firefox_profiles(Os::Linux, &dirs, ProfileData::Cookies);
        assert_eq!(
            cookies
                .iter()
                .map(|profile| profile.name.as_str())
                .collect::<Vec<_>>(),
            ["default-release", "work"]
        );
        let passwords = firefox_profiles(Os::Linux, &dirs, ProfileData::Passwords);
        assert_eq!(passwords.len(), 1);
        assert_eq!(passwords[0].name, "work");

        assert_eq!(
            resolve_firefox_profile(
                Os::Linux,
                &dirs,
                "Profiles/abc.default-release",
                ProfileData::Cookies
            ),
            Some(relative)
        );
        assert_eq!(
            resolve_firefox_profile(
                Os::Linux,
                &dirs,
                "Profiles/abc.default-release",
                ProfileData::Passwords
            ),
            None
        );
        assert_eq!(
            resolve_firefox_profile(Os::Linux, &dirs, "../../etc", ProfileData::Cookies),
            None
        );
    }

    #[test]
    fn reads_plaintext_cookies_of_the_default_context() {
        let dir = tempfile::tempdir().unwrap();
        write_cookie_db(
            dir.path(),
            &[
                (".github.com", "session", "value-1", 1_700_000_000, ""),
                ("github.com", "ms", "value-2", 1_700_000_000_000, ""),
                (".github.com", "container", "c", 0, "^userContextId=1"),
                (".other.com", "other", "o", 0, ""),
            ],
        );
        let filter = ScopeFilter::new(&CookieScope::Domains {
            domains: vec!["github.com".into()],
        })
        .unwrap();
        let batch = read_cookie_database(&dir.path().join("cookies.sqlite"), &filter).unwrap();
        assert_eq!(batch.cookies.len(), 2);
        assert_eq!(batch.cookies[0].value, "value-1");
        assert_eq!(batch.cookies[0].expires_unix, Some(1_700_000_000));
        assert_eq!(batch.cookies[1].expires_unix, Some(1_700_000_000));
        assert_eq!(batch.cookies[0].same_site, SameSite::Strict);
        assert!(batch.cookies[0].is_secure);
        assert!(!batch.cookies[0].is_httponly);

        let counts = cookie_host_counts(&dir.path().join("cookies.sqlite")).unwrap();
        assert_eq!(counts.get(".github.com"), Some(&1));
        assert_eq!(counts.values().sum::<u32>(), 3);
    }

    #[test]
    fn expiry_units_and_sessions() {
        assert_eq!(firefox_expiry_to_unix(0), None);
        assert_eq!(firefox_expiry_to_unix(10), Some(10));
        assert_eq!(
            firefox_expiry_to_unix(1_700_000_000_123),
            Some(1_700_000_000)
        );
    }
}
