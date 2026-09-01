//! Rust-owned security and execution ledger for the canonical Companion API.
//!
//! Authorization state is transactional SQLite data. UI databases may cache
//! projections, but they are never consulted as an authority.

use once_cell::sync::Lazy;
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
    /// The extension origin this device was registered from, for a browser
    /// companion; `None` for every other device class.
    ///
    /// It rides on the snapshot rather than being a second query because the
    /// check it feeds is on the authentication path: a browser device's every
    /// request must carry this exact `Origin`. `WebOriginPolicy` alone cannot
    /// enforce that — a request with no `Origin` header at all is classified
    /// `Native` and allowed, which is the right default for a native client
    /// and the wrong one for a device that is definitionally a browser.
    pub bound_origin: Option<String>,
}

/// One enrollable device class: its own token table, and what consuming a
/// token from it grants.
///
/// The tables stay separate on purpose. The two classes consume into different
/// capability sets, and a token that could be spent on either would make the
/// device class a property of whichever endpoint happened to receive it —
/// exactly the client-chosen label the registration path refuses to trust.
/// What is shared is the *procedure*, not the token space.
struct EnrollmentClass {
    /// Table name, interpolated into SQL because a table name cannot be bound
    /// as a parameter. Safe by construction: the only values are the two
    /// private constants below, never anything reaching this from a request.
    table: &'static str,
    /// Granted on registration, and nothing else is.
    capabilities: &'static [&'static str],
    created_audit: &'static str,
    registered_audit: &'static str,
}

/// A least-privilege execution worker: agent work, and no ordinary agent
/// control, terminal, remote control or Owner authority.
const WORKER_ENROLLMENT: EnrollmentClass = EnrollmentClass {
    table: "worker_enrollments",
    capabilities: &["agent.worker"],
    created_audit: "worker_enrollment.created",
    registered_audit: "worker.registered",
};

/// A Cognia browser companion extension.
///
/// A browser device never receives `host.observe`, `agent.run`, `workspace.*`,
/// `terminal.open`, `process.spawn` or Owner authority. The two it does hold
/// name one closed effect each — submit a captured page as a new task, and read
/// back the submissions this same device made.
const BROWSER_ENROLLMENT: EnrollmentClass = EnrollmentClass {
    table: "browser_enrollments",
    capabilities: &["browser.submit", "browser.read-own"],
    created_audit: "browser_enrollment.created",
    registered_audit: "browser.registered",
};

/// The device half of a registration, gathered so the shared path does not take
/// nine positional `&str`s that are trivial to transpose.
struct EnrolledDevice<'a> {
    tenant_id: &'a str,
    enrollment: &'a str,
    challenge_id: &'a str,
    challenge_nonce: &'a str,
    device_id: &'a str,
    display_name: &'a str,
    public_key_pem: &'a str,
    public_key_thumbprint: &'a str,
    now: i64,
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
    /// ADR-0149: the `usr_…` this profile belongs to, once somebody has signed
    /// in. `None` on a profile that has only ever been unlocked locally, which
    /// stays a supported state forever — a person is a fact laid on top of a
    /// profile, never a precondition for opening one.
    pub user_id: Option<String>,
    /// The `org_…` that sign-in was scoped to, when the token carried one.
    pub org_id: Option<String>,
}

impl HostBinding {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            local_account_namespace: row.get(0)?,
            tenant_id: row.get(1)?,
            verifier_digest: row.get(2)?,
            pair_host_id: row.get(3)?,
            user_id: row.get(4)?,
            org_id: row.get(5)?,
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
    Quarantined,
    Suspended,
    Revoked,
}

impl DeviceLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Quarantined => "quarantined",
            Self::Suspended => "suspended",
            Self::Revoked => "revoked",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "active" => Some(Self::Active),
            "quarantined" => Some(Self::Quarantined),
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
    /// The person this device belongs to — ADR-0149 §5, step one.
    ///
    /// `None` for a device enrolled before anyone signed in on this profile,
    /// which stays a supported state. Reported so the console can answer "whose
    /// machine is this?"; **not** consulted by any capability check yet.
    pub user_id: Option<String>,
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

/// The owner half of the capability decision — ADR-0149 §5, step **two**.
///
/// # Why this is a predicate and not a lookup
///
/// Authorization is meant to resolve `device -> user -> membership ->
/// capability`. On the host, the middle step is bounded by what the host can
/// actually know: `host_bindings` records the ONE person this tenant belongs
/// to, and there is no membership table here — memberships are the
/// collaboration server's, and a stale local mirror that *granted* would be a
/// hole while one that *narrowed* would lock people out on every network
/// hiccup. So the host enforces the part it can prove: the device's person
/// must be the person this host acts for.
///
/// The shape is still the intersection the ADR describes. The person's ceiling
/// is "everything" for the bound person and "nothing" for anyone else, and the
/// device's own `capability_grants` narrow it from there. When a membership
/// mirror eventually lands, only the ceiling gets finer; the rule does not
/// move.
///
/// What this DOES stop: person A signs out, person B signs in on the same
/// machine, and A's still-paired phone keeps running agents on B's host. Until
/// now it could.
///
/// # Why both NULLs pass
///
/// `h.user_id IS NULL` — nobody has signed in on this host. That is a
/// supported state (ADR-0149 §9) and the overwhelmingly common one: identity
/// is optional, `account_bind_person` needs a Logto issuer this host may not
/// have configured at all, and a local-only desktop can never fill the column.
/// It cannot mean "deny".
///
/// `d.user_id IS NULL` — the device was enrolled before ADR-0149, or while
/// nobody was signed in. Every device that existed before step one is in this
/// state; denying them is the fleet-wide lockout step one existed to avoid.
/// Sign-in adopts them (`adopt_unowned_devices`), which is how the column
/// fills in without a backfill that would have guessed.
///
/// Requiring BOTH ids instead is a strictly larger rule than the attack above
/// needs — A-signed-out/B-signed-in is already `Some(a) != Some(b)` — and with
/// no migration behind it, it denied every pre-existing pairing on upgrade.
pub const OWNER_PREDICATE_SQL: &str =
    "(h.user_id IS NULL OR d.user_id IS NULL OR d.user_id = h.user_id)";

/// The Rust twin of [`OWNER_PREDICATE_SQL`], for callers that already hold both
/// ids. A test drives the two over the same table of cases, so neither can
/// drift into answering differently from the other.
pub fn owner_permits(host_person: Option<&str>, device_person: Option<&str>) -> bool {
    match (host_person, device_person) {
        (Some(host), Some(device)) => host == device,
        _ => true,
    }
}

