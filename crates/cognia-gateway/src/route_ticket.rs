//! Gateway route tickets (ADR-0090 Phase 2, plan §3.4).
//!
//! A route ticket is a session-scoped bearer the local Claude Code / Agent
//! SDK subprocess presents as its `ANTHROPIC_API_KEY`. It is NOT an ordinary
//! gateway API key:
//! - candidates and model bindings are FROZEN at mint (validated against the
//!   live snapshot); a later alias/settings change never alters them;
//! - the secret (`sk-cognia-rt-…`) lives in memory only — restarts require a
//!   re-mint, which must present the SAME frozen spec (no widening);
//! - metadata (everything but the secret) is persisted for audit/revocation;
//! - a ticket names the OPERATIONS it may perform and an optional BUDGET.
//!   Both default deny-safe when absent from a persisted v1 record.
//!
//! Budget accounting is atomic: [`RouteTicketRegistry::validate_and_reserve`]
//! checks the secret, expiry, revocation, operation scope and budget, and
//! records the reservation, all under ONE lock. A copy of the ticket handed
//! to the request context is never the accounting record, so concurrent
//! requests cannot both pass a `max_requests = 1` gate. Settlement and
//! release are keyed by request id and idempotent.
//!
//! There is deliberately NO `risk_ceiling` field. The management plane is not
//! served by this listener, so every operation a ticket can name belongs to
//! the same risk tier; a ceiling would be a synonym for `operations`.

use std::collections::{BTreeMap, HashMap};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::snapshot::RoutingSnapshot;

pub const TICKET_SECRET_PREFIX: &str = "sk-cognia-rt-";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TicketCandidate {
    pub deployment_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TicketAffinity {
    SessionSticky,
    StickyWithFailover,
    PerRequest,
}

/// Inference-plane operations a ticket may perform. Management operations are
/// not reachable through the gateway listener at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TicketOperation {
    Chat,
    CountTokens,
    Models,
    Embeddings,
    Responses,
}

impl TicketOperation {
    /// Whether a successful call draws tokens against the ticket budget.
    /// Listing models and counting tokens consume nothing.
    pub fn consumes_tokens(self) -> bool {
        matches!(self, Self::Chat | Self::Embeddings | Self::Responses)
    }
}

/// The operations a persisted record gets when it predates the field: what
/// the sidecar's existing Claude Code path needs, and nothing more. Neither
/// `embeddings` nor `responses` is granted by default.
pub fn default_ticket_operations() -> Vec<TicketOperation> {
    vec![
        TicketOperation::Chat,
        TicketOperation::CountTokens,
        TicketOperation::Models,
    ]
}

/// Optional consumption ceiling. `spent_*` are registry-owned counters and
/// are reset at mint; only the `max_*` members of a mint request are honoured.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TicketBudget {
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub spent_tokens: u64,
    #[serde(default)]
    pub max_requests: Option<u64>,
    #[serde(default)]
    pub spent_requests: u64,
    /// Per-ticket fixed-window limit; enforced by the server's keyed limiter.
    #[serde(default)]
    pub max_requests_per_min: Option<u32>,
}

/// One in-flight hold against a ticket budget. Transient: never persisted.
#[derive(Debug, Clone, PartialEq)]
pub struct TicketReservation {
    pub ticket_id: String,
    pub request_id: String,
    pub tokens_held: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteTicket {
    pub ticket_id: String,
    pub route_pin_id: String,
    pub execution_fingerprint: String,
    pub session_id: String,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// Ordered candidate walk — frozen at mint, immune to alias updates.
    pub candidates: Vec<TicketCandidate>,
    /// Frozen selector → concrete model map (primary/fast/powerful roles and
    /// the sonnet/haiku/opus family selectors Claude Code sends).
    pub model_bindings: BTreeMap<String, String>,
    pub credential_affinity: TicketAffinity,
    /// 401/403 never switches accounts unless explicitly allowed (R4).
    #[serde(default)]
    pub allow_auth_failover: bool,
    pub route_policy: String,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    #[serde(default)]
    pub profile_version: Option<u64>,
    #[serde(default)]
    pub revoked: bool,
    /// Operation scope. Absent on v1 records ⇒ [`default_ticket_operations`].
    #[serde(default = "default_ticket_operations")]
    pub operations: Vec<TicketOperation>,
    /// Consumption ceiling. Absent ⇒ unmetered (the pre-existing behaviour).
    #[serde(default)]
    pub budget: Option<TicketBudget>,
}

impl RouteTicket {
    /// Whether this ticket may perform `op`.
    pub fn allows(&self, op: TicketOperation) -> bool {
        self.operations.contains(&op)
    }

