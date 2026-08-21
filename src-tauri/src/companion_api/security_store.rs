//! Rust-owned security and execution ledger for the canonical Companion API.
//!
//! Authorization state is transactional SQLite data. UI databases may cache
//! projections, but they are never consulted as an authority.

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum SecurityStoreError {
    #[error("security database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("challenge is invalid, expired, or already consumed")]
    InvalidChallenge,
    #[error("owner invitation is invalid, expired, or already consumed")]
    InvalidInvitation,
    #[error("device is unknown or revoked")]
    DeviceUnavailable,
    #[error("socket ticket is invalid, expired, replayed, or bound to another endpoint")]
    InvalidSocketTicket,
    #[error("idempotency key was already used with a different request")]
    IdempotencyConflict,
    #[error("host policy is invalid, expired, revoked, or does not cover this command")]
    InvalidPolicy,
    #[error("run state transition is invalid")]
    InvalidRunTransition,
    #[error("the last owner can only be revoked through the deployment trust root")]
    LastOwner,
    #[error("the requested device capability set is invalid")]
    InvalidCapabilities,
    #[error("security schema migration failed: {0}")]
    Migration(String),
    #[error("device lifecycle transition is invalid")]
    InvalidDeviceTransition,
    #[error("the local account does not match this host's recorded binding")]
    HostBindingMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceChallenge {
    pub id: String,
    pub nonce: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SocketIdentity {
    pub tenant_id: String,
    pub device_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizationSnapshot {
    pub public_key_pem: String,
    pub key_thumbprint: String,
    pub capabilities: Vec<String>,
}

/// The sentinel namespace for a binding that predates any local account.
///
/// Mirrors `DEFAULT_ACCOUNT_NAMESPACE` in the client credential book, and for
/// the same reason: pairing can legitimately happen before anyone has unlocked
/// an account, and the first unlock adopts the bucket.
pub const LOCAL_NAMESPACE_UNBOUND: &str = "__local__";

/// One host's mapping from a local account namespace to a store tenant.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostBinding {
    pub local_account_namespace: String,
    pub tenant_id: String,
    pub verifier_digest: Option<String>,
    pub pair_host_id: Option<String>,
}

impl HostBinding {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            local_account_namespace: row.get(0)?,
            tenant_id: row.get(1)?,
            verifier_digest: row.get(2)?,
            pair_host_id: row.get(3)?,
        })
    }
}

/// Mint a tenant id.
///
/// Deliberately not the `acct_` shape that `generateAccountId` produces: the
/// tenant and the local account are different id spaces, and giving them
/// different prefixes keeps a confusion of the two visible instead of silent.
fn mint_tenant_id() -> String {
    format!("tnt_{}", uuid::Uuid::new_v4().simple())
}

/// The three states a device row can be in.
///
/// `Suspended` retains the device's keys and grants — it is a reversible "this
/// device is not allowed to act right now". `Revoked` is terminal: the keys are
/// gone, a `revocations` row exists, and there is no transition back.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceLifecycleState {
    Active,
    Suspended,
    Revoked,
}

