//! HITL consent broker for the automation `PerCall` tier.
//!
//! Flow:
//!
//! 1. Tauri command resolves to `Decision::RequireConsent { prompt }`.
//! 2. The command body calls `ConsentBroker::request` with the prompt + an
//!    `app_handle`. The broker:
//!    - Checks `session_grants` for an existing "always-allow" matching the
//!      `(surface, command, plugin_id, process_name)` tuple. If found,
//!      resolves to `Allow` immediately.
//!    - Otherwise generates a UUID, registers a oneshot sender, emits
//!      `automation:consent-request` with `{ id, prompt }`, and awaits the
//!      sender's receiver (with a configurable timeout, defaulting to 30s).
//! 3. The renderer-side overlay (`components/automation/consent-overlay.tsx`)
//!    listens for the event and renders "Allow once / Always allow this
//!    session / Reject". On click, it invokes the
//!    `automation_consent_respond(id, allow, persist)` Tauri command.
//! 4. `automation_consent_respond` calls `ConsentBroker::resolve` which
//!    fulfills the oneshot. If `persist == true`, it also adds an entry to
//!    `session_grants` so future calls matching the same tuple skip the UI.
//!
//! Session grants expire on app shutdown (in-memory only). They are NOT
//! persisted to disk — that is what `PermissionGate::Tier::Whitelist` is
//! for. The session is the unit of trust here.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::oneshot;

use super::permission::{ConsentPrompt, Surface};

/// Default time a consent request waits for the user before auto-rejecting.
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Identity of a `(surface, command, plugin_id, process_name)` grant. Empty
/// strings stand in for None so the HashSet key has a stable hash.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GrantKey {
    surface: Surface,
    command: String,
    plugin_id: String,
    process_name: String,
}

impl GrantKey {
    fn from_prompt(p: &ConsentPrompt) -> Self {
        Self {
            surface: p.surface,
            command: p.command.clone(),
            plugin_id: p.plugin_id.clone().unwrap_or_default(),
            process_name: p.process_name.clone().unwrap_or_default(),
        }
    }
}

/// Payload emitted as `automation:consent-request`. Carries the prompt the
/// renderer needs to render the overlay plus the broker id the renderer must
/// pass back via `automation_consent_respond`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRequestEvent {
    pub id: String,
    #[serde(flatten)]
    pub prompt: ConsentPrompt,
    pub timeout_ms: u64,
}

#[derive(Default)]
struct Inner {
    pending: HashMap<String, oneshot::Sender<bool>>,
    session_grants: HashSet<GrantKey>,
}

#[derive(Clone, Default)]
pub struct ConsentBroker {
    inner: Arc<Mutex<Inner>>,
}

impl ConsentBroker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns true if a previous "Always allow this session" decision
    /// covers the given prompt. Pure read — does not consume the grant.
    pub fn has_session_grant(&self, prompt: &ConsentPrompt) -> bool {
        self.inner
            .lock()
            .session_grants
            .contains(&GrantKey::from_prompt(prompt))
    }

    /// Block until the user responds (or the timeout elapses). Returns
    /// `true` when the user allows the call. The timeout maps to an implicit
    /// reject so the renderer can't hang a Rust command forever.
    pub async fn request(&self, app: tauri::AppHandle, prompt: ConsentPrompt) -> bool {
        if self.has_session_grant(&prompt) {
            return true;
        }
        let id = generate_id();
        let (tx, rx) = oneshot::channel::<bool>();
        {
            let mut g = self.inner.lock();
            g.pending.insert(id.clone(), tx);
        }
        let event = ConsentRequestEvent {
            id: id.clone(),
            prompt,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        };
        // If emit fails, the overlay can't appear — treat as decline.
        if app.emit("automation:consent-request", &event).is_err() {
            self.inner.lock().pending.remove(&id);
            return false;
        }
        match tokio::time::timeout(Duration::from_millis(DEFAULT_TIMEOUT_MS), rx).await {
            Ok(Ok(allow)) => allow,
            _ => {
                // Timeout or channel dropped — clean up + decline.
                self.inner.lock().pending.remove(&id);
                false
            }
        }
    }

    /// Renderer-side response. `persist == true` means "remember this
    /// allow/reject for the rest of the session". Pending lookup is by id;
    /// duplicate or unknown ids are silently dropped.
    pub fn resolve(&self, id: &str, allow: bool, persist: bool, prompt: Option<&ConsentPrompt>) {
        let sender = self.inner.lock().pending.remove(id);
        if let Some(tx) = sender {
            let _ = tx.send(allow);
        }
        if allow && persist {
            if let Some(p) = prompt {
                self.inner.lock().session_grants.insert(GrantKey::from_prompt(p));
            }
        }
    }

    /// Drop every session grant. Wired into the kill switch.
    pub fn clear_session_grants(&self) {
        self.inner.lock().session_grants.clear();
    }
}

fn generate_id() -> String {
    // Lightweight 16-byte hex id. We can't depend on `uuid` from this module
    // (no transitive dep), and a 128-bit random id is overkill — 8 bytes from
    // a system random source is enough for an in-process pending map.
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}", ts, n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::permission::Surface;

    fn prompt(cmd: &str, surface: Surface) -> ConsentPrompt {
        ConsentPrompt {
            command: cmd.to_string(),
            surface,
            plugin_id: None,
            process_name: None,
            window_title: None,
        }
    }

    #[test]
    fn session_grant_matches_same_tuple() {
        let b = ConsentBroker::new();
        let p = prompt("click", Surface::Workflow);
        assert!(!b.has_session_grant(&p));
        // Simulate the user choosing "Always allow this session" for a
        // matching prompt without going through the channel.
        b.inner
            .lock()
            .session_grants
            .insert(GrantKey::from_prompt(&p));
        assert!(b.has_session_grant(&p));
    }

    #[test]
    fn session_grant_does_not_leak_across_command_or_surface() {
        let b = ConsentBroker::new();
        let click = prompt("click", Surface::Workflow);
        b.inner
            .lock()
            .session_grants
            .insert(GrantKey::from_prompt(&click));
        // Different command, same surface — should NOT match.
        assert!(!b.has_session_grant(&prompt("type", Surface::Workflow)));
        // Same command, different surface — should NOT match.
        assert!(!b.has_session_grant(&prompt("click", Surface::Mcp)));
    }

    #[test]
    fn clear_session_grants_drops_every_entry() {
        let b = ConsentBroker::new();
        b.inner
            .lock()
            .session_grants
            .insert(GrantKey::from_prompt(&prompt("click", Surface::Workflow)));
        assert!(b.has_session_grant(&prompt("click", Surface::Workflow)));
        b.clear_session_grants();
        assert!(!b.has_session_grant(&prompt("click", Surface::Workflow)));
    }

    #[test]
    fn resolve_unknown_id_is_silent_noop() {
        let b = ConsentBroker::new();
        b.resolve("nonexistent", true, false, None);
        // No panic = pass.
    }

    #[test]
    fn generate_id_is_monotonic_and_unique() {
        let a = generate_id();
        let b = generate_id();
        assert_ne!(a, b);
    }
}
