//! HITL consent broker for the automation `PerCall` tier.
//!
//! Flow:
//!
//! 1. Tauri command resolves to `Decision::RequireConsent { prompt }`.
//! 2. The command body calls `ConsentBroker::request` with the prompt, an
//!    `app_handle`, and the caller's timeout budget. The broker:
//!    - Checks `session_grants` for an unexpired "always-allow" matching the
//!      `(session_key, surface, command, plugin_id, process_name)` tuple. If
//!      found, resolves to `Allow` immediately.
//!    - Otherwise generates a UUID, registers a oneshot sender, emits
//!      `automation:consent-request` with `{ id, prompt, timeoutMs }`, and
//!      awaits the sender's receiver until the timeout elapses.
//! 3. The renderer-side overlay (`components/automation/consent-overlay.tsx`)
//!    and the mobile sheet (`components/mobile/automation/mobile-consent-sheet.tsx`)
//!    listen for the event and render "Allow once / Don't ask again for N
//!    minutes / Reject". On click, they invoke the
//!    `automation_consent_respond(id, allow, persist, grantDurationMs)` command.
//! 4. `automation_consent_respond` calls `ConsentBroker::resolve` which
//!    fulfills the oneshot. If `persist == true`, it also records an entry in
//!    `session_grants` with an expiry so future calls matching the same tuple
//!    skip the UI until it lapses.
//!
//! Grants are in-memory only and additionally die on app shutdown and on the
//! kill switch. They are NOT persisted to disk — that is what
//! `PermissionGate::Tier::Whitelist` is for. The time-boxed grant exists so a
//! remote operator can hand the agent a working window without leaving a
//! standing authorization behind.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::permission::{ConsentPrompt, Surface};

/// Fallback wait budget when a caller doesn't supply one. Callers normally
/// pass `AutomationSettings::consent_timeout_ms`; this only covers the
/// headless/test paths that have no settings to read.
pub const DEFAULT_TIMEOUT_MS: u64 = 90_000;

/// Longest a "don't ask again" grant may live. The pickers offer 15/30/60
/// minutes; the broker clamps anything larger so a hand-rolled RPC can't mint
/// a grant that outlives the operator's attention.
pub const MAX_GRANT_DURATION_MS: u64 = 60 * 60 * 1000;

/// Used when a client asks to persist without naming a duration — keeps older
/// clients (which only sent `persist: true`) from minting an unbounded grant.
pub const DEFAULT_GRANT_DURATION_MS: u64 = 30 * 60 * 1000;

/// Identity of a `(session_key, surface, command, plugin_id, process_name)`
/// grant. Empty strings stand in for None so the map key has a stable hash.
///
/// `session_key` leads deliberately: a grant handed out in one conversation
/// must never cover a call made by another, even for the same command against
/// the same process.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GrantKey {
    session_key: String,
    surface: Surface,
    command: String,
    plugin_id: String,
    process_name: String,
}

impl GrantKey {
    fn from_prompt(p: &ConsentPrompt) -> Self {
        Self {
            session_key: p.session_key.clone().unwrap_or_default(),
            surface: p.surface,
            command: p.command.clone(),
            plugin_id: p.plugin_id.clone().unwrap_or_default(),
            process_name: p.process_name.clone().unwrap_or_default(),
        }
    }
}

/// Clamp a client-supplied grant duration into `[1ms, MAX_GRANT_DURATION_MS]`,
/// substituting the default when absent or zero.
fn clamp_grant_duration(requested: Option<u64>) -> Duration {
    let ms = match requested {
        None | Some(0) => DEFAULT_GRANT_DURATION_MS,
        Some(ms) => ms.min(MAX_GRANT_DURATION_MS),
    };
    Duration::from_millis(ms)
}

/// Display-only screen thumbnail attached to a consent request so a remote
/// approver isn't deciding blind.
///
/// Deliberately narrow: base64 PNG plus the dimensions needed to lay it out.
/// It rides the already-authenticated `/ws/v1/events` frame and nothing else —
/// never a push payload (4 KB cap, and lock screens are shoulder-surfable),
/// never the audit ring, never Dexie.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentThumbnail {
    /// Base64-encoded PNG bytes.
    pub bytes: String,
    pub width: u32,
    pub height: u32,
    /// True when the capture was blanked because the foreground window is a
    /// credential prompt. Lets the approver read a black frame as "it is
    /// touching a password box" instead of an unexplained black rectangle.
    pub redacted: bool,
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
    /// Absent on the local-only paths and whenever capture failed — the
    /// consent surfaces degrade to the text-only rendering they had before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<ConsentThumbnail>,
}