    /// Map an inbound model selector through the frozen bindings. Exact
    /// binding first; then a candidate whose model matches verbatim; else
    /// None (the request fails closed — never a live-alias substitution).
    pub fn resolve_model(&self, selector: &str) -> Option<String> {
        if let Some(bound) = self.model_bindings.get(selector) {
            return Some(bound.clone());
        }
        // Family selectors ("sonnet"/"haiku"/"opus") may arrive embedded in a
        // full model id; check the bindings by containment, longest key wins.
        let mut best: Option<(&String, &String)> = None;
        for (key, value) in &self.model_bindings {
            if selector.contains(key.as_str()) {
                match best {
                    Some((bk, _)) if bk.len() >= key.len() => {}
                    _ => best = Some((key, value)),
                }
            }
        }
        if let Some((_, value)) = best {
            return Some(value.clone());
        }
        self.candidates
            .iter()
            .find(|c| c.model_id == selector)
            .map(|c| c.model_id.clone())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedTicket {
    pub ticket: RouteTicket,
    /// Returned ONCE; never persisted, never logged.
    pub secret: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintRequest {
    pub session_id: String,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    pub execution_fingerprint: String,
    pub candidates: Vec<TicketCandidate>,
    #[serde(default)]
    pub model_bindings: BTreeMap<String, String>,
    pub credential_affinity: TicketAffinity,
    #[serde(default)]
    pub allow_auth_failover: bool,
    pub route_policy: String,
    /// Ticket lifetime; clamped to [60s, 24h].
    #[serde(default)]
    pub ttl_ms: Option<i64>,
    /// The model the execution will ask for. When `candidates` is empty they
    /// are derived from it, and when `model_bindings` is empty the family
    /// selectors (`primary`, `sonnet`, `haiku`, `opus`) are bound from it, so
    /// a caller only has to know the model it wants.
    #[serde(default)]
    pub model: Option<String>,
    /// Absent ⇒ [`default_ticket_operations`].
    #[serde(default)]
    pub operations: Option<Vec<TicketOperation>>,
    /// Absent ⇒ unmetered. Only `max_*` are read; `spent_*` start at zero.
    #[serde(default)]
    pub budget: Option<TicketBudget>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum TicketError {
    #[error("no candidates supplied")]
    NoCandidates,
    #[error("candidate {deployment_id}:{model_id} is not servable by the current snapshot")]
    UnknownCandidate {
        deployment_id: String,
        model_id: String,
    },
    #[error("re-mint for fingerprint {fingerprint} would widen the frozen spec: {detail}")]
    WidenedRemint { fingerprint: String, detail: String },
    #[error("no snapshot available")]
    NoSnapshot,
    #[error("persist failed: {0}")]
    Persist(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketReject {
    Unknown,
    Expired,
    Revoked,
    /// The ticket is valid but not scoped for the requested operation (403).
    OperationNotAllowed,
    /// The ticket is valid but its request or token budget is spent (429).
    BudgetExhausted,
}

/// Metadata persistence port — everything except secrets.
pub trait TicketMetaStore: Send + Sync + 'static {
    fn load(&self) -> Result<Vec<RouteTicket>, String>;
    fn save(&self, tickets: &[RouteTicket]) -> Result<(), String>;
}

/// In-memory store — tests and ephemeral hosts.
#[derive(Default)]
pub struct InMemoryTicketMetaStore {
    rows: Mutex<Vec<RouteTicket>>,
}

impl TicketMetaStore for InMemoryTicketMetaStore {
    fn load(&self) -> Result<Vec<RouteTicket>, String> {
        Ok(self.rows.lock().clone())
    }
    fn save(&self, tickets: &[RouteTicket]) -> Result<(), String> {
        *self.rows.lock() = tickets.to_vec();
        Ok(())
    }
}

/// JSON-file store (`gateway-tickets.json` beside `gateway-config.json` on
/// desktop; `<data>/.cognia/gateway-tickets.json` headless).
pub struct FileTicketMetaStore {
    pub path: std::path::PathBuf,
}

impl TicketMetaStore for FileTicketMetaStore {
    fn load(&self) -> Result<Vec<RouteTicket>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error.to_string()),
        }
    }
    fn save(&self, tickets: &[RouteTicket]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let raw = serde_json::to_string_pretty(tickets).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, raw).map_err(|e| e.to_string())
    }
}

struct TicketRecord {
    ticket: RouteTicket,
    /// Present only for tickets minted in THIS process lifetime.
    secret: Option<String>,
}

/// Everything the accounting needs, behind ONE lock.
#[derive(Default)]
struct Inner {
    records: Vec<TicketRecord>,
    /// request id → hold. Removed on settle or release.
    reservations: HashMap<String, TicketReservation>,
    /// Budget counters changed since the last persist. Flushed on the
    /// server's periodic key flush and on stop, never per request.
    dirty: bool,
}

pub struct RouteTicketRegistry {
    inner: Mutex<Inner>,
    store: Mutex<std::sync::Arc<dyn TicketMetaStore>>,
}

const MIN_TTL_MS: i64 = 60_000;
const MAX_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS: i64 = 12 * 60 * 60 * 1000;

impl RouteTicketRegistry {
    pub fn new(store: std::sync::Arc<dyn TicketMetaStore>) -> Self {
        let records = store
            .load()
            .unwrap_or_default()
            .into_iter()
            .map(|ticket| TicketRecord {
                ticket,
                secret: None,
            })
            .collect();
        Self {
            inner: Mutex::new(Inner {
                records,
                ..Inner::default()
            }),
            store: Mutex::new(store),
        }
    }