/// The one capability query. Built from [`OWNER_PREDICATE_SQL`] rather than
/// spelling the predicate again, so there is a single copy to audit.
///
/// `host_bindings.tenant_id` is `UNIQUE`, so the `LEFT JOIN` adds at most one
/// row and cannot multiply the count — which is the concrete reason ADR-0149
/// §9's "relax that constraint" is not free.
///
/// Built ONCE, not per call: `has_capability` sits on the companion request
/// path — `rpc.rs`, `ws_terminal.rs` and `remote_execution.rs` all reach it —
/// so formatting a ~400-byte query per request, before the connection lock is
/// even taken, was pure overhead. `Lazy` keeps the single-copy-to-audit
/// property without paying for it on every decision.
static CAPABILITY_DECISION_SQL: Lazy<String> = Lazy::new(|| {
    format!(
        "SELECT COUNT(*)
         FROM capability_grants g
         JOIN devices d ON d.tenant_id = g.tenant_id AND d.id = g.device_id
         LEFT JOIN host_bindings h ON h.tenant_id = g.tenant_id
         WHERE g.tenant_id = ?1 AND g.device_id = ?2 AND g.capability = ?3
           AND g.revoked_at IS NULL AND d.status = 'active'
           AND {OWNER_PREDICATE_SQL}"
    )
});

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
        self.create_enrollment(&WORKER_ENROLLMENT, tenant_id, actor_id, now, ttl_secs)
    }

    /// Mint a one-time enrollment secret into `class`'s own table.
    ///
    /// The class is a parameter rather than the tables being merged: which
    /// table a token lives in *is* the device class, and that is what lets
    /// [`Self::register_enrolled_device`] assert the class instead of trusting
    /// a label the client chose. What the two classes share — the two-UUID
    /// secret, the hash-at-rest, the TTL, the audit row — is shared here so a
    /// fix to any of it cannot land on only one of them.
    fn create_enrollment(
        &self,
        class: &EnrollmentClass,
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
            &format!(
                "INSERT INTO {}
             (id, tenant_id, token_hash, expires_at, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                class.table
            ),
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
            class.created_audit,
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

        // ADR-0149 §5: a device belongs to whoever enrolled it, and the only
        // person this host can name is the one bound to the tenant. `None`
        // when nobody has signed in, which is a supported state.
        let owner = host_person_for_tenant(&tx, tenant_id)?;
        // Enrol ACTIVE even when no person is bound. Quarantining on "nobody
        // has signed in" is the same fleet-wide lockout `OWNER_PREDICATE_SQL`
        // documents: identity is optional here, so on a local-only host that
        // condition is permanent and every new pairing would enrol unusable
        // with no un-quarantine path. Quarantine stays what it is elsewhere —
        // a deliberate act (`assign_device_user` clearing or reassigning an
        // owner), not the default outcome of an unconfigured host.
        let status = "active";
        tx.execute(
            "INSERT INTO devices
             (id, tenant_id, display_name, role, status, user_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'owner', ?4, ?5, ?6, ?6)",
            params![device_id, tenant_id, display_name, status, owner, now],
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
        self.register_enrolled_device(
            &WORKER_ENROLLMENT,
            EnrolledDevice {
                tenant_id,
                enrollment,
                challenge_id,
                challenge_nonce,
                device_id,
                display_name,
                public_key_pem,
                public_key_thumbprint,
                now,
            },
            |_tx| Ok(()),
        )
    }

    /// Consume `class`'s enrollment and register the device it names.
    ///
    /// One transaction, in this order and no other: consume the challenge,
    /// find the enrollment, consume the enrollment, write the device, write its
    /// key, grant exactly `class.capabilities`, audit. Every step is a
    /// single-row `UPDATE` whose affected count is checked, so a replay of
    /// either secret loses the race rather than registering a second device.
    ///
    /// `extra` writes whatever the class needs beyond a device — the browser
    /// class's bound origin — inside the same transaction, so a device can
    /// never exist without it.
    fn register_enrolled_device(
        &self,
        class: &EnrollmentClass,
        device: EnrolledDevice<'_>,
        extra: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), SecurityStoreError>,
    ) -> Result<(), SecurityStoreError> {
        let EnrolledDevice {
            tenant_id,
            enrollment,
            challenge_id,
            challenge_nonce,
            device_id,
            display_name,
            public_key_pem,
            public_key_thumbprint,
            now,
        } = device;
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
                &format!(
                    "SELECT id FROM {}
                 WHERE tenant_id = ?1 AND token_hash = ?2
                   AND consumed_at IS NULL AND expires_at >= ?3",
                    class.table
                ),
                params![tenant_id, hash_secret(enrollment), now],
                |row| row.get(0),
            )
            .optional()?;
        let enrollment_id = enrollment_id.ok_or(SecurityStoreError::InvalidInvitation)?;
        if tx.execute(
            &format!(
                "UPDATE {} SET consumed_at = ?1, consumed_by_device_id = ?2
             WHERE id = ?3 AND consumed_at IS NULL",
                class.table
            ),
            params![now, device_id, enrollment_id],
        )? != 1
        {
            return Err(SecurityStoreError::InvalidInvitation);
        }
        let owner = host_person_for_tenant(&tx, tenant_id)?;
        // Enrol ACTIVE even when no person is bound. Quarantining on "nobody
        // has signed in" is the same fleet-wide lockout `OWNER_PREDICATE_SQL`
        // documents: identity is optional here, so on a local-only host that
        // condition is permanent and every new pairing would enrol unusable
        // with no un-quarantine path. Quarantine stays what it is elsewhere —
        // a deliberate act (`assign_device_user` clearing or reassigning an
        // owner), not the default outcome of an unconfigured host.
        let status = "active";
        tx.execute(
            "INSERT INTO devices
             (id, tenant_id, display_name, role, status, user_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'member', ?4, ?5, ?6, ?6)",
            params![device_id, tenant_id, display_name, status, owner, now],
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
        extra(&tx)?;
        for capability in class.capabilities {
            upsert_capability_grant(&tx, tenant_id, device_id, capability, now)?;
        }
        insert_audit(
            &tx,
            tenant_id,
            device_id,
            class.registered_audit,
            device_id,
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Create a one-time enrollment for a browser companion extension.
    ///
    /// Its own table rather than a reuse of `worker_enrollments`: the two
    /// consume into different capability sets, and a token that can be spent
    /// on either would make the device class a property of whichever endpoint
    /// happened to receive it. Keeping the tables apart is what lets
    /// [`Self::register_browser_device`] assert the class instead of trusting
    /// a client-supplied label.
    pub fn create_browser_enrollment(
        &self,
        tenant_id: &str,
        actor_id: &str,
        now: i64,
        ttl_secs: i64,
    ) -> Result<String, SecurityStoreError> {
        self.create_enrollment(&BROWSER_ENROLLMENT, tenant_id, actor_id, now, ttl_secs)
    }

    /// Consume a browser enrollment and register a companion extension with
    /// only `browser.submit` and `browser.read-own`.
    ///
    /// A browser device never receives `host.observe`, `agent.run`,
    /// `workspace.*`, `terminal.open`, `process.spawn` or Owner authority. The
    /// two it does hold name one closed effect each — submit a captured page
    /// as a new task, and read back the submissions this same device made.
    ///
    /// `extension_origin` is recorded here and replayed on every subsequent
    /// request (see [`AuthorizationSnapshot::bound_origin`]). It is validated
    /// by the caller against `extension_origin::is_cognia_extension_origin`
    /// before it reaches this method.
    #[allow(clippy::too_many_arguments)]
    pub fn register_browser_device(
        &self,
        tenant_id: &str,
        enrollment: &str,
        challenge_id: &str,
        challenge_nonce: &str,
        device_id: &str,
        display_name: &str,
        public_key_pem: &str,
        public_key_thumbprint: &str,
        extension_origin: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        self.register_enrolled_device(
            &BROWSER_ENROLLMENT,
            EnrolledDevice {
                tenant_id,
                enrollment,
                challenge_id,
                challenge_nonce,
                device_id,
                display_name,
                public_key_pem,
                public_key_thumbprint,
                now,
            },
            |tx| {
                tx.execute(
                    "INSERT INTO browser_devices
                     (device_id, tenant_id, extension_origin, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![device_id, tenant_id, extension_origin, now],
                )?;
                Ok(())
            },
        )
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
        let owner = host_person_for_tenant(&tx, tenant_id)?;
        // Enrol ACTIVE even when no person is bound. Quarantining on "nobody
        // has signed in" is the same fleet-wide lockout `OWNER_PREDICATE_SQL`
        // documents: identity is optional here, so on a local-only host that
        // condition is permanent and every new pairing would enrol unusable
        // with no un-quarantine path. Quarantine stays what it is elsewhere —
        // a deliberate act (`assign_device_user` clearing or reassigning an
        // owner), not the default outcome of an unconfigured host.
        let status = "active";
        tx.execute(
            "INSERT INTO devices
             (id, tenant_id, display_name, role, status, user_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![device_id, tenant_id, display_name, role, status, owner, now],
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

    /// Record (or clear) the person a device belongs to — ADR-0149 §5, step one.
    ///
    /// Assigning a person only activates the device when that same person is
    /// already bound to this tenant; otherwise it is quarantined until the
    /// claim path can prove both sides of the relationship.
    ///
    /// Clearing RESTORES it. Clearing exists because adoption can be wrong — a
    /// shared machine, a device handed on — and it is the only un-quarantine
    /// path a human has, so making it quarantine too turned "correct a wrong
    /// owner" into "brick the device". An unowned device is exactly the state
    /// [`OWNER_PREDICATE_SQL`] permits, so there is nothing left to hold it
    /// back.
    pub fn assign_device_user(
        &self,
        tenant_id: &str,
        device_id: &str,
        user_id: Option<&str>,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let changed = self.conn.lock().execute(
            "UPDATE devices SET user_id = ?3,
                -- Quarantine only on a PROVEN conflict: a person is bound to
                -- this tenant and it is not the one being assigned. Anything
                -- else ('nobody signed in here', 'no owner claimed') is a state
                -- `OWNER_PREDICATE_SQL` permits, so parking it would deny a
                -- device the decision query would have allowed — the two must
                -- not disagree.
                status = CASE
                    WHEN status = 'revoked' THEN status
                    WHEN EXISTS (
                        SELECT 1 FROM host_bindings h
                         WHERE h.tenant_id = ?1
                           AND h.user_id IS NOT NULL
                           AND ?3 IS NOT NULL
                           AND h.user_id <> ?3
                    ) THEN 'quarantined'
                    ELSE 'active'
                END,
                updated_at = ?4
             WHERE tenant_id = ?1 AND id = ?2",
            params![tenant_id, device_id, user_id, now],
        )?;
        if changed == 0 {
            return Err(SecurityStoreError::DeviceUnavailable);
        }
        Ok(())
    }

    /// Attribute this tenant's unowned devices to `user_id`, returning how many.
    ///
    /// Called at sign-in. A device with no owner was enrolled on a profile
    /// before anybody signed in on it, and the profile is one person's
    /// encryption boundary — its password is theirs — so the person who just
    /// proved they hold it is the honest answer.
    ///
    /// Deliberately only touches rows where `user_id IS NULL`. A device already
    /// attributed to somebody keeps its owner: signing in must never reassign
    /// another person's machine, which is precisely the failure a blanket
    /// backfill would cause on a host two people share.
    pub fn adopt_unowned_devices(
        &self,
        tenant_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<usize, SecurityStoreError> {
        let adopted = self.conn.lock().execute(
            "UPDATE devices SET user_id = ?2,
                    status = CASE WHEN status = 'quarantined' THEN 'active' ELSE status END,
                    updated_at = ?3
             WHERE tenant_id = ?1 AND user_id IS NULL",
            params![tenant_id, user_id, now],
        )?;
        Ok(adopted)
    }

    /// Which person a device belongs to, or `None` if nobody has claimed it.
    pub fn device_user(
        &self,
        tenant_id: &str,
        device_id: &str,
    ) -> Result<Option<String>, SecurityStoreError> {
        let found: Option<Option<String>> = self
            .conn
            .lock()
            .query_row(
                "SELECT user_id FROM devices WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, device_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.flatten())
    }

    /// Whether this device is the tenant's Owner, i.e. the deployment's trust
    /// root rather than a member acting under it.
    ///
    /// Only `active` Owners count. A revoked or suspended Owner row must not
    /// keep authorizing anything, which is the whole point of revoking it.
    pub fn is_owner_device(
        &self,
        tenant_id: &str,
        device_id: &str,
    ) -> Result<bool, SecurityStoreError> {
        let count: i64 = self.conn.lock().query_row(
            "SELECT COUNT(*) FROM devices \
             WHERE tenant_id = ?1 AND id = ?2 AND role = 'owner' AND status = 'active'",
            params![tenant_id, device_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn has_capability(
        &self,
        tenant_id: &str,
        device_id: &str,
        capability: &str,
    ) -> Result<bool, SecurityStoreError> {
        let count: i64 = self.conn.lock().query_row(
            CAPABILITY_DECISION_SQL.as_str(),
            params![tenant_id, device_id, capability],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Every device that is not `active`, across all tenants.
    ///
    /// Feeds [`super::deny_list::DenyList::seed_from_store`] at startup. The
    /// deny list used to be seeded from the renderer's Dexie mirror, which
    /// meant a revocation survived a restart only if the renderer had written
    /// that row — and under a real local account it never did, so every reboot
    /// silently un-revoked everything. Reading the store is the fix: the store
    /// is where the revocation was actually recorded.
    ///
    /// Returns `(tenant_id, device_id)` because the deny list is keyed by both;
    /// a bare device id would let one tenant's revocation reject another
    /// tenant's device of the same id.
    pub fn list_inactive_devices(&self) -> Result<Vec<(String, String)>, SecurityStoreError> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(
            "SELECT tenant_id, id FROM devices
             WHERE status != 'active'
             ORDER BY tenant_id, id",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn list_devices(&self, tenant_id: &str) -> Result<Vec<DeviceSummary>, SecurityStoreError> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(
            "SELECT id, display_name, role, status, user_id, created_at, updated_at
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
                user_id: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
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
        // The browser class's two capabilities are not *assignable* — no
        // ordinary device may be handed them — but the browser device itself
        // holds them, and every caller of this method reads that device's live
        // snapshot and hands it straight back (`apply_device_grant`,
        // `companion_set_worker`, the `fleet_worker_set` arm, the Owner route,
        // `cognia-server devices grant|revoke`). Rejecting them by name would
        // therefore not make the class unforgeable, it would make a browser
        // device's grants uneditable. So the check is on the device's class,
        // which `browser_devices` decides and no request can claim.
        let is_browser_device: bool = tx.query_row(
            "SELECT EXISTS (
                 SELECT 1 FROM browser_devices WHERE tenant_id = ?1 AND device_id = ?2
             )",
            params![tenant_id, device_id],
            |row| row.get(0),
        )?;
        if normalized.iter().any(|capability| {
            !is_assignable_device_capability(capability)
                && (!is_browser_device
                    || !BROWSER_ENROLLMENT
                        .capabilities
                        .contains(&capability.as_str()))
        }) {
            return Err(SecurityStoreError::InvalidCapabilities);
        }
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
             SELECT k.public_key_pem, k.thumbprint, g.capability, b.extension_origin
             FROM devices d
             JOIN active_key k
             LEFT JOIN capability_grants g
               ON g.tenant_id = d.tenant_id AND g.device_id = d.id
              AND g.revoked_at IS NULL
             LEFT JOIN browser_devices b
               ON b.tenant_id = d.tenant_id AND b.device_id = d.id
             WHERE d.tenant_id = ?1 AND d.id = ?2 AND d.status = 'active'
             ORDER BY g.capability",
        )?;
        let rows = statement.query_map(params![tenant_id, device_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut snapshot: Option<AuthorizationSnapshot> = None;
        for row in rows {
            let (public_key_pem, key_thumbprint, capability, bound_origin) = row?;
            let current = snapshot.get_or_insert_with(|| AuthorizationSnapshot {
                public_key_pem,
                key_thumbprint,
                capabilities: Vec::new(),
                bound_origin,
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
                "SELECT local_account_namespace, tenant_id, verifier_digest, pair_host_id,
                        user_id, org_id
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
                "SELECT local_account_namespace, tenant_id, verifier_digest, pair_host_id,
                        user_id, org_id
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
        let unclaimed: Option<(String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT tenant_id, user_id, org_id
                 FROM host_bindings WHERE local_account_namespace = ?1",
                [LOCAL_NAMESPACE_UNBOUND],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        let binding = if let Some((tenant_id, user_id, org_id)) = unclaimed {
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
                user_id,
                org_id,
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
                // A brand-new row: nobody has signed into this profile yet.
                user_id: None,
                org_id: None,
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

    /// Record which person a bound profile belongs to — ADR-0149 §9.
    ///
    /// Separate from [`Self::bind_host_account`] on purpose. That one is
    /// reached by a verified password unlock and proves a PROFILE; this one is
    /// reached by a completed sign-in and asserts a PERSON. Collapsing them
    /// would make signing in look like it re-proved the profile, and would put
    /// a renderer-supplied user id on the same path as the verifier pin.
    ///
    /// Refuses a namespace that has no binding: a person cannot be attached to
    /// a profile this host has never seen unlocked.
    pub fn bind_host_person(
        &self,
        local_account_namespace: &str,
        user_id: &str,
        org_id: Option<&str>,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        let changed = self.conn.lock().execute(
            "UPDATE host_bindings SET user_id = ?1, org_id = ?2, updated_at = ?3
             WHERE local_account_namespace = ?4",
            params![user_id, org_id, now, local_account_namespace],
        )?;
        if changed == 0 {
            return Err(SecurityStoreError::HostBindingMismatch);
        }
        Ok(())
    }

    /// Forget the person on a profile (sign-out), keeping the profile binding.
    ///
    /// Signing out is not un-owning a tenant: the devices paired to this
    /// profile stay paired, exactly as locking the account leaves them paired.
    pub fn clear_host_person(
        &self,
        local_account_namespace: &str,
        now: i64,
    ) -> Result<(), SecurityStoreError> {
        self.conn.lock().execute(
            "UPDATE host_bindings SET user_id = NULL, org_id = NULL, updated_at = ?1
             WHERE local_account_namespace = ?2",
            params![now, local_account_namespace],
        )?;
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
            DeviceLifecycleState::Revoked | DeviceLifecycleState::Quarantined => {
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
            DeviceLifecycleState::Revoked | DeviceLifecycleState::Quarantined => {
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

/// The capabilities a freshly paired device of `role` holds.
///
/// Split out from [`insert_default_grants`] so the backfill migration
/// ([`migrate_client_plane_grants`]) reads the same list the registration path
/// writes. A device paired before those names existed must end up with the same
/// grants as one paired after, and two hand-kept lists is how that stops being
/// true.
fn default_capabilities_for_role(role: &str) -> &'static [&'static str] {
    if role == "owner" {
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
            // ADR-0162 file transfer over a synchronized SSH profile. An owner
            // device already holds `terminal.open` and `process.spawn`, so it
            // could reach the same bytes through a shell; withholding the
            // interface while granting the shell would be a distinction the
            // machine does not make. A MEMBER device gets nothing here and
            // needs the explicit `ssh-files` grant, which is where the ADR's
            // "off by default" bites.
            "ssh.files",
            // Dormant, deliberately, and pinned by
            // `every_grantable_capability_has_an_enforcement_point`. Neither
            // name is the required capability of any command in
            // `protocol/companion-commands.json`, so holding one grants
            // nothing today. They stay in the defaults rather than being
            // retired because `replace_capabilities` rejects the WHOLE
            // incoming list when any name is not assignable: an owner device
            // paired before this build already carries both, and the device
            // console reads the current grants and writes them back, so
            // dropping them from `is_assignable_device_capability` would turn
            // every capability edit on an existing owner into
            // `InvalidCapabilities`. Retiring them needs a store migration
            // that clears the rows first.
            "device.admin",
            "server.admin",
            "scheduler.manage",
            // The client data plane — this device's own sessions, messages,
            // transcripts and settings. `protocol/companion-commands.json`
            // gates 22 commands on these two (`sync_pull`, `session_list`,
            // `message_send`, `app_settings_update`, …) and nothing granted
            // them, so every paired device answered 403 to the entire mirror
            // it exists to serve. Pinned by
            // `owner_default_grants_cover_every_device_reachable_command`.
            "client.read",
            "client.write",
            // The performance plane. Unlike the client plane these commands
            // ARE device-reachable (`target: execution`, http/ws/webrtc), so
            // they cleared the transport gate and died one line later on a
            // capability no code path granted — the remote perf dashboard was
            // 403 for every paired device, owner included.
            "performance.observe",
            "performance.traces",
            "performance.capture",
        ]
    } else {
        // A member device reads its own client plane but does not write it;
        // `client.write` stays an explicit elevation, like `workspace.write`.
        &["host.observe", "agent.run", "workspace.read", "client.read"]
    }
}

/// The capabilities this build ADDED to the defaults, by role.
///
/// The backfill grants exactly these to devices that were paired before they
/// existed — not the whole default set. Re-asserting the older names would
/// silently un-revoke a capability an admin took away on purpose; these five
/// have no such history, because until this build nothing could grant them at
/// all (`is_assignable_device_capability` rejected every one).
fn backfilled_capabilities_for_role(role: &str) -> &'static [&'static str] {
    if role == "owner" {
        &[
            "client.read",
            "client.write",
            "performance.observe",
            "performance.traces",
            "performance.capture",
        ]
    } else {
        &["client.read"]
    }
}

fn insert_default_grants(
    tx: &rusqlite::Transaction<'_>,
    tenant_id: &str,
    device_id: &str,
    role: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    for capability in default_capabilities_for_role(role) {
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
            // Dormant: no command requires either (see the note in
            // `default_capabilities_for_role`). Accepted so an existing owner's
            // grant list still round-trips through `replace_capabilities`.
            | "device.admin"
            | "server.admin"
            // Assignable and command-less on purpose: `agent.worker` is
            // enforced by `ws_worker::worker_authorized` at the socket, not by
            // any RPC descriptor.
            | "agent.worker"
            | "client.read"
            | "client.write"
            | "performance.observe"
            | "performance.traces"
            | "performance.capture"
            // ADR-0162. Deliberately not `workspace.write`: that name is safe
            // because `authorize_workspace_root` confines it to a registered
            // directory, and SFTP has no equivalent confinement to offer. A
            // device holding this reads and writes the target machine as the
            // profile's user, and the name has to say so.
            | "ssh.files"
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
const MIGRATION_HOST_BINDING_PERSON: &str = "host-binding-person-v1";
const MIGRATION_DEVICE_USER: &str = "device-user-v1";
const MIGRATION_DEVICE_QUARANTINE: &str = "device-quarantine-v1";
const MIGRATION_CLIENT_PLANE_GRANTS: &str = "client-plane-grants-v1";
const MIGRATION_SSH_FILES_GRANT: &str = "ssh-files-grant-v1";

/// Steps 4-7 of the rebuild. The column list is spelled out rather than
/// `SELECT *` so that a future column landing in a different position cannot
/// silently transpose two values.
const DEVICES_REBUILD_SQL: &str = r#"
CREATE TABLE devices_new (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'service')),
    status TEXT NOT NULL CHECK(status IN ('active', 'quarantined', 'suspended', 'revoked')),
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

const DEVICES_QUARANTINE_REBUILD_SQL: &str = r#"
CREATE TABLE devices_new (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'service')),
    status TEXT NOT NULL CHECK(status IN ('active', 'quarantined', 'suspended', 'revoked')),
    user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
-- Status is carried across UNCHANGED. This migration widens the CHECK
-- constraint so `quarantined` becomes expressible; it does not park anybody.
-- Rewriting every NULL-owned row to 'quarantined' was the fleet-wide lockout
-- `migrate_device_user` is documented to avoid — `user_id IS NULL` is every
-- device enrolled before ADR-0149, and on a host where nobody ever signs in it
-- is every device, permanently.
INSERT INTO devices_new
    (id, tenant_id, display_name, role, status, user_id, created_at, updated_at)
    SELECT id, tenant_id, display_name, role, status,
           user_id, created_at, updated_at
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
    migrate_host_binding_person(conn, now)?;
    migrate_device_user(conn, now)?;
    migrate_device_quarantine(conn, now, backup_target)?;
    migrate_client_plane_grants(conn, now)?;
    migrate_ssh_files_grant(conn, now)?;
    Ok(())
}

/// Give devices that were already paired the client-plane and performance
/// capabilities this build added to the pairing defaults.
///
/// [`insert_default_grants`] only runs inside `register`, so without this an
/// upgrade fixes nothing for anybody: every existing pairing keeps answering
/// 403 `capability_denied` on `sync_pull`, `session_list`, `message_send`,
/// `app_settings_update` and the whole remote performance dashboard — the exact
/// failures the new defaults exist to end — and the only remedy would be to
/// unpair and pair again.
///
/// Scoped to the names in [`backfilled_capabilities_for_role`] and keyed by the
/// device's own role, so a member is not quietly promoted, and suspended
/// devices are included because suspension is a status the owner can lift
/// rather than a decision about capabilities.
///
/// The enrollment classes are excluded by construction. A browser or worker
/// device is a `member` row too, but it holds only its class's closed
/// capabilities — never `host.observe`, which both ordinary default sets carry
/// and neither class does. Selecting on that grant is what keeps this backfill
/// from handing a browser extension the client data plane its comment
/// explicitly denies it.
/// Give owner devices paired before ADR-0162 the `ssh.files` grant.
///
/// Its own marker rather than a line added to [`backfilled_capabilities_for_role`]:
/// that migration's marker is already committed on every existing host, so a
/// name appended to its list would reach a fresh database and nobody else. Each
/// backfill therefore owns the list it backfills.
///
/// Owner devices only, and re-granting is safe for the same reason the client
/// plane's was: until this build `is_assignable_device_capability` rejected the
/// name, so nobody can have revoked it on purpose and no revocation is being
/// undone. A member device is untouched, which is where the ADR's "granted
/// separately" lives.
fn migrate_ssh_files_grant(conn: &mut Connection, now: i64) -> Result<(), SecurityStoreError> {
    if migration_applied(conn, MIGRATION_SSH_FILES_GRANT)? {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let devices: Vec<(String, String)> = {
        let mut statement = tx.prepare(
            "SELECT d.id, d.tenant_id FROM devices d
             WHERE d.status IN ('active', 'suspended') AND d.role = 'owner'",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (device_id, tenant_id) in devices {
        upsert_capability_grant(&tx, &tenant_id, &device_id, "ssh.files", now)?;
    }
    mark_migration(&tx, MIGRATION_SSH_FILES_GRANT, now)?;
    tx.commit()?;
    Ok(())
}

fn migrate_client_plane_grants(conn: &mut Connection, now: i64) -> Result<(), SecurityStoreError> {
    if migration_applied(conn, MIGRATION_CLIENT_PLANE_GRANTS)? {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let devices: Vec<(String, String, String)> = {
        let mut statement = tx.prepare(
            "SELECT d.id, d.tenant_id, d.role FROM devices d
             WHERE d.status IN ('active', 'suspended')
               AND EXISTS (
                 SELECT 1 FROM capability_grants g
                 WHERE g.tenant_id = d.tenant_id AND g.device_id = d.id
                   AND g.capability = 'host.observe' AND g.revoked_at IS NULL
               )",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (device_id, tenant_id, role) in devices {
        for capability in backfilled_capabilities_for_role(&role) {
            upsert_capability_grant(&tx, &tenant_id, &device_id, capability, now)?;
        }
    }
    mark_migration(&tx, MIGRATION_CLIENT_PLANE_GRANTS, now)?;
    tx.commit()?;
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

/// Widen `host_bindings` to the ADR-0149 triple `(localProfile, user, org)`.
///
/// Both columns are added nullable and nothing is backfilled: an existing
/// binding was made by a password unlock, which proves a profile and says
/// nothing about who was holding it. Guessing a person here would attribute
/// somebody's paired devices to a name nobody asserted.
///
/// `tenant_id` keeps its UNIQUE constraint. ADR-0149 §9 notes it must eventually
/// be relaxed, but only once two profiles genuinely need to share one Org's
/// tenant — which needs the device→user resolution of Batch 4. Loosening a
/// uniqueness constraint on this table before anything requires it would widen
/// the blast radius of a renderer that lies about its account id, for no gain.
fn migrate_host_binding_person(conn: &mut Connection, now: i64) -> Result<(), SecurityStoreError> {
    if migration_applied(conn, MIGRATION_HOST_BINDING_PERSON)? {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for column in ["user_id", "org_id"] {
        let present: bool = {
            let mut statement = tx.prepare("PRAGMA table_info('host_bindings')")?;
            let names = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            names.iter().any(|name| name == column)
        };
        if !present {
            tx.execute(
                &format!("ALTER TABLE host_bindings ADD COLUMN {column} TEXT"),
                [],
            )?;
        }
    }
    mark_migration(&tx, MIGRATION_HOST_BINDING_PERSON, now)?;
    tx.commit()?;
    Ok(())
}

/// The person bound to a tenant on this host, if any.
///
/// `host_bindings.tenant_id` is UNIQUE, so this is a single row by construction
/// — which is also why relaxing that constraint is not free: it would make this
/// lookup ambiguous, and every device enrolled afterwards would inherit an
/// arbitrary one of the candidates.
fn host_person_for_tenant(
    conn: &Connection,
    tenant_id: &str,
) -> Result<Option<String>, SecurityStoreError> {
    let found: Option<Option<String>> = conn
        .query_row(
            "SELECT user_id FROM host_bindings WHERE tenant_id = ?1",
            params![tenant_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.flatten())
}

/// Give `devices` a `user_id` — ADR-0149 §5, step **one** of two.
///
/// The migration itself is still pure bookkeeping: the column is added
/// nullable and nothing is backfilled, because the host cannot name the person
/// behind a device that was enrolled before it could ask. Step **two** has
/// since landed, so [`SecurityStore::has_capability`] does now read the column.
/// A NULL row keeps working — see [`OWNER_PREDICATE_SQL`] — and is claimed at
/// the next sign-in by [`SecurityStore::adopt_unowned_devices`], which is the
/// backfill. Parking those rows instead would be the lockout this very comment
/// describes.
///
/// The split is not caution for its own sake. `capability_grants` is on the hot
/// request path — `rpc.rs`, `ws_terminal.rs` and `remote_execution.rs` all reach
/// it per request — so a release that both introduced the column and started
/// routing decisions through it would evaluate the new rule against devices
/// whose `user_id` is still NULL, which is every device that existed before the
/// upgrade. That is a fleet-wide lockout, and it is exactly what shipping the
/// two halves apart prevents: by the time the decision moves, the column has
/// been filling in for a release.
///
/// No backfill here for the same reason `migrate_host_binding_person` does
/// none: a device that predates any sign-in was enrolled by somebody this host
/// cannot name. Adoption is an explicit act, and it happens at sign-in through
/// [`SecurityStore::adopt_unowned_devices`], where a person has just proved who
/// they are.
fn migrate_device_user(conn: &mut Connection, now: i64) -> Result<(), SecurityStoreError> {
    if migration_applied(conn, MIGRATION_DEVICE_USER)? {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let present: bool = {
        let mut statement = tx.prepare("PRAGMA table_info('devices')")?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        names.iter().any(|name| name == "user_id")
    };
    if !present {
        tx.execute("ALTER TABLE devices ADD COLUMN user_id TEXT", [])?;
    }
    mark_migration(&tx, MIGRATION_DEVICE_USER, now)?;
    tx.commit()?;
    Ok(())
}

fn migrate_device_quarantine(
    conn: &mut Connection,
    now: i64,
    backup_target: Option<&Path>,
) -> Result<(), SecurityStoreError> {
    if migration_applied(conn, MIGRATION_DEVICE_QUARANTINE)? {
        return Ok(());
    }
    let already_widened =
        table_ddl(conn, "devices")?.is_some_and(|ddl| ddl.contains("'quarantined'"));
    if already_widened {
        // Nothing to rewrite: the CHECK constraint already admits
        // `quarantined`, and no existing row is parked (see
        // `DEVICES_QUARANTINE_REBUILD_SQL`).
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        mark_migration(&tx, MIGRATION_DEVICE_QUARANTINE, now)?;
        tx.commit()?;
        return Ok(());
    }

    let backup = match backup_target {
        Some(path) => write_pre_migration_backup(conn, path)?,
        None => None,
    };
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    conn.pragma_update(None, "legacy_alter_table", true)?;
    let outcome = rebuild_devices_for_quarantine(conn, now);
    conn.pragma_update(None, "legacy_alter_table", false)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    outcome?;
    if let Some(path) = backup {
        if let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(path = %path.display(), %error, "could not remove quarantine migration backup");
        }
    }
    Ok(())
}

fn rebuild_devices_for_quarantine(
    conn: &mut Connection,
    now: i64,
) -> Result<(), SecurityStoreError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(DEVICES_QUARANTINE_REBUILD_SQL)?;
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
        return Err(SecurityStoreError::Migration(format!(
            "the quarantine migration left {violations} foreign key violation(s)"
        )));
    }
    mark_migration(&tx, MIGRATION_DEVICE_QUARANTINE, now)?;
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
    -- ADR-0149 §5 step 1: whose machine this is. Nullable, and NOTHING reads it
    -- for an authorization decision yet -- see `assign_device_user`.
    user_id TEXT,
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
    -- ADR-0149: the person and organisation half of the binding triple.
    -- Nullable forever: a LocalProfile that nobody has signed into is a
    -- supported state, not an unfinished one.
    user_id                 TEXT,
    org_id                  TEXT,
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
CREATE TABLE IF NOT EXISTS browser_enrollments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,
    consumed_by_device_id TEXT
);
CREATE TABLE IF NOT EXISTS browser_devices (
    device_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    extension_origin TEXT NOT NULL,
    created_at INTEGER NOT NULL
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
        for table in ["device_keys", "socket_tickets"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1, "{table} lost its row across the rebuild");
        }
        // Grants are checked by identity rather than by count, because the
        // backfills that run alongside this rebuild legitimately ADD rows.
        // Counting would turn every future default-grant migration into a
        // failure of a test that is about a table rebuild.
        let seeded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM capability_grants
                 WHERE id = 'grant-1' AND device_id = 'device-active'
                   AND capability = 'terminal.open'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            seeded, 1,
            "capability_grants lost its row across the rebuild"
        );
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
        assert!(migration_applied(&conn, MIGRATION_DEVICE_QUARANTINE).unwrap());
    }

    /// The migration WIDENS the status vocabulary; it must not park anybody.
    ///
    /// Rewriting `user_id IS NULL` rows to `quarantined` denied every device
    /// enrolled before ADR-0149 the moment the release landed — and on a host
    /// where nobody signs in, permanently. Adoption at sign-in is the backfill.
    #[test]
    fn the_quarantine_migration_preserves_every_device_status() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE security_migrations (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
             CREATE TABLE devices (
                 id TEXT NOT NULL,
                 tenant_id TEXT NOT NULL,
                 display_name TEXT NOT NULL,
                 role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'service')),
                 status TEXT NOT NULL CHECK(status IN ('active', 'suspended', 'revoked')),
                 user_id TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (tenant_id, id)
             );
             INSERT INTO devices VALUES
               ('unowned', 'tenant-a', 'Old phone', 'member', 'active', NULL, 1, 1),
               ('owned', 'tenant-a', 'Known phone', 'member', 'active', 'usr_ada', 1, 1);",
        )
        .unwrap();

        migrate_device_quarantine(&mut conn, 200, None).unwrap();
        let unowned: String = conn
            .query_row(
                "SELECT status FROM devices WHERE id = 'unowned'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let owned: String = conn
            .query_row("SELECT status FROM devices WHERE id = 'owned'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(unowned, "active");
        assert_eq!(owned, "active");
        // The point of the migration: `quarantined` is now expressible.
        assert!(table_ddl(&conn, "devices")
            .unwrap()
            .is_some_and(|ddl| ddl.contains("'quarantined'")));
    }

    #[test]
    fn the_person_migration_adds_both_columns_to_a_pre_adr_0149_database() {
        // The real upgrade path: a database created before ADR-0149 has a
        // host_bindings table without the person half. A fresh DDL run would
        // not fix it, because CREATE TABLE IF NOT EXISTS is a no-op there.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE host_bindings (
                 local_account_namespace TEXT PRIMARY KEY NOT NULL,
                 tenant_id               TEXT NOT NULL UNIQUE,
                 verifier_digest         TEXT,
                 pair_host_id            TEXT,
                 bound_at                INTEGER NOT NULL,
                 updated_at              INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS security_migrations (
                 key TEXT PRIMARY KEY,
                 applied_at INTEGER NOT NULL
             );
             INSERT INTO host_bindings
                 (local_account_namespace, tenant_id, bound_at, updated_at)
             VALUES ('acct_old', 'tnt_old', 1, 1);",
        )
        .unwrap();

        migrate_host_binding_person(&mut conn, 200).unwrap();

        let columns: Vec<String> = {
            let mut statement = conn.prepare("PRAGMA table_info('host_bindings')").unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(columns.iter().any(|name| name == "user_id"));
        assert!(columns.iter().any(|name| name == "org_id"));

        // Nothing is backfilled: an unlock proves a profile and says nothing
        // about who was holding it.
        let user: Option<String> = conn
            .query_row(
                "SELECT user_id FROM host_bindings WHERE local_account_namespace = 'acct_old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(user, None);

        // Running it twice must not fail on a duplicate column.
        migrate_host_binding_person(&mut conn, 201).unwrap();
        assert!(migration_applied(&conn, MIGRATION_HOST_BINDING_PERSON).unwrap());
    }

    #[test]
    fn a_fresh_database_already_carries_the_person_columns() {
        let store = SecurityStore::in_memory().unwrap();
        let conn = store.conn.lock();
        assert!(migration_applied(&conn, MIGRATION_HOST_BINDING_PERSON).unwrap());
        let columns: Vec<String> = {
            let mut statement = conn.prepare("PRAGMA table_info('host_bindings')").unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        for expected in ["user_id", "org_id"] {
            assert!(columns.iter().any(|name| name == expected), "{expected}");
        }
    }

    #[test]
    fn a_person_cannot_be_recorded_against_an_unknown_profile() {
        let store = SecurityStore::in_memory().unwrap();
        let error = store
            .bind_host_person("acct_never_bound", "usr_ada", None, 100)
            .unwrap_err();
        assert!(matches!(error, SecurityStoreError::HostBindingMismatch));
    }

    #[test]
    fn the_tenant_uniqueness_constraint_is_still_in_force() {
        // ADR-0149 §9 defers relaxing this until Batch 4 gives devices a user
        // to resolve through. If it is ever dropped, that must be a deliberate
        // edit with its own reasoning, not a side effect of widening the row.
        let store = SecurityStore::in_memory().unwrap();
        let conn = store.conn.lock();
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'host_bindings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(sql.contains("UNIQUE"), "tenant_id must stay unique for now");
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
        store
            .conn
            .lock()
            .execute(
                "INSERT OR IGNORE INTO host_bindings
                   (local_account_namespace, tenant_id, user_id, bound_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![format!("test:{tenant}"), tenant, ADA, now],
            )
            .unwrap();
        register_unowned(store, tenant, device, now);
    }

    fn register_unowned(store: &SecurityStore, tenant: &str, device: &str, now: i64) {
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

    // ── ADR-0149 §5 step one: devices belong to people ──────────────────────

    const ADA: &str = "usr_aaaaaaaaaaaaaaaaaaaaaaaa";
    const BOB: &str = "usr_bbbbbbbbbbbbbbbbbbbbbbbb";

    fn device_user(store: &SecurityStore, tenant: &str, device: &str) -> Option<String> {
        store.device_user(tenant, device).unwrap()
    }

    #[test]
    fn a_device_enrolled_before_anyone_signs_in_has_no_owner() {
        // The supported state the whole two-step split exists to protect.
        let store = SecurityStore::in_memory().unwrap();
        register_unowned(&store, "tenant-a", "device-a", 100);
        assert_eq!(device_user(&store, "tenant-a", "device-a"), None);
        // Active, not quarantined: nobody has signed in, so there is no person
        // this enrolment could contradict. `OWNER_PREDICATE_SQL` permits an
        // unowned device precisely because identity is optional here.
        assert_eq!(
            store.device_state("tenant-a", "device-a").unwrap(),
            Some(DeviceLifecycleState::Active)
        );
    }

    #[test]
    fn a_device_enrolled_after_sign_in_inherits_the_bound_person() {
        let store = SecurityStore::in_memory().unwrap();
        store.bind_host_account("acct_a", None, 90).unwrap();
        let tenant = store.host_binding("acct_a").unwrap().unwrap().tenant_id;
        store.bind_host_person("acct_a", ADA, None, 95).unwrap();

        register(&store, &tenant, "device-a", 100);
        assert_eq!(
            device_user(&store, &tenant, "device-a").as_deref(),
            Some(ADA)
        );
    }

    #[test]
    fn adoption_claims_only_the_unowned() {
        // Signing in must never reassign somebody else's machine — the failure
        // a blanket backfill would cause on a host two people share.
        let store = SecurityStore::in_memory().unwrap();
        register_unowned(&store, "tenant-a", "device-unowned", 100);
        register(&store, "tenant-a", "device-bobs", 101);
        store
            .assign_device_user("tenant-a", "device-bobs", Some(BOB), 102)
            .unwrap();

        assert_eq!(
            store.adopt_unowned_devices("tenant-a", ADA, 110).unwrap(),
            1
        );
        assert_eq!(
            device_user(&store, "tenant-a", "device-unowned").as_deref(),
            Some(ADA)
        );
        assert_eq!(
            device_user(&store, "tenant-a", "device-bobs").as_deref(),
            Some(BOB)
        );
    }

    #[test]
    fn adoption_is_idempotent_and_scoped_to_one_tenant() {
        let store = SecurityStore::in_memory().unwrap();
        register_unowned(&store, "tenant-a", "device-a", 100);
        register_unowned(&store, "tenant-b", "device-b", 101);

        assert_eq!(
            store.adopt_unowned_devices("tenant-a", ADA, 110).unwrap(),
            1
        );
        // Every sign-in after the first adopts nothing.
        assert_eq!(
            store.adopt_unowned_devices("tenant-a", ADA, 111).unwrap(),
            0
        );
        assert_eq!(device_user(&store, "tenant-b", "device-b"), None);
    }

    #[test]
    fn an_owner_can_be_corrected_and_cleared() {
        // Adoption can be wrong — a shared machine, a device handed on — and a
        // wrong owner that cannot be corrected is worse than no owner.
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        store
            .assign_device_user("tenant-a", "device-a", Some(ADA), 110)
            .unwrap();
        store
            .assign_device_user("tenant-a", "device-a", Some(BOB), 111)
            .unwrap();
        assert_eq!(
            device_user(&store, "tenant-a", "device-a").as_deref(),
            Some(BOB)
        );

        store
            .assign_device_user("tenant-a", "device-a", None, 112)
            .unwrap();
        assert_eq!(device_user(&store, "tenant-a", "device-a"), None);
    }

    #[test]
    fn assigning_an_owner_to_an_unknown_device_is_refused() {
        let store = SecurityStore::in_memory().unwrap();
        assert!(matches!(
            store.assign_device_user("tenant-a", "ghost", Some(ADA), 100),
            Err(SecurityStoreError::DeviceUnavailable)
        ));
    }

    #[test]
    fn list_devices_reports_the_owner() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);
        store
            .assign_device_user("tenant-a", "device-a", Some(ADA), 110)
            .unwrap();

        let devices = store.list_devices("tenant-a").unwrap();
        let found = devices
            .iter()
            .find(|device| device.device_id == "device-a")
            .expect("listed");
        assert_eq!(found.user_id.as_deref(), Some(ADA));
    }

    /// A host bound to `person`; returns the tenant its devices live under.
    fn host_bound_to(store: &SecurityStore, person: &str) -> String {
        let tenant = host_with_no_person(store);
        store.bind_host_person("acct_a", person, None, 95).unwrap();
        tenant
    }

    /// A host whose profile is bound but that nobody has signed in on — the
    /// common state, and the one the reroute must leave alone.
    fn host_with_no_person(store: &SecurityStore) -> String {
        store.bind_host_account("acct_a", None, 90).unwrap();
        store.host_binding("acct_a").unwrap().unwrap().tenant_id
    }

    /// Step **two**: the reroute itself. Person A signs out, person B signs in,
    /// and A's still-paired phone stops being able to act on B's machine.
    #[test]
    fn a_device_owned_by_somebody_else_loses_every_grant() {
        let store = SecurityStore::in_memory().unwrap();
        let tenant = host_bound_to(&store, ADA);
        register(&store, &tenant, "device-a", 100);

        assert!(
            store
                .has_capability(&tenant, "device-a", "host.admin")
                .unwrap(),
            "the bound person's own device keeps what it was granted"
        );

        store
            .assign_device_user(&tenant, "device-a", Some(BOB), 120)
            .unwrap();
        assert!(
            !store
                .has_capability(&tenant, "device-a", "host.admin")
                .unwrap(),
            "a grant recorded for somebody else's device must not stand"
        );

        // The grant row itself is untouched — the decision narrowed, nothing
        // was revoked. Handing the device back restores it without a re-grant.
        store
            .assign_device_user(&tenant, "device-a", Some(ADA), 130)
            .unwrap();
        assert!(store
            .has_capability(&tenant, "device-a", "host.admin")
            .unwrap());
    }

    /// A historical NULL-owned device keeps working, and sign-in adopts it.
    ///
    /// Denying it instead is the fleet-wide lockout `OWNER_PREDICATE_SQL`
    /// documents: `user_id IS NULL` is every device enrolled before ADR-0149,
    /// and there is no backfill that could have guessed the person. Adoption
    /// at sign-in is what fills the column, and only AFTER that is the device
    /// bound to one person — which the strangers' tests below pin.
    #[test]
    fn an_unattributed_device_keeps_working_and_is_adopted_at_sign_in() {
        let store = SecurityStore::in_memory().unwrap();
        let tenant = host_with_no_person(&store);
        register_unowned(&store, &tenant, "device-a", 100);
        // Enrolled before anyone signed in, so it carries no owner...
        assert_eq!(device_user(&store, &tenant, "device-a"), None);
        assert!(store
            .has_capability(&tenant, "device-a", "host.admin")
            .unwrap());

        // ...and then somebody signs in, which claims it.
        store.bind_host_person("acct_a", ADA, None, 110).unwrap();
        assert_eq!(store.adopt_unowned_devices(&tenant, ADA, 120).unwrap(), 1);
        assert_eq!(
            device_user(&store, &tenant, "device-a"),
            Some(ADA.to_owned())
        );
        assert!(store
            .has_capability(&tenant, "device-a", "host.admin")
            .unwrap());
    }

    /// A host nobody has signed in on has no person to compare against, so it
    /// cannot deny on ownership — it denies once a DIFFERENT person is bound.
    ///
    /// This is the half of the rule that keeps identity optional: requiring a
    /// bound person before any device works would lock out every install that
    /// never configures an identity provider.
    #[test]
    fn an_unbound_host_defers_ownership_until_a_person_is_bound() {
        let store = SecurityStore::in_memory().unwrap();
        let tenant = host_with_no_person(&store);
        register_unowned(&store, &tenant, "device-a", 100);
        store
            .assign_device_user(&tenant, "device-a", Some(BOB), 110)
            .unwrap();

        assert!(store
            .has_capability(&tenant, "device-a", "host.admin")
            .unwrap());

        // Ada signs in on this host; Bob's device is now a stranger's.
        store.bind_host_person("acct_a", ADA, None, 120).unwrap();
        assert!(!store
            .has_capability(&tenant, "device-a", "host.admin")
            .unwrap());
    }

    /// Ownership narrows; it never widens. Belonging to the right person is
    /// permission for the grants a device already has, never a grant of its
    /// own — the device row stays the floor.
    #[test]
    fn ownership_never_widens_beyond_the_recorded_grants() {
        let store = SecurityStore::in_memory().unwrap();
        let tenant = host_bound_to(&store, ADA);
        register(&store, &tenant, "device-a", 100);

        // Enrolled under the bound person, so the owner check passes...
        assert_eq!(
            device_user(&store, &tenant, "device-a").as_deref(),
            Some(ADA)
        );
        assert!(store
            .has_capability(&tenant, "device-a", "host.admin")
            .unwrap());
        // ...and a capability nobody granted is still refused.
        assert!(!store
            .has_capability(&tenant, "device-a", "agent.worker")
            .unwrap());
    }

    /// The predicate exists twice — once as SQL on the hot path, once as Rust
    /// for callers that already hold both ids. They must answer identically,
    /// so both are driven over the same table of cases.
    #[test]
    fn the_sql_predicate_and_its_rust_twin_agree() {
        let store = SecurityStore::in_memory().unwrap();
        let tenant = host_with_no_person(&store);
        register(&store, &tenant, "device-a", 100);

        let cases: [(Option<&str>, Option<&str>); 5] = [
            (None, None),
            (None, Some(BOB)),
            (Some(ADA), None),
            (Some(ADA), Some(ADA)),
            (Some(ADA), Some(BOB)),
        ];

        for (host_person, device_person) in cases {
            match host_person {
                Some(person) => store.bind_host_person("acct_a", person, None, 110).unwrap(),
                None => store.clear_host_person("acct_a", 110).unwrap(),
            }
            store
                .assign_device_user(&tenant, "device-a", device_person, 120)
                .unwrap();

            assert_eq!(
                store
                    .has_capability(&tenant, "device-a", "host.admin")
                    .unwrap(),
                owner_permits(host_person, device_person),
                "SQL and Rust disagree for host={host_person:?} device={device_person:?}"
            );
        }
    }

    /// The SQL half of the reroute, pinned structurally: the decision query
    /// MUST read the column now. A future edit that drops the join — restoring
    /// the pre-4b query — fails here rather than silently re-admitting every
    /// stranger's device.
    #[test]
    fn the_capability_query_reads_the_owner_column() {
        assert!(CAPABILITY_DECISION_SQL.contains(OWNER_PREDICATE_SQL));
        assert!(CAPABILITY_DECISION_SQL.contains("LEFT JOIN host_bindings"));
    }

    #[test]
    fn the_owner_column_survives_an_upgrade_from_a_database_without_it() {
        // The migration path real installs take, as opposed to a fresh schema.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE devices (
                 id TEXT NOT NULL,
                 tenant_id TEXT NOT NULL,
                 display_name TEXT NOT NULL,
                 role TEXT NOT NULL,
                 status TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (tenant_id, id)
             );
             INSERT INTO devices VALUES ('device-a', 'tenant-a', 'Phone', 'owner', 'active', 1, 1);
             CREATE TABLE IF NOT EXISTS security_migrations (
                 key TEXT PRIMARY KEY NOT NULL,
                 applied_at INTEGER NOT NULL
             );",
        )
        .unwrap();

        migrate_device_user(&mut conn, 200).unwrap();
        // Idempotent: a second run is a no-op rather than a duplicate-column error.
        migrate_device_user(&mut conn, 201).unwrap();

        let owner: Option<String> = conn
            .query_row(
                "SELECT user_id FROM devices WHERE id = 'device-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            owner, None,
            "an existing device is not attributed to a guess"
        );
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
    fn browser_enrollment_is_single_use_and_grants_only_the_two_browser_capabilities() {
        let store = SecurityStore::in_memory().unwrap();
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        let enrollment = store
            .create_browser_enrollment("tenant-a", "owner-a", 100, 300)
            .unwrap();
        store
            .register_browser_device(
                "tenant-a",
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                "browser-a",
                "Chrome on this Mac",
                "pem",
                "thumb-browser-a",
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                101,
            )
            .unwrap();

        assert_eq!(
            store
                .capability_snapshot("tenant-a", "browser-a")
                .unwrap()
                .unwrap(),
            vec!["browser.read-own", "browser.submit"]
        );
        // The whole point of a separate device class: none of the capabilities
        // that would let a tab drive the host come along with it.
        for capability in [
            "host.observe",
            "agent.run",
            "workspace.read",
            "workspace.write",
            "terminal.open",
            "process.spawn",
            "host.admin",
            "agent.worker",
        ] {
            assert!(
                !store
                    .has_capability("tenant-a", "browser-a", capability)
                    .unwrap(),
                "a browser device must not hold {capability}"
            );
        }

        let replay_challenge = store.issue_challenge("tenant-a", 102, 60).unwrap();
        assert!(matches!(
            store.register_browser_device(
                "tenant-a",
                &enrollment,
                &replay_challenge.id,
                &replay_challenge.nonce,
                "browser-b",
                "Copied extension",
                "pem-b",
                "thumb-browser-b",
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                103,
            ),
            Err(SecurityStoreError::InvalidInvitation)
        ));
    }

    #[test]
    fn browser_capabilities_cannot_be_assigned_to_an_ordinary_device() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "device-a", 100);

        for capability in ["browser.submit", "browser.read-own"] {
            assert!(matches!(
                store.replace_device_capabilities(
                    "tenant-a",
                    "owner-a",
                    "device-a",
                    &[capability.to_string()],
                    101,
                ),
                Err(SecurityStoreError::InvalidCapabilities)
            ));
        }
    }

    #[test]
    fn a_browser_device_keeps_its_own_capabilities_through_a_grant_edit() {
        // Every caller of `replace_device_capabilities` reads the device's live
        // snapshot and hands it back with one grant added or removed. Refusing
        // the two browser capabilities by name would therefore have made a
        // browser device's grants uneditable — the Device Console's switches,
        // `companion_set_worker`, the `fleet_worker_set` arm, the Owner route
        // and `cognia-server devices grant|revoke` would all answer
        // InvalidCapabilities on a device that legitimately holds them.
        let store = SecurityStore::in_memory().unwrap();
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        let enrollment = store
            .create_browser_enrollment("tenant-a", "owner-a", 100, 300)
            .unwrap();
        store
            .register_browser_device(
                "tenant-a",
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                "browser-a",
                "Chrome on this Mac",
                "pem",
                "thumb-browser-a",
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                101,
            )
            .unwrap();

        // The snapshot round-trips, plus one ordinary grant the owner toggled on.
        let replaced = store
            .replace_device_capabilities(
                "tenant-a",
                "owner-a",
                "browser-a",
                &[
                    "browser.read-own".into(),
                    "browser.submit".into(),
                    "host.observe".into(),
                ],
                102,
            )
            .unwrap();
        assert_eq!(
            replaced,
            vec!["browser.read-own", "browser.submit", "host.observe"]
        );
        assert!(store
            .has_capability("tenant-a", "browser-a", "browser.submit")
            .unwrap());

        // The class is what admits them, not the name: an ordinary device in
        // the same tenant is still refused.
        register(&store, "tenant-a", "device-a", 103);
        assert!(matches!(
            store.replace_device_capabilities(
                "tenant-a",
                "owner-a",
                "device-a",
                &["browser.submit".into()],
                104,
            ),
            Err(SecurityStoreError::InvalidCapabilities)
        ));
    }

    #[test]
    fn a_browser_enrollment_cannot_be_spent_as_a_worker_enrollment() {
        // The two tables exist separately so the device class is decided by
        // which enrollment was consumed, never by a label on the request.
        let store = SecurityStore::in_memory().unwrap();
        let browser = store
            .create_browser_enrollment("tenant-a", "owner-a", 100, 300)
            .unwrap();
        let worker = store
            .create_worker_enrollment("tenant-a", "owner-a", 100, 300)
            .unwrap();

        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        assert!(matches!(
            store.register_worker_device(
                "tenant-a",
                &browser,
                &challenge.id,
                &challenge.nonce,
                "worker-a",
                "Worker A",
                "pem",
                "thumb-a",
                101,
            ),
            Err(SecurityStoreError::InvalidInvitation)
        ));

        let challenge = store.issue_challenge("tenant-a", 102, 60).unwrap();
        assert!(matches!(
            store.register_browser_device(
                "tenant-a",
                &worker,
                &challenge.id,
                &challenge.nonce,
                "browser-a",
                "Browser A",
                "pem",
                "thumb-a",
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                103,
            ),
            Err(SecurityStoreError::InvalidInvitation)
        ));
    }

    #[test]
    fn the_authorization_snapshot_carries_a_browser_devices_bound_origin_and_nothing_elses() {
        let store = SecurityStore::in_memory().unwrap();
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        let enrollment = store
            .create_browser_enrollment("tenant-a", "owner-a", 100, 300)
            .unwrap();
        store
            .register_browser_device(
                "tenant-a",
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                "browser-a",
                "Chrome",
                "pem",
                "thumb-browser-a",
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                101,
            )
            .unwrap();
        register(&store, "tenant-a", "device-a", 100);

        let browser = store
            .authorization_snapshot("tenant-a", "browser-a")
            .unwrap()
            .expect("browser device is active");
        assert_eq!(
            browser.bound_origin.as_deref(),
            Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop")
        );
        // An ordinary paired device has no bound origin, so the enforcement
        // that reads this field cannot accidentally start policing them.
        let ordinary = store
            .authorization_snapshot("tenant-a", "device-a")
            .unwrap()
            .expect("ordinary device is active");
        assert_eq!(ordinary.bound_origin, None);

        // Revocation still removes the device wholesale — a bound origin is
        // not a second life for a revoked key.
        store
            .revoke_device("tenant-a", "owner-a", "browser-a", false, 104)
            .unwrap();
        assert!(store
            .authorization_snapshot("tenant-a", "browser-a")
            .unwrap()
            .is_none());
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
            // Sorted by the snapshot query. `client.read` is the member's own
            // data plane: its sessions, messages and sync deltas.
            vec!["agent.run", "client.read", "host.observe", "workspace.read"]
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
    /// Every capability the command manifest can demand of a *device* must be
    /// one a device can actually hold.
    ///
    /// `client.read`, `client.write` and the three `performance.*` names were
    /// added to `protocol/companion-commands.json` and to nothing else: no
    /// role seeded them, and `is_assignable_device_capability` rejected them,
    /// so no grant API could add them either. The result was 33 commands whose
    /// gate no principal could ever pass — `sync_pull`, `session_list`,
    /// `message_send`, `app_settings_update` and the whole remote performance
    /// dashboard answered 403 to every paired device, owner included.
    ///
    /// Two names are deliberately exempt. `service.internal` and
    /// `client.local` are not device capabilities at all — they mark the
    /// loopback service plane and renderer-local commands. `browser.submit`
    /// and `browser.read-own` belong to the browser-enrollment class, which
    /// `replace_capabilities` admits by device class rather than by name (see
    /// the `is_browser_device` branch there).
    #[test]
    fn every_device_capability_in_the_manifest_is_grantable() {
        const NOT_A_DEVICE_CAPABILITY: &[&str] = &["service.internal", "client.local"];
        let browser_only = super::BROWSER_ENROLLMENT.capabilities;

        let mut unreachable: Vec<&str> = super::super::command_manifest::commands()
            .iter()
            .map(|descriptor| descriptor.capability.as_str())
            .filter(|capability| !NOT_A_DEVICE_CAPABILITY.contains(capability))
            .filter(|capability| !browser_only.contains(capability))
            .filter(|capability| !is_assignable_device_capability(capability))
            .collect();
        unreachable.sort_unstable();
        unreachable.dedup();
        assert!(
            unreachable.is_empty(),
            "capabilities no device can hold: {unreachable:?}"
        );
    }

    /// The inverse of the test above: every capability the store will accept
    /// as a grant must have something that actually enforces it.
    ///
    /// The forward test catches a command whose capability nobody can hold.
    /// This one catches the other half, a switch that grants nothing, which is
    /// worse than useless because it reads as a security control. All three
    /// exemptions are named, and a name that stops being exempt has to be
    /// deleted from this list before the test goes green again.
    #[test]
    fn every_grantable_capability_has_an_enforcement_point() {
        /// Capabilities enforced somewhere other than a command descriptor, or
        /// not enforced at all and recorded as such (CLAUDE.md working rule 7:
        /// dormancy is documented at the type, labelled in the UI, and pinned
        /// by a test; any two of the three is a latent bug).
        const NO_COMMAND_REQUIRES_IT: &[(&str, &str)] = &[
            (
                "agent.worker",
                "enforced at the socket by ws_worker::worker_authorized, which has no RPC descriptor",
            ),
            (
                "device.admin",
                "dormant: nothing requires it, kept assignable so existing owner grant lists round-trip",
            ),
            (
                "server.admin",
                "dormant: nothing requires it, kept assignable so existing owner grant lists round-trip",
            ),
        ];

        let required: std::collections::HashSet<&str> = super::super::command_manifest::commands()
            .iter()
            .map(|descriptor| descriptor.capability.as_str())
            .collect();
        let exempt: std::collections::HashSet<&str> = NO_COMMAND_REQUIRES_IT
            .iter()
            .map(|(name, _)| *name)
            .collect();

        // Every name the store accepts. Kept next to the matches! arm it
        // mirrors, because a new arm with no entry here is exactly the drift
        // this test exists to catch.
        const ASSIGNABLE: &[&str] = &[
            "host.observe",
            "agent.run",
            "workspace.read",
            "workspace.write",
            "git.write",
            "terminal.open",
            "workflow.run",
            "process.spawn",
            "scheduler.manage",
            "secret.manage",
            "host.admin",
            "device.admin",
            "server.admin",
            "agent.worker",
            "client.read",
            "client.write",
            "performance.observe",
            "performance.traces",
            "performance.capture",
            "ssh.files",
        ];
        for capability in ASSIGNABLE {
            assert!(
                is_assignable_device_capability(capability),
                "{capability} is listed here but the store rejects it"
            );
        }

        let unenforced: Vec<&str> = ASSIGNABLE
            .iter()
            .copied()
            .filter(|capability| !required.contains(capability))
            .filter(|capability| !exempt.contains(capability))
            .collect();
        assert!(
            unenforced.is_empty(),
            "grantable capabilities that enforce nothing: {unenforced:?}. \
             Bind a command to it, or add it to NO_COMMAND_REQUIRES_IT with a reason."
        );

        // And the exemptions must stay honest: one that acquires a command is
        // no longer an exemption, and leaving it here hides the next real one.
        let stale: Vec<&str> = NO_COMMAND_REQUIRES_IT
            .iter()
            .map(|(name, _)| *name)
            .filter(|capability| required.contains(capability))
            .collect();
        assert!(
            stale.is_empty(),
            "exempted as enforcing nothing, but a command now requires it: {stale:?}"
        );
    }

    /// An owner device must be able to run every command the manifest exposes
    /// to device transports.
    ///
    /// The sibling test above proves such a capability *can* be granted; this
    /// one proves the default pairing actually grants it. `performance.*` is
    /// the case that needed both: it cleared the transport gate, so an owner
    /// reached the capability check and failed it.
    #[test]
    fn owner_default_grants_cover_every_device_reachable_command() {
        use super::super::command_manifest::{CommandTarget, CommandTransport};

        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "owner-a", 100);
        let granted = store
            .capability_snapshot("tenant-a", "owner-a")
            .unwrap()
            .expect("the freshly registered owner must be active");

        let mut missing: Vec<&str> = super::super::command_manifest::commands()
            .iter()
            .filter(|descriptor| {
                matches!(
                    descriptor.target,
                    CommandTarget::Execution | CommandTarget::HostAdmin
                ) && descriptor.transports.contains(&CommandTransport::Http)
            })
            .map(|descriptor| descriptor.capability.as_str())
            // The browser-enrollment class is a different kind of device, not
            // a weaker owner: `register_browser_device` is the only thing that
            // grants these, and an owner deliberately does not hold them.
            .filter(|capability| !BROWSER_ENROLLMENT.capabilities.contains(capability))
            .filter(|capability| !granted.iter().any(|held| held == capability))
            .collect();
        missing.sort_unstable();
        missing.dedup();
        assert!(
            missing.is_empty(),
            "an owner device cannot run these commands: {missing:?}"
        );
    }

    /// An owner paired before ADR-0162 gets `ssh.files` on upgrade, and a
    /// member does not.
    ///
    /// Without the backfill the grant would reach only hosts paired after this
    /// build, which is nobody who already uses the product. The member half is
    /// the other decision: the console's second switch is what turns it on for
    /// a device that is not the owner, and a migration that granted it wholesale
    /// would have made that switch describe something already given.
    #[test]
    fn the_ssh_files_backfill_reaches_owners_and_stops_at_members() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "owner-a", 100);

        {
            let conn = store.conn.lock();
            conn.execute(
                "INSERT INTO devices (id, tenant_id, display_name, role, status, created_at, updated_at)
                 VALUES ('member-a', 'tenant-a', 'Shared phone', 'member', 'active', 101, 101)",
                [],
            )
            .unwrap();
            conn.execute(
                "DELETE FROM capability_grants WHERE capability = 'ssh.files'",
                [],
            )
            .unwrap();
            conn.execute(
                "DELETE FROM security_migrations WHERE key = ?1",
                [MIGRATION_SSH_FILES_GRANT],
            )
            .unwrap();
        }
        assert!(!store
            .has_capability("tenant-a", "owner-a", "ssh.files")
            .unwrap());

        {
            let mut conn = store.conn.lock();
            migrate_ssh_files_grant(&mut conn, 200).unwrap();
        }
        assert!(store
            .has_capability("tenant-a", "owner-a", "ssh.files")
            .unwrap());
        assert!(!store
            .has_capability("tenant-a", "member-a", "ssh.files")
            .unwrap());
    }

    /// A device paired BEFORE the client-plane defaults existed must end up
    /// holding them after an upgrade.
    ///
    /// `insert_default_grants` only runs inside `register`, so without the
    /// backfill an upgrade fixes nothing for anybody who was already paired —
    /// the 403s on `sync_pull`, `session_list` and the performance plane simply
    /// survive it. The enrollment classes must NOT be swept up: a browser
    /// device is a `member` row too, and it is deliberately denied everything
    /// outside its own two capabilities.
    #[test]
    fn the_backfill_reaches_existing_pairings_and_stops_at_the_enrollment_classes() {
        let store = SecurityStore::in_memory().unwrap();
        register(&store, "tenant-a", "owner-a", 100);
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        let enrollment = store
            .create_browser_enrollment("tenant-a", "owner-a", 100, 600)
            .unwrap();
        store
            .register_browser_device(
                "tenant-a",
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                "browser-a",
                "Chrome",
                "pem",
                "thumb-browser",
                "https://example.test",
                101,
            )
            .unwrap();

        // Rewind to a pre-upgrade database: drop the new grants and the marker
        // so the migration has something to do.
        {
            let conn = store.conn.lock();
            conn.execute(
                "DELETE FROM capability_grants WHERE capability IN
                 ('client.read', 'client.write', 'performance.observe',
                  'performance.traces', 'performance.capture')",
                [],
            )
            .unwrap();
            conn.execute(
                "DELETE FROM security_migrations WHERE key = ?1",
                [MIGRATION_CLIENT_PLANE_GRANTS],
            )
            .unwrap();
        }
        assert!(!store
            .has_capability("tenant-a", "owner-a", "client.read")
            .unwrap());

        {
            let mut conn = store.conn.lock();
            migrate_client_plane_grants(&mut conn, 200).unwrap();
        }

        for capability in backfilled_capabilities_for_role("owner") {
            assert!(
                store
                    .has_capability("tenant-a", "owner-a", capability)
                    .unwrap(),
                "the backfill missed {capability} on an already-paired owner"
            );
        }
        // The browser extension keeps exactly its class, backfill or not.
        assert_eq!(
            store
                .capability_snapshot("tenant-a", "browser-a")
                .unwrap()
                .unwrap(),
            vec!["browser.read-own", "browser.submit"]
        );

        // Idempotent: the marker means a second open does nothing.
        {
            let mut conn = store.conn.lock();
            migrate_client_plane_grants(&mut conn, 300).unwrap();
        }
        assert!(store
            .has_capability("tenant-a", "owner-a", "client.write")
            .unwrap());
    }
}