impl DeviceLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Suspended => "suspended",
            Self::Revoked => "revoked",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "active" => Some(Self::Active),
            "suspended" => Some(Self::Suspended),
            "revoked" => Some(Self::Revoked),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    pub device_id: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdempotencyDecision {
    Started {
        operation_id: String,
    },
    InProgress {
        operation_id: String,
    },
    Completed {
        operation_id: String,
        receipt_json: String,
    },
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPolicySummary {
    pub policy_id: String,
    pub capability: String,
    pub policy: serde_json::Value,
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSummary {
    pub operation_id: String,
    pub status: String,
    pub receipt: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct SecurityStore {
    conn: Arc<Mutex<Connection>>,
}

static INSTALLED_STORE: once_cell::sync::Lazy<parking_lot::RwLock<Option<Arc<SecurityStore>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(None));

pub fn install_security_store(store: Option<Arc<SecurityStore>>) {
    *INSTALLED_STORE.write() = store;
}

pub fn security_store() -> Option<Arc<SecurityStore>> {
    INSTALLED_STORE.read().clone()
}

/// Serializes every test that installs the process-global store.
///
/// `install_security_store` REPLACES the slot, so `cargo test` — one binary,
/// threads in parallel — will happily swap another test's store out from under
/// it mid-body. A capability test that reads "not granted" because its store
/// was replaced is a false green on a permission gate, which is exactly the
/// class of bug the caller is usually testing for.
///
/// Hold it for the whole test body.
#[cfg(test)]
pub(crate) fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    static STORE_TEST_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    // Poisoning only means an earlier test panicked while holding the guard;
    // every test installs its own store on entry, so the state is still usable
    // and failing all subsequent tests would bury the original failure.
    STORE_TEST_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl SecurityStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Arc<Self>, SecurityStoreError> {
        let path = path.as_ref();
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA_SQL)?;
        let now = unix_time_secs();
        apply_schema_migrations(&mut conn, now, Some(path))?;
        reconcile_interrupted_operations(&mut conn, now)?;
        Ok(Arc::new(Self {
            conn: Arc::new(Mutex::new(conn)),
        }))
    }

    pub fn in_memory() -> Result<Arc<Self>, SecurityStoreError> {
        let mut conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA_SQL)?;
        // An in-memory database is built from the current `SCHEMA_SQL` and so
        // only ever records markers. Running the runner here anyway is what
        // keeps it exercised by the test suite rather than only by real user
        // data on someone's disk.
        apply_schema_migrations(&mut conn, unix_time_secs(), None)?;
        Ok(Arc::new(Self {
            conn: Arc::new(Mutex::new(conn)),
        }))
    }

    pub fn issue_challenge(
        &self,
        tenant_id: &str,
        now: i64,
        ttl_secs: i64,
    ) -> Result<DeviceChallenge, SecurityStoreError> {
        let challenge = DeviceChallenge {
            id: uuid::Uuid::new_v4().to_string(),
            nonce: format!("{}.{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
            expires_at: now.saturating_add(ttl_secs),
        };
        self.conn.lock().execute(
            "INSERT INTO device_challenges
             (id, tenant_id, nonce_hash, expires_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                challenge.id,
                tenant_id,
                hash_secret(&challenge.nonce),
                challenge.expires_at,
                now
            ],
        )?;
        Ok(challenge)
    }

    pub fn create_owner_invitation(
        &self,
        tenant_id: &str,
        actor_id: &str,
        now: i64,
        ttl_secs: i64,
    ) -> Result<String, SecurityStoreError> {
        let secret = format!("{}.{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let invitation_id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO owner_invitations
             (id, tenant_id, token_hash, expires_at, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                invitation_id,
                tenant_id,
                hash_secret(&secret),
                now.saturating_add(ttl_secs),
                actor_id,
                now
            ],
        )?;
        insert_audit(
            &tx,
            tenant_id,
            actor_id,
            "owner_invitation.created",
            &invitation_id,
            now,
        )?;
        tx.commit()?;
        Ok(secret)
    }

    /// Create a one-time enrollment for a least-privilege execution worker.
    pub fn create_worker_enrollment(
        &self,
        tenant_id: &str,
        actor_id: &str,
        now: i64,
        ttl_secs: i64,
    ) -> Result<String, SecurityStoreError> {
        let secret = format!("{}.{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let enrollment_id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO worker_enrollments
             (id, tenant_id, token_hash, expires_at, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                enrollment_id,
                tenant_id,
                hash_secret(&secret),
                now.saturating_add(ttl_secs),
                actor_id,
                now
            ],
        )?;
        insert_audit(
            &tx,
            tenant_id,
            actor_id,
            "worker_enrollment.created",
            &enrollment_id,
            now,
        )?;
        tx.commit()?;
        Ok(secret)
    }

    pub fn consume_challenge(
        &self,
        tenant_id: &str,
        challenge_id: &str,
        challenge_nonce: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let consumed = self.conn.lock().execute(
            "UPDATE device_challenges SET consumed_at = ?1
             WHERE id = ?2 AND tenant_id = ?3 AND nonce_hash = ?4
               AND consumed_at IS NULL AND expires_at >= ?1",
            params![now, challenge_id, tenant_id, hash_secret(challenge_nonce)],
        )?;
        if consumed == 1 {
            Ok(())
        } else {
            Err(SecurityStoreError::InvalidChallenge)
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register_owner_device(
        &self,
        tenant_id: &str,
        invitation: &str,
        challenge_id: &str,
        challenge_nonce: &str,
        device_id: &str,
        display_name: &str,
        public_key_pem: &str,
        public_key_thumbprint: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let consumed_challenge = tx.execute(
            "UPDATE device_challenges
             SET consumed_at = ?1
             WHERE id = ?2 AND tenant_id = ?3 AND nonce_hash = ?4
               AND consumed_at IS NULL AND expires_at >= ?1",
            params![now, challenge_id, tenant_id, hash_secret(challenge_nonce)],
        )?;
        if consumed_challenge != 1 {
            return Err(SecurityStoreError::InvalidChallenge);
        }

        let invitation_id: Option<String> = tx
            .query_row(
                "SELECT id FROM owner_invitations
                 WHERE tenant_id = ?1 AND token_hash = ?2
                   AND consumed_at IS NULL AND expires_at >= ?3",
                params![tenant_id, hash_secret(invitation), now],
                |row| row.get(0),
            )
            .optional()?;
        let invitation_id = invitation_id.ok_or(SecurityStoreError::InvalidInvitation)?;
        let consumed_invitation = tx.execute(
            "UPDATE owner_invitations SET consumed_at = ?1, consumed_by_device_id = ?2
             WHERE id = ?3 AND consumed_at IS NULL",
            params![now, device_id, invitation_id],
        )?;
        if consumed_invitation != 1 {
            return Err(SecurityStoreError::InvalidInvitation);
        }

        tx.execute(
            "INSERT INTO devices
             (id, tenant_id, display_name, role, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'owner', 'active', ?4, ?4)",
            params![device_id, tenant_id, display_name, now],
        )?;
        tx.execute(
            "INSERT INTO device_keys
             (id, device_id, tenant_id, public_key_pem, thumbprint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                device_id,
                tenant_id,
                public_key_pem,
                public_key_thumbprint,
                now
            ],
        )?;
        insert_default_grants(&tx, tenant_id, device_id, "owner", now)?;
        insert_audit(
            &tx,
            tenant_id,
            device_id,
            "device.registered",
            device_id,
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Consume a worker enrollment and register only the `agent.worker`
    /// capability. Worker enrollment never grants ordinary agent control,
    /// terminal, remote control, or Owner authority.
    #[allow(clippy::too_many_arguments)]
    pub fn register_worker_device(
        &self,
        tenant_id: &str,
        enrollment: &str,
        challenge_id: &str,
        challenge_nonce: &str,
        device_id: &str,
        display_name: &str,
        public_key_pem: &str,
        public_key_thumbprint: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let consumed_challenge = tx.execute(
            "UPDATE device_challenges SET consumed_at = ?1
             WHERE id = ?2 AND tenant_id = ?3 AND nonce_hash = ?4
               AND consumed_at IS NULL AND expires_at >= ?1",
            params![now, challenge_id, tenant_id, hash_secret(challenge_nonce)],
        )?;
        if consumed_challenge != 1 {
            return Err(SecurityStoreError::InvalidChallenge);
        }
        let enrollment_id: Option<String> = tx
            .query_row(
                "SELECT id FROM worker_enrollments
                 WHERE tenant_id = ?1 AND token_hash = ?2
                   AND consumed_at IS NULL AND expires_at >= ?3",
                params![tenant_id, hash_secret(enrollment), now],
                |row| row.get(0),
            )
            .optional()?;
        let enrollment_id = enrollment_id.ok_or(SecurityStoreError::InvalidInvitation)?;
        if tx.execute(
            "UPDATE worker_enrollments SET consumed_at = ?1, consumed_by_device_id = ?2
             WHERE id = ?3 AND consumed_at IS NULL",
            params![now, device_id, enrollment_id],
        )? != 1
        {
            return Err(SecurityStoreError::InvalidInvitation);
        }
        tx.execute(
            "INSERT INTO devices
             (id, tenant_id, display_name, role, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'member', 'active', ?4, ?4)",
            params![device_id, tenant_id, display_name, now],
        )?;
        tx.execute(
            "INSERT INTO device_keys
             (id, device_id, tenant_id, public_key_pem, thumbprint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                device_id,
                tenant_id,
                public_key_pem,
                public_key_thumbprint,
                now
            ],
        )?;
        upsert_capability_grant(&tx, tenant_id, device_id, "agent.worker", now)?;
        insert_audit(
            &tx,
            tenant_id,
            device_id,
            "worker.registered",
            device_id,
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register_oidc_device(
        &self,
        tenant_id: &str,
        actor_id: &str,
        challenge_id: &str,
        challenge_nonce: &str,
        device_id: &str,
        display_name: &str,
        public_key_pem: &str,
        public_key_thumbprint: &str,
        role: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        if !matches!(role, "owner" | "member") {
            return Err(SecurityStoreError::DeviceUnavailable);
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let consumed_challenge = tx.execute(
            "UPDATE device_challenges SET consumed_at = ?1
             WHERE id = ?2 AND tenant_id = ?3 AND nonce_hash = ?4
               AND consumed_at IS NULL AND expires_at >= ?1",
            params![now, challenge_id, tenant_id, hash_secret(challenge_nonce)],
        )?;
        if consumed_challenge != 1 {
            return Err(SecurityStoreError::InvalidChallenge);
        }
        tx.execute(
            "INSERT INTO devices
             (id, tenant_id, display_name, role, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)",
            params![device_id, tenant_id, display_name, role, now],
        )?;
        tx.execute(
            "INSERT INTO device_keys
             (id, device_id, tenant_id, public_key_pem, thumbprint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                device_id,
                tenant_id,
                public_key_pem,
                public_key_thumbprint,
                now
            ],
        )?;
        insert_default_grants(&tx, tenant_id, device_id, role, now)?;
        insert_audit(
            &tx,
            tenant_id,
            actor_id,
            "device.registered_oidc",
            device_id,
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn has_capability(
        &self,
        tenant_id: &str,
        device_id: &str,
        capability: &str,
    ) -> Result<bool, SecurityStoreError> {
        let count: i64 = self.conn.lock().query_row(
            "SELECT COUNT(*)
             FROM capability_grants g
             JOIN devices d ON d.tenant_id = g.tenant_id AND d.id = g.device_id
             WHERE g.tenant_id = ?1 AND g.device_id = ?2 AND g.capability = ?3
               AND g.revoked_at IS NULL AND d.status = 'active'",
            params![tenant_id, device_id, capability],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn list_devices(&self, tenant_id: &str) -> Result<Vec<DeviceSummary>, SecurityStoreError> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(
            "SELECT id, display_name, role, status, created_at, updated_at
             FROM devices
             WHERE tenant_id = ?1 AND role != 'service'
             ORDER BY created_at, id",
        )?;
        let rows = statement.query_map(params![tenant_id], |row| {
            Ok(DeviceSummary {
                device_id: row.get(0)?,
                display_name: row.get(1)?,
                role: row.get(2)?,
                status: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                capabilities: Vec::new(),
            })
        })?;
        let mut devices = rows.collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for device in &mut devices {
            let mut grants = conn.prepare(
                "SELECT capability FROM capability_grants
                 WHERE tenant_id = ?1 AND device_id = ?2 AND revoked_at IS NULL
                 ORDER BY capability",
            )?;
            device.capabilities = grants
                .query_map(params![tenant_id, device.device_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
        }
        Ok(devices)
    }

    /// Return every device that was enrolled as an execution worker, including
    /// devices whose `agent.worker` grant was later revoked. Worker identity is
    /// historical; the live capability snapshot is authorization state, not a
    /// deletion signal for the owner's management surface.
    pub fn list_worker_devices(
        &self,
        tenant_id: &str,
    ) -> Result<Vec<DeviceSummary>, SecurityStoreError> {
        let workers = self
            .list_devices(tenant_id)?
            .into_iter()
            .filter(|device| {
                self.conn
                    .lock()
                    .query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM audit_events
                           WHERE tenant_id = ?1 AND action = 'worker.registered'
                             AND target_id = ?2
                         )",
                        params![tenant_id, device.device_id],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
            })
            .collect();
        Ok(workers)
    }

    /// Atomically replace the complete live capability snapshot for one device.
    pub fn replace_device_capabilities(
        &self,
        tenant_id: &str,
        actor_id: &str,
        device_id: &str,
        capabilities: &[String],
        now: i64,
    ) -> Result<Vec<String>, SecurityStoreError> {
        let mut normalized = capabilities.to_vec();
        normalized.sort();
        normalized.dedup();
        if normalized
            .iter()
            .any(|capability| !is_assignable_device_capability(capability))
        {
            return Err(SecurityStoreError::InvalidCapabilities);
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Management plane: a suspended device's grants must stay editable, or
        // the Device Center's switches would silently no-op on a paused device.
        let role: Option<String> = tx
            .query_row(
                "SELECT role FROM devices
                 WHERE tenant_id = ?1 AND id = ?2 AND status IN ('active', 'suspended')",
                params![tenant_id, device_id],
                |row| row.get(0),
            )
            .optional()?;
        let role = role.ok_or(SecurityStoreError::DeviceUnavailable)?;
        if role == "owner"
            && !normalized
                .iter()
                .any(|capability| capability == "host.admin")
        {
            return Err(SecurityStoreError::InvalidCapabilities);
        }
        tx.execute(
            "UPDATE capability_grants SET revoked_at = ?1
             WHERE tenant_id = ?2 AND device_id = ?3 AND revoked_at IS NULL",
            params![now, tenant_id, device_id],
        )?;
        for capability in &normalized {
            upsert_capability_grant(&tx, tenant_id, device_id, capability, now)?;
        }
        insert_audit(
            &tx,
            tenant_id,
            actor_id,
            "device.capabilities_replaced",
            device_id,
            now,
        )?;
        tx.commit()?;
        Ok(normalized)
    }

    /// Import the retired `device-grants.json` projection exactly once.
    pub fn migrate_legacy_device_grants(
        &self,
        control: &[String],
        agent_control: &[String],
        terminal: &[String],
        now: i64,
    ) -> Result<bool, SecurityStoreError> {
        const MARKER: &str = "legacy-device-grants-v1";
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let already_applied: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM security_migrations WHERE key = ?1)",
            [MARKER],
            |row| row.get(0),
        )?;
        if already_applied {
            return Ok(false);
        }
        // Mapping comes from `GrantKind` so the import, the desktop toggles,
        // and the `cognia-server devices` CLI cannot grant different sets.
        for (devices, capabilities) in [
            (control, super::device_grants::GrantKind::Control),
            (agent_control, super::device_grants::GrantKind::AgentControl),
            (terminal, super::device_grants::GrantKind::Terminal),
        ]
        .map(|(devices, kind)| (devices, kind.capabilities()))
        {
            for device_id in devices {
                let tenant: Option<String> = tx
                    .query_row(
                        "SELECT tenant_id FROM devices
                         WHERE id = ?1 AND status IN ('active', 'suspended') LIMIT 1",
                        [device_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(tenant_id) = tenant {
                    for capability in capabilities {
                        upsert_capability_grant(&tx, &tenant_id, device_id, capability, now)?;
                    }
                }
            }
        }
        tx.execute(
            "INSERT INTO security_migrations (key, applied_at) VALUES (?1, ?2)",
            params![MARKER, now],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Provision a loopback-authenticated protocol adapter as a durable
    /// service-role device principal. The wire principal still executes as a
    /// least-privilege device, with only the supplied canonical capabilities.
    pub fn ensure_service_principal(
        &self,
        tenant_id: &str,
        device_id: &str,
        display_name: &str,
        capabilities: &[&str],
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO devices
             (id, tenant_id, display_name, role, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'service', 'active', ?4, ?4)
             ON CONFLICT(tenant_id, id) DO UPDATE SET
               display_name = excluded.display_name,
               role = 'service',
               status = 'active',
               updated_at = excluded.updated_at",
            params![device_id, tenant_id, display_name, now],
        )?;
        tx.execute(
            "UPDATE capability_grants SET revoked_at = ?1
             WHERE tenant_id = ?2 AND device_id = ?3 AND revoked_at IS NULL",
            params![now, tenant_id, device_id],
        )?;
        for capability in capabilities {
            tx.execute(
                "INSERT INTO capability_grants
                 (id, tenant_id, device_id, capability, created_at, revoked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
                 ON CONFLICT(tenant_id, device_id, capability) DO UPDATE SET
                   policy_id = NULL,
                   created_at = excluded.created_at,
                   revoked_at = NULL",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    tenant_id,
                    device_id,
                    capability,
                    now
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn capability_snapshot(
        &self,
        tenant_id: &str,
        device_id: &str,
    ) -> Result<Option<Vec<String>>, SecurityStoreError> {
        let connection = self.conn.lock();
        let active: bool = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM devices
               WHERE tenant_id = ?1 AND id = ?2 AND status = 'active'
             )",
            params![tenant_id, device_id],
            |row| row.get(0),
        )?;
        if !active {
            return Ok(None);
        }
        let mut statement = connection.prepare(
            "SELECT capability FROM capability_grants
             WHERE tenant_id = ?1 AND device_id = ?2 AND revoked_at IS NULL
             ORDER BY capability",
        )?;
        let capabilities = statement
            .query_map(params![tenant_id, device_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(Some(capabilities))
    }

    pub fn create_host_policy(
        &self,
        tenant_id: &str,
        actor_id: &str,
        capability: &str,
        policy: &serde_json::Value,
        expires_at: Option<i64>,
        now: i64,
    ) -> Result<HostPolicySummary, SecurityStoreError> {
        let policy_id = uuid::Uuid::new_v4().to_string();
        let policy_json =
            serde_json::to_string(policy).map_err(|_| SecurityStoreError::InvalidPolicy)?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO host_policies
             (id, tenant_id, capability, policy_json, expires_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                policy_id,
                tenant_id,
                capability,
                policy_json,
                expires_at,
                now
            ],
        )?;
        insert_audit(
            &tx,
            tenant_id,
            actor_id,
            "host_policy.created",
            &policy_id,
            now,
        )?;
        tx.commit()?;
        Ok(HostPolicySummary {
            policy_id,
            capability: capability.to_string(),
            policy: policy.clone(),
            expires_at,
            created_at: now,
        })
    }

    pub fn list_host_policies(
        &self,
        tenant_id: &str,
        now: i64,
    ) -> Result<Vec<HostPolicySummary>, SecurityStoreError> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(
            "SELECT id, capability, policy_json, expires_at, created_at
             FROM host_policies
             WHERE tenant_id = ?1 AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at >= ?2)
             ORDER BY created_at, id",
        )?;
        let rows = statement
            .query_map(params![tenant_id, now], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(policy_id, capability, policy_json, expires_at, created_at)| {
                    Ok(HostPolicySummary {
                        policy_id,
                        capability,
                        policy: serde_json::from_str(&policy_json)
                            .map_err(|_| SecurityStoreError::InvalidPolicy)?,
                        expires_at,
                        created_at,
                    })
                },
            )
            .collect()
    }

    pub fn authorize_host_policy(
        &self,
        tenant_id: &str,
        policy_id: &str,
        capability: &str,
        command: &str,
        now: i64,
    ) -> Result<serde_json::Value, SecurityStoreError> {
        let policy_json: Option<String> = self
            .conn
            .lock()
            .query_row(
                "SELECT policy_json FROM host_policies
                 WHERE id = ?1 AND tenant_id = ?2 AND capability = ?3
                   AND revoked_at IS NULL
                   AND (expires_at IS NULL OR expires_at >= ?4)",
                params![policy_id, tenant_id, capability, now],
                |row| row.get(0),
            )
            .optional()?;
        let policy: serde_json::Value = policy_json
            .as_deref()
            .ok_or(SecurityStoreError::InvalidPolicy)
            .and_then(|value| {
                serde_json::from_str(value).map_err(|_| SecurityStoreError::InvalidPolicy)
            })?;
        let allowed = policy
            .get("commands")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|commands| {
                commands
                    .iter()
                    .any(|candidate| candidate.as_str() == Some(command))
            });
        if allowed {
            Ok(policy)
        } else {
            Err(SecurityStoreError::InvalidPolicy)
        }
    }

    pub fn begin_idempotent_operation(
        &self,
        tenant_id: &str,
        device_id: &str,
        host_id: &str,
        idempotency_key: &str,
        request_hash: &str,
        now: i64,
    ) -> Result<IdempotencyDecision, SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String, Option<String>)> = tx
            .query_row(
                "SELECT request_hash, operation_id, receipt_json
                 FROM idempotency_records
                 WHERE tenant_id = ?1 AND device_id = ?2 AND idempotency_key = ?3",
                params![tenant_id, device_id, idempotency_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((existing_hash, operation_id, receipt_json)) = existing {
            if existing_hash != request_hash {
                return Err(SecurityStoreError::IdempotencyConflict);
            }
            return Ok(match receipt_json {
                Some(receipt_json) => IdempotencyDecision::Completed {
                    operation_id,
                    receipt_json,
                },
                None => IdempotencyDecision::InProgress { operation_id },
            });
        }
        let operation_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO idempotency_records
             (tenant_id, device_id, idempotency_key, request_hash, operation_id,
              status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?6)",
            params![
                tenant_id,
                device_id,
                idempotency_key,
                request_hash,
                operation_id,
                now
            ],
        )?;
        tx.execute(
            "INSERT INTO runs
             (id, tenant_id, device_id, host_id, status, request_hash, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?6)",
            params![
                operation_id,
                tenant_id,
                device_id,
                host_id,
                request_hash,
                now
            ],
        )?;
        insert_audit(&tx, tenant_id, device_id, "run.queued", &operation_id, now)?;
        tx.commit()?;
        Ok(IdempotencyDecision::Started { operation_id })
    }

    pub fn mark_operation_running(
        &self,
        tenant_id: &str,
        operation_id: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let updated = self.conn.lock().execute(
            "UPDATE runs SET status = 'running', updated_at = ?1
             WHERE tenant_id = ?2 AND id = ?3 AND status IN ('queued', 'recovering')",
            params![now, tenant_id, operation_id],
        )?;
        if updated == 1 {
            Ok(())
        } else {
            Err(SecurityStoreError::InvalidRunTransition)
        }
    }

    pub fn operation(
        &self,
        tenant_id: &str,
        device_id: &str,
        operation_id: &str,
    ) -> Result<Option<OperationSummary>, SecurityStoreError> {
        let row: Option<(String, String, Option<String>, i64, i64)> = self
            .conn
            .lock()
            .query_row(
                "SELECT operation_id, status, receipt_json, created_at, updated_at
                 FROM idempotency_records
                 WHERE tenant_id = ?1 AND device_id = ?2 AND operation_id = ?3",
                params![tenant_id, device_id, operation_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(operation_id, status, receipt_json, created_at, updated_at)| {
                let receipt = receipt_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()
                    .map_err(|_| SecurityStoreError::InvalidRunTransition)?;
                Ok(OperationSummary {
                    operation_id,
                    status,
                    receipt,
                    created_at,
                    updated_at,
                })
            },
        )
        .transpose()
    }

    pub fn complete_idempotent_operation(
        &self,
        tenant_id: &str,
        device_id: &str,
        idempotency_key: &str,
        receipt_json: &str,
        succeeded: bool,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = tx.execute(
            "UPDATE idempotency_records
             SET status = ?1, receipt_json = ?2, updated_at = ?3
             WHERE tenant_id = ?4 AND device_id = ?5 AND idempotency_key = ?6
               AND receipt_json IS NULL",
            params![
                if succeeded { "succeeded" } else { "failed" },
                receipt_json,
                now,
                tenant_id,
                device_id,
                idempotency_key
            ],
        )?;
        if updated != 1 {
            return Err(SecurityStoreError::IdempotencyConflict);
        }
        let operation_id: String = tx.query_row(
            "SELECT operation_id FROM idempotency_records
             WHERE tenant_id = ?1 AND device_id = ?2 AND idempotency_key = ?3",
            params![tenant_id, device_id, idempotency_key],
            |row| row.get(0),
        )?;
        let run_updated = tx.execute(
            "UPDATE runs SET status = ?1, updated_at = ?2
             WHERE tenant_id = ?3 AND id = ?4 AND status = 'running'",
            params![
                if succeeded { "succeeded" } else { "failed" },
                now,
                tenant_id,
                operation_id
            ],
        )?;
        if run_updated != 1 {
            return Err(SecurityStoreError::InvalidRunTransition);
        }
        insert_audit(
            &tx,
            tenant_id,
            device_id,
            if succeeded {
                "run.succeeded"
            } else {
                "run.failed"
            },
            &operation_id,
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn active_device_key(
        &self,
        tenant_id: &str,
        device_id: &str,
    ) -> Result<Option<(String, String)>, SecurityStoreError> {
        self.conn
            .lock()
            .query_row(
                "SELECT k.public_key_pem, k.thumbprint
                 FROM device_keys k
                 JOIN devices d ON d.id = k.device_id AND d.tenant_id = k.tenant_id
                 WHERE d.tenant_id = ?1 AND d.id = ?2 AND d.status = 'active'
                   AND k.revoked_at IS NULL
                 ORDER BY k.created_at DESC LIMIT 1",
                params![tenant_id, device_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Load the active device key and all live capability grants in one
    /// read transaction. HTTP authentication passes this immutable snapshot
    /// into remote execution so the same request does not repeat key and
    /// capability queries.
    pub fn authorization_snapshot(
        &self,
        tenant_id: &str,
        device_id: &str,
    ) -> Result<Option<AuthorizationSnapshot>, SecurityStoreError> {
        let connection = self.conn.lock();
        let mut statement = connection.prepare(
            "WITH active_key AS (
                 SELECT public_key_pem, thumbprint
                 FROM device_keys
                 WHERE tenant_id = ?1 AND device_id = ?2 AND revoked_at IS NULL
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
             )
             SELECT k.public_key_pem, k.thumbprint, g.capability
             FROM devices d
             JOIN active_key k
             LEFT JOIN capability_grants g
               ON g.tenant_id = d.tenant_id AND g.device_id = d.id
              AND g.revoked_at IS NULL
             WHERE d.tenant_id = ?1 AND d.id = ?2 AND d.status = 'active'
             ORDER BY g.capability",
        )?;
        let rows = statement.query_map(params![tenant_id, device_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut snapshot: Option<AuthorizationSnapshot> = None;
        for row in rows {
            let (public_key_pem, key_thumbprint, capability) = row?;
            let current = snapshot.get_or_insert_with(|| AuthorizationSnapshot {
                public_key_pem,
                key_thumbprint,
                capabilities: Vec::new(),
            });
            if let Some(capability) = capability {
                current.capabilities.push(capability);
            }
        }
        Ok(snapshot)
    }

    pub fn active_device_tenant(
        &self,
        device_id: &str,
    ) -> Result<Option<String>, SecurityStoreError> {
        self.conn
            .lock()
            .query_row(
                "SELECT tenant_id FROM devices
                 WHERE id = ?1 AND status = 'active'
                 ORDER BY updated_at DESC LIMIT 1",
                [device_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// The binding row for a local account namespace, if one exists.
    pub fn host_binding(
        &self,
        local_account_namespace: &str,
    ) -> Result<Option<HostBinding>, SecurityStoreError> {
        self.conn
            .lock()
            .query_row(
                "SELECT local_account_namespace, tenant_id, verifier_digest, pair_host_id
                 FROM host_bindings WHERE local_account_namespace = ?1",
                [local_account_namespace],
                HostBinding::from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    /// Bind a local account namespace to a tenant, minting or adopting one.
    ///
    /// The adoption order is what keeps existing installs working:
    /// 1. this namespace already has a row — reuse it;
    /// 2. the unclaimed `__local__` bucket exists — move the namespace onto it
    ///    and **keep its tenant**, so every device paired before there was an
    ///    account keeps authenticating;
    /// 3. otherwise mint a fresh `tnt_…` tenant.
    ///
    /// `verifier_digest` is the security boundary. Rust cannot prove that a
    /// renderer-supplied `local_account_namespace` is genuine — the account
    /// registry lives in IndexedDB — so instead it pins the namespace to the
    /// password verifier it was first seen with. A compromised renderer can
    /// still mint a *new* namespace (which gets an empty tenant and no
    /// devices), but it can never re-point an established one at a verifier of
    /// its own choosing. Rotating a password therefore has to go through
    /// [`Self::rebind_host_verifier`].
    pub fn bind_host_account(
        &self,
        local_account_namespace: &str,
        verifier_digest: Option<&str>,
        now: i64,
    ) -> Result<HostBinding, SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let existing: Option<HostBinding> = tx
            .query_row(
                "SELECT local_account_namespace, tenant_id, verifier_digest, pair_host_id
                 FROM host_bindings WHERE local_account_namespace = ?1",
                [local_account_namespace],
                HostBinding::from_row,
            )
            .optional()?;

        if let Some(binding) = existing {
            match (binding.verifier_digest.as_deref(), verifier_digest) {
                (Some(recorded), Some(presented)) if recorded != presented => {
                    return Err(SecurityStoreError::HostBindingMismatch);
                }
                // First verified unlock after a legacy adoption records the
                // digest, which is what arms the pin for every later bind.
                (None, Some(presented)) => {
                    tx.execute(
                        "UPDATE host_bindings SET verifier_digest = ?1, updated_at = ?2
                         WHERE local_account_namespace = ?3",
                        params![presented, now, local_account_namespace],
                    )?;
                    tx.commit()?;
                    return Ok(HostBinding {
                        verifier_digest: Some(presented.to_string()),
                        ..binding
                    });
                }
                _ => {}
            }
            tx.commit()?;
            return Ok(binding);
        }

        // Adopt the unclaimed legacy bucket, tenant and all.
        let unclaimed: Option<String> = tx
            .query_row(
                "SELECT tenant_id FROM host_bindings WHERE local_account_namespace = ?1",
                [LOCAL_NAMESPACE_UNBOUND],
                |row| row.get(0),
            )
            .optional()?;

        let binding = if let Some(tenant_id) = unclaimed {
            tx.execute(
                "UPDATE host_bindings
                 SET local_account_namespace = ?1, verifier_digest = ?2, updated_at = ?3
                 WHERE local_account_namespace = ?4",
                params![
                    local_account_namespace,
                    verifier_digest,
                    now,
                    LOCAL_NAMESPACE_UNBOUND
                ],
            )?;
            HostBinding {
                local_account_namespace: local_account_namespace.to_string(),
                tenant_id,
                verifier_digest: verifier_digest.map(str::to_string),
                pair_host_id: None,
            }
        } else {
            let tenant_id = mint_tenant_id();
            tx.execute(
                "INSERT INTO host_bindings
                 (local_account_namespace, tenant_id, verifier_digest, bound_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![local_account_namespace, tenant_id, verifier_digest, now],
            )?;
            HostBinding {
                local_account_namespace: local_account_namespace.to_string(),
                tenant_id,
                verifier_digest: verifier_digest.map(str::to_string),
                pair_host_id: None,
            }
        };
        tx.commit()?;
        Ok(binding)
    }

    /// Re-pin a binding to a new password verifier. This is the deliberate
    /// escape hatch for a password rotation, and the only way an established
    /// digest ever changes.
    pub fn rebind_host_verifier(
        &self,
        local_account_namespace: &str,
        verifier_digest: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let changed = self.conn.lock().execute(
            "UPDATE host_bindings SET verifier_digest = ?1, updated_at = ?2
             WHERE local_account_namespace = ?3",
            params![verifier_digest, now, local_account_namespace],
        )?;
        if changed == 0 {
            return Err(SecurityStoreError::HostBindingMismatch);
        }
        Ok(())
    }

    /// Resolve a tenant back to the local account namespace that owns it.
    pub fn host_namespace_for_tenant(
        &self,
        tenant_id: &str,
    ) -> Result<Option<String>, SecurityStoreError> {
        self.conn
            .lock()
            .query_row(
                "SELECT local_account_namespace FROM host_bindings WHERE tenant_id = ?1",
                [tenant_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// The tenant a host with no unlocked account should serve.
    ///
    /// The companion server can start before anyone unlocks, and devices paired
    /// earlier still have to authenticate, so this resolves to the unclaimed
    /// `__local__` bucket when one exists rather than refusing.
    pub fn unbound_host_tenant(&self) -> Result<Option<String>, SecurityStoreError> {
        self.conn
            .lock()
            .query_row(
                "SELECT tenant_id FROM host_bindings WHERE local_account_namespace = ?1",
                [LOCAL_NAMESPACE_UNBOUND],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Record the host id that this tenant's QR pair payload advertises.
    ///
    /// The repo derives a host id three different ways and the pair payload's
    /// form is load-bearing on the client: mobile derives an explicitly
    /// immutable `cursorNamespace` from it. Unifying them would break every
    /// existing pairing, so for now the payload form is only recorded, ready
    /// for a later reconciliation.
    pub fn record_pair_host_id(
        &self,
        local_account_namespace: &str,
        pair_host_id: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        self.conn.lock().execute(
            "UPDATE host_bindings SET pair_host_id = ?1, updated_at = ?2
             WHERE local_account_namespace = ?3",
            params![pair_host_id, now, local_account_namespace],
        )?;
        Ok(())
    }

    /// Read a device's lifecycle state. `None` when the device does not exist.
    pub fn device_state(
        &self,
        tenant_id: &str,
        device_id: &str,
    ) -> Result<Option<DeviceLifecycleState>, SecurityStoreError> {
        let raw: Option<String> = self
            .conn
            .lock()
            .query_row(
                "SELECT status FROM devices WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, device_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(raw.as_deref().and_then(DeviceLifecycleState::parse))
    }

    /// Management-plane capability read: returns a snapshot for `active` AND
    /// `suspended` devices, together with which of the two it is.
    ///
    /// The authorization-plane [`Self::capability_snapshot`] stays strict —
    /// this exists so the UI can render and edit a paused device's grants
    /// without that widening leaking into a permission check.
    pub fn manageable_capability_snapshot(
        &self,
        tenant_id: &str,
        device_id: &str,
    ) -> Result<Option<(DeviceLifecycleState, Vec<String>)>, SecurityStoreError> {
        let connection = self.conn.lock();
        let raw: Option<String> = connection
            .query_row(
                "SELECT status FROM devices
                 WHERE tenant_id = ?1 AND id = ?2 AND status IN ('active', 'suspended')",
                params![tenant_id, device_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(state) = raw.as_deref().and_then(DeviceLifecycleState::parse) else {
            return Ok(None);
        };
        let mut statement = connection.prepare(
            "SELECT capability FROM capability_grants
             WHERE tenant_id = ?1 AND device_id = ?2 AND revoked_at IS NULL
             ORDER BY capability",
        )?;
        let capabilities = statement
            .query_map(params![tenant_id, device_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(Some((state, capabilities)))
    }

    /// Suspend an active device. Returns `false` when it was already suspended.
    ///
    /// Deliberately unlike [`Self::revoke_device`]:
    /// - `device_keys` are **retained** — holding the keys is the whole point,
    ///   it is what makes resume possible without re-pairing;
    /// - **no** `revocations` row is written — a suspension is not a revocation
    ///   and must not show up in the revocation ledger;
    /// - outstanding socket tickets **are** consumed, so a ticket minted a
    ///   moment before the suspension cannot still be redeemed after it.
    pub fn suspend_device(
        &self,
        tenant_id: &str,
        actor_id: &str,
        device_id: &str,
        trust_root_override: bool,
        now: i64,
    ) -> Result<bool, SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<String> = tx
            .query_row(
                "SELECT status FROM devices WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, device_id],
                |row| row.get(0),
            )
            .optional()?;
        let current = current
            .as_deref()
            .and_then(DeviceLifecycleState::parse)
            .ok_or(SecurityStoreError::DeviceUnavailable)?;
        match current {
            DeviceLifecycleState::Suspended => return Ok(false),
            DeviceLifecycleState::Revoked => {
                return Err(SecurityStoreError::InvalidDeviceTransition)
            }
            DeviceLifecycleState::Active => {}
        }

        let role: String = tx.query_row(
            "SELECT role FROM devices WHERE tenant_id = ?1 AND id = ?2",
            params![tenant_id, device_id],
            |row| row.get(0),
        )?;
        if role == "owner" && !trust_root_override {
            // Same invariant as `revoke_device`: suspending this owner has to
            // leave another *active* one behind. Otherwise the operator is
            // locked out of every owner-gated route with no way back short of
            // the CLI trust root.
            let other_active_owners: i64 = tx.query_row(
                "SELECT COUNT(*) FROM devices
                 WHERE tenant_id = ?1 AND role = 'owner' AND status = 'active'
                   AND id != ?2",
                params![tenant_id, device_id],
                |row| row.get(0),
            )?;
            if other_active_owners == 0 {
                return Err(SecurityStoreError::LastOwner);
            }
        }

        tx.execute(
            "UPDATE devices SET status = 'suspended', updated_at = ?1
             WHERE tenant_id = ?2 AND id = ?3",
            params![now, tenant_id, device_id],
        )?;
        tx.execute(
            "UPDATE socket_tickets SET consumed_at = ?1
             WHERE tenant_id = ?2 AND device_id = ?3 AND consumed_at IS NULL",
            params![now, tenant_id, device_id],
        )?;
        insert_audit(&tx, tenant_id, actor_id, "device.suspended", device_id, now)?;
        tx.commit()?;
        Ok(true)
    }

    /// Return a suspended device to service. Returns `false` when it was
    /// already active. Revocation is terminal, so a revoked device errors.
    pub fn resume_device(
        &self,
        tenant_id: &str,
        actor_id: &str,
        device_id: &str,
        now: i64,
    ) -> Result<bool, SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<String> = tx
            .query_row(
                "SELECT status FROM devices WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, device_id],
                |row| row.get(0),
            )
            .optional()?;
        let current = current
            .as_deref()
            .and_then(DeviceLifecycleState::parse)
            .ok_or(SecurityStoreError::DeviceUnavailable)?;
        match current {
            DeviceLifecycleState::Active => return Ok(false),
            DeviceLifecycleState::Revoked => {
                return Err(SecurityStoreError::InvalidDeviceTransition)
            }
            DeviceLifecycleState::Suspended => {}
        }

        tx.execute(
            "UPDATE devices SET status = 'active', updated_at = ?1
             WHERE tenant_id = ?2 AND id = ?3",
            params![now, tenant_id, device_id],
        )?;
        insert_audit(&tx, tenant_id, actor_id, "device.resumed", device_id, now)?;
        tx.commit()?;
        Ok(true)
    }

    pub fn revoke_device(
        &self,
        tenant_id: &str,
        actor_id: &str,
        device_id: &str,
        trust_root_override: bool,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // A suspended device must still be revocable — suspension is not a
        // dead end, it is a state you can escalate out of.
        let role: Option<String> = tx
            .query_row(
                "SELECT role FROM devices
                 WHERE tenant_id = ?1 AND id = ?2 AND status IN ('active', 'suspended')",
                params![tenant_id, device_id],
                |row| row.get(0),
            )
            .optional()?;
        let role = role.ok_or(SecurityStoreError::DeviceUnavailable)?;
        if role == "owner" && !trust_root_override {
            // The invariant `require_owner_access` actually needs is "some
            // ACTIVE owner still exists", so the count is of *other* owners
            // that are active. Counting suspended owners as protection would
            // be exactly backwards — a suspended owner cannot exercise owner
            // authority, so "suspend owner A, revoke owner B" would strand the
            // tenant with nothing that can authorize. Counting active owners
            // including this one is equally wrong the other way: it refuses to
            // revoke a *suspended* owner while an active one is right there.
            let other_active_owners: i64 = tx.query_row(
                "SELECT COUNT(*) FROM devices
                 WHERE tenant_id = ?1 AND role = 'owner' AND status = 'active'
                   AND id != ?2",
                params![tenant_id, device_id],
                |row| row.get(0),
            )?;
            if other_active_owners == 0 {
                return Err(SecurityStoreError::LastOwner);
            }
        }
        tx.execute(
            "UPDATE devices SET status = 'revoked', updated_at = ?1
             WHERE tenant_id = ?2 AND id = ?3",
            params![now, tenant_id, device_id],
        )?;
        tx.execute(
            "UPDATE device_keys SET revoked_at = ?1
             WHERE tenant_id = ?2 AND device_id = ?3 AND revoked_at IS NULL",
            params![now, tenant_id, device_id],
        )?;
        tx.execute(
            "INSERT INTO revocations
             (id, tenant_id, subject_type, subject_id, reason, created_at)
             VALUES (?1, ?2, 'device', ?3, 'owner_revoked', ?4)",
            params![uuid::Uuid::new_v4().to_string(), tenant_id, device_id, now],
        )?;
        tx.execute(
            "UPDATE socket_tickets SET consumed_at = ?1
             WHERE tenant_id = ?2 AND device_id = ?3 AND consumed_at IS NULL",
            params![now, tenant_id, device_id],
        )?;
        insert_audit(&tx, tenant_id, actor_id, "device.revoked", device_id, now)?;
        tx.commit()?;
        Ok(())
    }

    pub fn issue_socket_ticket(
        &self,
        tenant_id: &str,
        device_id: &str,
        path: &str,
        audience: &str,
        now: i64,
        ttl_secs: i64,
    ) -> Result<String, SecurityStoreError> {
        if self.capability_snapshot(tenant_id, device_id)?.is_none() {
            return Err(SecurityStoreError::DeviceUnavailable);
        }
        let ticket = format!("{}.{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        self.conn.lock().execute(
            "INSERT INTO socket_tickets
             (id, ticket_hash, tenant_id, device_id, path, audience, expires_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                uuid::Uuid::new_v4().to_string(),
                hash_secret(&ticket),
                tenant_id,
                device_id,
                path,
                audience,
                now.saturating_add(ttl_secs),
                now
            ],
        )?;
        Ok(ticket)
    }

    pub fn redeem_socket_ticket(
        &self,
        ticket: &str,
        path: &str,
        audience: &str,
        now: i64,
    ) -> Result<SocketIdentity, SecurityStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let identity: Option<SocketIdentity> = tx
            .query_row(
                "SELECT t.tenant_id, t.device_id
                 FROM socket_tickets t
                 JOIN devices d ON d.tenant_id = t.tenant_id AND d.id = t.device_id
                 WHERE t.ticket_hash = ?1 AND t.path = ?2 AND t.audience = ?3
                   AND t.consumed_at IS NULL AND t.expires_at >= ?4
                   AND d.status = 'active'",
                params![hash_secret(ticket), path, audience, now],
                |row| {
                    Ok(SocketIdentity {
                        tenant_id: row.get(0)?,
                        device_id: row.get(1)?,
                    })
                },
            )
            .optional()?;
        let identity = identity.ok_or(SecurityStoreError::InvalidSocketTicket)?;
        let consumed = tx.execute(
            "UPDATE socket_tickets SET consumed_at = ?1
             WHERE ticket_hash = ?2 AND consumed_at IS NULL",
            params![now, hash_secret(ticket)],
        )?;
        if consumed != 1 {
            return Err(SecurityStoreError::InvalidSocketTicket);
        }
        tx.commit()?;
        Ok(identity)
    }
}

pub(crate) fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn hash_secret(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn insert_audit(
    tx: &rusqlite::Transaction<'_>,
    tenant_id: &str,
    actor_id: &str,
    action: &str,
    target_id: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT INTO audit_events
         (id, tenant_id, actor_id, action, target_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            uuid::Uuid::new_v4().to_string(),
            tenant_id,
            actor_id,
            action,
            target_id,
            now
        ],
    )?;
    Ok(())
}

fn reconcile_interrupted_operations(
    conn: &mut Connection,
    now: i64,
) -> Result<usize, SecurityStoreError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let interrupted = {
        let mut statement = tx.prepare(
            "SELECT r.tenant_id, r.device_id, r.id
             FROM runs r
             JOIN idempotency_records i
               ON i.tenant_id = r.tenant_id
              AND i.device_id = r.device_id
              AND i.operation_id = r.id
             WHERE r.status IN ('queued', 'running', 'waiting_input', 'cancelling', 'recovering')
               AND i.receipt_json IS NULL",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let receipt = serde_json::json!({
        "httpStatus": 500,
        "error": {
            "code": "operation_interrupted",
            "message": "the server restarted before the operation recorded a terminal result",
            "retryable": true,
            "details": {},
        }
    })
    .to_string();
    for (tenant_id, device_id, operation_id) in &interrupted {
        tx.execute(
            "UPDATE idempotency_records
             SET status = 'failed', receipt_json = ?1, updated_at = ?2
             WHERE tenant_id = ?3 AND device_id = ?4 AND operation_id = ?5
               AND receipt_json IS NULL",
            params![receipt, now, tenant_id, device_id, operation_id],
        )?;
        tx.execute(
            "UPDATE runs SET status = 'failed', updated_at = ?1
             WHERE tenant_id = ?2 AND device_id = ?3 AND id = ?4",
            params![now, tenant_id, device_id, operation_id],
        )?;
        insert_audit(
            &tx,
            tenant_id,
            device_id,
            "run.interrupted",
            operation_id,
            now,
        )?;
    }
    tx.commit()?;
    for _ in 0..interrupted.len() {
        super::metrics::record_operation(super::metrics::OperationOutcome::Interrupted);
    }
    Ok(interrupted.len())
}

fn insert_default_grants(
    tx: &rusqlite::Transaction<'_>,
    tenant_id: &str,
    device_id: &str,
    role: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    let capabilities: &[&str] = if role == "owner" {
        &[
            "host.observe",
            "agent.run",
            "workspace.read",
            "workspace.write",
            "git.write",
            "terminal.open",
            "workflow.run",
            "process.spawn",
            "secret.manage",
            "host.admin",
            "device.admin",
            "server.admin",
            "scheduler.manage",
        ]
    } else {
        &["host.observe", "agent.run", "workspace.read"]
    };
    for capability in capabilities {
        tx.execute(
            "INSERT INTO capability_grants
             (id, tenant_id, device_id, capability, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                tenant_id,
                device_id,
                capability,
                now
            ],
        )?;
    }
    Ok(())
}

/// Whether `capability` is one the store will accept as a per-device grant.
///
/// `pub(crate)` so [`super::device_grants`] can pin its grant→capability
/// mapping against it: a toggle that writes a capability this rejects would be
/// a switch whose grant no gate can ever match.
pub(crate) fn is_assignable_device_capability(capability: &str) -> bool {
    matches!(
        capability,
        "host.observe"
            | "agent.run"
            | "workspace.read"
            | "workspace.write"
            | "git.write"
            | "terminal.open"
            | "workflow.run"
            | "process.spawn"
            | "scheduler.manage"
            | "secret.manage"
            | "host.admin"
            | "device.admin"
            | "server.admin"
            | "agent.worker"
    )
}

fn upsert_capability_grant(
    tx: &rusqlite::Transaction<'_>,
    tenant_id: &str,
    device_id: &str,
    capability: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT INTO capability_grants
         (id, tenant_id, device_id, capability, created_at, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL)
         ON CONFLICT(tenant_id, device_id, capability) DO UPDATE SET
           policy_id = NULL, created_at = excluded.created_at, revoked_at = NULL",
        params![
            uuid::Uuid::new_v4().to_string(),
            tenant_id,
            device_id,
            capability,
            now
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------
//
// `SCHEMA_SQL` is applied on every open with `CREATE TABLE IF NOT EXISTS`, so
// it can only ever add a missing table — it can never change one that is
// already on disk. Anything that alters an existing table has to run here.
//
// Migrations are keyed, recorded in `security_migrations`, and run in
// declaration order from both `open` and `in_memory`.

/// Widens `devices.status` from `('active','revoked')` to also admit
/// `'suspended'`. SQLite cannot `ALTER` a `CHECK` constraint, so this is the
/// documented 12-step table rebuild.
const MIGRATION_DEVICE_STATUS_SUSPENDED: &str = "device-status-suspended-v1";

/// Files every pre-existing tenant under a `host_bindings` row so the first
/// account unlock has something to adopt.
const MIGRATION_HOST_BINDING_LEGACY: &str = "host-binding-legacy-v1";

/// Steps 4-7 of the rebuild. The column list is spelled out rather than
/// `SELECT *` so that a future column landing in a different position cannot
/// silently transpose two values.
const DEVICES_REBUILD_SQL: &str = r#"
CREATE TABLE devices_new (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'service')),
    status TEXT NOT NULL CHECK(status IN ('active', 'suspended', 'revoked')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
INSERT INTO devices_new
    (id, tenant_id, display_name, role, status, created_at, updated_at)
    SELECT id, tenant_id, display_name, role, status, created_at, updated_at
    FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
"#;

fn migration_applied(conn: &Connection, key: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM security_migrations WHERE key = ?1)",
        [key],
        |row| row.get(0),
    )
}

fn mark_migration(tx: &rusqlite::Transaction<'_>, key: &str, now: i64) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO security_migrations (key, applied_at) VALUES (?1, ?2)",
        params![key, now],
    )?;
    Ok(())
}

fn table_ddl(conn: &Connection, table: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
}

/// Apply every pending schema migration, in declaration order.
///
/// `backup_target` is the on-disk database path, or `None` for an in-memory
/// store. It is only used by migrations that rewrite a table.
fn apply_schema_migrations(
    conn: &mut Connection,
    now: i64,
    backup_target: Option<&Path>,
) -> Result<(), SecurityStoreError> {
    migrate_device_status_suspended(conn, now, backup_target)?;
    migrate_host_binding_legacy(conn, now)?;
    Ok(())
}

/// Give every tenant that already has devices a `host_bindings` row.
///
/// In practice there is exactly one, the hardcoded `local_acct_a`, and it is
/// filed under the `__local__` sentinel so the first account unlock can adopt
/// it — keeping the tenant, and therefore every existing pairing, in place. The
/// loop is still total, because "in practice one" is not an invariant.
fn migrate_host_binding_legacy(conn: &mut Connection, now: i64) -> Result<(), SecurityStoreError> {
    if migration_applied(conn, MIGRATION_HOST_BINDING_LEGACY)? {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: i64 = tx.query_row("SELECT COUNT(*) FROM host_bindings", [], |row| row.get(0))?;
    if existing == 0 {
        let tenants = {
            let mut statement =
                tx.prepare("SELECT DISTINCT tenant_id FROM devices ORDER BY tenant_id")?;
            let collected = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            collected
        };
        for (index, tenant_id) in tenants.iter().enumerate() {
            // Only one bucket can be the unclaimed one. Any additional tenant
            // is parked under a namespace nothing will ever adopt by accident,
            // so it stays reachable but never silently attaches to an account.
            let namespace = if index == 0 {
                LOCAL_NAMESPACE_UNBOUND.to_string()
            } else {
                format!("__legacy__:{tenant_id}")
            };
            tx.execute(
                "INSERT OR IGNORE INTO host_bindings
                 (local_account_namespace, tenant_id, bound_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params![namespace, tenant_id, now],
            )?;
        }
    }
    mark_migration(&tx, MIGRATION_HOST_BINDING_LEGACY, now)?;
    tx.commit()?;
    Ok(())
}

fn migrate_device_status_suspended(
    conn: &mut Connection,
    now: i64,
    backup_target: Option<&Path>,
) -> Result<(), SecurityStoreError> {
    if migration_applied(conn, MIGRATION_DEVICE_STATUS_SUSPENDED)? {
        return Ok(());
    }

    // A database created from the current `SCHEMA_SQL` already carries the
    // widened constraint. Record the marker so the `sqlite_master` probe does
    // not re-run on every open for the rest of this install's life.
    let already_widened = table_ddl(conn, "devices")?
        .map(|ddl| ddl.contains("'suspended'"))
        .unwrap_or(false);
    if already_widened {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        mark_migration(&tx, MIGRATION_DEVICE_STATUS_SUSPENDED, now)?;
        tx.commit()?;
        return Ok(());
    }

    // The rebuild drops the parent of three foreign keys. A rollback covers a
    // failed statement, but not the process being killed mid-commit, so take a
    // consistent snapshot first. `VACUUM INTO` rather than a file copy: the
    // database runs in WAL mode and copying the main file alone can miss
    // committed pages that still live in the `-wal` sidecar.
    let backup = match backup_target {
        Some(path) => write_pre_migration_backup(conn, path)?,
        None => None,
    };

    // `PRAGMA foreign_keys` is a no-op inside a transaction, so both pragmas
    // are set on the bare connection. `legacy_alter_table` keeps step 7's
    // `RENAME` from re-parsing and rewriting the child tables' `REFERENCES
    // devices` clauses — which is what this procedure wants, because those
    // clauses already name the table the rename is about to produce.
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    conn.pragma_update(None, "legacy_alter_table", true)?;
    let outcome = rebuild_devices_table(conn, now);
    conn.pragma_update(None, "legacy_alter_table", false)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    outcome?;

    // Only once the rebuild has committed.
    if let Some(path) = backup {
        if let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(
                path = %path.display(),
                %error,
                "could not remove the pre-migration security backup"
            );
        }
    }
    Ok(())
}

fn rebuild_devices_table(conn: &mut Connection, now: i64) -> Result<(), SecurityStoreError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(DEVICES_REBUILD_SQL)?;

    // Commit gate. A rebuild that stranded `device_keys`, `capability_grants`,
    // or `socket_tickets` rows must roll back rather than ship a database whose
    // authorization joins quietly return nothing — which reads as "this device
    // was never granted anything", the exact shape of a silent auth bypass.
    let violations = {
        let mut statement = tx.prepare("PRAGMA foreign_key_check")?;
        let mut rows = statement.query([])?;
        let mut count = 0usize;
        while rows.next()?.is_some() {
            count += 1;
        }
        count
    };
    if violations > 0 {
        // Dropping the transaction unread rolls it back.
        return Err(SecurityStoreError::Migration(format!(
            "the device table rebuild left {violations} foreign key violation(s)"
        )));
    }

    mark_migration(&tx, MIGRATION_DEVICE_STATUS_SUSPENDED, now)?;
    tx.commit()?;
    Ok(())
}

/// Snapshot the database next to itself before a destructive migration.
/// Returns `None` when the path has no file name to hang the suffix off.
fn write_pre_migration_backup(
    conn: &Connection,
    database: &Path,
) -> Result<Option<std::path::PathBuf>, SecurityStoreError> {
    let Some(file_name) = database.file_name() else {
        return Ok(None);
    };
    let mut backup_name = file_name.to_os_string();
    backup_name.push(".pre-suspend.bak");
    let target = database.with_file_name(backup_name);

    // `VACUUM INTO` refuses to overwrite, so a backup left behind by an
    // interrupted earlier attempt has to go first.
    if target.exists() {
        std::fs::remove_file(&target).map_err(|error| {
            SecurityStoreError::Migration(format!(
                "could not clear the stale security backup: {error}"
            ))
        })?;
    }
    let target_str = target.to_str().ok_or_else(|| {
        SecurityStoreError::Migration("the security database path is not valid UTF-8".to_string())
    })?;
    conn.execute("VACUUM INTO ?1", [target_str])?;
    Ok(Some(target))
}

const SCHEMA_SQL: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'service')),
    status TEXT NOT NULL CHECK(status IN ('active', 'suspended', 'revoked')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS security_migrations (
    key TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
);
-- Which local account owns which SecurityStore tenant on this host.
--
-- `local_account_namespace` is the renderer's Dexie account id (`acct_…`), or
-- the `__local__` sentinel for a binding that predates any account. `tenant_id`
-- is this store's own tenant and is assigned once and never moved — every
-- already-paired device authenticates against it. The two are deliberately
-- separate id spaces; see `lib/companion/credential-book/types.ts`, which got
-- this layering right on the client first.
CREATE TABLE IF NOT EXISTS host_bindings (
    local_account_namespace TEXT PRIMARY KEY NOT NULL,
    tenant_id               TEXT NOT NULL UNIQUE,
    verifier_digest         TEXT,
    pair_host_id            TEXT,
    bound_at                INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_keys (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,
    thumbprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    UNIQUE (tenant_id, thumbprint),
    FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS capability_grants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    policy_id TEXT,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    UNIQUE (tenant_id, device_id, capability),
    FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS owner_invitations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,
    consumed_by_device_id TEXT
);
CREATE TABLE IF NOT EXISTS worker_enrollments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,
    consumed_by_device_id TEXT
);
CREATE TABLE IF NOT EXISTS device_challenges (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS host_policies (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS revocations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS socket_tickets (
    id TEXT PRIMARY KEY,
    ticket_hash TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    path TEXT NOT NULL,
    audience TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,
    FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    status TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    tenant_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq),
    FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    locator TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE TABLE IF NOT EXISTS idempotency_records (
    tenant_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    receipt_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, device_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_socket_tickets_expiry ON socket_tickets(expires_at);
CREATE INDEX IF NOT EXISTS idx_device_keys_active
    ON device_keys(tenant_id, device_id, revoked_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capability_grants_active
    ON capability_grants(tenant_id, device_id, capability, revoked_at);
CREATE INDEX IF NOT EXISTS idx_host_policies_authorization
    ON host_policies(tenant_id, capability, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_operation
    ON idempotency_records(tenant_id, device_id, operation_id);
CREATE INDEX IF NOT EXISTS idx_runs_tenant_device_created
    ON runs(tenant_id, device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_events_tenant_run ON run_events(tenant_id, run_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_events(tenant_id, created_at);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// The two-state `devices` DDL every install before the suspend migration
    /// was created with. Tests build a database from this on purpose: a
    /// migration that is only ever exercised against a database already in the
    /// new shape is a migration nothing tests.
    #[cfg(test)]
    const LEGACY_DEVICES_DDL: &str = r#"
CREATE TABLE devices (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'service')),
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
"#;

    /// Build a pre-migration database at `path`: the legacy `devices` table,
    /// the rest of the current schema, and one row in each of the three child
    /// tables whose foreign key points at `devices`.
    #[cfg(test)]
    fn seed_legacy_database(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(LEGACY_DEVICES_DDL).unwrap();
        // Everything else in `SCHEMA_SQL` is `IF NOT EXISTS`, so this leaves the
        // legacy `devices` table alone and creates the rest as it is today.
        conn.execute_batch(SCHEMA_SQL).unwrap();

        conn.execute(
            "INSERT INTO devices (id, tenant_id, display_name, role, status, created_at, updated_at)
             VALUES ('device-active', 'tenant-a', 'Active', 'owner', 'active', 10, 10)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO devices (id, tenant_id, display_name, role, status, created_at, updated_at)
             VALUES ('device-revoked', 'tenant-a', 'Revoked', 'member', 'revoked', 11, 12)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO device_keys (id, device_id, tenant_id, public_key_pem, thumbprint, created_at)
             VALUES ('key-1', 'device-active', 'tenant-a', 'PEM', 'thumb-1', 13)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO capability_grants (id, tenant_id, device_id, capability, created_at)
             VALUES ('grant-1', 'tenant-a', 'device-active', 'terminal.open', 14)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO socket_tickets
               (id, tenant_id, device_id, ticket_hash, path, audience, expires_at, created_at)
             VALUES ('ticket-1', 'tenant-a', 'device-active', 'hash-1', '/ws/events', 'events', 999, 15)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn devices_check_constraint_admits_suspended() {
        assert!(SCHEMA_SQL.contains("CHECK(status IN ('active', 'suspended', 'revoked'))"));
    }

    #[test]
    fn a_fresh_database_records_the_marker_without_rebuilding() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("security.sqlite");
        let store = SecurityStore::open(&path).unwrap();
        let conn = store.conn.lock();
        assert!(migration_applied(&conn, MIGRATION_DEVICE_STATUS_SUSPENDED).unwrap());
        // Nothing was rewritten, so no backup should have been produced.
        drop(conn);
        assert!(!path
            .with_file_name("security.sqlite.pre-suspend.bak")
            .exists());
    }

    #[test]
    fn legacy_two_state_devices_table_is_rebuilt() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("security.sqlite");
        seed_legacy_database(&path);

        let store = SecurityStore::open(&path).unwrap();
        let conn = store.conn.lock();

        assert!(migration_applied(&conn, MIGRATION_DEVICE_STATUS_SUSPENDED).unwrap());
        let ddl = table_ddl(&conn, "devices").unwrap().unwrap();
        assert!(
            ddl.contains("'suspended'"),
            "devices DDL was not widened: {ddl}"
        );

        // Both device rows survived, with their status intact.
        let rows = {
            let mut statement = conn
                .prepare("SELECT id, status FROM devices ORDER BY id")
                .unwrap();
            let collected = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            collected
        };
        assert_eq!(
            rows,
            vec![
                ("device-active".to_string(), "active".to_string()),
                ("device-revoked".to_string(), "revoked".to_string()),
            ]
        );

        // Every child row still points at a live parent.
        for table in ["device_keys", "capability_grants", "socket_tickets"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1, "{table} lost its row across the rebuild");
        }
        let violations = {
            let mut statement = conn.prepare("PRAGMA foreign_key_check").unwrap();
            let mut rows = statement.query([]).unwrap();
            let mut count = 0usize;
            while rows.next().unwrap().is_some() {
                count += 1;
            }
            count
        };
        assert_eq!(violations, 0);

        // The widened constraint actually accepts the new value.
        conn.execute(
            "INSERT INTO devices (id, tenant_id, display_name, role, status, created_at, updated_at)
             VALUES ('device-suspended', 'tenant-a', 'Suspended', 'member', 'suspended', 20, 20)",
            [],
        )
        .unwrap();

        // ...and still rejects a value outside it.
        assert!(conn
            .execute(
                "INSERT INTO devices (id, tenant_id, display_name, role, status, created_at, updated_at)
                 VALUES ('device-bogus', 'tenant-a', 'Bogus', 'member', 'paused', 21, 21)",
                [],
            )
            .is_err());

        drop(conn);
        drop(store);
        // The snapshot is removed once the rebuild commits.
        assert!(!path
            .with_file_name("security.sqlite.pre-suspend.bak")
            .exists());
    }

    #[test]
    fn schema_migration_is_idempotent_across_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("security.sqlite");
        seed_legacy_database(&path);

        let first = SecurityStore::open(&path).unwrap();
        drop(first);
        let second = SecurityStore::open(&path).unwrap();
        let conn = second.conn.lock();

        let applied_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM security_migrations WHERE key = ?1",
                [MIGRATION_DEVICE_STATUS_SUSPENDED],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(applied_count, 1);
        let device_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM devices", [], |row| row.get(0))
            .unwrap();
        assert_eq!(device_count, 2, "the second open re-ran the rebuild");
    }

    #[test]
    fn a_legacy_tenant_is_filed_under_the_unclaimed_sentinel() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("security.sqlite");
        seed_legacy_database(&path);

        let store = SecurityStore::open(&path).unwrap();

        // The tenant every pre-binding install used is now adoptable, and still
        // owns its devices. The first account unlock takes this bucket over
        // without the tenant moving, which is what keeps existing pairings alive.
        assert_eq!(
            store.unbound_host_tenant().unwrap().as_deref(),
            Some("tenant-a")
        );
        let adopted = store
            .bind_host_account("acct_real", Some("digest-a"), 200)
            .unwrap();
        assert_eq!(adopted.tenant_id, "tenant-a");
        assert_eq!(
            store
                .host_namespace_for_tenant("tenant-a")
                .unwrap()
                .as_deref(),
            Some("acct_real")
        );
        assert_eq!(store.list_devices("tenant-a").unwrap().len(), 2);
        // The bucket is no longer unclaimed, so a second account cannot take it.
        assert_eq!(store.unbound_host_tenant().unwrap(), None);
    }

    #[test]
    fn a_fresh_install_has_nothing_to_adopt() {
        let store = SecurityStore::in_memory().unwrap();
        assert_eq!(store.unbound_host_tenant().unwrap(), None);
        let minted = store
            .bind_host_account("acct_first", Some("digest-a"), 100)
            .unwrap();
        assert!(minted.tenant_id.starts_with("tnt_"));
    }

    #[test]
    fn in_memory_stores_run_the_migration_runner() {
        let store = SecurityStore::in_memory().unwrap();
        let conn = store.conn.lock();
        assert!(migration_applied(&conn, MIGRATION_DEVICE_STATUS_SUSPENDED).unwrap());
    }

    #[test]
    fn dpop_replays_are_not_persisted_in_the_security_schema() {
        assert!(!SCHEMA_SQL.contains("proof_replays"));
    }

    #[test]
    fn authorization_and_ledger_indexes_are_installed() {
        let store = SecurityStore::in_memory().unwrap();
        let connection = store.conn.lock();
        for (table, expected) in [
            ("device_keys", "idx_device_keys_active"),
            ("capability_grants", "idx_capability_grants_active"),
            ("host_policies", "idx_host_policies_authorization"),
            ("idempotency_records", "idx_idempotency_operation"),
            ("runs", "idx_runs_tenant_device_created"),
            ("audit_events", "idx_audit_tenant_created"),
        ] {
            let mut statement = connection
                .prepare(&format!("PRAGMA index_list('{table}')"))
                .unwrap();
            let names = statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(
                names.iter().any(|name| name == expected),
                "missing {expected} on {table}: {names:?}"
            );
        }
    }

    fn register(store: &SecurityStore, tenant: &str, device: &str, now: i64) {
        let challenge = store.issue_challenge(tenant, now, 60).unwrap();
        let invitation = store
            .create_owner_invitation(tenant, "local-trust-root", now, 60)
            .unwrap();
        store
            .register_owner_device(
                tenant,
                &invitation,
                &challenge.id,
                &challenge.nonce,
                device,
                "Owner phone",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                &format!("thumb-{device}"),
                now,
            )
            .unwrap();
    }

    /// Count the rows a query returns, for the ledger assertions below.
    fn scalar_i64(store: &SecurityStore, sql: &str) -> i64 {
        store
            .conn
            .lock()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn suspend_then_resume_round_trips_and_retains_keys() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);

        assert!(store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap());
        assert_eq!(
            store.device_state("tenant-a", "device-a").unwrap(),
            Some(DeviceLifecycleState::Suspended)
        );

        // The key is retained — that is what makes resume possible without
        // re-pairing — while the authorization plane still refuses to hand it out.
        let revoked_at: Option<i64> = store
            .conn
            .lock()
            .query_row(
                "SELECT revoked_at FROM device_keys
                 WHERE tenant_id = 'tenant-a' AND device_id = 'device-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revoked_at, None, "suspend must not revoke the device key");
        assert!(store
            .active_device_key("tenant-a", "device-a")
            .unwrap()
            .is_none());

        assert!(store
            .resume_device("tenant-a", "device-b", "device-a", 120)
            .unwrap());
        assert_eq!(
            store.device_state("tenant-a", "device-a").unwrap(),
            Some(DeviceLifecycleState::Active)
        );
        assert!(store
            .active_device_key("tenant-a", "device-a")
            .unwrap()
            .is_some());
    }

    #[test]
    fn suspend_and_resume_are_idempotent() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);

        assert!(store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap());
        assert!(
            !store
                .suspend_device("tenant-a", "device-b", "device-a", false, 111)
                .unwrap(),
            "a second suspend reports no change"
        );
        assert!(store
            .resume_device("tenant-a", "device-b", "device-a", 120)
            .unwrap());
        assert!(
            !store
                .resume_device("tenant-a", "device-b", "device-a", 121)
                .unwrap(),
            "a second resume reports no change"
        );
    }

    #[test]
    fn revocation_is_terminal_for_both_transitions() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);
        store
            .revoke_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();

        assert!(matches!(
            store.suspend_device("tenant-a", "device-b", "device-a", false, 111),
            Err(SecurityStoreError::InvalidDeviceTransition)
        ));
        assert!(matches!(
            store.resume_device("tenant-a", "device-b", "device-a", 112),
            Err(SecurityStoreError::InvalidDeviceTransition)
        ));
    }

    #[test]
    fn a_suspended_device_can_still_be_revoked() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);

        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();
        store
            .revoke_device("tenant-a", "device-b", "device-a", false, 111)
            .unwrap();
        assert_eq!(
            store.device_state("tenant-a", "device-a").unwrap(),
            Some(DeviceLifecycleState::Revoked)
        );
    }

    #[test]
    fn suspending_the_last_active_owner_is_refused_without_the_trust_root() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);

        assert!(matches!(
            store.suspend_device("tenant-a", "local-trust-root", "device-a", false, 110),
            Err(SecurityStoreError::LastOwner)
        ));
        // The deployment trust root may still do it.
        assert!(store
            .suspend_device("tenant-a", "local-trust-root", "device-a", true, 111)
            .unwrap());
    }

    #[test]
    fn the_last_active_owner_is_protected_even_when_another_owner_is_suspended() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);
        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();

        // device-b is now the only owner that can actually authorize anything.
        // A suspended owner is not a substitute, so revoking it is refused...
        assert!(matches!(
            store.revoke_device("tenant-a", "local", "device-b", false, 111),
            Err(SecurityStoreError::LastOwner)
        ));
        // ...and so is suspending it.
        assert!(matches!(
            store.suspend_device("tenant-a", "local", "device-b", false, 112),
            Err(SecurityStoreError::LastOwner)
        ));
    }

    #[test]
    fn a_suspended_owner_can_be_revoked_while_an_active_owner_remains() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);
        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();

        // The mirror image of the test above: device-b is active and can
        // authorize, so retiring the suspended owner strands nothing. Counting
        // active owners *including the target* would wrongly refuse this.
        store
            .revoke_device("tenant-a", "device-b", "device-a", false, 111)
            .unwrap();
        assert_eq!(
            store.device_state("tenant-a", "device-a").unwrap(),
            Some(DeviceLifecycleState::Revoked)
        );
    }

    #[test]
    fn a_suspended_device_is_invisible_to_every_authorization_query() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);
        let ticket = store
            .issue_socket_ticket("tenant-a", "device-a", "/ws/events", "events", 100, 60)
            .unwrap();

        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();

        assert!(!store
            .has_capability("tenant-a", "device-a", "host.admin")
            .unwrap());
        assert!(store
            .capability_snapshot("tenant-a", "device-a")
            .unwrap()
            .is_none());
        assert!(store
            .authorization_snapshot("tenant-a", "device-a")
            .unwrap()
            .is_none());
        assert!(store.active_device_tenant("device-a").unwrap().is_none());
        assert!(store
            .active_device_key("tenant-a", "device-a")
            .unwrap()
            .is_none());
        assert!(store
            .redeem_socket_ticket(&ticket, "/ws/events", "events", 111)
            .is_err());
    }

    #[test]
    fn suspend_consumes_outstanding_socket_tickets() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);
        store
            .issue_socket_ticket("tenant-a", "device-a", "/ws/events", "events", 100, 600)
            .unwrap();
        assert_eq!(
            scalar_i64(
                &store,
                "SELECT COUNT(*) FROM socket_tickets
                 WHERE device_id = 'device-a' AND consumed_at IS NULL"
            ),
            1
        );

        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();
        assert_eq!(
            scalar_i64(
                &store,
                "SELECT COUNT(*) FROM socket_tickets
                 WHERE device_id = 'device-a' AND consumed_at IS NULL"
            ),
            0,
            "a ticket minted before the suspension must not survive it"
        );
    }

    #[test]
    fn suspend_writes_no_revocations_row() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);

        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();
        assert_eq!(
            scalar_i64(&store, "SELECT COUNT(*) FROM revocations"),
            0,
            "a suspension is not a revocation and must stay out of the ledger"
        );

        store
            .revoke_device("tenant-a", "device-b", "device-a", false, 111)
            .unwrap();
        assert_eq!(scalar_i64(&store, "SELECT COUNT(*) FROM revocations"), 1);
    }

    #[test]
    fn a_suspended_devices_capabilities_remain_manageable() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);
        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();

        // The management plane sees it, and reports which state it is in.
        let (state, capabilities) = store
            .manageable_capability_snapshot("tenant-a", "device-a")
            .unwrap()
            .expect("a suspended device is manageable");
        assert_eq!(state, DeviceLifecycleState::Suspended);
        assert!(capabilities.iter().any(|entry| entry == "host.admin"));

        // And the grants stay editable while it is paused.
        store
            .replace_device_capabilities(
                "tenant-a",
                "device-b",
                "device-a",
                &["host.admin".to_string(), "terminal.open".to_string()],
                111,
            )
            .unwrap();
        let (_, capabilities) = store
            .manageable_capability_snapshot("tenant-a", "device-a")
            .unwrap()
            .unwrap();
        assert!(capabilities.iter().any(|entry| entry == "terminal.open"));

        // A revoked device is not manageable.
        store
            .revoke_device("tenant-a", "device-b", "device-a", false, 112)
            .unwrap();
        assert!(store
            .manageable_capability_snapshot("tenant-a", "device-a")
            .unwrap()
            .is_none());
    }

    #[test]
    fn audit_records_suspend_and_resume_with_the_actor() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);

        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();
        store
            .resume_device("tenant-a", "device-b", "device-a", 120)
            .unwrap();

        let actions = {
            let conn = store.conn.lock();
            let mut statement = conn
                .prepare(
                    "SELECT action, actor_id, target_id FROM audit_events
                     WHERE target_id = 'device-a'
                       AND action IN ('device.suspended', 'device.resumed')
                     ORDER BY created_at",
                )
                .unwrap();
            let collected = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            collected
        };
        assert_eq!(
            actions,
            vec![
                (
                    "device.suspended".to_string(),
                    "device-b".to_string(),
                    "device-a".to_string()
                ),
                (
                    "device.resumed".to_string(),
                    "device-b".to_string(),
                    "device-a".to_string()
                ),
            ]
        );
    }

    #[test]
    fn list_devices_reports_the_suspended_state() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        register(&store, "tenant-a", "device-b", 101);
        store
            .suspend_device("tenant-a", "device-b", "device-a", false, 110)
            .unwrap();

        let devices = store.list_devices("tenant-a").unwrap();
        let suspended = devices
            .iter()
            .find(|device| device.device_id == "device-a")
            .expect("the suspended device is still listed");
        assert_eq!(suspended.status, "suspended");
        // Its grants are still visible to the management plane.
        assert!(suspended
            .capabilities
            .iter()
            .any(|entry| entry == "host.admin"));
    }

    #[test]
    fn authorization_snapshot_loads_key_and_capabilities_together() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);

        let snapshot = store
            .authorization_snapshot("tenant-a", "device-a")
            .unwrap()
            .expect("active device snapshot");
        assert_eq!(snapshot.key_thumbprint, "thumb-device-a");
        assert!(snapshot.public_key_pem.contains("BEGIN PUBLIC KEY"));
        assert!(snapshot
            .capabilities
            .iter()
            .any(|capability| capability == "host.admin"));
        assert!(store
            .authorization_snapshot("tenant-a", "missing")
            .unwrap()
            .is_none());
    }

    #[test]
    fn invitation_and_challenge_are_single_use_transactionally() {
        let store = SecurityStore::in_memory().unwrap();
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        let invitation = store
            .create_owner_invitation("tenant-a", "root", 100, 60)
            .unwrap();
        store
            .register_owner_device(
                "tenant-a",
                &invitation,
                &challenge.id,
                &challenge.nonce,
                "device-a",
                "Phone",
                "pem",
                "thumb-a",
                101,
            )
            .unwrap();

        let replay = store.register_owner_device(
            "tenant-a",
            &invitation,
            &challenge.id,
            &challenge.nonce,
            "device-b",
            "Copied phone",
            "pem",
            "thumb-b",
            102,
        );
        assert!(matches!(replay, Err(SecurityStoreError::InvalidChallenge)));
        assert!(store
            .active_device_key("tenant-a", "device-b")
            .unwrap()
            .is_none());
    }

    #[test]
    fn worker_enrollment_is_single_use_and_grants_only_agent_worker() {
        let store = SecurityStore::in_memory().unwrap();
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        let enrollment = store
            .create_worker_enrollment("tenant-a", "owner-a", 100, 60)
            .unwrap();
        store
            .register_worker_device(
                "tenant-a",
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                "worker-a",
                "Worker A",
                "pem",
                "thumb-worker-a",
                101,
            )
            .unwrap();

        assert_eq!(
            store
                .capability_snapshot("tenant-a", "worker-a")
                .unwrap()
                .unwrap(),
            vec!["agent.worker"]
        );
        for capability in ["agent.run", "terminal.open", "host.admin", "process.spawn"] {
            assert!(!store
                .has_capability("tenant-a", "worker-a", capability)
                .unwrap());
        }
        store
            .replace_device_capabilities("tenant-a", "owner-a", "worker-a", &[], 102)
            .unwrap();
        let enrolled_workers = store.list_worker_devices("tenant-a").unwrap();
        assert_eq!(enrolled_workers.len(), 1);
        assert_eq!(enrolled_workers[0].device_id, "worker-a");
        assert!(enrolled_workers[0].capabilities.is_empty());
        assert!(store.list_worker_devices("tenant-b").unwrap().is_empty());
        let replay_challenge = store.issue_challenge("tenant-a", 102, 60).unwrap();
        assert!(matches!(
            store.register_worker_device(
                "tenant-a",
                &enrollment,
                &replay_challenge.id,
                &replay_challenge.nonce,
                "worker-b",
                "Worker B",
                "pem-b",
                "thumb-worker-b",
                103,
            ),
            Err(SecurityStoreError::InvalidInvitation)
        ));
    }

    #[test]
    fn socket_ticket_is_path_bound_short_lived_and_single_use() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        let ticket = store
            .issue_socket_ticket("tenant-a", "device-a", "/ws/events", "events", 110, 60)
            .unwrap();

        assert!(matches!(
            store.redeem_socket_ticket(&ticket, "/ws/terminal", "events", 111),
            Err(SecurityStoreError::InvalidSocketTicket)
        ));
        assert_eq!(
            store
                .redeem_socket_ticket(&ticket, "/ws/events", "events", 111)
                .unwrap(),
            SocketIdentity {
                tenant_id: "tenant-a".into(),
                device_id: "device-a".into(),
            }
        );
        assert!(matches!(
            store.redeem_socket_ticket(&ticket, "/ws/events", "events", 112),
            Err(SecurityStoreError::InvalidSocketTicket)
        ));

        let expired = store
            .issue_socket_ticket("tenant-a", "device-a", "/ws/events", "events", 120, 1)
            .unwrap();
        assert!(matches!(
            store.redeem_socket_ticket(&expired, "/ws/events", "events", 122),
            Err(SecurityStoreError::InvalidSocketTicket)
        ));
    }

    #[test]
    fn service_principal_uses_canonical_capabilities_and_socket_ledger() {
        let store = SecurityStore::in_memory().unwrap();
        store
            .ensure_service_principal("tenant-a", "acp-cli", "ACP CLI", &["agent.run"], 100)
            .unwrap();

        assert_eq!(
            store.capability_snapshot("tenant-a", "acp-cli").unwrap(),
            Some(vec!["agent.run".to_string()])
        );
        assert!(store.list_devices("tenant-a").unwrap().is_empty());

        let ticket = store
            .issue_socket_ticket("tenant-a", "acp-cli", "/ws/acp", "acp", 101, 60)
            .unwrap();
        assert_eq!(
            store
                .redeem_socket_ticket(&ticket, "/ws/acp", "acp", 102)
                .unwrap(),
            SocketIdentity {
                tenant_id: "tenant-a".into(),
                device_id: "acp-cli".into(),
            }
        );
    }

    #[test]
    fn last_owner_revoke_requires_trust_root_override_and_closes_tickets() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        let ticket = store
            .issue_socket_ticket("tenant-a", "device-a", "/ws/events", "events", 110, 60)
            .unwrap();
        assert!(matches!(
            store.revoke_device("tenant-a", "device-a", "device-a", false, 111),
            Err(SecurityStoreError::LastOwner)
        ));
        store
            .revoke_device("tenant-a", "local-trust-root", "device-a", true, 112)
            .unwrap();
        assert!(store
            .active_device_key("tenant-a", "device-a")
            .unwrap()
            .is_none());
        assert!(matches!(
            store.redeem_socket_ticket(&ticket, "/ws/events", "events", 113),
            Err(SecurityStoreError::InvalidSocketTicket)
        ));
    }

    #[test]
    fn tenant_boundaries_apply_to_device_keys_and_registration() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        assert!(store
            .active_device_key("tenant-b", "device-a")
            .unwrap()
            .is_none());
    }

    #[test]
    fn oidc_registration_consumes_challenge_and_assigns_role_preset() {
        let store = SecurityStore::in_memory().unwrap();
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        store
            .register_oidc_device(
                "tenant-a",
                "oidc-admin",
                &challenge.id,
                &challenge.nonce,
                "device-a",
                "Cloud phone",
                "pem",
                "thumb-a",
                "owner",
                101,
            )
            .unwrap();
        assert!(store
            .has_capability("tenant-a", "device-a", "host.admin")
            .unwrap());
        assert!(!store
            .has_capability("tenant-a", "device-a", "service.internal")
            .unwrap());
        assert!(matches!(
            store.register_oidc_device(
                "tenant-a",
                "oidc-admin",
                &challenge.id,
                &challenge.nonce,
                "device-b",
                "Replay",
                "pem-2",
                "thumb-b",
                "member",
                102,
            ),
            Err(SecurityStoreError::InvalidChallenge)
        ));
    }

    #[test]
    fn oidc_member_defaults_are_usable_but_least_privilege() {
        let store = SecurityStore::in_memory().unwrap();
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        store
            .register_oidc_device(
                "tenant-a",
                "member-user",
                &challenge.id,
                &challenge.nonce,
                "member-device",
                "Member browser",
                "pem",
                "thumb-member",
                "member",
                101,
            )
            .unwrap();
        assert_eq!(
            store
                .capability_snapshot("tenant-a", "member-device")
                .unwrap()
                .unwrap(),
            vec!["agent.run", "host.observe", "workspace.read"]
        );
        assert!(!store
            .has_capability("tenant-a", "member-device", "workspace.write")
            .unwrap());
    }

    #[test]
    fn owner_capabilities_replace_atomically_and_list_returns_the_snapshot() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "owner-a", 100);
        let replaced = store
            .replace_device_capabilities(
                "tenant-a",
                "owner-a",
                "owner-a",
                &[
                    "host.admin".into(),
                    "host.observe".into(),
                    "scheduler.manage".into(),
                ],
                110,
            )
            .unwrap();
        assert_eq!(
            replaced,
            vec!["host.admin", "host.observe", "scheduler.manage"]
        );
        assert_eq!(
            store.list_devices("tenant-a").unwrap()[0].capabilities,
            replaced
        );
        assert!(matches!(
            store.replace_device_capabilities(
                "tenant-a",
                "owner-a",
                "owner-a",
                &["service.internal".into()],
                111,
            ),
            Err(SecurityStoreError::InvalidCapabilities)
        ));
        assert_eq!(
            store
                .capability_snapshot("tenant-a", "owner-a")
                .unwrap()
                .unwrap(),
            vec!["host.admin", "host.observe", "scheduler.manage"]
        );
    }

    #[test]
    fn agent_worker_is_assignable_but_never_inherited_from_agent_control() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "owner-a", 100);
        assert!(!store
            .has_capability("tenant-a", "owner-a", "agent.worker")
            .unwrap());

        let capabilities = vec!["host.admin".into(), "agent.worker".into()];
        store
            .replace_device_capabilities("tenant-a", "owner-a", "owner-a", &capabilities, 110)
            .unwrap();
        assert!(store
            .has_capability("tenant-a", "owner-a", "agent.worker")
            .unwrap());
        assert!(!store
            .has_capability("tenant-a", "owner-a", "agent.run")
            .unwrap());
        assert!(!store
            .has_capability("tenant-a", "owner-a", "terminal.open")
            .unwrap());
    }

    #[test]
    fn legacy_grants_are_imported_once_so_revocation_cannot_reappear() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "owner-a", 100);
        assert!(store
            .migrate_legacy_device_grants(&["owner-a".into()], &[], &[], 110)
            .unwrap());
        let reduced = vec!["host.admin".into(), "host.observe".into()];
        store
            .replace_device_capabilities("tenant-a", "owner-a", "owner-a", &reduced, 111)
            .unwrap();
        assert!(!store
            .migrate_legacy_device_grants(&["owner-a".into()], &[], &[], 112)
            .unwrap());
        assert!(!store
            .has_capability("tenant-a", "owner-a", "workspace.write")
            .unwrap());
    }

    #[test]
    fn idempotency_survives_retries_and_rejects_payload_drift() {
        let store = SecurityStore::in_memory().unwrap();
        let started = store
            .begin_idempotent_operation("tenant-a", "device-a", "host-a", "key-a", "hash-a", 100)
            .unwrap();
        let operation_id = match started {
            IdempotencyDecision::Started { operation_id } => operation_id,
            other => panic!("unexpected decision: {other:?}"),
        };
        let run = || {
            store
                .conn
                .lock()
                .query_row(
                    "SELECT host_id, status FROM runs WHERE id = ?1",
                    [&operation_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .unwrap()
        };
        assert_eq!(run(), ("host-a".into(), "queued".into()));
        assert_eq!(
            store
                .begin_idempotent_operation(
                    "tenant-a", "device-a", "host-b", "key-a", "hash-a", 101,
                )
                .unwrap(),
            IdempotencyDecision::InProgress {
                operation_id: operation_id.clone()
            }
        );
        assert!(matches!(
            store.begin_idempotent_operation(
                "tenant-a",
                "device-a",
                "host-a",
                "key-a",
                "different",
                102,
            ),
            Err(SecurityStoreError::IdempotencyConflict)
        ));
        store
            .mark_operation_running("tenant-a", &operation_id, 102)
            .unwrap();
        assert_eq!(run(), ("host-a".into(), "running".into()));
        store
            .complete_idempotent_operation(
                "tenant-a",
                "device-a",
                "key-a",
                r#"{"httpStatus":200,"body":{"ok":true}}"#,
                true,
                103,
            )
            .unwrap();
        assert_eq!(run(), ("host-a".into(), "succeeded".into()));
        assert_eq!(
            store
                .begin_idempotent_operation(
                    "tenant-a", "device-a", "host-b", "key-a", "hash-a", 104,
                )
                .unwrap(),
            IdempotencyDecision::Completed {
                operation_id,
                receipt_json: r#"{"httpStatus":200,"body":{"ok":true}}"#.into()
            }
        );
    }

    #[test]
    fn host_policy_is_tenant_capability_command_and_expiry_bound() {
        let store = SecurityStore::in_memory().unwrap();
        let policy = store
            .create_host_policy(
                "tenant-a",
                "owner-a",
                "process.spawn",
                &serde_json::json!({
                    "version": 1,
                    "commands": ["mcp_server_start"],
                    "constraints": {
                        "network": false
                    }
                }),
                Some(200),
                100,
            )
            .unwrap();
        assert!(store
            .authorize_host_policy(
                "tenant-a",
                &policy.policy_id,
                "process.spawn",
                "mcp_server_start",
                150,
            )
            .is_ok());
        for denied in [
            store.authorize_host_policy(
                "tenant-b",
                &policy.policy_id,
                "process.spawn",
                "mcp_server_start",
                150,
            ),
            store.authorize_host_policy(
                "tenant-a",
                &policy.policy_id,
                "secret.manage",
                "mcp_server_start",
                150,
            ),
            store.authorize_host_policy(
                "tenant-a",
                &policy.policy_id,
                "process.spawn",
                "spawn_external_agent",
                150,
            ),
            store.authorize_host_policy(
                "tenant-a",
                &policy.policy_id,
                "process.spawn",
                "mcp_server_start",
                201,
            ),
        ] {
            assert!(matches!(denied, Err(SecurityStoreError::InvalidPolicy)));
        }
        assert_eq!(
            store.list_host_policies("tenant-a", 150).unwrap(),
            vec![policy]
        );
        assert!(store
            .list_host_policies("tenant-a", 201)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reopening_terminally_fails_incomplete_operations_without_replaying_them() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("security.sqlite");
        let store = SecurityStore::open(&path).unwrap();
        let started = store
            .begin_idempotent_operation("tenant-a", "device-a", "host-a", "key-a", "hash-a", 100)
            .unwrap();
        let IdempotencyDecision::Started { operation_id } = started else {
            panic!("expected a new operation");
        };
        store
            .mark_operation_running("tenant-a", &operation_id, 101)
            .unwrap();
        drop(store);

        let reopened = SecurityStore::open(&path).unwrap();
        let status: String = reopened
            .conn
            .lock()
            .query_row(
                "SELECT status FROM runs WHERE id = ?1",
                [&operation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "failed");
        let decision = reopened
            .begin_idempotent_operation("tenant-a", "device-a", "host-b", "key-a", "hash-a", 102)
            .unwrap();
        let IdempotencyDecision::Completed {
            operation_id: completed_id,
            receipt_json,
        } = decision
        else {
            panic!("expected a terminal receipt");
        };
        assert_eq!(completed_id, operation_id);
        let receipt: serde_json::Value = serde_json::from_str(&receipt_json).unwrap();
        assert_eq!(receipt["error"]["code"], "operation_interrupted");
        assert_eq!(receipt["error"]["retryable"], true);
    }
}
