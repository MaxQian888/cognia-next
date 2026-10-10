//! The process-wide file-share service (ADR-0222 §7).
//!
//! The host installs one [`FileShareService`] at startup with its data
//! directory and a root validator; the WebView (desktop) or brain (headless)
//! then activates the unlocked account, pushes mount tables and the effective
//! policy, and manages grants through the command shells or the companion
//! RPC. Everything that serves a credential — the WebDAV and SFTP listeners,
//! the SFTPGo provider — reads its state from here.
//!
//! One store per local account (`<data>/cognia/accounts/<id>/file-share.sqlite`).
//! Locking or switching the account stops the listeners and drops every live
//! connection; nothing is served without an active account.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use tokio_util::sync::CancellationToken;

use crate::assets::{SharedAssetReader, UnavailableAssetReader};
use crate::audit::{self, Channel, Event, Outcome};
use crate::backoff;
use crate::credentials::{self, VerifiedCache};
use crate::error::{FileShareError, FileShareResult};
use crate::gateway::Caller;
use crate::grants::{self, Effects};
use crate::listener::{self, ListenerConfig, ListenerConfigInput, ListenerStatus, Runtime, SECRET_SERVICE, TUNNEL_TOKEN_ACCOUNT};
use crate::model::{
    status_reason, CreateGrantRequest, CreatedGrant, GrantStatus, GrantView, IssuedCredential,
    ProviderKind, Protocol,
};
use crate::mounts::{self, RootValidator, SessionMountsInput, SharedMountSource, UnavailableMountSource};
use crate::now_ms;
use crate::page::{self, Page, PageRequest};
use crate::policy::{self, PolicyPush, PolicySnapshot};
use crate::sftpgo::{self, SftpgoConfig, SftpgoConfigInput, SftpgoStatus};
use crate::store::{AuditRow, CredentialRow, Store};

static SERVICE: OnceLock<Arc<FileShareService>> = OnceLock::new();

/// How often maintenance runs.
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60);
/// How often audit and backoff rows are pruned.
const PRUNE_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// Longest wait for a quick tunnel's public URL.
const TUNNEL_URL_TIMEOUT_SECS: u64 = 45;

/// Install the service once (later calls return the first one).
pub fn install(data_dir: PathBuf, root_validator: RootValidator) -> Arc<FileShareService> {
    SERVICE
        .get_or_init(|| Arc::new(FileShareService::new(data_dir, root_validator)))
        .clone()
}

/// The installed service, if the host installed one.
pub fn get() -> Option<Arc<FileShareService>> {
    SERVICE.get().cloned()
}

/// The installed service, or the reason there is none.
pub fn require() -> FileShareResult<Arc<FileShareService>> {
    get().ok_or_else(|| {
        FileShareError::new(
            "file_share_unavailable",
            "live file sharing is not available on this host",
        )
    })
}

#[derive(Clone)]
pub(crate) struct Active {
    pub account_id: String,
    pub store: Arc<Store>,
    pub policy: Arc<RwLock<PolicySnapshot>>,
}

/// Live connections per grant, so revoking a grant ends its sessions and
/// in-flight transfers.
#[derive(Default)]
pub struct LiveRegistry {
    inner: Mutex<LiveInner>,
}

#[derive(Default)]
struct LiveInner {
    epochs: HashMap<String, u64>,
    connections: HashMap<u64, (String, CancellationToken)>,
    next: u64,
}

/// A registered connection; deregisters on drop.
pub struct LiveGuard {
    registry: Arc<FileShareService>,
    id: u64,
    pub token: CancellationToken,
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.registry.live.inner.lock().connections.remove(&self.id);
    }
}

impl LiveRegistry {
    /// The grant's current epoch; it changes when the grant is disconnected.
    pub fn epoch(&self, grant_id: &str) -> u64 {
        self.inner.lock().epochs.get(grant_id).copied().unwrap_or(0)
    }

    /// End every live connection of a grant and invalidate its open files.
    pub fn disconnect(&self, grant_id: &str) {
        let mut inner = self.inner.lock();
        *inner.epochs.entry(grant_id.to_string()).or_insert(0) += 1;
        for (grant, token) in inner.connections.values() {
            if grant == grant_id {
                token.cancel();
            }
        }
    }

    /// End every live connection.
    pub fn disconnect_all(&self) {
        let mut inner = self.inner.lock();
        let grants: Vec<String> = inner
            .connections
            .values()
            .map(|(grant, _)| grant.clone())
            .collect();
        for grant in grants {
            *inner.epochs.entry(grant).or_insert(0) += 1;
        }
        for (_, token) in inner.connections.values() {
            token.cancel();
        }
    }

    pub fn connection_count(&self) -> usize {
        self.inner.lock().connections.len()
    }
}

/// Why an authentication attempt failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthFailure {
    /// Wrong username, password or key.
    Invalid,
    /// Too many failures; try again after this many milliseconds.
    Locked { retry_after_ms: i64 },
    /// No account is active, or the store failed.
    Unavailable,
}

/// The whole service as the settings surface shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileShareStatus {
    pub active: bool,
    pub account_id: Option<String>,
    pub policy: PolicySnapshot,
    pub listener: ListenerStatus,
    pub sftpgo: SftpgoStatus,
    /// Conversations whose mount tables the app should keep pushing.
    pub sessions_with_grants: Vec<String>,
    pub active_grants: usize,
    pub live_connections: usize,
    pub pending_provider_ops: usize,
}

/// What a sync accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub synced: usize,
    pub sessions_with_grants: Vec<String>,
}

/// An audit query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    pub session_id: Option<String>,
    pub grant_id: Option<String>,
}

/// The installed service.
pub struct FileShareService {
    data_dir: PathBuf,
    root_validator: RootValidator,
    active: RwLock<Option<Active>>,
    assets: RwLock<SharedAssetReader>,
    mount_source: RwLock<SharedMountSource>,
    pub(crate) verified: VerifiedCache,
    pub(crate) live: LiveRegistry,
    /// The collaboration answering loops (ADR-0222 §6).
    pub(crate) collab: crate::collab::Responders,
    runtime: tokio::sync::Mutex<Runtime>,
    lifecycle: tokio::sync::Mutex<()>,
    maintenance_started: AtomicBool,
    /// The account the host's own session unlocked; `None` until it binds one.
    bound_account: RwLock<Option<Option<String>>>,
    bind_generation: std::sync::atomic::AtomicU64,
    bind_order: tokio::sync::Mutex<()>,
    last_prune: Mutex<i64>,
    dummy_hash: OnceLock<String>,
}

fn valid_account_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

impl FileShareService {
    fn new(data_dir: PathBuf, root_validator: RootValidator) -> Self {
        Self {
            data_dir,
            root_validator,
            active: RwLock::new(None),
            assets: RwLock::new(Arc::new(UnavailableAssetReader)),
            mount_source: RwLock::new(Arc::new(UnavailableMountSource)),
            verified: VerifiedCache::default(),
            live: LiveRegistry::default(),
            collab: crate::collab::Responders::default(),
            runtime: tokio::sync::Mutex::new(Runtime::default()),
            lifecycle: tokio::sync::Mutex::new(()),
            maintenance_started: AtomicBool::new(false),
            bound_account: RwLock::new(None),
            bind_generation: std::sync::atomic::AtomicU64::new(0),
            bind_order: tokio::sync::Mutex::new(()),
            last_prune: Mutex::new(0),
            dummy_hash: OnceLock::new(),
        }
    }

