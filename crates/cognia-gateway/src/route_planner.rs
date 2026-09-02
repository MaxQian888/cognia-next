//! Synchronous, request-local routing for V2 gateway snapshots.
//!
//! Snapshot compilation stays renderer/profile-store side; this module owns
//! only deterministic eligibility and ordering on the Rust hot path.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};

use parking_lot::Mutex;
use serde_json::Value;

use crate::execute::{candidates_from_entries, Candidate};
use crate::route_ticket::TicketCandidate;
use crate::snapshot::{AliasSnapshot, ProviderSnapshot, RoutingSnapshot, SnapshotEntry};

#[derive(Default)]
pub struct RoutePlannerState {
    /// Next logical slot per policy/route/candidate-set fingerprint.
    cursors: Mutex<HashMap<String, u64>>,
}

fn fingerprint(snapshot: &RoutingSnapshot, route: &str, entries: &[SnapshotEntry]) -> String {
    let revision = snapshot
        .routing_policy
        .as_ref()
        .map(|policy| policy.policy_revision.as_str())
        .unwrap_or("legacy");
    let members = entries
        .iter()
        .map(|entry| {
            format!(
                "{}:{}:{}",
                entry.provider_id,
                entry.model_id,
                entry.weight.unwrap_or(1)
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    format!("{revision}:{route}:{members}")
}

fn reserve_slot(state: &RoutePlannerState, key: String, modulo: u64) -> u64 {
    let mut cursors = state.cursors.lock();
    if cursors.len() >= 1_024 && !cursors.contains_key(&key) {
        cursors.clear();
    }
    let next = cursors.entry(key).or_insert(0);
    let selected = *next % modulo.max(1);
    *next = next.wrapping_add(1);
    selected
}

fn selected_index(
    snapshot: &RoutingSnapshot,
    alias: &AliasSnapshot,
    entries: &[SnapshotEntry],
    state: &RoutePlannerState,
) -> usize {
    if entries.len() <= 1 || alias.distribution == "priority" {
        return 0;
    }
    let key = fingerprint(snapshot, &alias.alias, entries);
    if alias.distribution == "weighted" {
        let total: u64 = alias
            .entries
            .iter()
            .filter(|entry| {
                entries.iter().any(|eligible| {
                    eligible.provider_id == entry.provider_id && eligible.model_id == entry.model_id
                })
            })
            .map(|entry| u64::from(entry.weight.unwrap_or(1).max(1)))
            .sum();
        let sequence = reserve_slot(state, key.clone(), u64::MAX);
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut hasher);
        sequence.hash(&mut hasher);
        let slot = hasher.finish() % total;
        let mut cumulative = 0u64;
        for (index, entry) in entries.iter().enumerate() {
            cumulative += u64::from(entry.weight.unwrap_or(1).max(1));
            if slot < cumulative {
                return index;
            }
        }
        0
    } else {
        reserve_slot(state, key, entries.len() as u64) as usize
    }
}

#[derive(Default)]
struct RequestRequirements {
    tools: bool,
    vision: bool,
    structured_output: bool,
    streaming: bool,
    estimated_context_tokens: u64,
    local_only: bool,
}

fn value_contains_image(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(value_contains_image),
        Value::Object(object) => {
            object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "image" | "image_url" | "input_image"))
                || object.values().any(value_contains_image)
        }
        _ => false,
    }
}

fn request_requirements(body: &Value) -> RequestRequirements {
    let serialized_len = serde_json::to_string(body)
        .map(|value| value.len())
        .unwrap_or(0);
    RequestRequirements {
        tools: body
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| !tools.is_empty()),
        vision: body.get("messages").is_some_and(value_contains_image),
        structured_output: body.get("response_format").is_some()
            || body.pointer("/output_config/format").is_some(),
        streaming: body.get("stream").and_then(Value::as_bool).unwrap_or(false),
        estimated_context_tokens: (serialized_len as u64).div_ceil(4),
        local_only: body
            .pointer("/routing/dataPolicy/locality")
            .and_then(Value::as_str)
            == Some("local-only"),
    }
}