#[derive(Default)]
struct Inner {
    pending: HashMap<String, PendingConsent>,
    /// Grant → the instant it lapses. Entries are evicted lazily on lookup.
    session_grants: HashMap<GrantKey, Instant>,
}

struct PendingConsent {
    sender: oneshot::Sender<bool>,
    event: ConsentRequestEvent,
    deadline: Instant,
}

#[derive(Clone, Default)]
pub struct ConsentBroker {
    inner: Arc<Mutex<Inner>>,
}

impl ConsentBroker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns true if a previous "don't ask again" decision still covers the
    /// given prompt. Does not consume the grant, but does evict it once it has
    /// lapsed so an expired grant can never be resurrected by a clock quirk.
    pub fn has_session_grant(&self, prompt: &ConsentPrompt) -> bool {
        // One-shot prompts are never covered by a grant, even a live one.
        if prompt.is_one_shot() {
            return false;
        }
        let key = GrantKey::from_prompt(prompt);
        let mut inner = self.inner.lock();
        match inner.session_grants.get(&key) {
            Some(expiry) if *expiry > Instant::now() => true,
            Some(_) => {
                inner.session_grants.remove(&key);
                false
            }
            None => false,
        }
    }

    /// Block until the user responds (or `timeout_ms` elapses). Returns `true`
    /// when the user allows the call. The timeout maps to an implicit reject
    /// (fail-closed) so the renderer can't hang a Rust command forever, and so
    /// an unreachable phone never silently authorizes an action.
    ///
    /// `timeout_ms` comes from `AutomationSettings::consent_timeout_ms`; the
    /// emitted event carries the same number so both consent surfaces render a
    /// countdown that matches what the broker actually honors.
    pub async fn request(
        &self,
        app: tauri::AppHandle,
        prompt: ConsentPrompt,
        timeout_ms: u64,
    ) -> bool {
        self.request_with_thumbnail(app, prompt, timeout_ms, None)
            .await
    }

    /// Same as [`request`](Self::request) but carries a pre-captured screen
    /// thumbnail so a remote approver can see what they are authorizing. The
    /// dispatcher supplies it; the thumbnail is display-only and never
    /// influences the decision, the grant key, or the audit row.
    pub async fn request_with_thumbnail(
        &self,
        app: tauri::AppHandle,
        prompt: ConsentPrompt,
        timeout_ms: u64,
        thumbnail: Option<ConsentThumbnail>,
    ) -> bool {
        use tauri::Emitter as _;
        self.request_with_emitter(prompt, timeout_ms, thumbnail, move |event| {
            app.emit("automation:consent-request", event)
                .map_err(|error| error.to_string())
        })
        .await
    }

    /// Host-neutral request path used by cognia-server. The emitter publishes
    /// the exact same event payload onto the authenticated companion EventBus,
    /// while [`resolve`](Self::resolve) remains the shared response endpoint.
    pub async fn request_with_emitter<F>(
        &self,
        prompt: ConsentPrompt,
        timeout_ms: u64,
        thumbnail: Option<ConsentThumbnail>,
        emit: F,
    ) -> bool
    where
        F: FnOnce(&ConsentRequestEvent) -> Result<(), String>,
    {
        if self.has_session_grant(&prompt) {
            return true;
        }
        let id = generate_id();
        let (tx, rx) = oneshot::channel::<bool>();
        let event = ConsentRequestEvent {
            id: id.clone(),
            prompt,
            timeout_ms,
            thumbnail,
        };
        {
            let mut g = self.inner.lock();
            g.pending.insert(
                id.clone(),
                PendingConsent {
                    sender: tx,
                    event: event.clone(),
                    deadline: Instant::now() + Duration::from_millis(timeout_ms),
                },
            );
        }
        self.emit_and_wait(id, event, rx, timeout_ms, emit).await
    }

    /// Snapshot requests that still await a response. This is the reconnect
    /// backfill for remote consent surfaces when the EventBus replay cursor is
    /// no longer available. Each event's timeout is rewritten to the remaining
    /// broker budget so a reconnected client cannot display a stale countdown.
    pub fn pending_requests(&self) -> Vec<ConsentRequestEvent> {
        let now = Instant::now();
        let mut inner = self.inner.lock();
        inner.pending.retain(|_, pending| pending.deadline > now);
        inner
            .pending
            .values()
            .map(|pending| {
                let mut event = pending.event.clone();
                event.timeout_ms = pending
                    .deadline
                    .saturating_duration_since(now)
                    .as_millis()
                    .max(1) as u64;
                event
            })
            .collect()
    }

    async fn emit_and_wait<F>(
        &self,
        id: String,
        event: ConsentRequestEvent,
        rx: oneshot::Receiver<bool>,
        timeout_ms: u64,
        emit: F,
    ) -> bool
    where
        F: FnOnce(&ConsentRequestEvent) -> Result<(), String>,
    {
        // If emit fails, no consent surface can appear — treat as decline.
        if emit(&event).is_err() {
            self.inner.lock().pending.remove(&id);
            return false;
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(allow)) => allow,
            _ => {
                // Timeout or channel dropped — clean up + decline.
                self.inner.lock().pending.remove(&id);
                false
            }
        }
    }

    /// Renderer-side response. `persist == true` means "don't ask again for
    /// this tuple", bounded by `grant_duration_ms` (clamped to
    /// [`MAX_GRANT_DURATION_MS`], defaulted when absent). Pending lookup is by
    /// id; duplicate or unknown ids are silently dropped.
    ///
    /// Only an *allow* can persist — a rejection is always one-shot, so a
    /// mis-tap can't lock the agent out for an hour.
    pub fn resolve_registered(
        &self,
        id: &str,
        allow: bool,
        persist: bool,
        grant_duration_ms: Option<u64>,
    ) {
        let pending = self.inner.lock().pending.remove(id);
        let Some(pending) = pending else {
            return;
        };
        let prompt = pending.event.prompt;
        let _ = pending.sender.send(allow);
        // `is_one_shot` is checked here as well as in `has_session_grant`, so a
        // grant for such a prompt is never even written — a stale entry could
        // otherwise outlive a future change to the read path.
        if allow && persist && !prompt.is_one_shot() {
            let expiry = Instant::now() + clamp_grant_duration(grant_duration_ms);
            self.inner
                .lock()
                .session_grants
                .insert(GrantKey::from_prompt(&prompt), expiry);
        }
    }

    /// Compatibility wrapper for older in-process callers that supplied the
    /// prompt again. The client copy is deliberately ignored: grants are
    /// always derived from the broker's registered request metadata.
    pub fn resolve(
        &self,
        id: &str,
        allow: bool,
        persist: bool,
        grant_duration_ms: Option<u64>,
        _prompt: Option<&ConsentPrompt>,
    ) {
        self.resolve_registered(id, allow, persist, grant_duration_ms);
    }

    /// Drop every session grant. Wired into the kill switch.
    pub fn clear_session_grants(&self) {
        self.inner.lock().session_grants.clear();
    }
}