    /// A service over an in-memory store (tests and the crate's integration
    /// tests of the listeners).
    #[doc(hidden)]
    pub fn for_tests(store: Store, policy: PolicySnapshot, root_validator: RootValidator) -> Arc<Self> {
        let service = Self::new(std::env::temp_dir(), root_validator);
        *service.active.write() = Some(Active {
            account_id: "test".into(),
            store: Arc::new(store),
            policy: Arc::new(RwLock::new(policy)),
        });
        Arc::new(service)
    }

    /// [`Self::for_tests`] under its own account id, for tests that touch the
    /// process-global secret store and must not share keys.
    #[cfg(test)]
    pub(crate) fn for_tests_account(store: Store, policy: PolicySnapshot, account_id: &str) -> Arc<Self> {
        let service = Self::new(std::env::temp_dir(), tests::validator());
        *service.active.write() = Some(Active {
            account_id: account_id.into(),
            store: Arc::new(store),
            policy: Arc::new(RwLock::new(policy)),
        });
        Arc::new(service)
    }

    /// A service over `data_dir` with no account served yet (the host
    /// crate's tests of its account binding).
    #[doc(hidden)]
    pub fn unactivated_for_tests(data_dir: PathBuf, root_validator: RootValidator) -> Arc<Self> {
        Arc::new(Self::new(data_dir, root_validator))
    }

    pub(crate) fn active(&self) -> FileShareResult<Active> {
        self.active.read().clone().ok_or_else(FileShareError::locked)
    }

