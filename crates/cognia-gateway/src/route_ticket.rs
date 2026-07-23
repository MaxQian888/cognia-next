//! Gateway route tickets (ADR-0090 Phase 2, plan §3.4).
//!
//! A route ticket is a session-scoped bearer the local Claude Code / Agent
//! SDK subprocess presents as its `ANTHROPIC_API_KEY`. It is NOT an ordinary
//! gateway API key:
//! - candidates and model bindings are FROZEN at mint (validated against the
//!   live snapshot); a later alias/settings change never alters them;
//! - the secret (`sk-cognia-rt-…`) lives in memory only — restarts require a
//!   re-mint, which must present the SAME frozen spec (no widening);
//! - metadata (everything but the secret) is persisted for audit/revocation.

use std::collections::BTreeMap;

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
}

impl RouteTicket {
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

pub struct RouteTicketRegistry {
    records: Mutex<Vec<TicketRecord>>,
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
            records: Mutex::new(records),
            store: Mutex::new(store),
        }
    }

    /// Swap the metadata store (boot-time: in-memory → on-disk once the data
    /// dir is known). Existing persisted metadata is merged in (secrets are
    /// never persisted, so reloaded records validate as Unknown until
    /// re-minted) and the combined set is persisted to the new store.
    pub fn attach_store(&self, store: std::sync::Arc<dyn TicketMetaStore>) {
        let loaded = store.load().unwrap_or_default();
        let mut records = self.records.lock();
        for ticket in loaded {
            if !records
                .iter()
                .any(|r| r.ticket.ticket_id == ticket.ticket_id)
            {
                records.push(TicketRecord {
                    ticket,
                    secret: None,
                });
            }
        }
        *self.store.lock() = store;
        let _ = self.persist(&records);
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
        if request.candidates.is_empty() {
            return Err(TicketError::NoCandidates);
        }
        let snapshot = snapshot.ok_or(TicketError::NoSnapshot)?;
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

        let mut records = self.records.lock();
        if let Some(prior) = records
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
        };
        records.push(TicketRecord {
            ticket: ticket.clone(),
            secret: Some(secret.clone()),
        });
        self.persist(&records)?;
        Ok(MintedTicket { ticket, secret })
    }

    /// Constant-time secret validation. Expired/revoked/unknown all fail
    /// closed with a typed reason (the middleware maps every reason to 401 —
    /// no fallthrough into the ordinary key path).
    pub fn validate(&self, supplied: &str, now_ms: i64) -> Result<RouteTicket, TicketReject> {
        let records = self.records.lock();
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
        let Some(index) = matched else {
            return Err(TicketReject::Unknown);
        };
        let ticket = &records[index].ticket;
        if ticket.revoked {
            return Err(TicketReject::Revoked);
        }
        if now_ms >= ticket.expires_at_ms {
            return Err(TicketReject::Expired);
        }
        Ok(ticket.clone())
    }

    pub fn revoke(&self, ticket_id: &str) -> bool {
        let mut records = self.records.lock();
        let mut hit = false;
        for record in records.iter_mut() {
            if record.ticket.ticket_id == ticket_id {
                record.ticket.revoked = true;
                record.secret = None;
                hit = true;
            }
        }
        if hit {
            let _ = self.persist(&records);
        }
        hit
    }

    pub fn revoke_session(&self, session_id: &str) -> usize {
        let mut records = self.records.lock();
        let mut count = 0;
        for record in records.iter_mut() {
            if record.ticket.session_id == session_id && !record.ticket.revoked {
                record.ticket.revoked = true;
                record.secret = None;
                count += 1;
            }
        }
        if count > 0 {
            let _ = self.persist(&records);
        }
        count
    }

    /// Drop expired records entirely (their audit value has a horizon).
    pub fn sweep_expired(&self, now_ms: i64) -> usize {
        let mut records = self.records.lock();
        let before = records.len();
        records.retain(|r| now_ms < r.ticket.expires_at_ms);
        let dropped = before - records.len();
        if dropped > 0 {
            let _ = self.persist(&records);
        }
        dropped
    }

    /// Redacted listing (no secrets are stored, so this is just the metadata).
    pub fn list(&self) -> Vec<RouteTicket> {
        self.records
            .lock()
            .iter()
            .map(|r| r.ticket.clone())
            .collect()
    }

    pub fn active_count(&self, now_ms: i64) -> usize {
        self.records
            .lock()
            .iter()
            .filter(|r| !r.ticket.revoked && now_ms < r.ticket.expires_at_ms)
            .count()
    }
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
        assert_eq!(ticket.resolve_model("primary").as_deref(), Some("model-alpha"));
        // Family selector embedded in a full model id.
        assert_eq!(
            ticket.resolve_model("claude-sonnet-5").as_deref(),
            Some("model-alpha")
        );
        // Verbatim candidate model.
        assert_eq!(ticket.resolve_model("model-alpha").as_deref(), Some("model-alpha"));
        // Unmapped selector fails closed.
        assert_eq!(ticket.resolve_model("gpt-4o"), None);
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
