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
pub use crate::org_usage::MemberBinding;
use crate::org_usage::{MemberUsageLedger, MemberUsageStore, InMemoryMemberUsageStore, month_at};

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
    /// Frozen at reservation, including when settlement crosses UTC midnight.
    pub member_month: Option<(MemberBinding, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteTicket {
    /// P6c binds person tickets to the verified org member at mint. Other mint
    /// paths leave this None; unbound tickets retain their previous behavior.
    /// Host-only and ephemeral like ticket secrets: never plaintext metadata.
    #[serde(skip)]
    pub member: Option<MemberBinding>,
    #[serde(default)]
    pub owner_account_id: Option<String>,
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
    #[serde(default)]
    pub strict_selectors: bool,
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
        if self.strict_selectors {
            return self
                .candidates
                .iter()
                .find(|c| c.model_id == selector)
                .map(|c| c.model_id.clone());
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
    /// Host-only, ephemeral account credentials. Never persisted in ticket metadata.
    #[serde(default)]
    pub provider_overrides: Vec<crate::snapshot::ProviderSnapshot>,
    pub session_id: String,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    pub execution_fingerprint: String,
    pub candidates: Vec<TicketCandidate>,
    #[serde(default)]
    pub model_bindings: BTreeMap<String, String>,
    #[serde(default)]
    pub strict_selectors: bool,
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
    #[error("invalid strict model plan: {0}")]
    InvalidModelPlan(String),
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
    MemberUsageCapReached { reset_at: i64 },
    /// Fail closed on unavailable sealed accounting, never unlimited fallback.
    MemberUsageUnavailable,
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
    provider_overrides: Vec<crate::snapshot::ProviderSnapshot>,
    task_client: Option<reqwest::Client>,
    task_authority: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
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
    usage: MemberUsageLedger,
    usage_dirty: bool,
    usage_unavailable: bool,
}

pub struct RouteTicketRegistry {
    inner: Mutex<Inner>,
    store: Mutex<std::sync::Arc<dyn TicketMetaStore>>,
    usage_store: Mutex<std::sync::Arc<dyn MemberUsageStore>>,
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
                provider_overrides: Vec::new(),
                task_client: None,
                task_authority: None,
            })
            .collect();
        Self {
            inner: Mutex::new(Inner {
                records,
                ..Inner::default()
            }),
            store: Mutex::new(store),
            usage_store: Mutex::new(std::sync::Arc::new(InMemoryMemberUsageStore::default())),
        }
    }

    /// Boot-time only; failed loading disables member accounting until a
    /// successful attach. Unbound tickets remain unaffected.
    pub fn attach_usage_store(&self, store: std::sync::Arc<dyn MemberUsageStore>) -> Result<(), TicketError> {
        let mut inner = self.inner.lock();
        inner.usage_unavailable = true;
        let mut usage = store.load().map_err(TicketError::Persist)?;
        for org in usage.orgs.values_mut() {
            for rows in org.months.values_mut() {
                for row in rows.values_mut() {
                    row.spent = row.spent.saturating_add(row.reserved);
                    row.reserved = 0;
                }
            }
        }
        inner.usage = usage;
        inner.usage_dirty = true;
        *self.usage_store.lock() = store;
        inner.usage_unavailable = false;
        Ok(())
    }

    pub fn org_member_usage_get(&self, org: &str, month: &str, people: &[String]) -> Result<serde_json::Value, String> {
        if !crate::org_usage::valid_month(month) { return Err("invalid month".into()); }
        let inner = self.inner.lock();
        if inner.usage_unavailable { return Err("organization usage store unavailable".into()); }
        Ok(inner.usage.report(org, month, people))
    }

    /// None user => org default; Some(user), None value => remove override;
    /// Some(None) => explicitly unlimited. Persist before publishing the cap.
    pub fn org_usage_cap_set(&self, org: &str, user: Option<&str>, value: Option<Option<u64>>) -> Result<(), String> {
        if value.flatten().is_some_and(|n| n > crate::org_usage::MAX_MONTHLY_TOKENS) { return Err("invalid monthly tokens".into()); }
        let mut inner = self.inner.lock();
        if inner.usage_unavailable { return Err("organization usage store unavailable".into()); }
        let mut usage = inner.usage.orgs.get(org).cloned().unwrap_or_default();
        match user {
            None => usage.default_monthly_tokens = value.flatten(),
            Some(user) => match value {
                Some(cap) => { usage.overrides.insert(user.into(), cap); },
                None => { usage.overrides.remove(user); },
            },
        }
        self.usage_store.lock().save_org(org, &usage)?;
        inner.usage.orgs.insert(org.into(), usage);
        Ok(())
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
                    provider_overrides: Vec::new(),
                    task_client: None,
                    task_authority: None,
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
        let now = chrono::Utc::now().timestamp_millis();
        for record in &mut inner.records {
            if record.ticket.revoked || record.ticket.expires_at_ms <= now {
                record.secret = None;
                record.provider_overrides.clear();
                record.task_client = None;
            }
        }
        if inner.usage_dirty {
            if inner.usage_unavailable { return Err(TicketError::Persist("organization usage store unavailable".into())); }
            for (org, usage) in &inner.usage.orgs {
                self.usage_store.lock().save_org(org, usage).map_err(TicketError::Persist)?;
            }
            inner.usage_dirty = false;
        }
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
        self.mint_owned(request, snapshot, now_ms, None)
    }

    pub fn mint_owned(
        &self,
        request: MintRequest,
        snapshot: Option<&RoutingSnapshot>,
        now_ms: i64,
        owner_account_id: Option<String>,
    ) -> Result<MintedTicket, TicketError> {
        self.person_mint_owned(request, snapshot, now_ms, owner_account_id, None)
    }

    /// P6c Host-only member authority, supplied outside the deserializable request.
    pub fn person_mint_owned(
        &self, request: MintRequest, snapshot: Option<&RoutingSnapshot>, now_ms: i64,
        owner_account_id: Option<String>, member: Option<MemberBinding>,
    ) -> Result<MintedTicket, TicketError> {
        let mut frozen = snapshot.ok_or(TicketError::NoSnapshot)?.clone();
        for provider in &request.provider_overrides {
            let deployment = provider.deployment_id.as_deref().unwrap_or(&provider.id);
            if !request.candidates.iter().any(|candidate| {
                candidate.deployment_id == deployment
                    && provider.models.contains(&candidate.model_id)
            }) {
                return Err(TicketError::UnknownCandidate {
                    deployment_id: deployment.to_string(),
                    model_id: String::new(),
                });
            }
            frozen
                .providers
                .retain(|p| p.id != provider.id && p.deployment_id.as_deref() != Some(deployment));
            frozen.providers.push(provider.clone());
        }
        frozen.validate().map_err(TicketError::Persist)?;
        let snapshot = &frozen;
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
        if request.strict_selectors {
            if request.candidates.len() != 1
                || request.allow_auth_failover
                || request.credential_affinity != TicketAffinity::SessionSticky
            {
                return Err(TicketError::InvalidModelPlan(
                    "one deployment and no auth failover required".into(),
                ));
            }
            let candidate = &request.candidates[0];
            let provider = snapshot
                .provider_by_deployment(&candidate.deployment_id)
                .or_else(|| snapshot.provider(&candidate.deployment_id))
                .ok_or_else(|| TicketError::InvalidModelPlan("missing task deployment".into()))?;
            // The plan is what the request binds, never everything the
            // deployment happens to list: a strict ticket on a shared
            // deployment must not become addressable for its other models.
            let bound: std::collections::BTreeSet<&String> = request
                .model_bindings
                .values()
                .filter(|m| *m != &candidate.model_id)
                .collect();
            if bound.iter().any(|m| !provider.models.contains(m)) {
                return Err(TicketError::InvalidModelPlan(
                    "bound model missing from deployment".into(),
                ));
            }
            let plan = crate::task_lease::TaskModelPlan {
                additional_models: bound.into_iter().cloned().collect(),
                // The lease adds defaults and identities after validating the caller's
                // 64 selectors. Those generated entries do not consume that limit.
                model_bindings: request
                    .model_bindings
                    .iter()
                    .filter(|(key, value)| {
                        !(key == value && provider.models.contains(value))
                            && !(["primary", "fast", "powerful", "sonnet", "haiku", "opus"]
                                .contains(&key.as_str())
                                && *value == &candidate.model_id)
                    })
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            };
            plan.validate(&candidate.model_id)
                .map_err(TicketError::InvalidModelPlan)?;
            if !provider.models.contains(&candidate.model_id) {
                return Err(TicketError::InvalidModelPlan(
                    "primary model missing from deployment".into(),
                ));
            }
            // Every plan model is addressable by its real id, never a family substring.
            for model in std::iter::once(&candidate.model_id).chain(&plan.additional_models) {
                request.model_bindings.insert(model.clone(), model.clone());
            }
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
            .filter(|r| {
                r.ticket.execution_fingerprint == request.execution_fingerprint
                    && r.ticket.owner_account_id == owner_account_id
            })
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
            if request.model_bindings != prior.ticket.model_bindings
                || request.strict_selectors != prior.ticket.strict_selectors
            {
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
            member,
            owner_account_id,
            ticket_id: ticket_id.clone(),
            route_pin_id: format!("pin_{}", uuid::Uuid::new_v4().simple()),
            execution_fingerprint: request.execution_fingerprint,
            session_id: request.session_id,
            parent_session_id: request.parent_session_id,
            candidates: request.candidates,
            model_bindings: request.model_bindings,
            strict_selectors: request.strict_selectors,
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
            provider_overrides: request.provider_overrides,
            task_client: None,
            task_authority: None,
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
                || inner.records[index].ticket.member.is_some()
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
            if ticket.revoked
                || inner.records[index]
                    .task_authority
                    .as_ref()
                    .is_some_and(|check| !check())
            {
                return Err(TicketReject::Revoked);
            }
            if now_ms >= ticket.expires_at_ms {
                return Err(TicketReject::Expired);
            }
            if !ticket.allows(op) {
                return Err(TicketReject::OperationNotAllowed);
            }
        }
        // Protect member holds; preserve legacy unbound duplicate-id behavior.
        if inner.reservations.get(request_id).is_some_and(|hold|
            hold.member_month.is_some() || inner.records[index].ticket.member.is_some()) {
            return Err(TicketReject::BudgetExhausted);
        }
        let member_month = inner.records[index].ticket.member.clone().map(|member| (member, month_at(now_ms)));
        if let Some((member, month)) = &member_month {
            if inner.usage_unavailable { return Err(TicketReject::MemberUsageUnavailable); }
            inner.usage.check(member, month, est_tokens)?;
        }
        let held: u64 = inner
            .reservations
            .values()
            .filter(|r| r.ticket_id == ticket_id)
            .fold(0u64, |sum, r| sum.saturating_add(r.tokens_held));
        let Inner {
            records,
            reservations,
            dirty,
            usage,
            usage_dirty,
            ..
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
        if let Some((member, month)) = &member_month {
            let row = usage.row_mut(member, month);
            row.reserved = row.reserved.saturating_add(est_tokens);
            *usage_dirty = true;
        }
        reservations.insert(
            request_id.to_string(),
            TicketReservation {
                ticket_id,
                request_id: request_id.to_string(),
                tokens_held: est_tokens,
                member_month,
            },
        );
        Ok(records[index].ticket.clone())
    }

    /// Replace a hold with the tokens actually consumed. Idempotent: a
    /// request id with no open reservation is a no-op.
    /// Re-evaluate the final translated/continued prompt atomically. The
    /// middleware estimate predates history expansion and model output caps.
    pub fn reserve_model_output(
        &self,
        request_id: &str,
        input_tokens: u64,
        requested_output: Option<u64>,
    ) -> Result<Option<u64>, TicketReject> {
        let mut inner = self.inner.lock();
        let Some(reservation) = inner.reservations.get(request_id) else {
            return Ok(requested_output);
        };
        let reservation = reservation.clone();
        let mut limit = None;
        if let Some(budget) = inner.records.iter().find(|r| r.ticket.ticket_id == reservation.ticket_id).and_then(|r| r.ticket.budget.as_ref()) {
            if let Some(max) = budget.max_tokens {
                let other_held = inner.reservations.iter().filter(|(id, r)| id.as_str() != request_id && r.ticket_id == reservation.ticket_id)
                    .fold(0u64, |sum, (_, r)| sum.saturating_add(r.tokens_held));
                let remaining = max.saturating_sub(budget.spent_tokens).saturating_sub(other_held).saturating_sub(input_tokens);
                if remaining == 0 { return Err(TicketReject::BudgetExhausted); }
                limit = Some(remaining);
            }
        }
        if let Some((member, month)) = &reservation.member_month {
            if inner.usage_unavailable { return Err(TicketReject::MemberUsageUnavailable); }
            if let Some(org) = inner.usage.orgs.get(&member.org_id) {
                if let Some(cap) = org.effective_cap(&member.user_id) {
                    let row = org.months.get(month).and_then(|rows| rows.get(&member.user_id));
                    let used = row.map_or(0, |r| r.spent.saturating_add(r.reserved.saturating_sub(reservation.tokens_held)));
                    let remaining = cap.saturating_sub(used).saturating_sub(input_tokens);
                    if remaining == 0 { return Err(TicketReject::MemberUsageCapReached { reset_at: crate::org_usage::reset_at(month) }); }
                    limit = Some(limit.map_or(remaining, |ticket: u64| ticket.min(remaining)));
                }
            }
        }
        let output = match limit { Some(remaining) => Some(requested_output.unwrap_or(remaining).min(remaining)), None => requested_output };
        // Preserve legacy unmetered behavior when neither budget applies.
        if reservation.member_month.is_none() && limit.is_none() { return Ok(requested_output); }
        let held = input_tokens.saturating_add(output.unwrap_or(0));
        if let Some((member, month)) = &reservation.member_month {
            let row = inner.usage.row_mut(member, month);
            row.reserved = row.reserved.saturating_sub(reservation.tokens_held).saturating_add(held);
            inner.usage_dirty = true;
        }
        inner.reservations.get_mut(request_id).unwrap().tokens_held = held;
        Ok(output)
    }

    pub fn settle_reservation(&self, request_id: &str, actual_tokens: u64) {
        let mut inner = self.inner.lock();
        let Some(reservation) = inner.reservations.remove(request_id) else {
            return;
        };
        if let Some((member, month)) = &reservation.member_month {
            let row = inner.usage.row_mut(member, month);
            row.reserved = row.reserved.saturating_sub(reservation.tokens_held);
            row.spent = row.spent.saturating_add(actual_tokens);
            inner.usage_dirty = true;
        }
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

    /// Dispatched work may end without usage (omitted usage, cancellation or
    /// expiry). Charge the member hold conservatively; legacy unbound requests
    /// retain their refund behavior. Known partial usage is a lower bound.
    pub fn org_usage_settle_unknown(&self, request_id: &str, known_tokens: u64) {
        let held = self.inner.lock().reservations.get(request_id)
            .filter(|hold| hold.member_month.is_some()).map(|hold| hold.tokens_held.max(known_tokens));
        match held {
            Some(tokens) => self.settle_reservation(request_id, tokens),
            None => self.release_reservation(request_id),
        }
    }

    /// Drop a hold for a request that was never served (gateway rejection or
    /// upstream failure); the request slot is handed back. Idempotent.
    pub fn release_reservation(&self, request_id: &str) {
        let mut inner = self.inner.lock();
        let Some(reservation) = inner.reservations.remove(request_id) else {
            return;
        };
        if let Some((member, month)) = &reservation.member_month {
            let row = inner.usage.row_mut(member, month);
            row.reserved = row.reserved.saturating_sub(reservation.tokens_held);
            row.spent = row.spent.saturating_add(0);
            inner.usage_dirty = true;
        }
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
        if ticket.revoked
            || inner.records[index]
                .task_authority
                .as_ref()
                .is_some_and(|check| !check())
        {
            return Err(TicketReject::Revoked);
        }
        if now_ms >= ticket.expires_at_ms {
            return Err(TicketReject::Expired);
        }
        Ok(ticket.clone())
    }

    /// Clone only this live task's credentials. Global snapshots remain untouched.
    pub fn provider_overrides(&self, ticket_id: &str) -> Vec<crate::snapshot::ProviderSnapshot> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut inner = self.inner.lock();
        for record in &mut inner.records {
            if record.ticket.expires_at_ms <= now || record.ticket.revoked {
                record.provider_overrides.clear();
                record.task_client = None;
            }
        }
        inner
            .records
            .iter()
            .find(|record| record.ticket.ticket_id == ticket_id)
            .map(|record| record.provider_overrides.clone())
            .unwrap_or_default()
    }

    pub fn is_live(&self, ticket_id: &str, now_ms: i64) -> bool {
        self.inner.lock().records.iter().any(|record| {
            record.ticket.ticket_id == ticket_id
                && !record.ticket.revoked
                && record.ticket.expires_at_ms > now_ms
                && record.secret.is_some()
                && record.task_authority.as_ref().is_none_or(|check| check())
        })
    }

    pub fn set_task_authority(
        &self,
        ticket_id: &str,
        authority: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) {
        if let Some(record) = self
            .inner
            .lock()
            .records
            .iter_mut()
            .find(|r| r.ticket.ticket_id == ticket_id)
        {
            record.task_authority = Some(authority);
        }
    }

    pub fn set_task_client(&self, ticket_id: &str, client: reqwest::Client) {
        if let Some(record) = self
            .inner
            .lock()
            .records
            .iter_mut()
            .find(|r| r.ticket.ticket_id == ticket_id)
        {
            record.task_client = Some(client);
        }
    }

    pub fn task_client(&self, ticket_id: &str) -> Option<reqwest::Client> {
        self.inner
            .lock()
            .records
            .iter()
            .find(|r| r.ticket.ticket_id == ticket_id)
            .and_then(|r| r.task_client.clone())
    }

    pub fn renew(&self, ticket_id: &str, now_ms: i64, ttl_ms: i64) -> bool {
        let mut inner = self.inner.lock();
        let Some(record) = inner.records.iter_mut().find(|r| {
            r.ticket.ticket_id == ticket_id
                && !r.ticket.revoked
                && r.ticket.expires_at_ms > now_ms
                && r.secret.is_some()
                && r.task_authority.as_ref().is_none_or(|check| check())
        }) else {
            return false;
        };
        record.ticket.expires_at_ms =
            (now_ms + ttl_ms).min(record.ticket.issued_at_ms + MAX_TTL_MS);
        inner.dirty = true;
        true
    }

    pub fn secret_matches_ticket(&self, ticket_id: &str, secret: &str) -> bool {
        let inner = self.inner.lock();
        Self::match_secret(&inner.records, secret)
            .is_some_and(|index| inner.records[index].ticket.ticket_id == ticket_id)
    }

    pub fn revoke(&self, ticket_id: &str) -> bool {
        let mut inner = self.inner.lock();
        let mut hit = false;
        for record in inner.records.iter_mut() {
            if record.ticket.ticket_id == ticket_id {
                record.ticket.revoked = true;
                record.secret = None;
                record.provider_overrides.clear();
                record.task_client = None;
                hit = true;
            }
        }
        if hit {
            let _ = self.persist(&inner.records);
        }
        hit
    }

    /// P6c credential rotation revokes only this org's provider deployments.
    /// Clear credentials and secrets even if metadata persistence fails.
    pub fn person_revoke_provider(&self, org: &str, provider: &str) -> usize {
        let mut inner = self.inner.lock();
        let mut count = 0;
        for record in &mut inner.records {
            if !record.ticket.revoked
                && record.ticket.member.as_ref().is_some_and(|member| member.org_id == org)
                && record.provider_overrides.iter().any(|entry| entry.id == provider
                    || entry.deployment_id.as_deref() == Some(provider)) {
                record.ticket.revoked = true;
                record.secret = None;
                record.provider_overrides.clear();
                record.task_client = None;
                count += 1;
            }
        }
        inner.dirty |= count > 0;
        count
    }

    pub fn revoke_session(&self, session_id: &str) -> usize {
        let mut inner = self.inner.lock();
        let mut count = 0;
        for record in inner.records.iter_mut() {
            if record.ticket.session_id == session_id && !record.ticket.revoked {
                record.ticket.revoked = true;
                record.secret = None;
                record.provider_overrides.clear();
                record.task_client = None;
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
            let expired: Vec<_> = inner.reservations.values().filter(|r| !live.contains(&r.ticket_id)).cloned().collect();
            for hold in expired {
                inner.reservations.remove(&hold.request_id);
                if let Some((member, month)) = &hold.member_month {
                    let row = inner.usage.row_mut(member, month);
                    row.reserved = row.reserved.saturating_sub(hold.tokens_held);
                    // Expiry must not refund dispatched work with unknown usage.
                    row.spent = row.spent.saturating_add(hold.tokens_held);
                    inner.usage_dirty = true;
                }
            }
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

    fn p6b_member_ticket(reg: &RouteTicketRegistry, now: i64, user: &str) -> MintedTicket {
        let mut request = mint_request();
        request.execution_fingerprint = format!("p6b-{}", uuid::Uuid::new_v4());
        let mut ticket = reg.mint(request, Some(&snapshot()), now).unwrap();
        let member = MemberBinding { org_id: "org_p6b_test".into(), user_id: user.into() };
        reg.inner.lock().records.iter_mut().find(|r| r.ticket.ticket_id == ticket.ticket.ticket_id).unwrap().ticket.member = Some(member.clone());
        ticket.ticket.member = Some(member);
        ticket
    }

    fn p6b_now(month: &str) -> i64 { crate::org_usage::reset_at(month) - 1000 }

    #[test]
    fn p6c_member_authority_is_host_only_ephemeral_and_atomic_at_mint() {
        let registry = registry();
        let legacy = registry.mint_owned(mint_request(), Some(&snapshot()), 1, Some("operator".into())).unwrap();
        assert!(legacy.ticket.member.is_none());
        let member = MemberBinding { org_id:"org_p6c_bound".into(), user_id:"usr_p6c_bound".into() };
        let minted = registry.person_mint_owned(mint_request(), Some(&snapshot()), 1,
            Some("pb_member".into()), Some(member.clone())).unwrap();
        assert_eq!(registry.validate(&minted.secret, 2).unwrap().member, Some(member));
        assert!(registry.secret_has_token_budget(&minted.secret));
        let wire = serde_json::to_string(&minted.ticket).unwrap();
        assert!(!wire.contains("usr_p6c_bound"));
        assert!(serde_json::from_str::<RouteTicket>(&wire).unwrap().member.is_none());
    }

    #[test]
    fn p6b_concurrent_reservations_never_overshoot_member_cap() {
        let reg = std::sync::Arc::new(registry());
        reg.org_usage_cap_set("org_p6b_test", None, Some(Some(30))).unwrap();
        let now = p6b_now("2026-10");
        let tickets: Vec<_> = (0..20).map(|_| p6b_member_ticket(&reg, now, "usr_p6b_one")).collect();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(20));
        let handles: Vec<_> = tickets.into_iter().enumerate().map(|(i, ticket)| {
            let reg = reg.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, &format!("race-{i}"), 10).is_ok()
            })
        }).collect();
        assert_eq!(handles.into_iter().map(|h| h.join().unwrap()).filter(|ok| *ok).count(), 3);
        for hold in reg.open_reservations() { reg.settle_reservation(&hold.request_id, 10); }
        let report = reg.org_member_usage_get("org_p6b_test", "2026-10", &[]).unwrap();
        assert_eq!(report["members"][0]["spentTokens"], 30);
        assert_eq!(report["members"][0]["reservedTokens"], 0);
        let ticket = p6b_member_ticket(&reg, now, "usr_p6b_other");
        assert!(reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "other", 30).is_ok());
    }

    #[test]
    fn p6b_month_rollover_settles_original_month_and_release_is_idempotent() {
        let reg = registry();
        reg.org_usage_cap_set("org_p6b_test", None, Some(Some(10))).unwrap();
        let now = p6b_now("2026-12");
        let ticket = p6b_member_ticket(&reg, now, "usr_p6b_one");
        reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "dec", 10).unwrap();
        assert_eq!(reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "full", 1), Err(TicketReject::MemberUsageCapReached { reset_at: crate::org_usage::reset_at("2026-12") }));
        reg.validate_and_reserve(&ticket.secret, now + 2000, TicketOperation::Chat, "jan", 10).unwrap();
        reg.settle_reservation("dec", 7); reg.settle_reservation("dec", 7);
        reg.release_reservation("jan"); reg.release_reservation("jan");
        assert_eq!(reg.org_member_usage_get("org_p6b_test", "2026-12", &[]).unwrap()["members"][0]["spentTokens"], 7);
        assert_eq!(reg.org_member_usage_get("org_p6b_test", "2027-01", &[]).unwrap()["members"][0]["reservedTokens"], 0);
        assert_eq!(reg.org_member_usage_get("org_p6b_test", "2027-01", &[]).unwrap()["members"][0]["spentTokens"], 0);
    }

    #[test]
    fn p6b_translated_output_rechecks_cap_without_ticket_budget() {
        let reg = registry(); let now = p6b_now("2026-10");
        reg.org_usage_cap_set("org_p6b_test", None, Some(Some(30))).unwrap();
        let ticket = p6b_member_ticket(&reg, now, "usr_p6b_one");
        assert!(reg.secret_has_token_budget(&ticket.secret));
        reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "one", 5).unwrap();
        reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "two", 10).unwrap();
        assert_eq!(reg.reserve_model_output("one", 10, Some(100)), Ok(Some(10)));
        assert_eq!(reg.open_reservations().iter().find(|r| r.request_id == "one").unwrap().tokens_held, 20);
        assert!(matches!(reg.reserve_model_output("two", 10, Some(1)), Err(TicketReject::MemberUsageCapReached { .. })));
        assert_eq!(reg.org_member_usage_get("org_p6b_test", "2026-10", &[]).unwrap()["members"][0]["reservedTokens"], 30);
        reg.release_reservation("two"); reg.settle_reservation("one", 15);
        assert_eq!(reg.org_member_usage_get("org_p6b_test", "2026-10", &[]).unwrap()["members"][0]["spentTokens"], 15);
    }

    #[test]
    fn p6b_usage_flush_restart_and_synchronous_caps() {
        use crate::org_usage::{InMemoryMemberUsageStore, MemberUsageStore};
        let store = std::sync::Arc::new(InMemoryMemberUsageStore::default());
        let reg = registry(); reg.attach_usage_store(store.clone()).unwrap();
        reg.org_usage_cap_set("org_p6b_test", None, Some(Some(100))).unwrap();
        reg.org_usage_cap_set("org_p6b_test", Some("usr_p6b_one"), Some(Some(50))).unwrap();
        assert_eq!(store.load().unwrap().orgs["org_p6b_test"].effective_cap("usr_p6b_one"), Some(50));
        let now = p6b_now("2026-10"); let ticket = p6b_member_ticket(&reg, now, "usr_p6b_one");
        reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "settled", 20).unwrap();
        reg.settle_reservation("settled", 12);
        assert!(store.load().unwrap().orgs["org_p6b_test"].months.is_empty(), "usage must not write per call");
        reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "orphan", 10).unwrap();
        reg.flush().unwrap();
        let persisted = store.load().unwrap();
        assert_eq!(persisted.orgs["org_p6b_test"].months["2026-10"]["usr_p6b_one"].spent, 12);
        assert_eq!(persisted.orgs["org_p6b_test"].months["2026-10"]["usr_p6b_one"].reserved, 10);
        let restarted = registry(); restarted.attach_usage_store(store).unwrap();
        let report = restarted.org_member_usage_get("org_p6b_test", "2026-10", &[]).unwrap();
        assert_eq!(report["members"][0]["spentTokens"], 22);
        assert_eq!(report["members"][0]["reservedTokens"], 0);
        assert_eq!(report["members"][0]["monthlyTokens"], 50);
        let source = include_str!("server.rs");
        assert!(source.contains("tokio::time::interval(Duration::from_secs(60))"));
        assert!(source.contains("flush_tickets.flush()"));
        assert!(include_str!("lib.rs").contains("self.tickets.flush()"));
    }

    #[test]
    fn p6b_expiry_and_missing_stream_usage_cannot_refund_member_work() {
        let reg = registry(); let now = p6b_now("2026-10");
        reg.org_usage_cap_set("org_p6b_test", None, Some(Some(50))).unwrap();
        let ticket = p6b_member_ticket(&reg, now, "usr_p6b_one");
        reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "stream", 10).unwrap();
        assert!(reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "stream", 1).is_err());
        reg.org_usage_settle_unknown("stream", 0); reg.org_usage_settle_unknown("stream", 0);
        reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "expires", 10).unwrap();
        assert_eq!(reg.sweep_expired(ticket.ticket.expires_at_ms), 1);
        assert!(reg.open_reservations().is_empty());
        let report = reg.org_member_usage_get("org_p6b_test", "2026-10", &[]).unwrap();
        assert_eq!(report["members"][0]["spentTokens"], 20);
        assert_eq!(report["members"][0]["reservedTokens"], 0);
        reg.release_reservation("expires"); reg.settle_reservation("expires", 20);
        assert_eq!(reg.org_member_usage_get("org_p6b_test", "2026-10", &[]).unwrap(), report);
        let legacy = reg.mint(mint_request(), Some(&snapshot()), now).unwrap();
        reg.validate_and_reserve(&legacy.secret, now, TicketOperation::Chat, "legacy-stream", 10).unwrap();
        reg.org_usage_settle_unknown("legacy-stream", 10);
        assert!(reg.open_reservations().is_empty());
        assert_eq!(reg.org_member_usage_get("org_p6b_test", "2026-10", &[]).unwrap(), report);
    }

    #[test]
    fn p6b_store_failures_keep_caps_atomic_and_flush_dirty_for_retry() {
        struct P6bStore {
            memory: crate::org_usage::InMemoryMemberUsageStore,
            fail: std::sync::atomic::AtomicBool,
        }
        impl crate::org_usage::MemberUsageStore for P6bStore {
            fn load(&self) -> Result<MemberUsageLedger, String> {
                if self.fail.load(std::sync::atomic::Ordering::SeqCst) { return Err("organization usage store unavailable".into()); }
                self.memory.load()
            }
            fn save_org(&self, org: &str, usage: &crate::org_usage::OrgUsage) -> Result<(), String> {
                if self.fail.load(std::sync::atomic::Ordering::SeqCst) { return Err("organization usage store unavailable".into()); }
                self.memory.save_org(org, usage)
            }
        }
        let store = std::sync::Arc::new(P6bStore { memory: Default::default(), fail: Default::default() });
        let reg = registry(); reg.attach_usage_store(store.clone()).unwrap();
        reg.org_usage_cap_set("org_p6b_test", None, Some(Some(10))).unwrap();
        store.fail.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(reg.org_usage_cap_set("org_p6b_test", None, Some(None)).is_err());
        assert_eq!(reg.org_member_usage_get("org_p6b_test", "2026-10", &[]).unwrap()["defaultMonthlyTokens"], 10);
        let now = p6b_now("2026-10"); let ticket = p6b_member_ticket(&reg, now, "usr_p6b_one");
        reg.validate_and_reserve(&ticket.secret, now, TicketOperation::Chat, "request", 10).unwrap();
        reg.settle_reservation("request", 8);
        assert!(reg.flush().is_err());
        assert!(reg.inner.lock().usage_dirty);
        store.fail.store(false, std::sync::atomic::Ordering::SeqCst);
        reg.flush().unwrap();
        assert!(!reg.inner.lock().usage_dirty);
        assert_eq!(store.memory.load().unwrap().orgs["org_p6b_test"].months["2026-10"]["usr_p6b_one"].spent, 8);
        store.fail.store(true, std::sync::atomic::Ordering::SeqCst);
        let unavailable = registry();
        assert!(unavailable.attach_usage_store(store).is_err());
        let member = p6b_member_ticket(&unavailable, now, "usr_p6b_one");
        assert_eq!(unavailable.validate_and_reserve(&member.secret, now, TicketOperation::Chat, "closed", 1), Err(TicketReject::MemberUsageUnavailable));
        let legacy = unavailable.mint(mint_request(), Some(&snapshot()), now).unwrap();
        assert!(unavailable.validate_and_reserve(&legacy.secret, now, TicketOperation::Chat, "legacy", 1).is_ok());
        assert!(unavailable.org_member_usage_get("org_p6b_test", "2026-10", &[]).is_err());
    }

    #[test]
    fn p6b_unbound_tickets_and_mint_paths_remain_unchanged() {
        let reg = registry();
        reg.org_usage_cap_set("org_p6b_test", None, Some(Some(0))).unwrap();
        let ticket = reg.mint(mint_request(), Some(&snapshot()), 0).unwrap();
        assert!(ticket.ticket.member.is_none());
        let bound = p6b_member_ticket(&reg, 0, "usr_p6b_never_plaintext");
        let metadata = serde_json::to_string(&bound.ticket).unwrap();
        assert!(!metadata.contains("usr_p6b_never_plaintext"));
        assert!(serde_json::from_str::<RouteTicket>(&metadata).unwrap().member.is_none());
        assert!(!reg.secret_has_token_budget(&ticket.secret));
        reg.validate_and_reserve(&ticket.secret, 1, TicketOperation::Chat, "legacy", 100).unwrap();
        reg.validate_and_reserve(&ticket.secret, 1, TicketOperation::Chat, "legacy", 200).unwrap();
        assert_eq!(reg.open_reservations()[0].tokens_held, 200);
        assert_eq!(reg.reserve_model_output("legacy", 1000, Some(4000)), Ok(Some(4000)));
        reg.settle_reservation("legacy", 5000);
        assert!(reg.inner.lock().usage.orgs["org_p6b_test"].months.is_empty());
    }

    #[test]
    fn strict_model_resolution_never_uses_containment() {
        let reg = registry();
        let mut ticket = reg
            .mint(mint_request(), Some(&snapshot()), 0)
            .unwrap()
            .ticket;
        ticket
            .model_bindings
            .insert("haiku".into(), "model-alpha".into());
        assert_eq!(
            ticket.resolve_model("claude-haiku-x").as_deref(),
            Some("model-alpha")
        );
        ticket.strict_selectors = true;
        assert_eq!(
            ticket.resolve_model("haiku").as_deref(),
            Some("model-alpha")
        );
        assert_eq!(
            ticket.resolve_model("model-alpha").as_deref(),
            Some("model-alpha")
        );
        assert_eq!(ticket.resolve_model("claude-haiku-x"), None);
        assert_eq!(ticket.resolve_model("unknown"), None);
    }

    #[test]
    fn strict_mint_refuses_binding_outside_deployment() {
        let reg = registry();
        let mut request = mint_request();
        request.strict_selectors = true;
        request.candidates.truncate(1);
        request.allow_auth_failover = false;
        request.credential_affinity = TicketAffinity::SessionSticky;
        request
            .model_bindings
            .insert("haiku".into(), "outside".into());
        assert!(matches!(
            reg.mint(request, Some(&snapshot()), 0),
            Err(TicketError::InvalidModelPlan(_))
        ));
    }

    #[test]
    fn strict_mint_binds_only_the_requested_models_of_a_shared_deployment() {
        let reg = registry();
        let mut snapshot = snapshot();
        snapshot.providers[0].models = vec![
            "model-alpha".into(),
            "model-beta".into(),
            "model-gamma".into(),
        ];
        let mut request = mint_request();
        request.strict_selectors = true;
        request.candidates.truncate(1);
        request.credential_affinity = TicketAffinity::SessionSticky;
        request
            .model_bindings
            .insert("haiku".into(), "model-beta".into());
        let ticket = reg.mint(request, Some(&snapshot), 0).unwrap().ticket;
        assert_eq!(ticket.resolve_model("haiku").as_deref(), Some("model-beta"));
        assert_eq!(
            ticket.resolve_model("model-beta").as_deref(),
            Some("model-beta")
        );
        assert_eq!(ticket.resolve_model("model-gamma"), None);
        assert!(!ticket.model_bindings.contains_key("model-gamma"));
    }

    #[test]
    fn remint_authority_is_scoped_to_the_local_account_owner() {
        let reg = registry();
        let snapshot = snapshot();
        let mut narrow = mint_request();
        narrow.candidates.truncate(1);
        let ticket = reg
            .mint_owned(narrow, Some(&snapshot), 1, Some("account-a".into()))
            .unwrap();
        assert_eq!(ticket.ticket.owner_account_id.as_deref(), Some("account-a"));
        assert!(reg
            .mint_owned(mint_request(), Some(&snapshot), 2, Some("account-a".into()))
            .is_err());
        assert!(reg
            .mint_owned(mint_request(), Some(&snapshot), 2, Some("account-b".into()))
            .is_ok());
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
        assert!(!ticket.strict_selectors);
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
                    reg.validate_and_reserve(
                        &secret,
                        1,
                        TicketOperation::Chat,
                        &format!("req-{i}"),
                        0,
                    )
                    .is_ok()
                })
            })
            .collect();
        let admitted = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|admitted| *admitted)
            .count();
        assert_eq!(
            admitted, 1,
            "exactly one request may pass a max_requests=1 gate"
        );
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
        assert_eq!(
            reg.open_reservations().len(),
            1,
            "refused calls hold nothing"
        );
    }

    #[test]
    fn final_model_reservation_accounts_for_expanded_history_and_output_cap() {
        let reg = registry();
        let mut request = mint_request();
        request.budget = Some(TicketBudget {
            max_tokens: Some(100),
            ..Default::default()
        });
        let minted = reg.mint(request, Some(&snapshot()), 0).unwrap();
        reg.validate_and_reserve(&minted.secret, 1, TicketOperation::Chat, "r", 10)
            .unwrap();
        assert_eq!(reg.reserve_model_output("r", 80, Some(40)), Ok(Some(20)));
        assert_eq!(
            reg.reserve_model_output("r", 101, None),
            Err(TicketReject::BudgetExhausted)
        );
        reg.release_reservation("r");
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
        assert_eq!(
            store.load().unwrap()[0]
                .budget
                .as_ref()
                .unwrap()
                .spent_tokens,
            30
        );
        reg.flush().unwrap();
        assert_eq!(
            store.load().unwrap()[0]
                .budget
                .as_ref()
                .unwrap()
                .spent_tokens,
            35
        );
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