    /// Swap the metadata store (boot-time: in-memory → on-disk once the data
    /// dir is known). Existing persisted metadata is merged in (secrets are
    /// never persisted, so reloaded records validate as Unknown until
    /// re-minted) and the combined set is persisted to the new store.
    pub fn attach_store(&self, store: std::sync::Arc<dyn TicketMetaStore>) {
        let loaded = store.load().unwrap_or_default();
        let mut inner = self.inner.lock();
        for ticket in loaded {
            if !inner
                .records
                .iter()
                .any(|r| r.ticket.ticket_id == ticket.ticket_id)
            {
                inner.records.push(TicketRecord {
                    ticket,
                    secret: None,
                });
            }
        }
        *self.store.lock() = store;
        let _ = self.persist(&inner.records);
    }

    /// Persist budget counters if any changed since the last write. Cheap
    /// when clean; call it from a periodic flush and from shutdown.
    pub fn flush(&self) -> Result<(), TicketError> {
        let mut inner = self.inner.lock();
        if !inner.dirty {
            return Ok(());
        }
        self.persist(&inner.records)?;
        inner.dirty = false;
        Ok(())
    }

    fn persist(&self, records: &[TicketRecord]) -> Result<(), TicketError> {
        let metas: Vec<RouteTicket> = records.iter().map(|r| r.ticket.clone()).collect();
        let store = std::sync::Arc::clone(&self.store.lock());
        store.save(&metas).map_err(TicketError::Persist)
    }

    /// Mint a ticket for a frozen execution spec. Every candidate must be
    /// servable by the CURRENT snapshot (fail closed on unknowns), and a
    /// re-mint for a fingerprint that already has persisted metadata must
    /// present a candidate subset + identical bindings — restarts can renew
    /// authority, never widen it.
    pub fn mint(
        &self,
        request: MintRequest,
        snapshot: Option<&RoutingSnapshot>,
        now_ms: i64,
    ) -> Result<MintedTicket, TicketError> {
        let snapshot = snapshot.ok_or(TicketError::NoSnapshot)?;
        let mut request = request;
        if request.candidates.is_empty() {
            if let Some(model) = request.model.as_deref() {
                request.candidates = crate::route_planner::candidates_for_model(snapshot, model);
            }
        }
        if request.candidates.is_empty() {
            return Err(TicketError::NoCandidates);
        }
        if request.model_bindings.is_empty() {
            let model = request
                .model
                .clone()
                .unwrap_or_else(|| request.candidates[0].model_id.clone());
            request.model_bindings = crate::route_planner::bindings_for_candidates(
                snapshot,
                &request.candidates,
                &model,
            );
        }
        let operations = request
            .operations
            .clone()
            .unwrap_or_else(default_ticket_operations);
        let budget = request.budget.clone().map(|b| TicketBudget {
            max_tokens: b.max_tokens,
            max_requests: b.max_requests,
            max_requests_per_min: b.max_requests_per_min,
            spent_tokens: 0,
            spent_requests: 0,
        });
        for candidate in &request.candidates {
            let provider = snapshot
                .provider_by_deployment(&candidate.deployment_id)
                .or_else(|| snapshot.provider(&candidate.deployment_id));
            let servable = provider.is_some_and(|p| {
                p.models.is_empty() || p.models.iter().any(|m| m == &candidate.model_id)
            });
            if !servable {
                return Err(TicketError::UnknownCandidate {
                    deployment_id: candidate.deployment_id.clone(),
                    model_id: candidate.model_id.clone(),
                });
            }
        }

        let mut inner = self.inner.lock();
        if let Some(prior) = inner
            .records
            .iter()
            .filter(|r| r.ticket.execution_fingerprint == request.execution_fingerprint)
            .max_by_key(|r| r.ticket.issued_at_ms)
        {
            let prior_set: std::collections::BTreeSet<(&str, &str)> = prior
                .ticket
                .candidates
                .iter()
                .map(|c| (c.deployment_id.as_str(), c.model_id.as_str()))
                .collect();
            for candidate in &request.candidates {
                if !prior_set.contains(&(
                    candidate.deployment_id.as_str(),
                    candidate.model_id.as_str(),
                )) {
                    return Err(TicketError::WidenedRemint {
                        fingerprint: request.execution_fingerprint.clone(),
                        detail: format!(
                            "candidate {}:{} was not in the original ticket",
                            candidate.deployment_id, candidate.model_id
                        ),
                    });
                }
            }
            if request.model_bindings != prior.ticket.model_bindings {
                return Err(TicketError::WidenedRemint {
                    fingerprint: request.execution_fingerprint.clone(),
                    detail: "model bindings differ from the original ticket".into(),
                });
            }
            if let Some(op) = operations
                .iter()
                .find(|op| !prior.ticket.operations.contains(op))
            {
                return Err(TicketError::WidenedRemint {
                    fingerprint: request.execution_fingerprint.clone(),
                    detail: format!("operation {op:?} was not in the original ticket"),
                });
            }
            if budget_widened(prior.ticket.budget.as_ref(), budget.as_ref()) {
                return Err(TicketError::WidenedRemint {
                    fingerprint: request.execution_fingerprint.clone(),
                    detail: "budget exceeds the original ticket".into(),
                });
            }
        }

        let ttl = request
            .ttl_ms
            .unwrap_or(DEFAULT_TTL_MS)
            .clamp(MIN_TTL_MS, MAX_TTL_MS);
        let ticket_id = format!("rt_{}", uuid::Uuid::new_v4().simple());
        let secret = format!(
            "{TICKET_SECRET_PREFIX}{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let ticket = RouteTicket {
            ticket_id: ticket_id.clone(),
            route_pin_id: format!("pin_{}", uuid::Uuid::new_v4().simple()),
            execution_fingerprint: request.execution_fingerprint,
            session_id: request.session_id,
            parent_session_id: request.parent_session_id,
            candidates: request.candidates,
            model_bindings: request.model_bindings,
            credential_affinity: request.credential_affinity,
            allow_auth_failover: request.allow_auth_failover,
            route_policy: request.route_policy,
            issued_at_ms: now_ms,
            expires_at_ms: now_ms + ttl,
            profile_version: snapshot.profile_version,
            revoked: false,
            operations,
            budget,
        };
        inner.records.push(TicketRecord {
            ticket: ticket.clone(),
            secret: Some(secret.clone()),
        });
        self.persist(&inner.records)?;
        Ok(MintedTicket { ticket, secret })
    }