    /// The store and policy every gateway decision reads.
    pub(crate) fn context(&self) -> Option<(Arc<Store>, PolicySnapshot)> {
        self.active
            .read()
            .as_ref()
            .map(|active| (active.store.clone(), active.policy.read().clone()))
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// Install the reader for Dexie-backed mounts.
    pub fn set_asset_reader(&self, reader: SharedAssetReader) {
        *self.assets.write() = reader;
    }

    pub(crate) fn asset_reader(&self) -> SharedAssetReader {
        self.assets.read().clone()
    }

    /// Install where mount tables are pulled from.
    pub fn set_mount_source(&self, source: SharedMountSource) {
        *self.mount_source.write() = source;
    }

    pub fn live(&self) -> &LiveRegistry {
        &self.live
    }

    pub(crate) fn register_connection(self: &Arc<Self>, grant_id: &str) -> LiveGuard {
        let token = CancellationToken::new();
        let mut inner = self.live.inner.lock();
        inner.next += 1;
        let id = inner.next;
        inner
            .connections
            .insert(id, (grant_id.to_string(), token.clone()));
        drop(inner);
        LiveGuard {
            registry: self.clone(),
            id,
            token,
        }
    }

    fn store_path(&self, account_id: &str) -> PathBuf {
        self.data_dir
            .join("cognia")
            .join("accounts")
            .join(account_id)
            .join("file-share.sqlite")
    }

    // ── Account ────────────────────────────────────────────────────────────

    /// Bind the account the host's own account session says is unlocked
    /// (`None`: locked). This is the authority: the desktop calls it from its
    /// account session and the headless server at boot, and from then on
    /// [`Self::activate`] (the app's IPC or RPC call) may only confirm it.
    ///
    /// The returned future applies the binding; the caller spawns it. The
    /// order is fixed when this is called, not when the future runs: a later
    /// binding always wins, so a lock that races an unlock cannot leave the
    /// unlocked account served.
    pub fn bind_account(
        self: &Arc<Self>,
        account_id: Option<String>,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        *self.bound_account.write() = Some(account_id.clone());
        let generation = self.bind_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let service = self.clone();
        async move {
            let _order = service.bind_order.lock().await;
            if service.bind_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if let Err(error) = service.apply_account(account_id).await {
                log::warn!("file-share: account binding failed: {error}");
            }
        }
    }

    /// Serve `account_id`'s store, or nothing (`None`: locked or signed out).
    /// Once the host bound an account ([`Self::bind_account`]) this only
    /// confirms it: a different account is refused.
    pub async fn activate(self: &Arc<Self>, account_id: Option<String>) -> FileShareResult<FileShareStatus> {
        if let Some(bound) = self.bound_account.read().clone() {
            if bound != account_id {
                return Err(FileShareError::new(
                    "file_share_locked",
                    "that is not the account this host has unlocked",
                ));
            }
        }
        self.apply_account(account_id).await?;
        Ok(self.status().await)
    }

    async fn apply_account(self: &Arc<Self>, account_id: Option<String>) -> FileShareResult<()> {
        let changed = {
            let _lifecycle = self.lifecycle.lock().await;
            let current = self.active.read().as_ref().map(|active| active.account_id.clone());
            if current == account_id {
                false
            } else {
                self.runtime.lock().await.stop();
                // Cleared before the loops stop, so a sync already running
                // sees the change and starts none for the old account
                // (`collab::reconcile` checks it under the loops' lock).
                *self.active.write() = None;
                self.collab.stop_all();
                self.live.disconnect_all();
                self.verified.clear();
                if let Some(id) = account_id.as_deref() {
                    if !valid_account_id(id) {
                        return Err(FileShareError::invalid("not an account id"));
                    }
                    let path = self.store_path(id);
                    let store = tokio::task::spawn_blocking(move || Store::open(&path))
                        .await
                        .map_err(FileShareError::store)??;
                    let snapshot: PolicySnapshot =
                        store.setting(policy::SETTINGS_KEY)?.unwrap_or_default();
                    *self.active.write() = Some(Active {
                        account_id: id.to_string(),
                        store: Arc::new(store),
                        policy: Arc::new(RwLock::new(snapshot)),
                    });
                }
                true
            }
        };
        // A confirmation of the account already served leaves the listener
        // and its connections alone.
        if changed && account_id.is_some() {
            self.restart_listener().await;
            self.start_maintenance();
            crate::collab::spawn_sync(self);
        }
        Ok(())
    }

    // ── Mounts and policy ──────────────────────────────────────────────────

    /// Accept pushed mount tables.
    pub async fn sync(self: &Arc<Self>, sessions: Vec<SessionMountsInput>) -> FileShareResult<SyncReport> {
        let active = self.active()?;
        let now = now_ms();
        let mut prepared = Vec::with_capacity(sessions.len());
        for input in &sessions {
            prepared.push((input.session_id.clone(), mounts::prepare(input, &self.root_validator, now)?));
        }
        for (input, (session_id, (records, assets))) in sessions.iter().zip(&prepared) {
            active.store.replace_session_mounts(session_id, input.state, records, assets, now)?;
        }
        self.maintain_now().await;
        Ok(SyncReport {
            synced: prepared.len(),
            sessions_with_grants: active.store.sessions_with_open_grants()?,
        })
    }

    /// Pull one conversation's mount table from the app and store it. A
    /// failed pull keeps the last table (pushed or pulled): the gateway then
    /// serves what it knew, and a mount that changed in between goes stale on
    /// its fingerprint rather than being trusted.
    pub async fn pull_session(self: &Arc<Self>, session_id: &str) -> FileShareResult<bool> {
        let active = self.active()?;
        let source = self.mount_source.read().clone();
        let input = match source.session_mounts(session_id).await {
            Ok(input) => input,
            Err(reason) => {
                log::debug!("file-share: mount table for {session_id} not pulled: {reason}");
                return Ok(false);
            }
        };
        if input.session_id != session_id {
            return Err(FileShareError::invalid(
                "the app answered with another conversation's mount table",
            ));
        }
        let now = now_ms();
        let (records, assets) = mounts::prepare(&input, &self.root_validator, now)?;
        active.store.replace_session_mounts(session_id, input.state, &records, &assets, now)?;
        Ok(true)
    }

    /// Pull every conversation that still has a grant to serve or resume.
    async fn pull_sessions_with_grants(self: &Arc<Self>) {
        let Ok(active) = self.active() else {
            return;
        };
        let Ok(sessions) = active.store.sessions_with_open_grants() else {
            return;
        };
        for session_id in sessions {
            if let Err(error) = self.pull_session(&session_id).await {
                log::warn!("file-share: mount table for {session_id} refused: {error}");
            }
        }
    }

    /// Accept a pushed effective policy.
    pub async fn set_policy(self: &Arc<Self>, push: PolicyPush) -> FileShareResult<PolicySnapshot> {
        let active = self.active()?;
        let current = active.policy.read().clone();
        let next = match current.apply(push, now_ms()) {
            Some(next) => {
                active.store.set_setting(policy::SETTINGS_KEY, &next, next.updated_at)?;
                *active.policy.write() = next.clone();
                audit::record(
                    &active.store,
                    next.updated_at,
                    Event {
                        principal: audit::OWNER,
                        action: "policy.update",
                        reason: Some(&format!("revision {}", next.revision)),
                        ..Event::default()
                    },
                );
                next
            }
            None => current,
        };
        self.maintain_now().await;
        Ok(next)
    }

    // ── Grants ─────────────────────────────────────────────────────────────

    /// Create a live grant for credential holders.
    pub async fn create_grant(
        self: &Arc<Self>,
        request: CreateGrantRequest,
        principal: &str,
    ) -> FileShareResult<CreatedGrant> {
        let active = self.active()?;
        // Fresh paths and fingerprints for the grant to bind to. A grant made
        // from a paired device has no other way to get them here.
        self.pull_session(&request.session_id).await?;
        let sftpgo = if request.provider == ProviderKind::Sftpgo {
            Some(self.sftpgo_client(&active)?)
        } else {
            None
        };
        let policy = active.policy.read().clone();
        let store = active.store.clone();
        let principal_owned = principal.to_string();
        let created = tokio::task::spawn_blocking(move || {
            grants::create(&store, &policy, &request, &principal_owned, now_ms())
        })
        .await
        .map_err(FileShareError::store)??;

        if let Some((config, client)) = sftpgo {
            if let Err(error) = self.provision(&active, &config, &client, &created).await {
                let effects = grants::revoke(&active.store, &created.grant.id, "provider_failed", "system", now_ms())?;
                self.apply_effects(&active, effects).await;
                return Err(error);
            }
        }
        if created.grant.audience.is_collab() {
            crate::collab::spawn_sync(self);
        }
        let endpoints = self.endpoints_for(&active, created.grant.provider).await;
        Ok(CreatedGrant {
            grant: created.grant,
            credentials: created.credentials,
            endpoints,
        })
    }

    async fn provision(
        &self,
        active: &Active,
        config: &SftpgoConfig,
        client: &sftpgo::Client,
        created: &grants::Created,
    ) -> FileShareResult<()> {
        let mounts = active.store.mounts_for_session(&created.grant.session_id)?;
        for (issued, row) in created.credentials.iter().zip(&created.rows) {
            let username = &row.view.username;
            let folders = sftpgo::plan_folders(config, username, &created.grant, &mounts)?;
            for folder in &folders {
                client.create_folder(folder).await?;
            }
            let body = sftpgo::user_body(
                config,
                username,
                Some(&issued.password),
                row.ssh_public_key.as_deref(),
                row.view.protocol,
                &created.grant,
                &folders,
                true,
            );
            client.create_user(&body).await?;
        }
        Ok(())
    }

    /// One page of grants with their credentials (never secrets), newest
    /// first.
    pub fn list_grants(&self, session_id: Option<&str>, request: &PageRequest) -> FileShareResult<Page<GrantView>> {
        let active = self.active()?;
        let after = page::parse_grant_cursor(request)?;
        let size = page::size(request, page::GRANT_PAGE) as usize;
        let mut grants = active.store.list_grants_page(session_id, after, size as u32 + 1)?;
        let more = grants.len() > size;
        grants.truncate(size);
        let next = more
            .then(|| grants.last().map(|last| page::grant_cursor(last.created_at, &last.id)))
            .flatten();
        let mut items = Vec::with_capacity(grants.len());
        for grant in grants {
            let credentials = active
                .store
                .credentials_for_grant(&grant.id)?
                .into_iter()
                .map(|row| row.view)
                .collect();
            items.push(GrantView { grant, credentials });
        }
        Ok(Page::from_cursor(items, next))
    }

    fn grant_view(&self, active: &Active, grant_id: &str) -> FileShareResult<GrantView> {
        let grant = active
            .store
            .grant(grant_id)?
            .ok_or_else(|| FileShareError::not_found(format!("no live share {grant_id}")))?;
        let credentials = active
            .store
            .credentials_for_grant(grant_id)?
            .into_iter()
            .map(|row| row.view)
            .collect();
        Ok(GrantView { grant, credentials })
    }

    pub async fn revoke_grant(self: &Arc<Self>, grant_id: &str, principal: &str) -> FileShareResult<GrantView> {
        let active = self.active()?;
        let effects = grants::revoke(&active.store, grant_id, status_reason::REVOKED, principal, now_ms())?;
        self.apply_effects(&active, effects).await;
        crate::collab::spawn_sync(self);
        self.grant_view(&active, grant_id)
    }

    pub async fn suspend_grant(self: &Arc<Self>, grant_id: &str, principal: &str) -> FileShareResult<GrantView> {
        let active = self.active()?;
        let effects = grants::suspend(&active.store, grant_id, status_reason::OWNER, principal, now_ms())?;
        self.apply_effects(&active, effects).await;
        crate::collab::spawn_sync(self);
        self.grant_view(&active, grant_id)
    }

    pub async fn resume_grant(self: &Arc<Self>, grant_id: &str, principal: &str) -> FileShareResult<GrantView> {
        let active = self.active()?;
        // A stale grant resumes by rebinding to the current table, so it must
        // be current.
        if let Some(grant) = active.store.grant(grant_id)? {
            self.pull_session(&grant.session_id).await?;
        }
        let policy = active.policy.read().clone();
        let effects = grants::resume(&active.store, &policy, grant_id, principal, now_ms())?;
        self.apply_effects(&active, effects).await;
        crate::collab::spawn_sync(self);
        self.grant_view(&active, grant_id)
    }

    /// Issue a new password for one credential.
    pub async fn rotate_credential(
        self: &Arc<Self>,
        credential_id: &str,
        principal: &str,
    ) -> FileShareResult<IssuedCredential> {
        let active = self.active()?;
        let store = active.store.clone();
        let id = credential_id.to_string();
        let principal_owned = principal.to_string();
        let (issued, row) = tokio::task::spawn_blocking(move || grants::rotate(&store, &id, &principal_owned, now_ms()))
            .await
            .map_err(FileShareError::store)??;
        self.verified.forget(&row.view.username);
        if row.view.provider == ProviderKind::Sftpgo {
            let (_, client) = self.sftpgo_client(&active)?;
            client.set_password(&row.view.username, &issued.password).await?;
        }
        // Sessions opened with the old password end now.
        self.live.disconnect(&row.view.grant_id);
        Ok(issued)
    }

    /// One page of the audit trail, newest first.
    pub fn audit(&self, query: &AuditQuery, request: &PageRequest) -> FileShareResult<Page<AuditRow>> {
        let active = self.active()?;
        let before = page::parse_audit_cursor(request)?;
        let size = page::size(request, page::AUDIT_PAGE) as usize;
        let mut rows = active.store.list_audit(
            query.session_id.as_deref(),
            query.grant_id.as_deref(),
            before,
            size as u32 + 1,
        )?;
        let more = rows.len() > size;
        rows.truncate(size);
        let next = more.then(|| rows.last().map(|last| page::audit_cursor(last.id))).flatten();
        Ok(Page::from_cursor(rows, next))
    }

    // ── Authentication ─────────────────────────────────────────────────────

    fn dummy_hash(&self) -> &str {
        self.dummy_hash.get_or_init(|| {
            credentials::hash_password(&credentials::new_password()).unwrap_or_default()
        })
    }

    fn caller_for(row: &CredentialRow, protocol: Protocol, channel: Channel, remote: Option<&str>) -> Caller {
        Caller {
            grant_id: row.view.grant_id.clone(),
            holder: crate::gateway::Holder::Credential {
                credential_id: row.view.id.clone(),
                username: row.view.username.clone(),
                protocol,
            },
            channel,
            remote: remote.map(str::to_string),
        }
    }

    /// Authenticate a built-in credential by password.
    pub async fn authenticate_password(
        self: &Arc<Self>,
        protocol: Protocol,
        username: &str,
        password: &str,
        remote: Option<&str>,
    ) -> Result<Caller, AuthFailure> {
        let channel = match protocol {
            Protocol::Webdav => Channel::Webdav,
            Protocol::Sftp => Channel::Sftp,
        };
        let active = self.active().map_err(|_| AuthFailure::Unavailable)?;
        let store = active.store.clone();
        let now = now_ms();
        let key = credentials::backoff_key(username, remote.unwrap_or("-"));
        let record = store.failure(&key).map_err(|_| AuthFailure::Unavailable)?;
        if let Some(retry_after_ms) = backoff::retry_after(&record, now) {
            grants::audit_auth(&store, now, username, channel, remote, Outcome::Denied, Some("locked"));
            return Err(AuthFailure::Locked { retry_after_ms });
        }
        let row = store
            .credential_by_username(username)
            .map_err(|_| AuthFailure::Unavailable)?
            .filter(|row| {
                row.view.protocol == protocol
                    && row.view.provider == ProviderKind::Builtin
                    && row.view.revoked_at.is_none()
            });
        let hash = row
            .as_ref()
            .and_then(|row| row.password_hash.clone())
            .unwrap_or_else(|| self.dummy_hash().to_string());
        let ok = if row.is_some() && self.verified.hit(username, password) {
            true
        } else {
            let password_owned = password.to_string();
            let matched = tokio::task::spawn_blocking(move || credentials::verify_password(&password_owned, &hash))
                .await
                .unwrap_or(false);
            matched && row.is_some()
        };
        if !ok {
            let next = backoff::after_failure(&record, now);
            let _ = store.put_failure(&key, next);
            grants::audit_auth(&store, now, username, channel, remote, Outcome::Denied, Some("bad_credentials"));
            return Err(AuthFailure::Invalid);
        }
        let row = row.expect("checked above");
        if record.failures > 0 {
            let _ = store.clear_failure(&key);
        }
        self.verified.remember(username, password);
        Ok(Self::caller_for(&row, protocol, channel, remote))
    }

    /// Authenticate an SFTP credential by its registered public key. Key
    /// mismatches are not charged: clients offer every key they hold.
    pub fn authenticate_key(
        &self,
        username: &str,
        key: &russh::keys::PublicKey,
        remote: Option<&str>,
    ) -> Result<Caller, AuthFailure> {
        let active = self.active().map_err(|_| AuthFailure::Unavailable)?;
        let now = now_ms();
        let record = active
            .store
            .failure(&credentials::backoff_key(username, remote.unwrap_or("-")))
            .map_err(|_| AuthFailure::Unavailable)?;
        if let Some(retry_after_ms) = backoff::retry_after(&record, now) {
            return Err(AuthFailure::Locked { retry_after_ms });
        }
        let row = active
            .store
            .credential_by_username(username)
            .map_err(|_| AuthFailure::Unavailable)?
            .filter(|row| {
                row.view.protocol == Protocol::Sftp
                    && row.view.provider == ProviderKind::Builtin
                    && row.view.revoked_at.is_none()
            })
            .ok_or(AuthFailure::Invalid)?;
        let stored = row
            .ssh_public_key
            .as_deref()
            .and_then(|text| russh::keys::PublicKey::from_openssh(text).ok())
            .ok_or(AuthFailure::Invalid)?;
        if stored.key_data() != key.key_data() {
            return Err(AuthFailure::Invalid);
        }
        Ok(Self::caller_for(&row, Protocol::Sftp, Channel::Sftp, remote))
    }

    // ── Effects ────────────────────────────────────────────────────────────

    pub(crate) async fn apply_effects(&self, active: &Active, effects: Effects) {
        if effects.is_empty() {
            return;
        }
        for grant_id in &effects.disconnect {
            self.live.disconnect(grant_id);
        }
        let sftpgo = self.sftpgo_client(active).ok();
        let groups: [(&str, &Vec<CredentialRow>); 3] = [
            ("deprovision", &effects.deprovision),
            ("disable", &effects.disable),
            ("enable", &effects.enable),
        ];
        for (op, rows) in groups {
            for row in rows {
                self.verified.forget(&row.view.username);
                if row.view.provider != ProviderKind::Sftpgo {
                    continue;
                }
                let payload = self.provider_payload(active, row);
                let result = match &sftpgo {
                    Some((_, client)) => run_provider_op(client, op, &payload).await,
                    None => Err(FileShareError::new("sftpgo_unconfigured", "SFTPGo is not configured")),
                };
                if let Err(error) = result {
                    log::warn!("file-share: SFTPGo {op} for {} queued for retry: {error}", row.view.username);
                    let _ = active.store.enqueue_provider_op(
                        "sftpgo",
                        op,
                        &row.view.id,
                        &payload.to_string(),
                        now_ms() + 30_000,
                        &error.to_string(),
                    );
                }
            }
        }
    }

    fn provider_payload(&self, active: &Active, row: &CredentialRow) -> serde_json::Value {
        let folder_count = active
            .store
            .grant(&row.view.grant_id)
            .ok()
            .flatten()
            .map(|grant| grant.paths.len())
            .unwrap_or(0);
        serde_json::json!({
            "username": row.view.username,
            "folders": (0..folder_count).map(|i| format!("{}-{i}", row.view.username)).collect::<Vec<_>>(),
        })
    }

    // ── Maintenance ────────────────────────────────────────────────────────

    /// One maintenance pass now (also run every minute once started).
    pub async fn maintain_now(self: &Arc<Self>) {
        let Ok(active) = self.active() else {
            return;
        };
        let policy = active.policy.read().clone();
        let now = now_ms();
        match grants::maintain(&active.store, &policy, now) {
            Ok(effects) => self.apply_effects(&active, effects).await,
            Err(error) => log::warn!("file-share maintenance failed: {error}"),
        }
        self.retry_provider_ops(&active).await;
        crate::collab::spawn_sync(self);
        let prune_due = {
            let mut last = self.last_prune.lock();
            if now - *last >= PRUNE_INTERVAL_MS {
                *last = now;
                true
            } else {
                false
            }
        };
        if prune_due {
            let _ = active.store.prune_audit(now - audit::RETENTION_MS);
            let _ = active.store.prune_failures(now - backoff::RESET_AFTER_MS);
        }
    }

    async fn retry_provider_ops(&self, active: &Active) {
        let Ok(due) = active.store.due_provider_ops(now_ms()) else {
            return;
        };
        if due.is_empty() {
            return;
        }
        let client = self.sftpgo_client(active).ok();
        for op in due {
            let payload: serde_json::Value = serde_json::from_str(&op.payload).unwrap_or_default();
            let result = match &client {
                Some((_, client)) => run_provider_op(client, &op.op, &payload).await,
                None => Err(FileShareError::new("sftpgo_unconfigured", "SFTPGo is not configured")),
            };
            match result {
                Ok(()) => {
                    let _ = active.store.complete_provider_op(op.id);
                }
                Err(error) => {
                    let delay = 30_000_i64.saturating_mul(1 << op.attempts.min(7)).min(3_600_000);
                    let _ = active.store.reschedule_provider_op(op.id, now_ms() + delay, &error.to_string());
                }
            }
        }
    }

    /// Start the minute loop (idempotent; needs a Tokio runtime).
    pub fn start_maintenance(self: &Arc<Self>) {
        if self.maintenance_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            self.maintenance_started.store(false, Ordering::SeqCst);
            return;
        };
        let service = Arc::downgrade(self);
        handle.spawn(async move {
            loop {
                tokio::time::sleep(MAINTENANCE_INTERVAL).await;
                let Some(service) = service.upgrade() else {
                    return;
                };
                service.pull_sessions_with_grants().await;
                service.maintain_now().await;
            }
        });
    }