fn entry_is_eligible(
    snapshot: &RoutingSnapshot,
    entry: &SnapshotEntry,
    requirements: &RequestRequirements,
) -> bool {
    let provider_ok = snapshot
        .provider(&entry.provider_id)
        .is_some_and(|provider| {
            crate::execute::is_executable_protocol(&provider.protocol)
                && !provider.base_url.trim().is_empty()
        });
    if !provider_ok || entry.available == Some(false) {
        return false;
    }
    if requirements.local_only && entry.locality.as_deref() != Some("local") {
        return false;
    }
    if let Some(constraint) = snapshot.routing_policy.as_ref().and_then(|policy| {
        policy
            .provider_constraints
            .iter()
            .find(|constraint| constraint.provider_id == entry.provider_id && constraint.enabled)
    }) {
        if constraint.circuit_open
            || constraint
                .max_requests_per_minute
                .zip(constraint.current_requests_per_minute)
                .is_some_and(|(limit, current)| current >= limit)
            || constraint
                .max_tokens_per_minute
                .zip(constraint.current_tokens_per_minute)
                .is_some_and(|(limit, current)| current >= limit)
            || constraint
                .daily_cost_budget
                .zip(constraint.current_daily_cost)
                .is_some_and(|(limit, current)| current >= limit)
        {
            return false;
        }
    }
    if let Some(capabilities) = &entry.capabilities {
        if (requirements.tools && capabilities.tools == Some(false))
            || (requirements.vision && capabilities.vision == Some(false))
            || (requirements.structured_output && capabilities.structured_output == Some(false))
            || (requirements.streaming && capabilities.streaming == Some(false))
            || capabilities
                .context_tokens
                .is_some_and(|limit| limit < requirements.estimated_context_tokens)
        {
            return false;
        }
    }
    if let Some(conditions) = &entry.conditions {
        if conditions
            .max_cost_per_1_m
            .zip(entry.pricing_per_1_m)
            .is_some_and(|(limit, actual)| actual > limit)
            || conditions
                .max_latency_ms
                .zip(entry.latency_ms)
                .is_some_and(|(limit, actual)| actual > limit)
        {
            return false;
        }
    }
    true
}

fn executable_entries(
    snapshot: &RoutingSnapshot,
    entries: &[SnapshotEntry],
    requirements: &RequestRequirements,
) -> Vec<SnapshotEntry> {
    entries
        .iter()
        .filter(|entry| entry_is_eligible(snapshot, entry, requirements))
        .cloned()
        .collect()
}

fn primary_first(entries: &[SnapshotEntry], selected: usize) -> Vec<SnapshotEntry> {
    if entries.is_empty() {
        return Vec::new();
    }
    let mut ordered = Vec::with_capacity(entries.len());
    ordered.push(entries[selected].clone());
    ordered.extend(
        entries
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != selected)
            .map(|(_, entry)| entry.clone()),
    );
    ordered
}

fn prompt_text(body: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            if let Some(content) = message.get("content").and_then(Value::as_str) {
                parts.push(content);
            }
        }
    }
    if let Some(prompt) = body.get("prompt").and_then(Value::as_str) {
        parts.push(prompt);
    }
    parts.join(" ")
}

fn difficulty_alias<'a>(snapshot: &'a RoutingSnapshot, body: &Value) -> Option<&'a AliasSnapshot> {
    let policy = snapshot.routing_policy.as_ref()?;
    let aliases = &policy.auto.candidate_aliases;
    if aliases.is_empty() {
        return None;
    }
    let text = prompt_text(body);
    let complexity = text.len() as f64 / 4_000.0
        + if text.contains("```") { 0.25 } else { 0.0 }
        + if text.contains("analyze") || text.contains("reason") {
            0.2
        } else {
            0.0
        };
    let thresholds = policy.auto.thresholds.as_ref();
    let balanced = thresholds.map(|value| value.balanced).unwrap_or(0.34);
    let powerful = thresholds.map(|value| value.powerful).unwrap_or(0.67);
    let (tier, index) = if complexity >= powerful {
        ("powerful", aliases.len().saturating_sub(1))
    } else if complexity >= balanced {
        ("balanced", 1.min(aliases.len().saturating_sub(1)))
    } else {
        ("fast", 0)
    };
    policy
        .tier_aliases
        .get(tier)
        .and_then(|alias| snapshot.find_alias(alias))
        .or_else(|| snapshot.find_alias(&aliases[index]))
}