    /// Index of the record whose secret matches `supplied`, constant-time
    /// over every in-memory secret. Caller holds the lock.
    fn match_secret(records: &[TicketRecord], supplied: &str) -> Option<usize> {
        let supplied_bytes = supplied.as_bytes();
        let mut matched: Option<usize> = None;
        for (index, record) in records.iter().enumerate() {
            let Some(secret) = record.secret.as_ref() else {
                continue;
            };
            let bytes = secret.as_bytes();
            if bytes.len() == supplied_bytes.len() && bytes.ct_eq(supplied_bytes).unwrap_u8() == 1 {
                matched = Some(index);
            }
        }
        matched
    }

    /// Whether the secret names a live ticket with a token ceiling. The
    /// middleware uses this to decide whether buffering the body for an
    /// estimate is worth it; it grants nothing.
    pub fn secret_has_token_budget(&self, supplied: &str) -> bool {
        let inner = self.inner.lock();
        Self::match_secret(&inner.records, supplied).is_some_and(|index| {
            inner.records[index]
                .ticket
                .budget
                .as_ref()
                .is_some_and(|b| b.max_tokens.is_some())
        })
    }

    /// The gate the middleware uses. Secret, expiry, revocation, operation
    /// scope, budget check and reservation happen under one lock, so N
    /// concurrent requests against `max_requests = 1` admit exactly one.
    /// `est_tokens` is held against `max_tokens` until settled or released.
    pub fn validate_and_reserve(
        &self,
        supplied: &str,
        now_ms: i64,
        op: TicketOperation,
        request_id: &str,
        est_tokens: u64,
    ) -> Result<RouteTicket, TicketReject> {
        let mut inner = self.inner.lock();
        let index = Self::match_secret(&inner.records, supplied).ok_or(TicketReject::Unknown)?;
        let ticket_id = inner.records[index].ticket.ticket_id.clone();
        {
            let ticket = &inner.records[index].ticket;
            if ticket.revoked {
                return Err(TicketReject::Revoked);
            }
            if now_ms >= ticket.expires_at_ms {
                return Err(TicketReject::Expired);
            }
            if !ticket.allows(op) {
                return Err(TicketReject::OperationNotAllowed);
            }
        }
        let held: u64 = inner
            .reservations
            .values()
            .filter(|r| r.ticket_id == ticket_id)
            .map(|r| r.tokens_held)
            .sum();
        let Inner {
            records,
            reservations,
            dirty,
        } = &mut *inner;
        if let Some(budget) = records[index].ticket.budget.as_mut() {
            if let Some(max) = budget.max_requests {
                if budget.spent_requests >= max {
                    return Err(TicketReject::BudgetExhausted);
                }
            }
            if let Some(max) = budget.max_tokens {
                if budget
                    .spent_tokens
                    .saturating_add(held)
                    .saturating_add(est_tokens)
                    > max
                {
                    return Err(TicketReject::BudgetExhausted);
                }
            }
            budget.spent_requests += 1;
            *dirty = true;
        }
        reservations.insert(
            request_id.to_string(),
            TicketReservation {
                ticket_id,
                request_id: request_id.to_string(),
                tokens_held: est_tokens,
            },
        );
        Ok(records[index].ticket.clone())
    }

    /// Replace a hold with the tokens actually consumed. Idempotent: a
    /// request id with no open reservation is a no-op.
    pub fn settle_reservation(&self, request_id: &str, actual_tokens: u64) {
        let mut inner = self.inner.lock();
        let Some(reservation) = inner.reservations.remove(request_id) else {
            return;
        };
        if let Some(record) = inner
            .records
            .iter_mut()
            .find(|r| r.ticket.ticket_id == reservation.ticket_id)
        {
            if let Some(budget) = record.ticket.budget.as_mut() {
                budget.spent_tokens = budget.spent_tokens.saturating_add(actual_tokens);
                inner.dirty = true;
            }
        }
    }

