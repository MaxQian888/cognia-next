//! The Rust-only password vault (ADR-0201).
//!
//! Every password is one `cognia-secrets` secret-store entry
//! ([`PASSWORD_SERVICE`] / credential id); its metadata (origin, realm,
//! username, source, timestamps, note) is a second entry
//! ([`METADATA_SERVICE`] / credential id, JSON). Origins the user chose
//! "never save" for are entries under [`NEVER_SAVE_SERVICE`]. The secret store
//! is AES-256-GCM encrypted at rest under the OS-keyring master key, so no
//! password is ever written to disk in plaintext, and nothing here logs a
//! value.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{normalize_origin, ImportedCredential};
use crate::scope::site_of_host;
use crate::secret::SecretString;
use crate::ImportError;

pub const PASSWORD_SERVICE: &str = "cognia.browser.passwords";
pub const METADATA_SERVICE: &str = "cognia.browser.passwords.meta";
pub const NEVER_SAVE_SERVICE: &str = "cognia.browser.passwords.never";

/// Where vault entries are kept. Production uses [`SecretStoreBackend`].
pub trait VaultBackend: Send + Sync {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, ImportError>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), ImportError>;
    fn delete(&self, service: &str, account: &str) -> Result<(), ImportError>;
    fn list_accounts(&self, service: &str) -> Result<Vec<String>, ImportError>;
}

/// The `cognia-secrets` encrypted store.
pub struct SecretStoreBackend;

fn store_error(operation: &str, error: String) -> ImportError {
    // The store's messages name the failure (locked, unavailable), never a
    // value.
    log::warn!("browser password vault {operation} failed: {error}");
    ImportError::SecretStore
}

