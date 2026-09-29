//! Safari's `Cookies.binarycookies` (macOS only). The file lives in Safari's
//! sandbox container, which macOS only lets an app open with Full Disk
//! Access; a refused open is the typed
//! [`ImportError::FullDiskAccessRequired`].
//!
//! Layout: `cook`, a big-endian page count and page sizes, then pages. Each
//! page starts with `00 00 01 00`, a little-endian cookie count and cookie
//! offsets. Each cookie record is little-endian: size, version, flags
//! (`1` Secure, `4` HttpOnly), port flag, offsets of domain / name / path /
//! value (NUL-terminated, relative to the record), two comment offsets, then
//! expiry and creation as `f64` seconds since 2001-01-01.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;

use crate::browsers::{HostDirs, Os};
use crate::import::CookieBatch;
use crate::scope::ScopeFilter;
use crate::{ImportError, ImportedCookie, SameSite};

/// Seconds between the Unix epoch and the Mac absolute-time epoch.
const MAC_EPOCH_OFFSET: f64 = 978_307_200.0;
const FLAG_SECURE: u32 = 0x1;
const FLAG_HTTP_ONLY: u32 = 0x4;
/// Upper bound on a store we are willing to parse (Safari's is a few MB).
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// The profile id Safari's single cookie store is listed under.
pub const SAFARI_PROFILE_ID: &str = "default";

fn candidates(dirs: &HostDirs) -> Vec<PathBuf> {
    dirs.home
        .iter()
        .flat_map(|home| {
            [
                home.join("Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"),
                home.join("Library/Cookies/Cookies.binarycookies"),
            ]
        })
        .collect()
}

fn is_permission_error(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(1 | 13))
}

/// Locate and open Safari's cookie store. The sandboxed container copy is
/// authoritative: when macOS refuses it, the (stale) legacy copy is not used.
fn open_store(os: Os, dirs: &HostDirs) -> Result<(PathBuf, std::fs::File), ImportError> {
    if os != Os::MacOs {
        return Err(ImportError::UnsupportedOs);
    }
    for candidate in candidates(dirs) {
        match std::fs::File::open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if is_permission_error(&error) => {
                return Err(ImportError::FullDiskAccessRequired)
            }
            Err(_) => continue,
        }
    }
    Err(ImportError::NoProfile)
}

/// Whether Safari's store can be opened right now.
pub fn probe(os: Os, dirs: &HostDirs) -> Result<PathBuf, ImportError> {
    open_store(os, dirs).map(|(path, _)| path)
}