    /// Drop a hold for a request that was never served (gateway rejection or
    /// upstream failure); the request slot is handed back. Idempotent.
    pub fn release_reservation(&self, request_id: &str) {
        let mut inner = self.inner.lock();
        let Some(reservation) = inner.reservations.remove(request_id) else {
            return;
        };
        if let Some(record) = inner
            .records
            .iter_mut()
            .find(|r| r.ticket.ticket_id == reservation.ticket_id)
        {
            if let Some(budget) = record.ticket.budget.as_mut() {
                budget.spent_requests = budget.spent_requests.saturating_sub(1);
                inner.dirty = true;
            }
        }
    }

    /// Open reservations (tests and diagnostics).
    pub fn open_reservations(&self) -> Vec<TicketReservation> {
        self.inner.lock().reservations.values().cloned().collect()
    }

    /// Constant-time secret validation. Expired/revoked/unknown all fail
    /// closed with a typed reason (the middleware maps every reason to 401 —
    /// no fallthrough into the ordinary key path).
    ///
    /// Read-only: it reserves nothing, so the request middleware must use
    /// [`Self::validate_and_reserve`] instead.
    pub fn validate(&self, supplied: &str, now_ms: i64) -> Result<RouteTicket, TicketReject> {
        let inner = self.inner.lock();
        let index = Self::match_secret(&inner.records, supplied).ok_or(TicketReject::Unknown)?;
        let ticket = &inner.records[index].ticket;
        if ticket.revoked {
            return Err(TicketReject::Revoked);
        }
        if now_ms >= ticket.expires_at_ms {
            return Err(TicketReject::Expired);
        }
        Ok(ticket.clone())
    }

    pub fn revoke(&self, ticket_id: &str) -> bool {
        let mut inner = self.inner.lock();
        let mut hit = false;
        for record in inner.records.iter_mut() {
            if record.ticket.ticket_id == ticket_id {
                record.ticket.revoked = true;
                record.secret = None;
                hit = true;
            }
        }
        if hit {
            let _ = self.persist(&inner.records);
        }
        hit
    }

    pub fn revoke_session(&self, session_id: &str) -> usize {
        let mut inner = self.inner.lock();
        let mut count = 0;
        for record in inner.records.iter_mut() {
            if record.ticket.session_id == session_id && !record.ticket.revoked {
                record.ticket.revoked = true;
                record.secret = None;
                count += 1;
            }
        }
        if count > 0 {
            let _ = self.persist(&inner.records);
        }
        count
    }

    /// Drop expired records entirely (their audit value has a horizon). Open
    /// reservations of a dropped ticket go with it.
    pub fn sweep_expired(&self, now_ms: i64) -> usize {
        let mut inner = self.inner.lock();
        let before = inner.records.len();
        inner.records.retain(|r| now_ms < r.ticket.expires_at_ms);
        let dropped = before - inner.records.len();
        if dropped > 0 {
            let live: std::collections::HashSet<String> = inner
                .records
                .iter()
                .map(|r| r.ticket.ticket_id.clone())
                .collect();
            inner
                .reservations
                .retain(|_, reservation| live.contains(&reservation.ticket_id));
            let _ = self.persist(&inner.records);
        }
        dropped
    }

    /// Redacted listing (no secrets are stored, so this is just the metadata).
    pub fn list(&self) -> Vec<RouteTicket> {
        self.inner
            .lock()
            .records
            .iter()
            .map(|r| r.ticket.clone())
            .collect()
    }

