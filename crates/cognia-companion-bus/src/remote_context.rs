//! Remote execution contexts: which paired device a turn answers to.
//!
//! When a paired device sends a turn, the host registers a
//! [`RemoteExecutionContext`] for the session. Every request the host then
//! raises on that turn (a permission prompt, a plugin tool call, a review, a
//! protocol-adapter exec) carries the context. The event bus records the
//! request's response id here as it publishes it, and the approval arms in
//! `remote_execution` accept an answer only from the originating device,
//! only for the latest generation, and only once.
//!
//! Split out of `remote_execution` so the event bus can register pending
//! requests without depending on the execution pipeline (ADR-0196 P4).

use std::collections::{HashMap, HashSet, VecDeque};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const CONTEXT_TTL_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecutionContext {
    pub host_id: String,
    pub origin_device_id: String,
    pub session_id: String,
    pub generation: u64,
    pub request_id: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Default)]
struct RegistryState {
    latest: HashMap<String, RemoteExecutionContext>,
    pending: HashSet<String>,
    consumed: HashSet<String>,
    /// Response ids raised under a remote context, per session, oldest first.
    ///
    /// Separate from `pending` / `consumed` because the two answer different
    /// questions. Those are keyed by the context's `request_id`, so they are
    /// generation-bound: a new send retires them, which is right, because a
    /// retired context must not still satisfy single-use. Whether a request
    /// *was* remote-scoped is not generation-bound at all. The request outlives
    /// the turn that raised it, and it stays the origin device's to answer for
    /// as long as it is answerable.
    ///
    /// Bounded per session, because nothing removes a session from this
    /// registry and a long session can raise many requests.
    scoped: HashMap<String, VecDeque<String>>,
}

/// How many remote-scoped response ids to remember per session.
///
/// Only ever read on the approval path that omits a context, so a linear scan
/// of at most this many ids is cheaper than a second index.
const SCOPED_RESPONSES_PER_SESSION: usize = 512;

#[derive(Debug, Default)]
pub struct RemoteExecutionRegistry {
    state: Mutex<RegistryState>,
}

impl RemoteExecutionRegistry {
    pub fn register(
        &self,
        host_id: &str,
        origin_device_id: &str,
        session_id: &str,
        now_ms: u64,
    ) -> RemoteExecutionContext {
        let mut state = self.state.lock();
        let generation = state
            .latest
            .get(session_id)
            .map_or(1, |context| context.generation.saturating_add(1));
        let context = RemoteExecutionContext {
            host_id: host_id.to_string(),
            origin_device_id: origin_device_id.to_string(),
            session_id: session_id.to_string(),
            generation,
            request_id: Uuid::new_v4().to_string(),
            issued_at: now_ms,
            expires_at: now_ms.saturating_add(CONTEXT_TTL_MS),
        };
        state.latest.insert(session_id.to_string(), context.clone());
        // Retire the previous generation's keys. `scoped` is deliberately not
        // touched: it records which requests belong to a remote origin, and a
        // request raised by an earlier turn is still that turn's to answer.
        // Clearing it here is what let a later send erase the scope and hand
        // the request to any device holding a control grant.
        state
            .consumed
            .retain(|key| !key.starts_with(&format!("{session_id}:")));
        state
            .pending
            .retain(|key| !key.starts_with(&format!("{session_id}:")));
        context
    }