    // ── Listener ───────────────────────────────────────────────────────────

    fn listener_config(&self, active: &Active) -> ListenerConfig {
        active
            .store
            .setting(listener::SETTINGS_KEY)
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    fn tunnel_token() -> Option<String> {
        cognia_secrets::secret_store::get(SECRET_SERVICE, TUNNEL_TOKEN_ACCOUNT)
            .ok()
            .flatten()
            .filter(|token| !token.is_empty())
    }

    /// Store new listener settings and apply them.
    pub async fn set_listener(self: &Arc<Self>, input: ListenerConfigInput) -> FileShareResult<ListenerStatus> {
        let active = self.active()?;
        let token_present = match input.tunnel_token.as_deref() {
            Some(token) => !token.trim().is_empty(),
            None => Self::tunnel_token().is_some(),
        };
        input.config.validate(token_present)?;
        if let Some(token) = input.tunnel_token.as_deref() {
            let result = if token.trim().is_empty() {
                cognia_secrets::secret_store::delete(SECRET_SERVICE, TUNNEL_TOKEN_ACCOUNT)
            } else {
                cognia_secrets::secret_store::set(SECRET_SERVICE, TUNNEL_TOKEN_ACCOUNT, token.trim())
            };
            result.map_err(|error| FileShareError::new("secret_store_unavailable", error))?;
        }
        active
            .store
            .set_setting(listener::SETTINGS_KEY, &input.config, now_ms())?;
        audit::record(
            &active.store,
            now_ms(),
            Event {
                principal: audit::OWNER,
                action: "listener.update",
                reason: Some(if input.config.enabled { "enabled" } else { "disabled" }),
                ..Event::default()
            },
        );
        self.restart_listener().await;
        Ok(self.listener_status().await)
    }

    /// Stop whatever runs and start what the stored settings ask for.
    pub async fn restart_listener(self: &Arc<Self>) {
        let _lifecycle = self.lifecycle.lock().await;
        let mut runtime = self.runtime.lock().await;
        runtime.stop();
        self.live.disconnect_all();
        let Ok(active) = self.active() else {
            return;
        };
        let config = self.listener_config(&active);
        if !config.enabled {
            return;
        }
        if config.webdav {
            let tls = if config.webdav_tls() {
                match cognia_companion_connectivity::tls::ensure_certificate(&self.data_dir) {
                    Ok(material) => Some(material),
                    Err(error) => {
                        runtime.errors.push(listener::ComponentError {
                            component: "webdav".into(),
                            message: format!("no TLS certificate: {error}"),
                        });
                        None
                    }
                }
            } else {
                None
            };
            if !config.webdav_tls() || tls.is_some() {
                runtime.tls_fingerprint = tls.as_ref().map(|material| material.fingerprint_sha256.clone());
                match crate::builtin::dav::serve(self.clone(), &config, tls).await {
                    Ok(run) => runtime.webdav = Some(run),
                    Err(error) => runtime.errors.push(listener::ComponentError {
                        component: "webdav".into(),
                        message: error.to_string(),
                    }),
                }
            }
        }
        if config.sftp {
            match crate::builtin::sftp::host_key() {
                Ok(key) => {
                    runtime.host_key_fingerprint = Some(
                        key.public_key()
                            .fingerprint(russh::keys::HashAlg::Sha256)
                            .to_string(),
                    );
                    match crate::builtin::sftp::serve(self.clone(), &config, key).await {
                        Ok(run) => runtime.sftp = Some(run),
                        Err(error) => runtime.errors.push(listener::ComponentError {
                            component: "sftp".into(),
                            message: error.to_string(),
                        }),
                    }
                }
                Err(error) => runtime.errors.push(listener::ComponentError {
                    component: "sftp".into(),
                    message: error.to_string(),
                }),
            }
        }
        if config.exposure == listener::Exposure::Tunnel {
            if let Some(port) = runtime.webdav.as_ref().map(|run| run.port) {
                let origin = format!("http://127.0.0.1:{port}");
                let launched = match config.tunnel_mode {
                    listener::TunnelMode::Quick => cognia_companion_connectivity::tunnel::launch(&origin).await,
                    listener::TunnelMode::Named => match (Self::tunnel_token(), config.tunnel_hostname.as_deref()) {
                        (Some(token), Some(host)) => {
                            cognia_companion_connectivity::tunnel::launch_named(&token, &format!("https://{host}")).await
                        }
                        _ => Err(cognia_companion_connectivity::tunnel::TunnelError::Timeout),
                    },
                };
                match launched {
                    Ok(handle) => match handle.wait_for_url(TUNNEL_URL_TIMEOUT_SECS).await {
                        Ok(info) => {
                            runtime.tunnel_url = Some(info.public_url);
                            runtime.tunnel = Some(handle);
                        }
                        Err(error) => {
                            handle.stop();
                            runtime.errors.push(listener::ComponentError {
                                component: "tunnel".into(),
                                message: error.to_string(),
                            });
                        }
                    },
                    Err(error) => runtime.errors.push(listener::ComponentError {
                        component: "tunnel".into(),
                        message: error.to_string(),
                    }),
                }
            }
        }
    }

    /// Stop the listeners (host shutdown).
    pub async fn shutdown(&self) {
        self.runtime.lock().await.stop();
        self.collab.stop_all();
        self.live.disconnect_all();
    }

    pub async fn listener_status(&self) -> ListenerStatus {
        let config = self
            .active()
            .map(|active| self.listener_config(&active))
            .unwrap_or_default();
        let runtime = self.runtime.lock().await;
        ListenerStatus {
            endpoints: listener::builtin_endpoints(&config, &runtime),
            webdav_port: runtime.webdav.as_ref().map(|run| run.port),
            sftp_port: runtime.sftp.as_ref().map(|run| run.port),
            tunnel_url: runtime.tunnel_url.clone(),
            tunnel_pid: runtime.tunnel.as_ref().and_then(|tunnel| tunnel.pid()),
            tunnel_token_set: Self::tunnel_token().is_some(),
            errors: runtime.errors.clone(),
            config,
        }
    }

    async fn endpoints_for(&self, active: &Active, provider: ProviderKind) -> listener::Endpoints {
        match provider {
            ProviderKind::Builtin => {
                let config = self.listener_config(active);
                let runtime = self.runtime.lock().await;
                listener::builtin_endpoints(&config, &runtime)
            }
            ProviderKind::Sftpgo => sftpgo::endpoints_for(self.sftpgo_config(active).as_ref()),
        }
    }

    // ── SFTPGo ─────────────────────────────────────────────────────────────

    fn sftpgo_config(&self, active: &Active) -> Option<SftpgoConfig> {
        active.store.setting(sftpgo::SETTINGS_KEY).ok().flatten()
    }

    fn sftpgo_client(&self, active: &Active) -> FileShareResult<(SftpgoConfig, sftpgo::Client)> {
        let config = self.sftpgo_config(active).ok_or_else(|| {
            FileShareError::new("sftpgo_unconfigured", "SFTPGo is not configured on this host")
        })?;
        let key = sftpgo::api_key()?.ok_or_else(|| {
            FileShareError::new("sftpgo_unconfigured", "SFTPGo's admin API key is not set")
        })?;
        let client = sftpgo::Client::new(&config, key);
        Ok((config, client))
    }

    /// Store (or, with `None`, remove) the SFTPGo provider settings.
    pub async fn set_sftpgo(self: &Arc<Self>, input: Option<SftpgoConfigInput>) -> FileShareResult<SftpgoStatus> {
        let active = self.active()?;
        match input {
            Some(input) => {
                input.config.validate()?;
                if let Some(key) = input.api_key.as_deref() {
                    sftpgo::set_api_key(Some(key))?;
                }
                active.store.set_setting(sftpgo::SETTINGS_KEY, &input.config, now_ms())?;
            }
            None => {
                active.store.delete_setting(sftpgo::SETTINGS_KEY)?;
                sftpgo::set_api_key(None)?;
            }
        }
        Ok(self.sftpgo_status(&active, true).await)
    }

    async fn sftpgo_status(&self, active: &Active, probe: bool) -> SftpgoStatus {
        let config = self.sftpgo_config(active);
        let api_key_set = sftpgo::api_key().ok().flatten().is_some();
        let mut status = SftpgoStatus {
            configured: config.is_some() && api_key_set,
            endpoints: sftpgo::endpoints_for(config.as_ref()),
            config: config.clone(),
            api_key_set,
            healthy: None,
            error: None,
        };
        if probe && status.configured {
            match self.sftpgo_client(active) {
                Ok((_, client)) => match client.health().await {
                    Ok(()) => status.healthy = Some(true),
                    Err(error) => {
                        status.healthy = Some(false);
                        status.error = Some(error.message);
                    }
                },
                Err(error) => status.error = Some(error.message),
            }
        }
        status
    }

    // ── Collaboration ──────────────────────────────────────────────────────

    /// Register this host for a shared conversation (`Some`) or end the
    /// registration (`None`).
    pub async fn set_collab_host(
        self: &Arc<Self>,
        session_id: &str,
        input: Option<crate::collab::CollabHostInput>,
        principal: &str,
    ) -> FileShareResult<crate::collab::CollabHostStatus> {
        crate::collab::set_host(self, session_id, input, principal).await
    }

    /// One conversation's registration and how serving it fares.
    pub async fn collab_host_status(
        self: &Arc<Self>,
        session_id: &str,
    ) -> FileShareResult<crate::collab::CollabHostStatus> {
        crate::collab::status(self, session_id).await
    }

    // ── Status ─────────────────────────────────────────────────────────────

    pub async fn status(&self) -> FileShareStatus {
        let listener = self.listener_status().await;
        let Ok(active) = self.active() else {
            return FileShareStatus {
                active: false,
                account_id: None,
                policy: PolicySnapshot::default(),
                listener,
                sftpgo: SftpgoStatus::default(),
                sessions_with_grants: Vec::new(),
                active_grants: 0,
                live_connections: 0,
                pending_provider_ops: 0,
            };
        };
        let grants = active.store.list_grants(None).unwrap_or_default();
        let policy = active.policy.read().clone();
        FileShareStatus {
            active: true,
            account_id: Some(active.account_id.clone()),
            policy,
            listener,
            sftpgo: self.sftpgo_status(&active, false).await,
            sessions_with_grants: active.store.sessions_with_open_grants().unwrap_or_default(),
            active_grants: grants.iter().filter(|grant| grant.status == GrantStatus::Active).count(),
            live_connections: self.live.connection_count(),
            pending_provider_ops: active.store.pending_provider_ops().unwrap_or(0),
        }
    }
}

async fn run_provider_op(client: &sftpgo::Client, op: &str, payload: &serde_json::Value) -> FileShareResult<()> {
    let username = payload["username"].as_str().unwrap_or_default();
    match op {
        "deprovision" => {
            let folders: Vec<String> = payload["folders"]
                .as_array()
                .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            client.delete_user(username, &folders).await
        }
        "disable" => client.set_enabled(username, false).await,
        "enable" => client.set_enabled(username, true).await,
        other => Err(FileShareError::invalid(format!("unknown provider op {other}"))),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::gateway::tests::{fixture, open_policy};
    use crate::model::{CreatedBy, Permission};

    pub(crate) fn validator() -> RootValidator {
        Arc::new(|path: &str| {
            std::path::Path::new(path)
                .canonicalize()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())
        })
    }

    pub(crate) fn service_with(permissions: Vec<Permission>, paths: Vec<(&str, &str, bool)>) -> (Arc<FileShareService>, tempfile::TempDir) {
        let f = fixture(permissions, paths);
        let service = FileShareService::for_tests(f.store, open_policy(), validator());
        (service, f.dir)
    }

    #[test]
    fn account_ids_are_single_safe_segments() {
        assert!(valid_account_id("acct_123"));
        assert!(valid_account_id("local-acct.1"));
        assert!(!valid_account_id(".."));
        assert!(!valid_account_id("a/b"));
        assert!(!valid_account_id(""));
    }

    #[tokio::test]
    async fn activation_opens_one_store_per_account_and_locking_closes_it() {
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(FileShareService::new(dir.path().to_path_buf(), validator()));
        assert!(!service.status().await.active);
        assert_eq!(service.list_grants(None, &PageRequest::default()).unwrap_err().code, "file_share_locked");
        let status = service.activate(Some("acct_a".into())).await.unwrap();
        assert!(status.active);
        assert!(dir.path().join("cognia/accounts/acct_a/file-share.sqlite").is_file());
        let status = service.activate(None).await.unwrap();
        assert!(!status.active);
        assert!(service.activate(Some("../x".into())).await.is_err());
    }

    #[tokio::test]
    async fn the_host_binding_is_authoritative_and_the_last_one_wins() {
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(FileShareService::new(dir.path().to_path_buf(), validator()));
        // Bound in order unlock, lock, unlock-b; applied in reverse. Only the
        // last binding may take effect.
        let unlock = service.bind_account(Some("acct_a".into()));
        let lock = service.bind_account(None);
        let unlock_b = service.bind_account(Some("acct_b".into()));
        unlock_b.await;
        lock.await;
        unlock.await;
        assert_eq!(service.status().await.account_id.as_deref(), Some("acct_b"));
        // The app may confirm the bound account, never choose another.
        assert!(service.activate(Some("acct_b".into())).await.unwrap().active);
        assert_eq!(
            service.activate(Some("acct_a".into())).await.unwrap_err().code,
            "file_share_locked"
        );
        assert_eq!(service.activate(None).await.unwrap_err().code, "file_share_locked");
        service.bind_account(None).await;
        assert!(!service.status().await.active);
        assert!(!service.activate(None).await.unwrap().active);
    }

    #[tokio::test]
    async fn confirming_the_served_account_keeps_live_connections() {
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(FileShareService::new(dir.path().to_path_buf(), validator()));
        service.bind_account(Some("acct_a".into())).await;
        let guard = service.register_connection("fg_1");
        service.activate(Some("acct_a".into())).await.unwrap();
        assert!(!guard.token.is_cancelled());
        service.bind_account(None).await;
        assert!(guard.token.is_cancelled());
    }

    #[tokio::test]
    async fn the_policy_snapshot_persists_and_bumps_its_revision() {
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(FileShareService::new(dir.path().to_path_buf(), validator()));
        service.activate(Some("acct_a".into())).await.unwrap();
        let snapshot = service
            .set_policy(PolicyPush {
                policy: crate::policy::PolicyFields {
                    allow_protocol_credentials: true,
                    ..Default::default()
                },
                org_id: None,
                org_revision: None,
            })
            .await
            .unwrap();
        assert_eq!(snapshot.revision, 1);
        service.activate(None).await.unwrap();
        let status = service.activate(Some("acct_a".into())).await.unwrap();
        assert_eq!(status.policy.revision, 1);
        assert!(status.policy.fields.allow_protocol_credentials);
    }

    #[tokio::test]
    async fn password_auth_backs_off_and_remembers_success() {
        let (service, _dir) = service_with(vec![Permission::Read], vec![("workspace", "src", true)]);
        let active = service.active().unwrap();
        let created = grants::create(
            &active.store,
            &open_policy(),
            &CreateGrantRequest {
                session_id: "s1".into(),
                paths: vec!["/workspace/src".into()],
                permissions: vec![Permission::Read],
                protocols: vec![Protocol::Webdav],
                provider: ProviderKind::Builtin,
                expires_in_seconds: 3600,
                label: None,
                ssh_public_key: None,
                created_by: CreatedBy::User,
                audience: crate::model::AudienceRequest::Credentials,
            },
            "owner",
            now_ms(),
        )
        .unwrap();
        let username = created.credentials[0].credential.username.clone();
        let password = created.credentials[0].password.clone();
        let caller = service
            .authenticate_password(Protocol::Webdav, &username, &password, Some("10.0.0.1"))
            .await
            .unwrap();
        assert_eq!(caller.grant_id, created.grant.id);
        assert!(service.verified.hit(&username, &password));
        // The credential is WebDAV-only.
        assert_eq!(
            service.authenticate_password(Protocol::Sftp, &username, &password, Some("10.0.0.1")).await,
            Err(AuthFailure::Invalid)
        );
        for _ in 0..backoff::FREE_FAILURES {
            assert_eq!(
                service.authenticate_password(Protocol::Webdav, &username, "wrong", Some("10.0.0.2")).await,
                Err(AuthFailure::Invalid)
            );
        }
        let _ = service.authenticate_password(Protocol::Webdav, &username, "wrong", Some("10.0.0.2")).await;
        assert!(matches!(
            service.authenticate_password(Protocol::Webdav, &username, &password, Some("10.0.0.2")).await,
            Err(AuthFailure::Locked { .. })
        ));
        // Another address is not locked out.
        assert!(service
            .authenticate_password(Protocol::Webdav, &username, &password, Some("10.0.0.3"))
            .await
            .is_ok());
        let audit = service.audit(&AuditQuery::default(), &PageRequest::default()).unwrap().items;
        assert!(audit.iter().any(|row| row.action == "auth.fail" && row.reason.as_deref() == Some("locked")));
    }

    #[tokio::test]
    async fn unknown_users_fail_like_wrong_passwords() {
        let (service, _dir) = service_with(vec![Permission::Read], vec![]);
        assert_eq!(
            service.authenticate_password(Protocol::Webdav, "cg-nobody0000", "x", None).await,
            Err(AuthFailure::Invalid)
        );
    }

    #[test]
    fn disconnecting_a_grant_cancels_only_its_connections_and_bumps_its_epoch() {
        let (service, _dir) = service_with(vec![Permission::Read], vec![]);
        let a = service.register_connection("fg_a");
        let b = service.register_connection("fg_b");
        assert_eq!(service.live.connection_count(), 2);
        let before = service.live.epoch("fg_a");
        service.live.disconnect("fg_a");
        assert!(a.token.is_cancelled());
        assert!(!b.token.is_cancelled());
        assert_eq!(service.live.epoch("fg_a"), before + 1);
        drop(a);
        assert_eq!(service.live.connection_count(), 1);
        service.live.disconnect_all();
        assert!(b.token.is_cancelled());
    }

    struct FixedMounts(parking_lot::Mutex<Result<SessionMountsInput, String>>);

    #[async_trait::async_trait]
    impl crate::mounts::MountSource for FixedMounts {
        async fn session_mounts(&self, _session_id: &str) -> Result<SessionMountsInput, String> {
            self.0.lock().clone()
        }
    }

    fn workspace_input(session_id: &str, root: &str) -> SessionMountsInput {
        SessionMountsInput {
            session_id: session_id.into(),
            state: crate::model::SessionState::Active,
            mounts: vec![crate::mounts::MountInput {
                mount_id: "workspace".into(),
                virtual_path: "/workspace".into(),
                backing: crate::model::Backing::Disk,
                host_path: Some(root.into()),
                writable: true,
                status: "available".into(),
            }],
            assets: vec![],
        }
    }

    #[tokio::test]
    async fn a_grant_pulls_the_mount_table_it_binds_to() {
        let f = fixture(vec![Permission::Read], vec![]);
        let root = f.root.clone();
        let service = FileShareService::for_tests(f.store, open_policy(), validator());
        let request = |session: &str| CreateGrantRequest {
            session_id: session.into(),
            paths: vec!["/workspace/src".into()],
            permissions: vec![Permission::Read, Permission::Download],
            protocols: vec![Protocol::Webdav],
            provider: ProviderKind::Builtin,
            expires_in_seconds: 3600,
            label: None,
            ssh_public_key: None,
            created_by: CreatedBy::User,
            audience: crate::model::AudienceRequest::Credentials,
        };
        // Nothing pushed for s2 and nothing to pull from: refused.
        let error = service.create_grant(request("s2"), "device:phone").await.unwrap_err();
        assert_eq!(error.code, "mount_not_synced");

        let source = Arc::new(FixedMounts(parking_lot::Mutex::new(Ok(workspace_input("s2", &root)))));
        service.set_mount_source(source.clone());
        let created = service.create_grant(request("s2"), "device:phone").await.unwrap();
        assert_eq!(created.grant.paths[0].virtual_path, "/workspace/src");

        // A failed pull keeps the last table.
        *source.0.lock() = Err("brain offline".into());
        assert!(!service.pull_session("s2").await.unwrap());
        assert!(service.create_grant(request("s2"), "owner").await.is_ok());

        // An answer for another conversation is refused, not stored.
        *source.0.lock() = Ok(workspace_input("s3", &root));
        assert_eq!(service.pull_session("s2").await.unwrap_err().code, "invalid_request");
        let _keep = f.dir;
    }

    #[tokio::test]
    async fn create_revoke_and_rotate_through_the_service() {
        let (service, _dir) = service_with(vec![Permission::Read], vec![]);
        let created = service
            .create_grant(
                CreateGrantRequest {
                    session_id: "s1".into(),
                    paths: vec!["/workspace/src".into()],
                    permissions: vec![Permission::Read, Permission::Download],
                    protocols: vec![Protocol::Webdav, Protocol::Sftp],
                    provider: ProviderKind::Builtin,
                    expires_in_seconds: 3600,
                    label: None,
                    ssh_public_key: None,
                    created_by: CreatedBy::User,
                    audience: crate::model::AudienceRequest::Credentials,
                },
                "owner",
            )
            .await
            .unwrap();
        assert_eq!(created.endpoints.unavailable_reason.as_deref(), Some("listener_off"));
        let listed = service.list_grants(Some("s1"), &PageRequest::default()).unwrap().items;
        assert!(listed.iter().any(|view| view.grant.id == created.grant.id && view.credentials.len() == 2));
        let rotated = service
            .rotate_credential(&created.credentials[0].credential.id, "owner")
            .await
            .unwrap();
        assert_ne!(rotated.password, created.credentials[0].password);
        let view = service.revoke_grant(&created.grant.id, "owner").await.unwrap();
        assert_eq!(view.grant.status, GrantStatus::Revoked);
        assert!(view.credentials.iter().all(|c| c.revoked_at.is_some()));
        // An SFTPGo grant without SFTPGo configured is refused up front.
        let error = service
            .create_grant(
                CreateGrantRequest {
                    session_id: "s1".into(),
                    paths: vec!["/workspace/src".into()],
                    permissions: vec![Permission::Read],
                    protocols: vec![Protocol::Sftp],
                    provider: ProviderKind::Sftpgo,
                    expires_in_seconds: 3600,
                    label: None,
                    ssh_public_key: None,
                    created_by: CreatedBy::User,
                    audience: crate::model::AudienceRequest::Credentials,
                },
                "owner",
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "sftpgo_unconfigured");
    }

    /// A deleted conversation is pushed with no mounts at all; its grants are
    /// still revoked as `session_deleted`, and an archived one's suspended
    /// and resumed again, by the push alone.
    #[tokio::test]
    async fn pushed_session_states_drive_the_grants() {
        let (service, _dir) = service_with(vec![Permission::Read], vec![]);
        let root = service
            .active()
            .unwrap()
            .store
            .mounts_for_session("s1")
            .unwrap()
            .into_iter()
            .find_map(|mount| mount.host_path)
            .unwrap();
        use crate::model::SessionState;
        let workspace = |state: SessionState| SessionMountsInput {
            session_id: "s1".into(),
            state,
            mounts: vec![crate::mounts::MountInput {
                mount_id: "workspace".into(),
                virtual_path: "/workspace".into(),
                backing: crate::model::Backing::Disk,
                host_path: Some(root.clone()),
                writable: true,
                status: "available".into(),
            }],
            assets: vec![],
        };
        let created = service
            .create_grant(
                CreateGrantRequest {
                    session_id: "s1".into(),
                    paths: vec!["/workspace/src".into()],
                    permissions: vec![Permission::Read],
                    protocols: vec![Protocol::Webdav],
                    provider: ProviderKind::Builtin,
                    expires_in_seconds: 3600,
                    label: None,
                    ssh_public_key: None,
                    created_by: CreatedBy::User,
                    audience: crate::model::AudienceRequest::Credentials,
                },
                "owner",
            )
            .await
            .unwrap();
        let status = |service: &Arc<FileShareService>| {
            let grant = service.active().unwrap().store.grant(&created.grant.id).unwrap().unwrap();
            (grant.status, grant.status_reason)
        };

        service.sync(vec![workspace(SessionState::Archived)]).await.unwrap();
        assert_eq!(status(&service), (GrantStatus::Suspended, Some("session_archived".into())));
        service.sync(vec![workspace(SessionState::Active)]).await.unwrap();
        assert_eq!(status(&service).0, GrantStatus::Active);

        let report = service
            .sync(vec![SessionMountsInput { session_id: "s1".into(), state: SessionState::Deleted, mounts: vec![], assets: vec![] }])
            .await
            .unwrap();
        assert_eq!(status(&service), (GrantStatus::Revoked, Some("session_deleted".into())));
        assert!(report.sessions_with_grants.is_empty(), "nothing left to pull for a deleted conversation");
    }
}