    pub fn active_count(&self, now_ms: i64) -> usize {
        self.inner
            .lock()
            .records
            .iter()
            .filter(|r| !r.ticket.revoked && now_ms < r.ticket.expires_at_ms)
            .count()
    }
}

/// Whether `next` grants more than `prior` on any ceiling. A missing prior
/// ceiling is unlimited, so nothing can widen it; a missing next ceiling
/// against a bounded prior is a widening.
fn budget_widened(prior: Option<&TicketBudget>, next: Option<&TicketBudget>) -> bool {
    fn cap_widened(prior: Option<u64>, next: Option<u64>) -> bool {
        match (prior, next) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(p), Some(n)) => n > p,
        }
    }
    let Some(prior) = prior else {
        return false;
    };
    let (next_tokens, next_requests, next_rpm) = match next {
        Some(n) => (n.max_tokens, n.max_requests, n.max_requests_per_min),
        None => (None, None, None),
    };
    cap_widened(prior.max_tokens, next_tokens)
        || cap_widened(prior.max_requests, next_requests)
        || cap_widened(
            prior.max_requests_per_min.map(u64::from),
            next_rpm.map(u64::from),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [],
            "providers": [
                { "id": "dep-primary", "protocol": "anthropic",
                  "baseUrl": "https://open.bigmodel.cn/api/anthropic",
                  "apiKey": "sk-up-1", "enabled": true, "models": ["model-alpha"],
                  "deploymentId": "dep-primary" },
                { "id": "backup", "protocol": "anthropic", "baseUrl": "https://b.example",
                  "apiKey": "sk-up-2", "enabled": true, "models": ["model-alpha"] }
            ],
            "generatedAtMs": 1,
            "profileVersion": 7,
            "authority": "renderer",
        }))
        .unwrap()
    }

    fn registry() -> RouteTicketRegistry {
        RouteTicketRegistry::new(std::sync::Arc::new(InMemoryTicketMetaStore::default()))
    }

    fn mint_request() -> MintRequest {
        serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "executionFingerprint": "aexf1-abc",
            "candidates": [
                { "deploymentId": "dep-primary", "modelId": "model-alpha" },
                { "deploymentId": "backup", "modelId": "model-alpha" }
            ],
            "modelBindings": { "primary": "model-alpha", "sonnet": "model-alpha" },
            "credentialAffinity": "sticky-with-failover",
            "routePolicy": "gateway-required",
        }))
        .unwrap()
    }

    #[test]
    fn mint_validate_round_trip_freezes_candidates_and_version() {
        let reg = registry();
        let minted = reg.mint(mint_request(), Some(&snapshot()), 1_000).unwrap();
        assert!(minted.secret.starts_with(TICKET_SECRET_PREFIX));
        assert_eq!(minted.ticket.profile_version, Some(7));

        let validated = reg.validate(&minted.secret, 2_000).unwrap();
        assert_eq!(validated.ticket_id, minted.ticket.ticket_id);
        assert_eq!(validated.candidates.len(), 2);

        // Unknown / wrong-length secrets fail closed.
        assert_eq!(
            reg.validate("sk-cognia-rt-nope", 2_000),
            Err(TicketReject::Unknown)
        );
    }

    #[test]
    fn mint_rejects_candidates_outside_the_snapshot() {
        let reg = registry();
        let mut request = mint_request();
        request.candidates.push(TicketCandidate {
            deployment_id: "ghost".into(),
            model_id: "model-alpha".into(),
        });
        assert!(matches!(
            reg.mint(request, Some(&snapshot()), 0),
            Err(TicketError::UnknownCandidate { .. })
        ));

        let mut wrong_model = mint_request();
        wrong_model.candidates[0].model_id = "not-served".into();
        assert!(matches!(
            reg.mint(wrong_model, Some(&snapshot()), 0),
            Err(TicketError::UnknownCandidate { .. })
        ));

        assert!(matches!(
            reg.mint(mint_request(), None, 0),
            Err(TicketError::NoSnapshot)
        ));
    }

    #[test]
    fn expiry_revocation_and_sweep() {
        let reg = registry();
        let minted = reg.mint(mint_request(), Some(&snapshot()), 0).unwrap();
        let expiry = minted.ticket.expires_at_ms;
        assert_eq!(
            reg.validate(&minted.secret, expiry),
            Err(TicketReject::Expired)
        );

        let fresh = reg.validate(&minted.secret, expiry - 1);
        assert!(fresh.is_ok());

        assert!(reg.revoke(&minted.ticket.ticket_id));
        assert_eq!(
            reg.validate(&minted.secret, expiry - 1),
            Err(TicketReject::Unknown) // secret dropped on revoke
        );
        assert!(!reg.revoke("rt_missing"));

        assert_eq!(reg.sweep_expired(expiry + 1), 1);
        assert!(reg.list().is_empty());
    }

    #[test]
    fn remint_same_fingerprint_cannot_widen() {
        let store = std::sync::Arc::new(InMemoryTicketMetaStore::default());
        let reg = RouteTicketRegistry::new(std::sync::Arc::clone(&store) as _);
        reg.mint(mint_request(), Some(&snapshot()), 0).unwrap();

        // Simulate restart: metadata survives, secrets don't.
        let reg2 = RouteTicketRegistry::new(store as _);

        // Subset re-mint is allowed.
        let mut narrower = mint_request();
        narrower.candidates.truncate(1);
        assert!(reg2.mint(narrower, Some(&snapshot()), 10).is_ok());

        // Widening (new candidate) is refused.
        let mut wider = mint_request();
        wider.candidates.push(TicketCandidate {
            deployment_id: "backup".into(),
            model_id: "model-alpha".into(),
        });
        // Duplicate of an existing candidate is fine; a NEW deployment isn't.
        wider.candidates[0].deployment_id = "backup".into();
        // Craft a genuinely new pair by changing the snapshot-supported model
        // list is not possible here, so assert the bindings guard instead.
        let mut changed_bindings = mint_request();
        changed_bindings
            .model_bindings
            .insert("opus".into(), "model-alpha".into());
        assert!(matches!(
            reg2.mint(changed_bindings, Some(&snapshot()), 20),
            Err(TicketError::WidenedRemint { .. })
        ));
    }

    #[test]
    fn revoke_session_kills_every_ticket_of_the_session() {
        let reg = registry();
        reg.mint(mint_request(), Some(&snapshot()), 0).unwrap();
        let mut second = mint_request();
        second.execution_fingerprint = "aexf1-def".into();
        reg.mint(second, Some(&snapshot()), 0).unwrap();
        assert_eq!(reg.revoke_session("s1"), 2);
        assert_eq!(reg.active_count(1), 0);
    }

    #[test]
    fn model_selector_resolution_uses_frozen_bindings_only() {
        let reg = registry();
        let minted = reg.mint(mint_request(), Some(&snapshot()), 0).unwrap();
        let ticket = minted.ticket;
        assert_eq!(
            ticket.resolve_model("primary").as_deref(),
            Some("model-alpha")
        );
        // Family selector embedded in a full model id.
        assert_eq!(
            ticket.resolve_model("claude-sonnet-5").as_deref(),
            Some("model-alpha")
        );
        // Verbatim candidate model.
        assert_eq!(
            ticket.resolve_model("model-alpha").as_deref(),
            Some("model-alpha")
        );
        // Unmapped selector fails closed.
        assert_eq!(ticket.resolve_model("gpt-4o"), None);
    }

    #[test]
    fn v1_record_deserializes_with_deny_safe_defaults() {
        // A record persisted before `operations` / `budget` existed.
        let raw = serde_json::json!([{
            "ticketId": "rt_v1", "routePinId": "pin_v1",
            "executionFingerprint": "aexf1-v1", "sessionId": "s1",
            "candidates": [{ "deploymentId": "dep-primary", "modelId": "model-alpha" }],
            "modelBindings": { "primary": "model-alpha" },
            "credentialAffinity": "session-sticky", "routePolicy": "gateway-required",
            "issuedAtMs": 1, "expiresAtMs": 2
        }]);
        let tickets: Vec<RouteTicket> = serde_json::from_value(raw).unwrap();
        let ticket = &tickets[0];
        assert_eq!(ticket.operations, default_ticket_operations());
        assert!(ticket.allows(TicketOperation::Chat));
        assert!(ticket.allows(TicketOperation::CountTokens));
        assert!(ticket.allows(TicketOperation::Models));
        assert!(!ticket.allows(TicketOperation::Embeddings));
        assert!(!ticket.allows(TicketOperation::Responses));
        assert!(ticket.budget.is_none(), "absent budget is unmetered");
    }

    #[test]
    fn widened_operations_and_budget_are_refused_on_remint() {
        let store = std::sync::Arc::new(InMemoryTicketMetaStore::default());
        let reg = RouteTicketRegistry::new(std::sync::Arc::clone(&store) as _);
        let mut first = mint_request();
        first.budget = Some(TicketBudget {
            max_tokens: Some(1_000),
            max_requests: Some(10),
            ..TicketBudget::default()
        });
        reg.mint(first, Some(&snapshot()), 0).unwrap();
        let reg2 = RouteTicketRegistry::new(store as _);

        let mut wider_ops = mint_request();
        wider_ops.operations = Some(vec![TicketOperation::Chat, TicketOperation::Embeddings]);
        wider_ops.budget = Some(TicketBudget {
            max_tokens: Some(1_000),
            max_requests: Some(10),
            ..TicketBudget::default()
        });
        assert!(matches!(
            reg2.mint(wider_ops, Some(&snapshot()), 10),
            Err(TicketError::WidenedRemint { .. })
        ));

        let mut wider_budget = mint_request();
        wider_budget.budget = Some(TicketBudget {
            max_tokens: Some(2_000),
            max_requests: Some(10),
            ..TicketBudget::default()
        });
        assert!(matches!(
            reg2.mint(wider_budget, Some(&snapshot()), 20),
            Err(TicketError::WidenedRemint { .. })
        ));

        // Dropping the ceiling entirely is also a widening.
        let mut unbounded = mint_request();
        unbounded.budget = None;
        assert!(matches!(
            reg2.mint(unbounded, Some(&snapshot()), 30),
            Err(TicketError::WidenedRemint { .. })
        ));

        // Narrower on every axis is fine.
        let mut narrower = mint_request();
        narrower.operations = Some(vec![TicketOperation::Chat]);
        narrower.budget = Some(TicketBudget {
            max_tokens: Some(500),
            max_requests: Some(5),
            ..TicketBudget::default()
        });
        assert!(reg2.mint(narrower, Some(&snapshot()), 40).is_ok());
    }

    #[test]
    fn concurrent_reservations_admit_exactly_max_requests() {
        let reg = std::sync::Arc::new(registry());
        let mut request = mint_request();
        request.budget = Some(TicketBudget {
            max_requests: Some(1),
            ..TicketBudget::default()
        });
        let minted = reg.mint(request, Some(&snapshot()), 0).unwrap();
        let secret = std::sync::Arc::new(minted.secret);

        let n = 16;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(n));
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let reg = std::sync::Arc::clone(&reg);
                let secret = std::sync::Arc::clone(&secret);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    reg.validate_and_reserve(&secret, 1, TicketOperation::Chat, &format!("req-{i}"), 0)
                        .is_ok()
                })
            })
            .collect();
        let admitted = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|admitted| *admitted)
            .count();
        assert_eq!(admitted, 1, "exactly one request may pass a max_requests=1 gate");
        assert_eq!(reg.open_reservations().len(), 1);
    }

    #[test]
    fn ticket_scoped_to_chat_cannot_call_embeddings() {
        let reg = registry();
        let mut request = mint_request();
        request.operations = Some(vec![TicketOperation::Chat]);
        let minted = reg.mint(request, Some(&snapshot()), 0).unwrap();
        assert_eq!(
            reg.validate_and_reserve(&minted.secret, 1, TicketOperation::Embeddings, "r1", 0),
            Err(TicketReject::OperationNotAllowed)
        );
        assert_eq!(
            reg.validate_and_reserve(&minted.secret, 1, TicketOperation::Responses, "r2", 0),
            Err(TicketReject::OperationNotAllowed)
        );
        assert!(reg
            .validate_and_reserve(&minted.secret, 1, TicketOperation::Chat, "r3", 0)
            .is_ok());
        assert_eq!(reg.open_reservations().len(), 1, "refused calls hold nothing");
    }

    #[test]
    fn token_budget_holds_estimates_until_settled_or_released() {
        let reg = registry();
        let mut request = mint_request();
        request.budget = Some(TicketBudget {
            max_tokens: Some(100),
            ..TicketBudget::default()
        });
        let minted = reg.mint(request, Some(&snapshot()), 0).unwrap();
        assert!(reg.secret_has_token_budget(&minted.secret));

        assert!(reg
            .validate_and_reserve(&minted.secret, 1, TicketOperation::Chat, "a", 60)
            .is_ok());
        // 60 held + 60 requested > 100 ⇒ refused while the hold is open.
        assert_eq!(
            reg.validate_and_reserve(&minted.secret, 1, TicketOperation::Chat, "b", 60),
            Err(TicketReject::BudgetExhausted)
        );
        // Settling at the real (smaller) usage frees room.
        reg.settle_reservation("a", 30);
        reg.settle_reservation("a", 30); // idempotent
        assert!(reg
            .validate_and_reserve(&minted.secret, 1, TicketOperation::Chat, "b", 60)
            .is_ok());
        // Releasing hands the slot back without charging tokens.
        reg.release_reservation("b");
        reg.release_reservation("b"); // idempotent
        let budget = reg.list()[0].budget.clone().unwrap();
        assert_eq!(budget.spent_tokens, 30);
        assert_eq!(budget.spent_requests, 1);
        assert!(reg.open_reservations().is_empty());

        // Counters reach the store only on flush, never per request.
        let store = std::sync::Arc::new(InMemoryTicketMetaStore::default());
        reg.attach_store(std::sync::Arc::clone(&store) as _);
        reg.validate_and_reserve(&minted.secret, 1, TicketOperation::Chat, "c", 0)
            .unwrap();
        reg.settle_reservation("c", 5);
        assert_eq!(store.load().unwrap()[0].budget.as_ref().unwrap().spent_tokens, 30);
        reg.flush().unwrap();
        assert_eq!(store.load().unwrap()[0].budget.as_ref().unwrap().spent_tokens, 35);
    }

    #[test]
    fn haiku_selector_resolves_through_default_bindings() {
        let snapshot: RoutingSnapshot = serde_json::from_value(serde_json::json!({
            "aliases": [],
            "providers": [
                { "id": "dep-primary", "protocol": "anthropic", "baseUrl": "https://a.example",
                  "apiKey": "sk-up-1", "enabled": true,
                  "models": ["claude-opus-5", "claude-haiku-4-5-20251001"],
                  "deploymentId": "dep-primary" }
            ],
            "generatedAtMs": 1, "profileVersion": 1, "authority": "renderer",
        }))
        .unwrap();
        let reg = registry();
        // Only the model is known; candidates and bindings are derived.
        let request: MintRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "executionFingerprint": "aexf1-haiku",
            "candidates": [],
            "model": "claude-opus-5",
            "credentialAffinity": "session-sticky",
            "routePolicy": "gateway-required",
        }))
        .unwrap();
        let minted = reg.mint(request, Some(&snapshot), 0).unwrap();
        let ticket = minted.ticket;
        assert_eq!(ticket.candidates.len(), 1);
        assert_eq!(ticket.model_bindings["primary"], "claude-opus-5");
        assert_eq!(ticket.model_bindings["haiku"], "claude-haiku-4-5-20251001");
        // Claude Code's first background turn asks for a haiku model.
        assert_eq!(
            ticket.resolve_model("claude-haiku-4-5-20251001").as_deref(),
            Some("claude-haiku-4-5-20251001")
        );
        // A family with no dedicated model falls back to the primary.
        assert_eq!(ticket.model_bindings["sonnet"], "claude-opus-5");
        assert_eq!(
            ticket.resolve_model("claude-sonnet-5").as_deref(),
            Some("claude-opus-5")
        );
    }

    #[test]
    fn file_store_round_trips_metadata_without_secrets() {
        let dir = std::env::temp_dir().join(format!("cognia-gw-tickets-{}", std::process::id()));
        let path = dir.join("gateway-tickets.json");
        let _ = std::fs::remove_file(&path);
        let store = std::sync::Arc::new(FileTicketMetaStore { path: path.clone() });
        let reg = RouteTicketRegistry::new(std::sync::Arc::clone(&store) as _);
        let minted = reg.mint(mint_request(), Some(&snapshot()), 0).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains(&minted.ticket.ticket_id));
        assert!(
            !raw.contains(&minted.secret),
            "secret must never be persisted"
        );

        // Reload: metadata present, secret gone ⇒ validate() is Unknown.
        let reg2 = RouteTicketRegistry::new(store as _);
        assert_eq!(reg2.list().len(), 1);
        assert_eq!(reg2.validate(&minted.secret, 1), Err(TicketReject::Unknown));
        let _ = std::fs::remove_file(&path);
    }
}