fn generate_id() -> String {
    uuid::Uuid::new_v4().to_string()
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
            command_detail: None,
            session_key: None,
        }
    }

    /// Register a grant the way `resolve` would, with an explicit lifetime.
    fn grant(b: &ConsentBroker, p: &ConsentPrompt, ttl: Duration) {
        b.inner
            .lock()
            .session_grants
            .insert(GrantKey::from_prompt(p), Instant::now() + ttl);
    }

    fn register_pending(
        broker: &ConsentBroker,
        id: &str,
        prompt: ConsentPrompt,
    ) -> oneshot::Receiver<bool> {
        let (sender, receiver) = oneshot::channel();
        let event = ConsentRequestEvent {
            id: id.to_string(),
            prompt,
            timeout_ms: 1_000,
            thumbnail: None,
        };
        broker.inner.lock().pending.insert(
            id.to_string(),
            PendingConsent {
                sender,
                event,
                deadline: Instant::now() + Duration::from_secs(1),
            },
        );
        receiver
    }

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn record_start_ignores_a_pre_existing_grant() {
        // Even a live grant must not cover it. Without the `is_one_shot` check
        // in `has_session_grant`, `request_with_thumbnail` would short-circuit
        // and arm a global input hook with no prompt at all.
        let b = ConsentBroker::new();
        let p = prompt("record_start", Surface::ComputerUse);
        let _receiver = register_pending(&b, "record-start", p.clone());
        grant(&b, &p, MINUTE);
        assert!(
            !b.has_session_grant(&p),
            "a recording may never be pre-authorized"
        );
    }

    #[test]
    fn record_start_never_forms_a_session_grant() {
        let b = ConsentBroker::new();
        let p = prompt("record_start", Surface::ComputerUse);
        // The renderer asked to persist ("don't ask again"); the broker must
        // refuse to write the grant rather than merely refuse to read it.
        b.resolve(
            "record-start",
            true,
            true,
            Some(MINUTE.as_millis() as u64),
            Some(&p),
        );
        assert!(b.inner.lock().session_grants.is_empty());
    }

    #[test]
    fn an_ordinary_prompt_still_forms_a_grant() {
        // The one-shot rule must be narrow — every other prompt keeps its
        // "don't ask again" behaviour.
        let b = ConsentBroker::new();
        let p = prompt("click", Surface::ComputerUse);
        let _receiver = register_pending(&b, "click", p.clone());
        b.resolve(
            "click",
            true,
            true,
            Some(MINUTE.as_millis() as u64),
            Some(&p),
        );
        assert!(b.has_session_grant(&p));
    }

    #[test]
    fn session_grant_matches_same_tuple() {
        let b = ConsentBroker::new();
        let p = prompt("click", Surface::Workflow);
        assert!(!b.has_session_grant(&p));
        // Simulate the user choosing "don't ask again" for a matching prompt
        // without going through the channel.
        grant(&b, &p, MINUTE);
        assert!(b.has_session_grant(&p));
    }

    #[test]
    fn expired_session_grant_stops_short_circuiting() {
        let b = ConsentBroker::new();
        let p = prompt("click", Surface::ComputerUse);
        // Zero-length grant: already lapsed by the time we look it up, since
        // Instant only moves forward.
        grant(&b, &p, Duration::ZERO);
        assert!(
            !b.has_session_grant(&p),
            "a lapsed grant must fall back to prompting"
        );
    }

    #[test]
    fn expired_session_grant_is_evicted_on_lookup() {
        let b = ConsentBroker::new();
        let p = prompt("click", Surface::ComputerUse);
        grant(&b, &p, Duration::ZERO);
        assert!(!b.has_session_grant(&p));
        assert!(
            b.inner.lock().session_grants.is_empty(),
            "lapsed grants must not linger in the map"
        );
    }

    #[test]
    fn session_grant_does_not_leak_across_chat_sessions() {
        let b = ConsentBroker::new();
        let mut in_session_a = prompt("click", Surface::ComputerUse);
        in_session_a.session_key = Some("session-a".into());
        grant(&b, &in_session_a, MINUTE);

        let mut in_session_b = prompt("click", Surface::ComputerUse);
        in_session_b.session_key = Some("session-b".into());
        assert!(
            !b.has_session_grant(&in_session_b),
            "a grant from one conversation must not cover another"
        );
        // And a call with no session tag must not inherit it either.
        assert!(!b.has_session_grant(&prompt("click", Surface::ComputerUse)));
    }

    #[test]
    fn clamp_grant_duration_bounds_and_defaults() {
        assert_eq!(
            clamp_grant_duration(None),
            Duration::from_millis(DEFAULT_GRANT_DURATION_MS),
            "an older client sending only persist:true gets the default window"
        );
        assert_eq!(
            clamp_grant_duration(Some(0)),
            Duration::from_millis(DEFAULT_GRANT_DURATION_MS)
        );
        assert_eq!(
            clamp_grant_duration(Some(15 * 60 * 1000)),
            Duration::from_millis(15 * 60 * 1000)
        );
        assert_eq!(
            clamp_grant_duration(Some(u64::MAX)),
            Duration::from_millis(MAX_GRANT_DURATION_MS),
            "a hand-rolled RPC must not mint an unbounded grant"
        );
    }

    #[test]
    fn resolve_persists_a_bounded_grant() {
        let b = ConsentBroker::new();
        let p = prompt("click", Surface::ComputerUse);
        let _receiver = register_pending(&b, "bounded", p.clone());
        b.resolve("bounded", true, true, Some(15 * 60 * 1000), Some(&p));
        assert!(b.has_session_grant(&p));
    }

    #[test]
    fn resolve_never_persists_a_rejection() {
        let b = ConsentBroker::new();
        let p = prompt("click", Surface::ComputerUse);
        let _receiver = register_pending(&b, "rejected", p.clone());
        b.resolve("rejected", false, true, Some(15 * 60 * 1000), Some(&p));
        assert!(
            !b.has_session_grant(&p),
            "a denied prompt must stay one-shot"
        );
    }

    #[test]
    fn session_grant_ignores_command_detail() {
        // command_detail is display-only — a session grant must match the same
        // (surface, command, plugin, process) tuple regardless of the detail,
        // else every distinct bash command would defeat the grant.
        let b = ConsentBroker::new();
        let mut bash_a = prompt("bash", Surface::ComputerUse);
        bash_a.command_detail = Some("ls".into());
        grant(&b, &bash_a, MINUTE);
        let mut bash_b = prompt("bash", Surface::ComputerUse);
        bash_b.command_detail = Some("rm -rf /".into());
        assert!(b.has_session_grant(&bash_b));
    }

    #[test]
    fn session_grant_does_not_leak_across_command_or_surface() {
        let b = ConsentBroker::new();
        let click = prompt("click", Surface::Workflow);
        grant(&b, &click, MINUTE);
        // Different command, same surface — should NOT match.
        assert!(!b.has_session_grant(&prompt("type", Surface::Workflow)));
        // Same command, different surface — should NOT match.
        assert!(!b.has_session_grant(&prompt("click", Surface::Mcp)));
    }

    #[test]
    fn clear_session_grants_drops_every_entry() {
        let b = ConsentBroker::new();
        grant(&b, &prompt("click", Surface::Workflow), MINUTE);
        assert!(b.has_session_grant(&prompt("click", Surface::Workflow)));
        b.clear_session_grants();
        assert!(!b.has_session_grant(&prompt("click", Surface::Workflow)));
    }

    #[test]
    fn resolve_unknown_id_is_silent_noop() {
        let b = ConsentBroker::new();
        let p = prompt("click", Surface::ComputerUse);
        b.resolve("nonexistent", true, true, None, Some(&p));
        assert!(!b.has_session_grant(&p));
    }

    #[tokio::test]
    async fn host_neutral_request_emits_lists_and_resolves() {
        let broker = ConsentBroker::new();
        let expected = prompt("click", Surface::Mcp);
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let request_broker = broker.clone();
        let task = tokio::spawn(async move {
            request_broker
                .request_with_emitter(expected, 1_000, None, move |event| {
                    event_tx
                        .send(event.clone())
                        .map_err(|error| error.to_string())
                })
                .await
        });
        let event = event_rx.recv().await.expect("consent event");
        let pending = broker.pending_requests();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, event.id);
        assert!(pending[0].timeout_ms <= 1_000);
        broker.resolve_registered(&event.id, true, false, None);
        assert!(task.await.unwrap());
        assert!(broker.pending_requests().is_empty());
    }

    #[tokio::test]
    async fn failed_emitter_and_timeout_fail_closed_and_cleanup() {
        let broker = ConsentBroker::new();
        assert!(
            !broker
                .request_with_emitter(prompt("click", Surface::Mcp), 1_000, None, |_| Err(
                    "offline".into()
                ),)
                .await
        );
        assert!(broker.pending_requests().is_empty());

        assert!(
            !broker
                .request_with_emitter(prompt("click", Surface::Mcp), 1, None, |_| Ok(()),)
                .await
        );
        assert!(broker.pending_requests().is_empty());
    }

    #[tokio::test]
    async fn persisted_grant_uses_registered_prompt_not_client_prompt() {
        let broker = ConsentBroker::new();
        let registered = prompt("click", Surface::Mcp);
        let supplied = prompt("bash", Surface::ComputerUse);
        let receiver = register_pending(&broker, "secure-grant", registered.clone());
        broker.resolve("secure-grant", true, true, Some(1_000), Some(&supplied));
        assert!(receiver.await.unwrap());
        assert!(broker.has_session_grant(&registered));
        assert!(!broker.has_session_grant(&supplied));
    }

    #[test]
    fn generate_id_is_monotonic_and_unique() {
        let a = generate_id();
        let b = generate_id();
        assert_ne!(a, b);
    }

    #[test]
    fn generate_id_returns_uuid_v4() {
        let id = generate_id();
        let parsed = uuid::Uuid::parse_str(&id).expect("consent id should be a UUID");

        assert_eq!(parsed.get_version_num(), 4);
    }
}