impl VaultBackend for SecretStoreBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, ImportError> {
        cognia_secrets::secret_store::get(service, account)
            .map_err(|error| store_error("read", error))
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), ImportError> {
        cognia_secrets::secret_store::set(service, account, value)
            .map_err(|error| store_error("write", error))
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), ImportError> {
        cognia_secrets::secret_store::delete(service, account)
            .map_err(|error| store_error("delete", error))
    }

    fn list_accounts(&self, service: &str) -> Result<Vec<String>, ImportError> {
        cognia_secrets::secret_store::list_accounts(service)
            .map_err(|error| store_error("list", error))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMeta {
    pub id: String,
    pub origin: String,
    pub realm: Option<String>,
    pub username: String,
    /// `manual`, `saved` (from a page submit), `chrome`, `firefox`, `csv:<format>`, …
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub note: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NewCredential {
    pub origin: String,
    pub realm: Option<String>,
    pub username: String,
    pub password: SecretString,
    pub source: String,
    pub note: Option<String>,
    pub created_at: Option<i64>,
    pub last_used_at: Option<i64>,
}

impl NewCredential {
    pub fn from_imported(credential: ImportedCredential, source: &str) -> Self {
        Self {
            origin: credential.origin,
            realm: credential.realm,
            username: credential.username,
            password: credential.password,
            source: source.to_owned(),
            note: credential.note,
            created_at: credential.created_at,
            last_used_at: credential.last_used_at,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct CredentialPatch {
    pub username: Option<String>,
    pub password: Option<SecretString>,
    /// `Some("")` clears the note.
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveOutcome {
    Created(CredentialMeta),
    Updated(CredentialMeta),
    Unchanged(CredentialMeta),
}

impl SaveOutcome {
    pub fn meta(&self) -> &CredentialMeta {
        match self {
            Self::Created(meta) | Self::Updated(meta) | Self::Unchanged(meta) => meta,
        }
    }

    pub fn into_meta(self) -> CredentialMeta {
        match self {
            Self::Created(meta) | Self::Updated(meta) | Self::Unchanged(meta) => meta,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ImportTally {
    pub imported: usize,
    pub updated: usize,
    pub skipped: usize,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn clean_note(note: Option<String>) -> Option<String> {
    note.map(|note| note.trim().to_owned())
        .filter(|note| !note.is_empty())
}

/// Whether a credential saved for `credential_origin` may be offered on
/// `page_url`: the same site (registrable domain; the exact host and port for
/// IP literals and single-label hosts like `localhost`), and never an https
/// credential on a plain-http page off loopback.
pub fn origin_matches_url(credential_origin: &str, page_url: &str) -> bool {
    let (Ok(credential), Ok(page)) = (
        url::Url::parse(credential_origin),
        url::Url::parse(page_url),
    ) else {
        return false;
    };
    let (Some(credential_host), Some(page_host)) = (credential.host_str(), page.host_str()) else {
        return false;
    };
    if !matches!(page.scheme(), "http" | "https") {
        return false;
    }
    let credential_site = site_of_host(credential_host);
    if credential_site != site_of_host(page_host) {
        return false;
    }
    let registrable = crate::scope::registrable_domain(credential_host).is_ok();
    if !registrable && credential.port_or_known_default() != page.port_or_known_default() {
        return false;
    }
    let loopback = matches!(page_host, "localhost" | "127.0.0.1" | "[::1]")
        || page_host.ends_with(".localhost");
    !(credential.scheme() == "https" && page.scheme() == "http" && !loopback)
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

pub struct Vault<B: VaultBackend> {
    backend: B,
    write: Mutex<()>,
}

impl<B: VaultBackend> Vault<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            write: Mutex::new(()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.write
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_meta(&self, meta: &CredentialMeta) -> Result<(), ImportError> {
        let json = serde_json::to_string(meta).map_err(|_| ImportError::SecretStore)?;
        self.backend.set(METADATA_SERVICE, &meta.id, &json)
    }

    pub fn get(&self, id: &str) -> Result<Option<CredentialMeta>, ImportError> {
        if !valid_id(id) {
            return Ok(None);
        }
        let Some(json) = self.backend.get(METADATA_SERVICE, id)? else {
            return Ok(None);
        };
        Ok(serde_json::from_str(&json).ok())
    }

    fn require(&self, id: &str) -> Result<CredentialMeta, ImportError> {
        self.get(id)?.ok_or(ImportError::CredentialNotFound)
    }

    /// Every credential's metadata, by origin then username.
    pub fn list(&self) -> Result<Vec<CredentialMeta>, ImportError> {
        let mut all = Vec::new();
        for id in self.backend.list_accounts(METADATA_SERVICE)? {
            if let Some(meta) = self.get(&id)? {
                all.push(meta);
            }
        }
        all.sort_by(|a, b| {
            a.origin
                .cmp(&b.origin)
                .then_with(|| a.username.cmp(&b.username))
        });
        Ok(all)
    }

    fn find_exact(
        &self,
        origin: &str,
        realm: Option<&str>,
        username: &str,
    ) -> Result<Option<CredentialMeta>, ImportError> {
        Ok(self.list()?.into_iter().find(|meta| {
            meta.origin == origin && meta.realm.as_deref() == realm && meta.username == username
        }))
    }

    /// The saved password of `id`.
    pub fn password(&self, id: &str) -> Result<SecretString, ImportError> {
        self.require(id)?;
        self.backend
            .get(PASSWORD_SERVICE, id)?
            .map(SecretString::from)
            .ok_or(ImportError::CredentialNotFound)
    }

    /// Save a credential, updating the one with the same origin, realm and
    /// username if it exists.
    pub fn save(&self, credential: NewCredential, now: i64) -> Result<SaveOutcome, ImportError> {
        let origin = normalize_origin(&credential.origin).ok_or(ImportError::InvalidDomain)?;
        if credential.password.is_empty() {
            return Err(ImportError::InvalidFormat);
        }
        let realm = credential.realm.filter(|realm| !realm.trim().is_empty());
        let note = clean_note(credential.note);
        let _guard = self.lock();
        if let Some(mut existing) =
            self.find_exact(&origin, realm.as_deref(), &credential.username)?
        {
            let current = self
                .backend
                .get(PASSWORD_SERVICE, &existing.id)?
                .map(SecretString::from);
            let same_password = current.as_ref() == Some(&credential.password);
            let note_changes = note.is_some() && note != existing.note;
            if same_password && !note_changes {
                return Ok(SaveOutcome::Unchanged(existing));
            }
            if !same_password {
                self.backend
                    .set(PASSWORD_SERVICE, &existing.id, credential.password.expose())?;
            }
            if note_changes {
                existing.note = note;
            }
            existing.updated_at = now;
            self.write_meta(&existing)?;
            return Ok(SaveOutcome::Updated(existing));
        }
        let meta = CredentialMeta {
            id: new_id(),
            origin,
            realm,
            username: credential.username,
            source: credential.source,
            created_at: credential.created_at.unwrap_or(now),
            updated_at: now,
            last_used_at: credential.last_used_at,
            note,
        };
        self.backend
            .set(PASSWORD_SERVICE, &meta.id, credential.password.expose())?;
        if let Err(error) = self.write_meta(&meta) {
            let _ = self.backend.delete(PASSWORD_SERVICE, &meta.id);
            return Err(error);
        }
        Ok(SaveOutcome::Created(meta))
    }

    pub fn update(
        &self,
        id: &str,
        patch: CredentialPatch,
        now: i64,
    ) -> Result<CredentialMeta, ImportError> {
        let _guard = self.lock();
        let mut meta = self.require(id)?;
        if let Some(username) = patch.username {
            if username != meta.username {
                if self
                    .find_exact(&meta.origin, meta.realm.as_deref(), &username)?
                    .is_some()
                {
                    return Err(ImportError::CredentialExists);
                }
                meta.username = username;
            }
        }
        if let Some(password) = patch.password {
            if password.is_empty() {
                return Err(ImportError::InvalidFormat);
            }
            self.backend.set(PASSWORD_SERVICE, id, password.expose())?;
        }
        if let Some(note) = patch.note {
            meta.note = clean_note(Some(note));
        }
        meta.updated_at = now;
        self.write_meta(&meta)?;
        Ok(meta)
    }

    pub fn delete(&self, id: &str) -> Result<(), ImportError> {
        let _guard = self.lock();
        self.require(id)?;
        self.backend.delete(PASSWORD_SERVICE, id)?;
        self.backend.delete(METADATA_SERVICE, id)
    }

    pub fn mark_used(&self, id: &str, now: i64) -> Result<CredentialMeta, ImportError> {
        let _guard = self.lock();
        let mut meta = self.require(id)?;
        meta.last_used_at = Some(now);
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Credentials that may be offered on `url`, most recently used first.
    pub fn matches(&self, url: &str) -> Result<Vec<CredentialMeta>, ImportError> {
        let mut matching = self
            .list()?
            .into_iter()
            .filter(|meta| meta.realm.is_none() && origin_matches_url(&meta.origin, url))
            .collect::<Vec<_>>();
        matching.sort_by(|a, b| {
            b.last_used_at
                .cmp(&a.last_used_at)
                .then_with(|| a.username.cmp(&b.username))
        });
        Ok(matching)
    }

    /// Save every imported credential, counting new, updated and unchanged
    /// (or invalid) ones.
    pub fn import(
        &self,
        credentials: Vec<ImportedCredential>,
        source: &str,
        now: i64,
    ) -> ImportTally {
        let mut tally = ImportTally::default();
        for credential in credentials {
            match self.save(NewCredential::from_imported(credential, source), now) {
                Ok(SaveOutcome::Created(_)) => tally.imported += 1,
                Ok(SaveOutcome::Updated(_)) => tally.updated += 1,
                Ok(SaveOutcome::Unchanged(_)) | Err(_) => tally.skipped += 1,
            }
        }
        tally
    }

    /// Every credential as a Chrome-format CSV
    /// (`name,url,username,password,note`) and the row count.
    pub fn export_csv(&self) -> Result<(SecretString, usize), ImportError> {
        let mut out = String::from("name,url,username,password,note\n");
        let all = self.list()?;
        for meta in &all {
            let password = self.password(&meta.id)?;
            let name = url::Url::parse(&meta.origin)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| meta.origin.clone());
            out.push_str(&format!(
                "{},{},{},{},{}\n",
                csv_field(&name),
                csv_field(&meta.origin),
                csv_field(&meta.username),
                csv_field(password.expose()),
                csv_field(meta.note.as_deref().unwrap_or_default()),
            ));
        }
        Ok((SecretString::from(out), all.len()))
    }

    pub fn add_never_save(&self, origin: &str) -> Result<(), ImportError> {
        let origin = normalize_origin(origin).ok_or(ImportError::InvalidDomain)?;
        self.backend.set(NEVER_SAVE_SERVICE, &origin, "1")
    }

    pub fn is_never_save(&self, origin: &str) -> Result<bool, ImportError> {
        let Some(origin) = normalize_origin(origin) else {
            return Ok(false);
        };
        Ok(self.backend.get(NEVER_SAVE_SERVICE, &origin)?.is_some())
    }

    pub fn remove_never_save(&self, origin: &str) -> Result<(), ImportError> {
        let origin = normalize_origin(origin).ok_or(ImportError::InvalidDomain)?;
        self.backend.delete(NEVER_SAVE_SERVICE, &origin)
    }

    /// Whether saving `password` for `(origin, username)` would create, update
    /// or change nothing — for the save/update prompt.
    pub fn classify_pending(
        &self,
        origin: &str,
        username: &str,
        password: &SecretString,
    ) -> Result<PendingKind, ImportError> {
        let Some(origin) = normalize_origin(origin) else {
            return Err(ImportError::InvalidDomain);
        };
        if self.is_never_save(&origin)? {
            return Ok(PendingKind::Suppressed);
        }
        match self.find_exact(&origin, None, username)? {
            None => Ok(PendingKind::Save),
            Some(existing) => {
                let current = self
                    .backend
                    .get(PASSWORD_SERVICE, &existing.id)?
                    .map(SecretString::from);
                Ok(if current.as_ref() == Some(password) {
                    PendingKind::Unchanged
                } else {
                    PendingKind::Update { id: existing.id }
                })
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingKind {
    Save,
    Update { id: String },
    Unchanged,
    Suppressed,
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub struct MemoryBackend {
        pub entries: Mutex<BTreeMap<(String, String), String>>,
        pub fail_meta_writes: std::sync::atomic::AtomicBool,
    }

    impl VaultBackend for MemoryBackend {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, ImportError> {
            Ok(self
                .entries
                .lock()
                .unwrap()
                .get(&(service.to_owned(), account.to_owned()))
                .cloned())
        }

        fn set(&self, service: &str, account: &str, value: &str) -> Result<(), ImportError> {
            if service == METADATA_SERVICE
                && self
                    .fail_meta_writes
                    .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(ImportError::SecretStore);
            }
            self.entries
                .lock()
                .unwrap()
                .insert((service.to_owned(), account.to_owned()), value.to_owned());
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), ImportError> {
            self.entries
                .lock()
                .unwrap()
                .remove(&(service.to_owned(), account.to_owned()));
            Ok(())
        }

        fn list_accounts(&self, service: &str) -> Result<Vec<String>, ImportError> {
            Ok(self
                .entries
                .lock()
                .unwrap()
                .keys()
                .filter(|(entry_service, _)| entry_service == service)
                .map(|(_, account)| account.clone())
                .collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::MemoryBackend;
    use super::*;

    fn new_credential(origin: &str, username: &str, password: &str) -> NewCredential {
        NewCredential {
            origin: origin.into(),
            realm: None,
            username: username.into(),
            password: password.into(),
            source: "manual".into(),
            note: None,
            created_at: None,
            last_used_at: None,
        }
    }

    #[test]
    fn saves_passwords_and_metadata_as_separate_entries() {
        let vault = Vault::new(MemoryBackend::default());
        let meta = vault
            .save(new_credential("https://github.com/login", "me", "pw"), 10)
            .unwrap()
            .into_meta();
        assert_eq!(meta.origin, "https://github.com");
        assert_eq!(meta.created_at, 10);
        assert!(valid_id(&meta.id));
        let entries = vault.backend.entries.lock().unwrap().clone();
        assert_eq!(
            entries
                .get(&(PASSWORD_SERVICE.into(), meta.id.clone()))
                .unwrap(),
            "pw"
        );
        let stored_meta = entries
            .get(&(METADATA_SERVICE.into(), meta.id.clone()))
            .unwrap();
        assert!(!stored_meta.contains("\"pw\""));
        assert!(stored_meta.contains("\"createdAt\":10"));
        drop(entries);
        assert_eq!(vault.password(&meta.id).unwrap().expose(), "pw");
        assert_eq!(vault.list().unwrap(), vec![meta]);
    }

    #[test]
    fn saving_the_same_login_updates_or_leaves_it_unchanged() {
        let vault = Vault::new(MemoryBackend::default());
        let first = vault
            .save(new_credential("https://a.com", "me", "one"), 1)
            .unwrap();
        assert!(matches!(first, SaveOutcome::Created(_)));
        let same = vault
            .save(new_credential("https://a.com/x", "me", "one"), 2)
            .unwrap();
        assert!(matches!(same, SaveOutcome::Unchanged(_)));
        let changed = vault
            .save(new_credential("https://a.com", "me", "two"), 3)
            .unwrap();
        let SaveOutcome::Updated(meta) = changed else {
            panic!("expected an update")
        };
        assert_eq!(meta.id, first.meta().id);
        assert_eq!(meta.updated_at, 3);
        assert_eq!(vault.password(&meta.id).unwrap().expose(), "two");
        let mut with_note = new_credential("https://a.com", "me", "two");
        with_note.note = Some(" hi ".into());
        let SaveOutcome::Updated(noted) = vault.save(with_note, 4).unwrap() else {
            panic!("a new note updates")
        };
        assert_eq!(noted.note.as_deref(), Some("hi"));
        assert_eq!(vault.list().unwrap().len(), 1);
    }

    #[test]
    fn rejects_invalid_origins_and_empty_passwords() {
        let vault = Vault::new(MemoryBackend::default());
        assert_eq!(
            vault.save(new_credential("chrome://x", "me", "pw"), 1),
            Err(ImportError::InvalidDomain)
        );
        assert_eq!(
            vault.save(new_credential("https://a.com", "me", ""), 1),
            Err(ImportError::InvalidFormat)
        );
    }

    #[test]
    fn a_failed_metadata_write_rolls_back_the_password() {
        let vault = Vault::new(MemoryBackend::default());
        vault
            .backend
            .fail_meta_writes
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            vault.save(new_credential("https://a.com", "me", "pw"), 1),
            Err(ImportError::SecretStore)
        );
        assert!(vault.backend.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn updates_patch_fields_and_refuse_collisions() {
        let vault = Vault::new(MemoryBackend::default());
        let a = vault
            .save(new_credential("https://a.com", "alice", "1"), 1)
            .unwrap()
            .into_meta();
        vault
            .save(new_credential("https://a.com", "bob", "2"), 1)
            .unwrap();
        let patched = vault
            .update(
                &a.id,
                CredentialPatch {
                    username: Some("carol".into()),
                    password: Some("3".into()),
                    note: Some("n".into()),
                },
                5,
            )
            .unwrap();
        assert_eq!(patched.username, "carol");
        assert_eq!(patched.note.as_deref(), Some("n"));
        assert_eq!(patched.updated_at, 5);
        assert_eq!(vault.password(&a.id).unwrap().expose(), "3");
        let cleared = vault
            .update(
                &a.id,
                CredentialPatch {
                    note: Some(String::new()),
                    ..Default::default()
                },
                6,
            )
            .unwrap();
        assert_eq!(cleared.note, None);
        assert_eq!(
            vault.update(
                &a.id,
                CredentialPatch {
                    username: Some("bob".into()),
                    ..Default::default()
                },
                7
            ),
            Err(ImportError::CredentialExists)
        );
        assert_eq!(
            vault.update(
                &a.id,
                CredentialPatch {
                    password: Some("".into()),
                    ..Default::default()
                },
                7
            ),
            Err(ImportError::InvalidFormat)
        );
        assert_eq!(
            vault.update(
                "00000000000000000000000000000000",
                CredentialPatch::default(),
                7
            ),
            Err(ImportError::CredentialNotFound)
        );
    }

    #[test]
    fn deletes_both_entries_and_rejects_unknown_ids() {
        let vault = Vault::new(MemoryBackend::default());
        let meta = vault
            .save(new_credential("https://a.com", "me", "pw"), 1)
            .unwrap()
            .into_meta();
        vault.delete(&meta.id).unwrap();
        assert!(vault.backend.entries.lock().unwrap().is_empty());
        assert_eq!(vault.delete(&meta.id), Err(ImportError::CredentialNotFound));
        assert_eq!(
            vault.password("../../etc"),
            Err(ImportError::CredentialNotFound)
        );
        assert_eq!(vault.get("short").unwrap(), None);
    }

    #[test]
    fn matches_by_site_and_orders_by_last_use() {
        let vault = Vault::new(MemoryBackend::default());
        let old = vault
            .save(new_credential("https://accounts.github.com", "old", "1"), 1)
            .unwrap()
            .into_meta();
        let recent = vault
            .save(new_credential("https://github.com", "recent", "2"), 1)
            .unwrap()
            .into_meta();
        vault
            .save(new_credential("https://evilgithub.com", "x", "3"), 1)
            .unwrap();
        let mut realm = new_credential("https://github.com", "basic", "4");
        realm.realm = Some("Staff".into());
        vault.save(realm, 1).unwrap();
        vault.mark_used(&recent.id, 100).unwrap();
        vault.mark_used(&old.id, 50).unwrap();
        let matches = vault.matches("https://www.github.com/login").unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|meta| meta.username.as_str())
                .collect::<Vec<_>>(),
            ["recent", "old"]
        );
        assert!(vault.matches("http://github.com/login").unwrap().is_empty());
        assert!(vault.matches("not a url").unwrap().is_empty());
    }

    #[test]
    fn origin_matching_rules() {
        assert!(origin_matches_url(
            "https://github.com",
            "https://gist.github.com/x"
        ));
        assert!(origin_matches_url(
            "http://github.com",
            "https://github.com"
        ));
        assert!(!origin_matches_url(
            "https://github.com",
            "http://github.com"
        ));
        assert!(origin_matches_url(
            "http://localhost:3000",
            "http://localhost:3000/login"
        ));
        assert!(!origin_matches_url(
            "http://localhost:3000",
            "http://localhost:5173/login"
        ));
        assert!(origin_matches_url(
            "https://localhost:8443",
            "https://localhost:8443/"
        ));
        assert!(origin_matches_url(
            "https://127.0.0.1:8443",
            "http://127.0.0.1:8443/"
        ));
        assert!(!origin_matches_url("https://a.co.uk", "https://b.co.uk"));
        assert!(!origin_matches_url("https://a.com", "file:///a.com"));
        assert!(!origin_matches_url("garbage", "https://a.com"));
    }

    #[test]
    fn imports_and_tallies() {
        let vault = Vault::new(MemoryBackend::default());
        vault
            .save(new_credential("https://a.com", "me", "same"), 1)
            .unwrap();
        vault
            .save(new_credential("https://b.com", "me", "old"), 1)
            .unwrap();
        let imported = |origin: &str, password: &str| ImportedCredential {
            origin: origin.into(),
            realm: None,
            username: "me".into(),
            password: password.into(),
            created_at: Some(7),
            last_used_at: None,
            note: None,
        };
        let tally = vault.import(
            vec![
                imported("https://a.com", "same"),
                imported("https://b.com", "new"),
                imported("https://c.com", "pw"),
                imported("ftp://d.com", "pw"),
            ],
            "chrome",
            9,
        );
        assert_eq!(
            tally,
            ImportTally {
                imported: 1,
                updated: 1,
                skipped: 2
            }
        );
        let c = vault
            .list()
            .unwrap()
            .into_iter()
            .find(|meta| meta.origin == "https://c.com")
            .unwrap();
        assert_eq!(c.source, "chrome");
        assert_eq!(c.created_at, 7);
    }

    #[test]
    fn exports_chrome_csv_with_escaping() {
        let vault = Vault::new(MemoryBackend::default());
        let mut credential = new_credential("https://a.com", "me", "p,w\"x");
        credential.note = Some("line1\nline2".into());
        vault.save(credential, 1).unwrap();
        let (csv, count) = vault.export_csv().unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            csv.expose(),
            "name,url,username,password,note\na.com,https://a.com,me,\"p,w\"\"x\",\"line1\nline2\"\n"
        );
        let reparsed = super::super::csv::import_csv(csv.expose().to_owned(), None).unwrap();
        assert_eq!(reparsed.credentials[0].password.expose(), "p,w\"x");
    }

    #[test]
    fn never_save_list_and_pending_classification() {
        let vault = Vault::new(MemoryBackend::default());
        let saved = vault
            .save(new_credential("https://a.com", "me", "pw"), 1)
            .unwrap()
            .into_meta();
        assert_eq!(
            vault.classify_pending("https://a.com/login", "me", &"pw".into()),
            Ok(PendingKind::Unchanged)
        );
        assert_eq!(
            vault.classify_pending("https://a.com", "me", &"new".into()),
            Ok(PendingKind::Update { id: saved.id })
        );
        assert_eq!(
            vault.classify_pending("https://a.com", "you", &"x".into()),
            Ok(PendingKind::Save)
        );
        vault.add_never_save("https://b.com/path").unwrap();
        assert!(vault.is_never_save("https://b.com").unwrap());
        assert_eq!(
            vault.classify_pending("https://b.com", "x", &"y".into()),
            Ok(PendingKind::Suppressed)
        );
        vault.remove_never_save("https://b.com").unwrap();
        assert!(!vault.is_never_save("https://b.com").unwrap());
        assert!(!vault.is_never_save("bad://").unwrap());
        assert_eq!(
            vault.classify_pending("bad://", "x", &"y".into()),
            Err(ImportError::InvalidDomain)
        );
        // The never-save list is not a credential.
        assert_eq!(vault.list().unwrap().len(), 1);
    }

    #[test]
    fn secret_store_backend_round_trips_in_memory() {
        let backend = SecretStoreBackend;
        let vault = Vault::new(backend);
        let meta = vault
            .save(new_credential("https://store-test.example", "me", "pw"), 1)
            .unwrap()
            .into_meta();
        assert_eq!(vault.password(&meta.id).unwrap().expose(), "pw");
        assert!(vault
            .list()
            .unwrap()
            .iter()
            .any(|entry| entry.id == meta.id));
        vault.delete(&meta.id).unwrap();
        assert_eq!(vault.get(&meta.id).unwrap(), None);
    }
}
