use std::collections::{HashMap, HashSet};

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
}

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
}