    pub fn register_pending(
        &self,
        context: &RemoteExecutionContext,
        response_id: &str,
    ) -> Result<(), &'static str> {
        if response_id.is_empty() {
            return Err("REMOTE_RESPONSE_STALE");
        }
        let mut state = self.state.lock();
        let Some(latest) = state.latest.get(&context.session_id) else {
            return Err("REMOTE_RESPONSE_STALE");
        };
        if latest != context {
            return Err("REMOTE_RESPONSE_STALE");
        }
        state.pending.insert(pending_key(context, response_id));
        let scoped = state.scoped.entry(context.session_id.clone()).or_default();
        if !scoped.iter().any(|id| id == response_id) {
            if scoped.len() >= SCOPED_RESPONSES_PER_SESSION {
                scoped.pop_front();
            }
            scoped.push_back(response_id.to_string());
        }
        Ok(())
    }

    pub fn validate(
        &self,
        context: &RemoteExecutionContext,
        caller_device_id: &str,
        session_id: &str,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        let state = self.state.lock();
        validate_locked(&state, context, caller_device_id, session_id, now_ms)
    }

    pub fn validate_and_consume(
        &self,
        context: &RemoteExecutionContext,
        caller_device_id: &str,
        session_id: &str,
        response_id: &str,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        let mut state = self.state.lock();
        validate_locked(&state, context, caller_device_id, session_id, now_ms)?;
        let key = pending_key(context, response_id);
        if !state.pending.remove(&key) || !state.consumed.insert(key) {
            return Err("REMOTE_RESPONSE_STALE");
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn validate_pending_message(
        &self,
        context: &RemoteExecutionContext,
        caller_device_id: &str,
        session_id: &str,
        pending_id: &str,
        message_id: &str,
        terminal: bool,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        let mut state = self.state.lock();
        validate_locked(&state, context, caller_device_id, session_id, now_ms)?;
        let pending_key = pending_key(context, pending_id);
        if !state.pending.contains(&pending_key) {
            return Err("REMOTE_RESPONSE_STALE");
        }
        let message_key = format!("{pending_key}:message:{message_id}");
        if !state.consumed.insert(message_key) {
            return Err("REMOTE_RESPONSE_STALE");
        }
        if terminal {
            state.pending.remove(&pending_key);
        }
        Ok(())
    }
}

impl RemoteExecutionRegistry {
    /// Whether `response_id` (a permission `requestId`, a plugin `toolUseId`,
    /// …) on `session_id` was issued under a remote execution context — i.e.
    /// the turn that raised it was sent by a paired device, and only that
    /// device may answer it.
    ///
    /// A request that was never registered here came from a turn the host
    /// started itself (desktop composer, IM connector, scheduler, brain-driven
    /// HostState intent). Those carry no context, so the approval arms cannot
    /// demand one; they fall back to the caller's remote-control grant
    /// instead. This read is what stops a caller from *omitting* the context
    /// to sidestep the scope check on a remote-originated request, so it reads
    /// the per-session record rather than the generation-bound keys: a request
    /// stays scoped after it was consumed, and after a later send on the same
    /// session has retired the context that raised it.
    pub fn is_remote_scoped(&self, session_id: &str, response_id: &str) -> bool {
        let state = self.state.lock();
        state
            .scoped
            .get(session_id)
            .is_some_and(|ids| ids.iter().any(|id| id == response_id))
    }
}

fn pending_key(context: &RemoteExecutionContext, response_id: &str) -> String {
    format!(
        "{}:{}:{response_id}",
        context.session_id, context.request_id
    )
}

fn validate_locked(
    state: &RegistryState,
    context: &RemoteExecutionContext,
    caller_device_id: &str,
    session_id: &str,
    now_ms: u64,
) -> Result<(), &'static str> {
    if context.origin_device_id != caller_device_id || context.session_id != session_id {
        return Err("REMOTE_SCOPE_DENIED");
    }
    if context.expires_at < now_ms {
        return Err("REMOTE_PROXY_DISCONNECTED");
    }
    let Some(latest) = state.latest.get(session_id) else {
        return Err("REMOTE_RESPONSE_STALE");
    };
    if latest != context {
        return Err("REMOTE_RESPONSE_STALE");
    }
    Ok(())
}

static REGISTRY: once_cell::sync::Lazy<RemoteExecutionRegistry> =
    once_cell::sync::Lazy::new(RemoteExecutionRegistry::default);