fn read_store(os: Os, dirs: &HostDirs) -> Result<Vec<u8>, ImportError> {
    let (_, file) = open_store(os, dirs)?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            if is_permission_error(&error) {
                ImportError::FullDiskAccessRequired
            } else {
                ImportError::Database
            }
        })?;
    Ok(bytes)
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le_f64(bytes: &[u8], at: usize) -> Option<f64> {
    Some(f64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

fn c_string(record: &[u8], offset: u32) -> Option<String> {
    let start = offset as usize;
    let rest = record.get(start..)?;
    let end = rest.iter().position(|byte| *byte == 0)?;
    String::from_utf8(rest[..end].to_vec()).ok()
}

fn parse_record(record: &[u8]) -> Option<ImportedCookie> {
    let flags = le_u32(record, 8)?;
    let domain = c_string(record, le_u32(record, 16)?)?;
    let name = c_string(record, le_u32(record, 20)?)?;
    let path = c_string(record, le_u32(record, 24)?)?;
    let value = c_string(record, le_u32(record, 28)?)?;
    let expiry = le_f64(record, 40)?;
    if domain.is_empty() || name.is_empty() {
        return None;
    }
    let expires_unix =
        (expiry.is_finite() && expiry > 0.0).then_some((expiry + MAC_EPOCH_OFFSET) as i64);
    Some(ImportedCookie {
        host_key: domain,
        name,
        value,
        path: if path.is_empty() { "/".into() } else { path },
        expires_unix,
        is_secure: flags & FLAG_SECURE != 0,
        is_httponly: flags & FLAG_HTTP_ONLY != 0,
        same_site: SameSite::Unspecified,
    })
}

fn parse_page(page: &[u8], cookies: &mut Vec<ImportedCookie>) -> Option<()> {
    if page.get(0..4)? != [0x00, 0x00, 0x01, 0x00] {
        return None;
    }
    let count = le_u32(page, 4)? as usize;
    for index in 0..count {
        let offset = le_u32(page, 8 + index * 4)? as usize;
        let Some(size) = le_u32(page, offset) else {
            continue;
        };
        let Some(record) = page.get(offset..offset.saturating_add(size as usize)) else {
            continue;
        };
        if let Some(cookie) = parse_record(record) {
            cookies.push(cookie);
        }
    }
    Some(())
}

/// Every well-formed cookie in a `Cookies.binarycookies` file. Malformed pages
/// or records are skipped individually; a wrong magic is an error.
pub fn parse_binary_cookies(bytes: &[u8]) -> Result<Vec<ImportedCookie>, ImportError> {
    if bytes.get(0..4) != Some(b"cook".as_slice()) {
        return Err(ImportError::InvalidFormat);
    }
    let pages = be_u32(bytes, 4).ok_or(ImportError::InvalidFormat)? as usize;
    let mut sizes = Vec::with_capacity(pages.min(4096));
    for index in 0..pages {
        sizes.push(be_u32(bytes, 8 + index * 4).ok_or(ImportError::InvalidFormat)? as usize);
    }
    let mut cursor = 8 + pages * 4;
    let mut cookies = Vec::new();
    for size in sizes {
        let Some(page) = bytes.get(cursor..cursor.saturating_add(size)) else {
            break;
        };
        let _ = parse_page(page, &mut cookies);
        cursor += size;
    }
    Ok(cookies)
}

pub fn read_cookies(
    os: Os,
    dirs: &HostDirs,
    filter: &ScopeFilter,
) -> Result<CookieBatch, ImportError> {
    let bytes = read_store(os, dirs)?;
    Ok(CookieBatch {
        cookies: parse_binary_cookies(&bytes)?
            .into_iter()
            .filter(|cookie| filter.admits(&cookie.host_key))
            .collect(),
        skipped_app_bound: 0,
    })
}

pub fn cookie_host_counts(os: Os, dirs: &HostDirs) -> Result<BTreeMap<String, u32>, ImportError> {
    let bytes = read_store(os, dirs)?;
    let mut counts = BTreeMap::new();
    for cookie in parse_binary_cookies(&bytes)? {
        *counts.entry(cookie.host_key.clone()).or_insert(0) += 1;
    }
    Ok(counts)
}

/// Path of the store for display/diagnostics.
pub fn store_path(dirs: &HostDirs) -> Option<PathBuf> {
    candidates(dirs).into_iter().next()
}

#[cfg(test)]
pub(crate) mod test_support {
    pub struct FixtureCookie<'a> {
        pub domain: &'a str,
        pub name: &'a str,
        pub path: &'a str,
        pub value: &'a str,
        pub flags: u32,
        pub expiry_mac: f64,
    }

    fn record(cookie: &FixtureCookie<'_>) -> Vec<u8> {
        let header = 56_u32;
        let mut strings = Vec::new();
        let mut offsets = Vec::new();
        for text in [cookie.domain, cookie.name, cookie.path, cookie.value] {
            offsets.push(header + strings.len() as u32);
            strings.extend_from_slice(text.as_bytes());
            strings.push(0);
        }
        let size = header + strings.len() as u32;
        let mut out = Vec::new();
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&0_u32.to_le_bytes());
        out.extend_from_slice(&cookie.flags.to_le_bytes());
        out.extend_from_slice(&0_u32.to_le_bytes());
        for offset in offsets {
            out.extend_from_slice(&offset.to_le_bytes());
        }
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&cookie.expiry_mac.to_le_bytes());
        out.extend_from_slice(&0_f64.to_le_bytes());
        out.extend_from_slice(&strings);
        out
    }

    pub fn page(cookies: &[FixtureCookie<'_>]) -> Vec<u8> {
        let records = cookies.iter().map(record).collect::<Vec<_>>();
        let mut out = vec![0x00, 0x00, 0x01, 0x00];
        out.extend_from_slice(&(records.len() as u32).to_le_bytes());
        let mut offset = 8 + records.len() as u32 * 4 + 4;
        for record in &records {
            out.extend_from_slice(&offset.to_le_bytes());
            offset += record.len() as u32;
        }
        out.extend_from_slice(&[0; 4]);
        for record in records {
            out.extend_from_slice(&record);
        }
        out
    }

    pub fn file(pages: &[Vec<u8>]) -> Vec<u8> {
        let mut out = b"cook".to_vec();
        out.extend_from_slice(&(pages.len() as u32).to_be_bytes());
        for page in pages {
            out.extend_from_slice(&(page.len() as u32).to_be_bytes());
        }
        for page in pages {
            out.extend_from_slice(page);
        }
        out.extend_from_slice(&[0; 8]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::scope::CookieScope;

    fn fixture() -> Vec<u8> {
        file(&[
            page(&[
                FixtureCookie {
                    domain: ".github.com",
                    name: "session",
                    path: "/",
                    value: "abc",
                    flags: 5,
                    expiry_mac: 1_000.0,
                },
                FixtureCookie {
                    domain: "www.apple.com",
                    name: "pref",
                    path: "",
                    value: "x",
                    flags: 0,
                    expiry_mac: 0.0,
                },
            ]),
            page(&[FixtureCookie {
                domain: "api.github.com",
                name: "t",
                path: "/v1",
                value: "tok",
                flags: 1,
                expiry_mac: 2_000.5,
            }]),
        ])
    }

    #[test]
    fn parses_pages_records_flags_and_expiry() {
        let cookies = parse_binary_cookies(&fixture()).unwrap();
        assert_eq!(cookies.len(), 3);
        assert_eq!(cookies[0].host_key, ".github.com");
        assert_eq!(cookies[0].value, "abc");
        assert!(cookies[0].is_secure && cookies[0].is_httponly);
        assert_eq!(cookies[0].expires_unix, Some(978_308_200));
        assert_eq!(cookies[1].path, "/");
        assert_eq!(cookies[1].expires_unix, None);
        assert!(!cookies[1].is_secure);
        assert_eq!(cookies[2].path, "/v1");
        assert!(cookies[2].is_secure && !cookies[2].is_httponly);
    }

    #[test]
    fn rejects_a_wrong_magic_and_survives_truncation() {
        assert_eq!(
            parse_binary_cookies(b"nope"),
            Err(ImportError::InvalidFormat)
        );
        assert_eq!(
            parse_binary_cookies(b"cook"),
            Err(ImportError::InvalidFormat)
        );
        let full = fixture();
        let truncated = &full[..full.len() - 40];
        assert!(parse_binary_cookies(truncated).unwrap().len() < 3);
        let mut bad_page = fixture();
        bad_page[8 + 8] = 0xff;
        assert!(parse_binary_cookies(&bad_page).is_ok());
    }

    #[test]
    fn reads_the_container_store_through_a_scope() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::MacOs);
        assert_eq!(probe(Os::MacOs, &dirs), Err(ImportError::NoProfile));
        assert_eq!(probe(Os::Windows, &dirs), Err(ImportError::UnsupportedOs));
        let store = home
            .path()
            .join("Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies");
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        std::fs::write(&store, fixture()).unwrap();
        assert_eq!(probe(Os::MacOs, &dirs), Ok(store.clone()));
        assert_eq!(store_path(&dirs), Some(store));

        let filter = ScopeFilter::new(&CookieScope::Domains {
            domains: vec!["github.com".into()],
        })
        .unwrap();
        let batch = read_cookies(Os::MacOs, &dirs, &filter).unwrap();
        assert_eq!(batch.cookies.len(), 2);
        let counts = cookie_host_counts(Os::MacOs, &dirs).unwrap();
        assert_eq!(counts.len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_container_store_requires_full_disk_access() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::MacOs);
        let store = home
            .path()
            .join("Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies");
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        std::fs::write(&store, fixture()).unwrap();
        // Also a readable legacy copy, which must not be used instead.
        let legacy = home.path().join("Library/Cookies/Cookies.binarycookies");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, fixture()).unwrap();
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&store).is_ok() {
            // Running as root: permissions are not enforced.
            return;
        }
        assert_eq!(
            probe(Os::MacOs, &dirs),
            Err(ImportError::FullDiskAccessRequired)
        );
        assert_eq!(
            read_cookies(Os::MacOs, &dirs, &ScopeFilter::All).map(|batch| batch.cookies.len()),
            Err(ImportError::FullDiskAccessRequired)
        );
    }

    #[test]
    fn permission_errors_include_eperm() {
        assert!(is_permission_error(&std::io::Error::from_raw_os_error(1)));
        assert!(is_permission_error(&std::io::Error::from(
            std::io::ErrorKind::PermissionDenied
        )));
        assert!(!is_permission_error(&std::io::Error::from(
            std::io::ErrorKind::NotFound
        )));
    }
}