/// Merge an explicit alias's generation defaults into missing request fields.
/// Client-supplied values always win.
pub fn apply_parameter_defaults(snapshot: &RoutingSnapshot, model: &str, body: &Value) -> Value {
    let Some(defaults) = snapshot
        .find_alias(model)
        .and_then(|alias| alias.parameter_defaults.as_ref())
        .and_then(Value::as_object)
    else {
        return body.clone();
    };
    let mut merged = body.clone();
    let Some(object) = merged.as_object_mut() else {
        return merged;
    };
    for (policy_key, wire_key) in [
        ("temperature", "temperature"),
        ("maxTokens", "max_tokens"),
        ("topP", "top_p"),
        ("frequencyPenalty", "frequency_penalty"),
        ("presencePenalty", "presence_penalty"),
    ] {
        if !object.contains_key(wire_key) {
            if let Some(value) = defaults.get(policy_key) {
                object.insert(wire_key.to_string(), value.clone());
            }
        }
    }
    merged
}

fn auto_entries(snapshot: &RoutingSnapshot, body: &Value) -> Vec<SnapshotEntry> {
    let Some(policy) = &snapshot.routing_policy else {
        return Vec::new();
    };
    if policy.auto.strategy == "difficulty" {
        let requirements = request_requirements(body);
        return difficulty_alias(snapshot, body)
            .map(|alias| executable_entries(snapshot, &alias.entries, &requirements))
            .unwrap_or_default();
    }
    let mut alias_order = policy.auto.candidate_aliases.clone();
    match policy.auto.strategy.as_str() {
        // Candidate aliases are compiled low-to-high capability. Quality starts
        // at the strongest tier; balanced/adaptive start at the middle tier.
        "quality" => alias_order.reverse(),
        "balanced" | "adaptive" if alias_order.len() > 2 => {
            alias_order.rotate_left(1);
        }
        _ => {}
    }
    let requirements = request_requirements(body);
    let mut seen = HashSet::new();
    let mut entries: Vec<SnapshotEntry> = alias_order
        .iter()
        .filter_map(|alias| snapshot.find_alias(alias))
        .flat_map(|alias| alias.entries.iter().cloned())
        .filter(|entry| entry_is_eligible(snapshot, entry, &requirements))
        .filter(|entry| seen.insert((entry.provider_id.clone(), entry.model_id.clone())))
        .collect();
    match policy.auto.strategy.as_str() {
        "reliability" => entries.sort_by(|left, right| {
            right
                .success_rate
                .partial_cmp(&left.success_rate)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        "cost" => entries.sort_by(|left, right| {
            left.pricing_per_1_m
                .unwrap_or(f64::INFINITY)
                .partial_cmp(&right.pricing_per_1_m.unwrap_or(f64::INFINITY))
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        "speed" => entries.sort_by(|left, right| {
            left.latency_ms
                .unwrap_or(f64::INFINITY)
                .partial_cmp(&right.latency_ms.unwrap_or(f64::INFINITY))
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        "adaptive" => entries.sort_by(|left, right| {
            right
                .success_rate
                .partial_cmp(&left.success_rate)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    left.latency_ms
                        .unwrap_or(f64::INFINITY)
                        .partial_cmp(&right.latency_ms.unwrap_or(f64::INFINITY))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        }),
        _ => {}
    }
    entries
}

/// Return a complete primary-first candidate walk using only local state.
pub fn plan_candidates(
    snapshot: &RoutingSnapshot,
    model: &str,
    body: &Value,
    state: &RoutePlannerState,
    in_flight: &HashMap<String, u32>,
) -> Vec<Candidate> {
    if let Some(policy) = &snapshot.routing_policy {
        if model.eq_ignore_ascii_case(&policy.auto.model_id) {
            let mut entries = auto_entries(snapshot, body);
            if policy.auto.strategy == "least-busy" {
                entries
                    .sort_by_key(|entry| in_flight.get(&entry.provider_id).copied().unwrap_or(0));
            }
            return candidates_from_entries(snapshot, &entries);
        }
    }
    let Some(alias) = snapshot.find_alias(model) else {
        return crate::execute::resolve_candidates(snapshot, model);
    };
    let requirements = request_requirements(body);
    let entries = executable_entries(snapshot, &alias.entries, &requirements);
    if entries.is_empty() {
        return Vec::new();
    }
    let selected = selected_index(snapshot, alias, &entries, state);
    candidates_from_entries(snapshot, &primary_first(&entries, selected))
}

/// Candidates the gateway can serve for `model`, ordered. Rust twin of
/// `lib/gateway/mint-session-ticket.ts` `candidatesForModel`: an alias
/// contributes its ordered entries; a bare or `provider:model` id falls back
/// to whichever enabled providers list it. Deployment ids address the
/// Profile Store deployment, falling back to the provider id.
pub fn candidates_for_model(snapshot: &RoutingSnapshot, model: &str) -> Vec<TicketCandidate> {
    let deployment_for = |provider_id: &str| -> Option<String> {
        snapshot
            .providers
            .iter()
            .find(|p| p.id == provider_id)
            .map(|p| p.deployment_id.clone().unwrap_or_else(|| p.id.clone()))
    };
    if let Some(alias) = snapshot.find_alias(model) {
        return alias
            .entries
            .iter()
            .filter_map(|entry| {
                deployment_for(&entry.provider_id).map(|deployment_id| TicketCandidate {
                    deployment_id,
                    model_id: entry.model_id.clone(),
                })
            })
            .collect();
    }
    let (pinned_provider, bare_model) = match model.split_once(':') {
        Some((provider, rest)) if !rest.is_empty() => (Some(provider), rest),
        _ => (None, model),
    };
    snapshot
        .providers
        .iter()
        .filter(|p| p.enabled)
        .filter(|p| pinned_provider.is_none_or(|pinned| p.id == pinned))
        .filter(|p| p.models.iter().any(|m| m == bare_model))
        .map(|p| TicketCandidate {
            deployment_id: p.deployment_id.clone().unwrap_or_else(|| p.id.clone()),
            model_id: bare_model.to_string(),
        })
        .collect()
}

/// The family selectors Claude Code sends besides the primary model. Its
/// background turns (`haiku`) were the first request of every session to
/// fail with 400 when no ticket bound them.
const FAMILY_SELECTORS: [&str; 3] = ["sonnet", "haiku", "opus"];

/// Bind `primary` plus every family selector against the providers behind
/// `candidates`. A family gets the first model any candidate provider lists
/// whose id contains the family name; a family with no such model binds to
/// the primary so the turn still routes rather than failing closed.
pub fn bindings_for_candidates(
    snapshot: &RoutingSnapshot,
    candidates: &[TicketCandidate],
    model: &str,
) -> BTreeMap<String, String> {
    let primary = candidates
        .first()
        .map(|c| c.model_id.clone())
        .unwrap_or_else(|| model.to_string());
    let providers: Vec<&ProviderSnapshot> = candidates
        .iter()
        .filter_map(|c| {
            snapshot
                .provider_by_deployment(&c.deployment_id)
                .or_else(|| snapshot.provider(&c.deployment_id))
        })
        .collect();
    let mut bindings = BTreeMap::new();
    bindings.insert("primary".to_string(), primary.clone());
    for family in FAMILY_SELECTORS {
        let bound = providers
            .iter()
            .flat_map(|p| p.models.iter())
            .find(|m| m.to_lowercase().contains(family))
            .cloned()
            .unwrap_or_else(|| primary.clone());
        bindings.insert(family.to_string(), bound);
    }
    bindings
}

/// [`candidates_for_model`] followed by [`bindings_for_candidates`]: the
/// default `model_bindings` for a mint request that named only its model.
pub fn default_model_bindings(snapshot: &RoutingSnapshot, model: &str) -> BTreeMap<String, String> {
    let candidates = candidates_for_model(snapshot, model);
    bindings_for_candidates(snapshot, &candidates, model)
}

/// Whether the requested model names a configured route even if every
/// deployment is currently disabled, unsupported, or cooling down.
pub fn model_is_known(snapshot: &RoutingSnapshot, model: &str) -> bool {
    snapshot
        .routing_policy
        .as_ref()
        .is_some_and(|policy| model.eq_ignore_ascii_case(&policy.auto.model_id))
        || snapshot.find_alias(model).is_some()
        || model
            .split_once(':')
            .is_some_and(|(provider_id, concrete)| {
                !concrete.is_empty()
                    && snapshot
                        .providers
                        .iter()
                        .any(|provider| provider.id == provider_id)
            })
        || snapshot
            .providers
            .iter()
            .any(|provider| provider.models.iter().any(|candidate| candidate == model))
}

/// Provider ids belonging to a configured route without advancing any
/// distribution cursor. Used only to surface cooldown recovery metadata.
pub fn route_provider_ids(snapshot: &RoutingSnapshot, model: &str) -> HashSet<String> {
    let aliases: Vec<&AliasSnapshot> = if let Some(policy) = &snapshot.routing_policy {
        if model.eq_ignore_ascii_case(&policy.auto.model_id) {
            policy
                .auto
                .candidate_aliases
                .iter()
                .filter_map(|alias| snapshot.find_alias(alias))
                .collect()
        } else {
            snapshot.find_alias(model).into_iter().collect()
        }
    } else {
        snapshot.find_alias(model).into_iter().collect()
    };
    let mut ids: HashSet<String> = aliases
        .into_iter()
        .flat_map(|alias| alias.entries.iter().map(|entry| entry.provider_id.clone()))
        .collect();
    if let Some((provider_id, concrete)) = model.split_once(':') {
        if !concrete.is_empty() {
            ids.insert(provider_id.to_string());
        }
    }
    for provider in &snapshot.providers {
        if provider.models.iter().any(|candidate| candidate == model) {
            ids.insert(provider.id.clone());
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::RoutingSnapshot;

    fn snapshot(distribution: &str) -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [{ "alias": "fast", "distribution": distribution, "entries": [
                { "providerId": "a", "modelId": "m-a", "weight": 3 },
                { "providerId": "b", "modelId": "m-b", "weight": 1 }
            ]}],
            "providers": [
                { "id": "a", "protocol": "openai", "baseUrl": "https://a/v1", "enabled": true },
                { "id": "b", "protocol": "anthropic", "baseUrl": "https://b/v1", "enabled": true }
            ],
            "routingPolicy": {
                "schemaVersion": 2,
                "policyRevision": "p1",
                "auto": { "modelId": "auto", "strategy": "least-busy", "candidateAliases": ["fast"] },
                "maxFallbackAttempts": 3
            },
            "generatedAtMs": 1
        }))
        .unwrap()
    }

    #[test]
    fn round_robin_is_fair_and_starts_at_zero() {
        let state = RoutePlannerState::default();
        let snapshot = snapshot("round-robin");
        let selected: Vec<String> = (0..10_000)
            .map(|_| {
                plan_candidates(
                    &snapshot,
                    "fast",
                    &serde_json::json!({}),
                    &state,
                    &Default::default(),
                )[0]
                .provider
                .id
                .clone()
            })
            .collect();
        assert_eq!(selected[0], "a");
        let a = selected.iter().filter(|id| id.as_str() == "a").count();
        let b = selected.len() - a;
        assert!((a as isize - b as isize).abs() <= 1);
    }

    #[test]
    fn weighted_distribution_matches_configured_ratio() {
        let state = RoutePlannerState::default();
        let snapshot = snapshot("weighted");
        let a = (0..100_000)
            .filter(|_| {
                plan_candidates(
                    &snapshot,
                    "fast",
                    &serde_json::json!({}),
                    &state,
                    &Default::default(),
                )[0]
                .provider
                .id == "a"
            })
            .count();
        let share = a as f64 / 100_000.0;
        assert!((share - 0.75).abs() <= 0.02, "weighted share was {share}");
    }

    #[test]
    fn auto_least_busy_prefers_the_idle_deployment() {
        let state = RoutePlannerState::default();
        let mut in_flight = std::collections::HashMap::new();
        in_flight.insert("a".to_string(), 4);
        in_flight.insert("b".to_string(), 0);
        let plan = plan_candidates(
            &snapshot("priority"),
            "auto",
            &serde_json::json!({"messages": [{"role": "user", "content": "hello"}]}),
            &state,
            &in_flight,
        );
        assert_eq!(plan[0].provider.id, "b");
    }

    #[test]
    fn auto_builtin_strategies_select_the_expected_tier() {
        let mut snapshot: RoutingSnapshot = serde_json::from_value(serde_json::json!({
            "aliases": [
                { "alias": "fast", "entries": [{ "providerId": "a", "modelId": "fast" }] },
                { "alias": "balanced", "entries": [{ "providerId": "b", "modelId": "balanced" }] },
                { "alias": "powerful", "entries": [{ "providerId": "c", "modelId": "powerful" }] }
            ],
            "providers": [
                { "id": "a", "protocol": "openai", "baseUrl": "https://a/v1", "enabled": true },
                { "id": "b", "protocol": "openai", "baseUrl": "https://b/v1", "enabled": true },
                { "id": "c", "protocol": "anthropic", "baseUrl": "https://c/v1", "enabled": true }
            ],
            "routingPolicy": {
                "schemaVersion": 2,
                "policyRevision": "p1",
                "auto": {
                    "modelId": "auto",
                    "strategy": "reliability",
                    "candidateAliases": ["fast", "balanced", "powerful"]
                },
                "maxFallbackAttempts": 3
            },
            "generatedAtMs": 1
        }))
        .unwrap();
        let state = RoutePlannerState::default();
        for (strategy, expected) in [
            ("reliability", "a"),
            ("cost", "a"),
            ("speed", "a"),
            ("quality", "c"),
            ("balanced", "b"),
            ("adaptive", "b"),
        ] {
            snapshot.routing_policy.as_mut().unwrap().auto.strategy = strategy.to_string();
            let plan = plan_candidates(
                &snapshot,
                "auto",
                &serde_json::json!({}),
                &state,
                &Default::default(),
            );
            assert_eq!(plan[0].provider.id, expected, "strategy {strategy}");
        }
    }

    #[test]
    fn distribution_ignores_ineligible_candidates_before_reserving() {
        let state = RoutePlannerState::default();
        let mut snapshot = snapshot("round-robin");
        snapshot.providers[0].enabled = false;
        let selected: Vec<String> = (0..10)
            .map(|_| {
                plan_candidates(
                    &snapshot,
                    "fast",
                    &serde_json::json!({}),
                    &state,
                    &Default::default(),
                )[0]
                .provider
                .id
                .clone()
            })
            .collect();
        assert!(selected.iter().all(|provider| provider == "b"));
    }

    #[test]
    fn request_capabilities_filter_before_selection() {
        let state = RoutePlannerState::default();
        let mut snapshot = snapshot("priority");
        snapshot.aliases[0].entries[0].capabilities =
            Some(serde_json::from_value(serde_json::json!({ "tools": false })).unwrap());
        snapshot.aliases[0].entries[1].capabilities =
            Some(serde_json::from_value(serde_json::json!({ "tools": true })).unwrap());
        let plan = plan_candidates(
            &snapshot,
            "fast",
            &serde_json::json!({ "tools": [{ "type": "function" }] }),
            &state,
            &Default::default(),
        );
        assert_eq!(plan[0].provider.id, "b");
    }

    #[test]
    fn alias_parameter_defaults_fill_only_missing_fields() {
        let mut snapshot = snapshot("priority");
        snapshot.aliases[0].parameter_defaults = Some(serde_json::json!({
            "temperature": 0.2,
            "maxTokens": 512,
            "topP": 0.8
        }));
        let merged = apply_parameter_defaults(
            &snapshot,
            "fast",
            &serde_json::json!({ "model": "fast", "temperature": 0.9 }),
        );
        assert_eq!(merged["temperature"], 0.9);
        assert_eq!(merged["max_tokens"], 512);
        assert_eq!(merged["top_p"], 0.8);
    }

    #[test]
    fn request_size_estimate_matches_serde_json_wire_length() {
        let body = serde_json::json!({
            "model": "fast",
            "messages": [{ "role": "user", "content": "你好, analyze ```rust```" }],
            "stream": true
        });
        let expected = serde_json::to_string(&body).unwrap().len() as u64;
        assert_eq!(
            request_requirements(&body).estimated_context_tokens,
            expected.div_ceil(4)
        );
    }

    #[test]
    fn provider_constraints_filter_circuit_and_rate_exhaustion() {
        let state = RoutePlannerState::default();
        let mut snapshot = snapshot("priority");
        snapshot
            .routing_policy
            .as_mut()
            .unwrap()
            .provider_constraints = serde_json::from_value(serde_json::json!([
            {
                "providerId": "a",
                "enabled": true,
                "maxRequestsPerMinute": 10,
                "currentRequestsPerMinute": 10,
                "circuitOpen": false
            }
        ]))
        .unwrap();
        let plan = plan_candidates(
            &snapshot,
            "fast",
            &serde_json::json!({}),
            &state,
            &Default::default(),
        );
        assert_eq!(plan[0].provider.id, "b");
    }

    fn ticket_snapshot() -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [
                { "alias": "fast", "entries": [
                    { "providerId": "anthropic", "modelId": "claude-opus-5" },
                    { "providerId": "openai", "modelId": "gpt-5" }
                ]}
            ],
            "providers": [
                { "id": "anthropic", "protocol": "anthropic", "baseUrl": "https://a.example",
                  "enabled": true, "models": ["claude-opus-5", "claude-haiku-4-5-20251001"],
                  "deploymentId": "dep_anthropic" },
                { "id": "openai", "protocol": "openai", "baseUrl": "https://o.example",
                  "enabled": true, "models": ["gpt-5"], "deploymentId": "dep_openai" },
                { "id": "off", "protocol": "anthropic", "baseUrl": "https://x.example",
                  "enabled": false, "models": ["claude-opus-5"] }
            ],
            "generatedAtMs": 1
        }))
        .unwrap()
    }

    #[test]
    fn candidates_for_model_mirrors_the_renderer_twin() {
        let snap = ticket_snapshot();
        let ids = |v: Vec<TicketCandidate>| -> Vec<(String, String)> {
            v.into_iter().map(|c| (c.deployment_id, c.model_id)).collect()
        };
        assert_eq!(
            ids(candidates_for_model(&snap, "fast")),
            vec![
                ("dep_anthropic".into(), "claude-opus-5".into()),
                ("dep_openai".into(), "gpt-5".into())
            ]
        );
        // Bare id: every ENABLED provider that lists it (disabled `off` skipped).
        assert_eq!(
            ids(candidates_for_model(&snap, "claude-opus-5")),
            vec![("dep_anthropic".into(), "claude-opus-5".into())]
        );
        // Provider-pinned id.
        assert_eq!(
            ids(candidates_for_model(&snap, "anthropic:claude-opus-5")),
            vec![("dep_anthropic".into(), "claude-opus-5".into())]
        );
        assert!(candidates_for_model(&snap, "openai:claude-opus-5").is_empty());
        assert!(candidates_for_model(&snap, "nope").is_empty());
    }

    #[test]
    fn default_model_bindings_bind_every_family_selector() {
        let snap = ticket_snapshot();
        let bindings = default_model_bindings(&snap, "claude-opus-5");
        assert_eq!(bindings["primary"], "claude-opus-5");
        assert_eq!(bindings["haiku"], "claude-haiku-4-5-20251001");
        assert_eq!(bindings["opus"], "claude-opus-5");
        // No sonnet-class model anywhere ⇒ falls back to the primary.
        assert_eq!(bindings["sonnet"], "claude-opus-5");
        assert_eq!(bindings.len(), 4);
        // A model no provider serves still binds (mint validates candidates).
        let none = default_model_bindings(&snap, "ghost");
        assert_eq!(none["primary"], "ghost");
        assert_eq!(none["haiku"], "ghost");
    }
}