pub fn global() -> &'static RemoteExecutionRegistry {
    &REGISTRY
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_and_origin_bind_responses_to_the_latest_turn() {
        let registry = RemoteExecutionRegistry::default();
        let first = registry.register("host-a", "device-a", "session-a", 100);
        assert_eq!(first.generation, 1);
        assert!(registry
            .validate(&first, "device-a", "session-a", 101)
            .is_ok());
        assert_eq!(
            registry.validate(&first, "device-b", "session-a", 101),
            Err("REMOTE_SCOPE_DENIED")
        );

        let second = registry.register("host-a", "device-a", "session-a", 200);
        assert_eq!(second.generation, 2);
        assert_eq!(
            registry.validate(&first, "device-a", "session-a", 201),
            Err("REMOTE_RESPONSE_STALE")
        );
    }

    #[test]
    fn one_shot_responses_reject_replay() {
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        registry.register_pending(&context, "tool-1").unwrap();
        assert!(registry
            .validate_and_consume(&context, "device-a", "session-a", "tool-1", 101)
            .is_ok());
        assert_eq!(
            registry.validate_and_consume(&context, "device-a", "session-a", "tool-1", 102),
            Err("REMOTE_RESPONSE_STALE")
        );
    }

    #[test]
    fn responses_must_match_a_registered_pending_request() {
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        assert_eq!(
            registry.validate_and_consume(&context, "device-a", "session-a", "never-pending", 101,),
            Err("REMOTE_RESPONSE_STALE")
        );
    }

    #[test]
    fn protocol_messages_reject_replay_and_close_on_terminal_message() {
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        registry.register_pending(&context, "exec-1").unwrap();
        assert!(registry
            .validate_pending_message(
                &context,
                "device-a",
                "session-a",
                "exec-1",
                "message-1",
                false,
                101,
            )
            .is_ok());
        assert_eq!(
            registry.validate_pending_message(
                &context,
                "device-a",
                "session-a",
                "exec-1",
                "message-1",
                false,
                102,
            ),
            Err("REMOTE_RESPONSE_STALE")
        );
        assert!(registry
            .validate_pending_message(
                &context,
                "device-a",
                "session-a",
                "exec-1",
                "message-2",
                true,
                103,
            )
            .is_ok());
        assert_eq!(
            registry.validate_pending_message(
                &context,
                "device-a",
                "session-a",
                "exec-1",
                "message-3",
                false,
                104,
            ),
            Err("REMOTE_RESPONSE_STALE")
        );
    }

    #[test]
    fn expired_context_returns_a_retryable_disconnect_error() {
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        assert_eq!(
            registry.validate(&context, "device-a", "session-a", 100 + CONTEXT_TTL_MS + 1),
            Err("REMOTE_PROXY_DISCONNECTED")
        );
    }

    #[test]
    fn remote_scoped_read_tracks_pending_and_consumed_requests() {
        let registry = RemoteExecutionRegistry::default();
        assert!(!registry.is_remote_scoped("session-a", "req-1"));

        let context = registry.register("host-a", "device-a", "session-a", 100);
        assert!(!registry.is_remote_scoped("session-a", "req-1"));

        registry
            .register_pending(&context, "req-1")
            .expect("pending registers");
        assert!(registry.is_remote_scoped("session-a", "req-1"));
        assert!(!registry.is_remote_scoped("session-b", "req-1"));
        assert!(!registry.is_remote_scoped("session-a", "req-2"));

        registry
            .validate_and_consume(&context, "device-a", "session-a", "req-1", 150)
            .expect("consume succeeds");
        // Consumed stays scoped: a second answer without a context must not
        // be admitted on the grant path either.
        assert!(registry.is_remote_scoped("session-a", "req-1"));
    }

    #[test]
    fn a_later_send_does_not_unscope_an_earlier_request() {
        // `register` retires the previous generation's keys, which is right for
        // single-use. It must not also retire the fact that the request came
        // from a remote origin: the approval arm reads that to refuse a device
        // answering without a context, and every ordinary turn calls `register`
        // again. Erasing it here handed a phone's pending approval to any
        // device holding a control grant, repeatedly, since that path consumes
        // nothing.
        let registry = RemoteExecutionRegistry::default();
        let first = registry.register("host-a", "device-a", "session-a", 100);
        registry
            .register_pending(&first, "req-1")
            .expect("pending registers");
        assert!(registry.is_remote_scoped("session-a", "req-1"));

        // The same session sends again: a new generation, and the old context
        // is now stale for validation.
        let second = registry.register("host-a", "device-a", "session-a", 200);
        assert_ne!(first.request_id, second.request_id);
        assert!(registry.is_remote_scoped("session-a", "req-1"));
        assert_eq!(
            registry.validate_and_consume(&first, "device-a", "session-a", "req-1", 250),
            Err("REMOTE_RESPONSE_STALE"),
            "a retired context still cannot answer"
        );

        // Requests the session never raised remain unscoped, so a
        // host-originated approval still falls back to the control grant.
        assert!(!registry.is_remote_scoped("session-a", "req-2"));
        assert!(!registry.is_remote_scoped("session-b", "req-1"));
    }

    #[test]
    fn the_scoped_record_is_bounded_per_session() {
        // Nothing removes a session from this registry, so the record of which
        // requests were remote-scoped has to have a ceiling of its own.
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        for index in 0..(SCOPED_RESPONSES_PER_SESSION + 10) {
            registry
                .register_pending(&context, &format!("req-{index}"))
                .expect("pending registers");
        }
        let newest = format!("req-{}", SCOPED_RESPONSES_PER_SESSION + 9);
        assert!(registry.is_remote_scoped("session-a", &newest));
        assert!(
            !registry.is_remote_scoped("session-a", "req-0"),
            "the oldest ids are evicted rather than growing without bound"
        );
    }
}
