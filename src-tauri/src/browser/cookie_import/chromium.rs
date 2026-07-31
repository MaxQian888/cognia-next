use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
use pbkdf2::pbkdf2_hmac;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use super::{CookieSink, ImportError, ImportedCookie, Keychain, SameSite};

pub(super) struct ImportSummary {
    pub(super) injected: usize,
    pub(super) names: Vec<String>,
    pub(super) domains: Vec<String>,
}

pub(super) fn find_cookie_database(profile_dir: &Path) -> Option<PathBuf> {
    [
        profile_dir.join("Network/Cookies"),
        profile_dir.join("Cookies"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn copy_cookie_database(source: &Path, destination_dir: &Path) -> Result<PathBuf, ImportError> {
    let destination = destination_dir.join("Cookies");
    std::fs::copy(source, &destination).map_err(|_| ImportError::Database)?;
    for suffix in ["-wal", "-shm"] {
        let companion = PathBuf::from(format!("{}{suffix}", source.display()));
        if companion.is_file() {
            let copied = PathBuf::from(format!("{}{suffix}", destination.display()));
            std::fs::copy(companion, copied).map_err(|_| ImportError::Database)?;
        }
    }
    Ok(destination)
}

pub(super) fn import_profile(
    profile_dir: &Path,
    target: &str,
    service: &str,
    account: &str,
    keychain: &dyn Keychain,
    sink: &dyn CookieSink,
) -> Result<ImportSummary, ImportError> {
    registrable_domain(target)?;
    let source = find_cookie_database(profile_dir).ok_or(ImportError::Database)?;
    let temp = tempfile::tempdir().map_err(|_| ImportError::Database)?;
    let database = copy_cookie_database(&source, temp.path())?;
    let passphrase = keychain.read(service, account)?;
    if passphrase.is_empty() {
        return Ok(ImportSummary {
            injected: 0,
            names: Vec::new(),
            domains: Vec::new(),
        });
    }
    let cookies = read_cookies(&database, target, &passphrase)?;
    if cookies.is_empty() {
        return Ok(ImportSummary {
            injected: 0,
            names: Vec::new(),
            domains: Vec::new(),
        });
    }
    let injected_cookies = sink.inject(&cookies)?;
    let names = injected_cookies
        .iter()
        .map(|cookie| cookie.name.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let domains = injected_cookies
        .iter()
        .map(|cookie| cookie.host_key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(ImportSummary {
        injected: injected_cookies.len(),
        names,
        domains,
    })
}

fn derive_key(passphrase: &str) -> [u8; 16] {
    let mut key = [0_u8; 16];
    pbkdf2_hmac::<Sha1>(passphrase.as_bytes(), b"saltysalt", 1003, &mut key);
    key
}

fn decrypt_cookie_value(
    key: &[u8; 16],
    host_key: &str,
    encrypted_value: &[u8],
    db_version: i64,
) -> Result<String, ImportError> {
    let ciphertext = encrypted_value
        .strip_prefix(b"v10")
        .ok_or(ImportError::Decryption)?;
    let mut plaintext = cbc::Decryptor::<Aes128>::new(&(*key).into(), &[0x20_u8; 16].into())
        .decrypt_padded_vec::<Pkcs7>(ciphertext)
        .map_err(|_| ImportError::Decryption)?;

    if db_version >= 24 {
        let expected = Sha256::digest(host_key.as_bytes());
        if plaintext.len() < expected.len() || plaintext[..expected.len()] != expected[..] {
            return Err(ImportError::Decryption);
        }
        plaintext.drain(..expected.len());
    }

    String::from_utf8(plaintext).map_err(|_| ImportError::Decryption)
}

fn chrome_expires_to_unix(expires_utc: i64) -> Option<i64> {
    (expires_utc != 0).then(|| expires_utc / 1_000_000 - 11_644_473_600)
}

pub(super) fn registrable_domain(target: &str) -> Result<String, ImportError> {
    let normalized = target.trim().trim_start_matches('.').to_ascii_lowercase();
    let domain = match url::Host::parse(&normalized).map_err(|_| ImportError::InvalidDomain)? {
        url::Host::Domain(domain) => domain,
        _ => return Err(ImportError::InvalidDomain),
    };
    psl::domain_str(&domain)
        .map(str::to_owned)
        .ok_or(ImportError::InvalidDomain)
}

fn domain_matches(host_key: &str, target_host: &str) -> bool {
    let cookie_domain = host_key.trim_start_matches('.').to_ascii_lowercase();
    let target_host = target_host.trim_start_matches('.').to_ascii_lowercase();
    if !host_key.starts_with('.') {
        return target_host == cookie_domain;
    }
    target_host == cookie_domain
        || target_host
            .strip_suffix(&cookie_domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn immutable_database_uri(database: &Path) -> Result<String, ImportError> {
    let mut uri = url::Url::from_file_path(database).map_err(|_| ImportError::Database)?;
    uri.set_query(Some("mode=ro&immutable=1"));
    Ok(uri.to_string())
}

fn read_cookies(
    database: &Path,
    target: &str,
    passphrase: &str,
) -> Result<Vec<ImportedCookie>, ImportError> {
    let domain = registrable_domain(target)?;
    let target_host = target.trim().trim_start_matches('.').to_ascii_lowercase();
    let database_uri = immutable_database_uri(database)?;
    let connection = Connection::open_with_flags(
        database_uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|_| ImportError::Database)?;
    let db_version = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'version'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| ImportError::Database)?
        .unwrap_or(0);
    let key = derive_key(passphrase);
    let exact_dot = format!(".{domain}");
    let suffix = format!("%.{domain}");
    let has_partition_key = connection
        .prepare("PRAGMA table_info(cookies)")
        .and_then(|mut statement| {
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            for column in columns {
                if column.as_deref() == Ok("top_frame_site_key") {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .map_err(|_| ImportError::Database)?;
    let partition_filter = if has_partition_key {
        " AND COALESCE(top_frame_site_key, '') = ''"
    } else {
        ""
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT host_key,name,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite \
             FROM cookies WHERE (host_key = ?1 OR host_key = ?2 OR host_key LIKE ?3){partition_filter}"
        ))
        .map_err(|_| ImportError::Database)?;
    let rows = statement
        .query_map(rusqlite::params![domain, exact_dot, suffix], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|_| ImportError::Database)?;

    let mut cookies = Vec::new();
    for row in rows {
        let Ok((host_key, name, encrypted_value, path, expires_utc, secure, httponly, same_site)) =
            row
        else {
            continue;
        };
        if !domain_matches(&host_key, &target_host) {
            continue;
        }
        let Ok(value) = decrypt_cookie_value(&key, &host_key, &encrypted_value, db_version) else {
            continue;
        };
        cookies.push(ImportedCookie {
            host_key,
            name,
            value,
            path,
            expires_unix: chrome_expires_to_unix(expires_utc),
            is_secure: secure != 0,
            is_httponly: httponly != 0,
            same_site: match same_site {
                0 => SameSite::None,
                1 => SameSite::Lax,
                2 => SameSite::Strict,
                _ => SameSite::Unspecified,
            },
        });
    }
    Ok(cookies)
}

#[cfg(test)]
fn import_with(
    database: &Path,
    target: &str,
    service: &str,
    account: &str,
    keychain: &dyn Keychain,
    sink: &dyn CookieSink,
) -> Result<usize, ImportError> {
    let passphrase = keychain.read(service, account)?;
    let cookies = read_cookies(database, target, &passphrase)?;
    sink.inject(&cookies).map(|injected| injected.len())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use aes::Aes128;
    use cbc::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    use super::*;
    use crate::browser::cookie_import::SameSite;

    fn encrypt_v10(passphrase: &str, host_key: &str, value: &str, prefixed: bool) -> Vec<u8> {
        let key = derive_key(passphrase);
        let mut plaintext = Vec::new();
        if prefixed {
            plaintext.extend_from_slice(&Sha256::digest(host_key.as_bytes()));
        }
        plaintext.extend_from_slice(value.as_bytes());
        let ciphertext = cbc::Encryptor::<Aes128>::new(&key.into(), &[0x20; 16].into())
            .encrypt_padded_vec::<Pkcs7>(&plaintext);
        [b"v10".as_slice(), ciphertext.as_slice()].concat()
    }

    #[test]
    fn derives_the_documented_macos_key() {
        assert_eq!(
            hex::encode(derive_key("test-passphrase")),
            "1520ca2d2c5dceeeebcd3a50818a46c7"
        );
    }

    #[test]
    fn decrypts_v10_values_before_and_after_database_v24() {
        let key = derive_key("pass");
        let legacy = encrypt_v10("pass", ".example.com", "legacy", false);
        let current = encrypt_v10("pass", ".example.com", "current", true);

        assert_eq!(
            decrypt_cookie_value(&key, ".example.com", &legacy, 23).unwrap(),
            "legacy"
        );
        assert_eq!(
            decrypt_cookie_value(&key, ".example.com", &current, 24).unwrap(),
            "current"
        );
    }

    #[test]
    fn rejects_non_v10_and_wrong_host_prefixes() {
        let key = derive_key("pass");
        assert!(decrypt_cookie_value(&key, ".example.com", b"plain", 23).is_err());
        let encrypted = encrypt_v10("pass", ".other.com", "value", true);
        assert!(decrypt_cookie_value(&key, ".example.com", &encrypted, 24).is_err());
    }

    #[test]
    fn converts_chromium_expirations_and_sessions() {
        assert_eq!(chrome_expires_to_unix(0), None);
        assert_eq!(chrome_expires_to_unix(11_644_473_600_000_000), Some(0));
        assert_eq!(chrome_expires_to_unix(11_644_473_601_500_000), Some(1));
    }

    #[test]
    fn normalizes_to_the_registrable_domain() {
        assert_eq!(registrable_domain("www.github.com").unwrap(), "github.com");
        assert_eq!(
            registrable_domain("sub.example.co.uk").unwrap(),
            "example.co.uk"
        );
        assert!(registrable_domain("bad domain").is_err());
    }

    #[test]
    fn matches_only_the_target_domain_boundary() {
        for host in [".github.com", "www.github.com"] {
            assert!(
                domain_matches(host, "www.github.com"),
                "expected match: {host}"
            );
        }
        for host in [
            "github.com",
            ".api.github.com",
            "evilgithub.com",
            ".notgithub.com",
            "github.com.evil.test",
        ] {
            assert!(
                !domain_matches(host, "www.github.com"),
                "unexpected match: {host}"
            );
        }
        assert!(domain_matches("github.com", "github.com"));
    }

    #[test]
    fn builds_an_encoded_immutable_read_only_database_uri() {
        let uri = immutable_database_uri(Path::new("/tmp/Profile 1/Cookies")).unwrap();
        assert_eq!(uri, "file:///tmp/Profile%201/Cookies?mode=ro&immutable=1");
    }

    #[test]
    fn reads_matching_rows_and_skips_malformed_ciphertext() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER);\
             INSERT INTO meta(key,value) VALUES('version',24);\
             CREATE TABLE cookies(\
               host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,\
               is_secure INTEGER, is_httponly INTEGER, samesite INTEGER\
             );",
        )
        .unwrap();
        let good = encrypt_v10("pass", ".github.com", "secret", true);
        conn.execute(
            "INSERT INTO cookies VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                ".github.com",
                "session",
                good,
                "/",
                11_644_473_601_000_000_i64,
                1,
                1,
                2
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cookies VALUES('.github.com','broken',x'00','/',0,0,0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cookies VALUES('.example.com','other',x'00','/',0,0,0,0)",
            [],
        )
        .unwrap();
        drop(conn);

        let cookies = read_cookies(&db, "www.github.com", "pass").unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name, "session");
        assert_eq!(cookies[0].value, "secret");
        assert_eq!(cookies[0].expires_unix, Some(1));
        assert_eq!(cookies[0].same_site, SameSite::Strict);
    }

    #[test]
    fn skips_partitioned_cookies_in_modern_schemas() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER);\
             INSERT INTO meta(key,value) VALUES('version',24);\
             CREATE TABLE cookies(\
               host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,\
               is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT\
             );",
        )
        .unwrap();
        for (name, partition) in [("regular", ""), ("partitioned", "https://top.example")] {
            let encrypted = encrypt_v10("pass", ".github.com", name, true);
            conn.execute(
                "INSERT INTO cookies VALUES('.github.com',?1,?2,'/',0,1,1,1,?3)",
                rusqlite::params![name, encrypted, partition],
            )
            .unwrap();
        }
        drop(conn);

        let cookies = read_cookies(&db, "www.github.com", "pass").unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name, "regular");
    }

    struct FakeKeychain(Result<String, ImportError>);

    impl Keychain for FakeKeychain {
        fn read(&self, _service: &str, _account: &str) -> Result<String, ImportError> {
            self.0
                .as_ref()
                .map(Clone::clone)
                .map_err(|_| ImportError::PermissionDenied)
        }
    }

    #[derive(Default)]
    struct FakeSink(Mutex<Vec<String>>);

    impl CookieSink for FakeSink {
        fn inject(&self, cookies: &[ImportedCookie]) -> Result<Vec<ImportedCookie>, ImportError> {
            self.0
                .lock()
                .unwrap()
                .extend(cookies.iter().map(|cookie| cookie.name.clone()));
            Ok(cookies.to_vec())
        }
    }

    fn create_profile_with_cookie(passphrase: &str) -> tempfile::TempDir {
        let profile = tempdir().unwrap();
        let network = profile.path().join("Network");
        std::fs::create_dir(&network).unwrap();
        let database = network.join("Cookies");
        let connection = Connection::open(database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER);\
                 INSERT INTO meta(key,value) VALUES('version',24);\
                 CREATE TABLE cookies(\
                   host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,\
                   is_secure INTEGER, is_httponly INTEGER, samesite INTEGER\
                 );",
            )
            .unwrap();
        let encrypted = encrypt_v10(passphrase, ".github.com", "secret", true);
        for name in ["z-session", "a-session", "a-session"] {
            connection
                .execute(
                    "INSERT INTO cookies VALUES(?1,?2,?3,'/',0,1,1,1)",
                    rusqlite::params![".github.com", name, encrypted],
                )
                .unwrap();
        }
        drop(connection);
        profile
    }

    #[test]
    fn orchestration_stops_on_permission_denial() {
        let sink = FakeSink::default();
        let result = import_with(
            Path::new("missing"),
            "example.com",
            "service",
            "account",
            &FakeKeychain(Err(ImportError::PermissionDenied)),
            &sink,
        );
        assert!(matches!(result, Err(ImportError::PermissionDenied)));
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn profile_import_injects_and_deduplicates_public_metadata() {
        let profile = create_profile_with_cookie("pass");
        let sink = FakeSink::default();

        let summary = import_profile(
            profile.path(),
            "www.github.com",
            "service",
            "account",
            &FakeKeychain(Ok("pass".into())),
            &sink,
        )
        .unwrap();

        assert_eq!(summary.injected, 3);
        assert_eq!(summary.names, ["a-session", "z-session"]);
        assert_eq!(summary.domains, [".github.com"]);
        assert_eq!(sink.0.lock().unwrap().len(), 3);
    }

    #[test]
    fn empty_safe_storage_passphrase_skips_the_profile() {
        let profile = create_profile_with_cookie("pass");
        let sink = FakeSink::default();

        let summary = import_profile(
            profile.path(),
            "github.com",
            "service",
            "account",
            &FakeKeychain(Ok(String::new())),
            &sink,
        )
        .unwrap();

        assert_eq!(summary.injected, 0);
        assert!(summary.names.is_empty());
        assert!(summary.domains.is_empty());
        assert!(sink.0.lock().unwrap().is_empty());
    }

    struct FailingSink;

    impl CookieSink for FailingSink {
        fn inject(&self, _cookies: &[ImportedCookie]) -> Result<Vec<ImportedCookie>, ImportError> {
            Err(ImportError::Injection)
        }
    }

    #[test]
    fn profile_import_propagates_sink_failures() {
        let profile = create_profile_with_cookie("pass");
        assert!(matches!(
            import_profile(
                profile.path(),
                "github.com",
                "service",
                "account",
                &FakeKeychain(Ok("pass".into())),
                &FailingSink,
            ),
            Err(ImportError::Injection)
        ));
    }

    #[test]
    fn locates_network_and_legacy_cookie_databases() {
        let dir = tempdir().unwrap();
        let profile = dir.path().join("Default");
        std::fs::create_dir_all(profile.join("Network")).unwrap();
        std::fs::write(profile.join("Cookies"), []).unwrap();
        assert_eq!(
            find_cookie_database(&profile),
            Some(profile.join("Cookies"))
        );
        std::fs::write(profile.join("Network/Cookies"), []).unwrap();
        assert_eq!(
            find_cookie_database(&profile),
            Some(profile.join("Network/Cookies"))
        );
    }

    #[test]
    fn copies_wal_and_shm_companions() {
        let source_dir = tempdir().unwrap();
        let destination_dir = tempdir().unwrap();
        let source = source_dir.path().join("Cookies");
        std::fs::write(&source, b"db").unwrap();
        std::fs::write(format!("{}-wal", source.display()), b"wal").unwrap();
        std::fs::write(format!("{}-shm", source.display()), b"shm").unwrap();

        let copied = copy_cookie_database(&source, destination_dir.path()).unwrap();
        assert_eq!(std::fs::read(&copied).unwrap(), b"db");
        assert_eq!(
            std::fs::read(format!("{}-wal", copied.display())).unwrap(),
            b"wal"
        );
        assert_eq!(
            std::fs::read(format!("{}-shm", copied.display())).unwrap(),
            b"shm"
        );
    }
}
