//! In-memory allow list for devices permitted to issue *remote-control* RPCs.
//!
//! Read-only sync + observe is available to any paired device. The elevated
//! capability — attaching to and steering host-owned agent sessions
//! (`session_attach` / `session_detach`), controlling host goal loops
//! (`goal_pause` / `goal_resume` / `goal_stop`), and resolving host
//! computer-use consent (`automation_consent_respond`) — is gated behind this
//! list. Baseline paired chat (`claude_send` / `claude_interrupt` /
//! `claude_compact` / `claude_approve`) is intentionally **not** gated: it is
//! the phone's own chat path and predates this capability, so gating it would
//! break existing mobile clients.
//!
//! Mirrors [`super::deny_list::DenyList`] in spirit (an O(1) HashSet checked on
//! the request hot path with no Dexie round-trip), but is a **process-global**
//! singleton rather than
//! a field on `CompanionState`. That keeps the per-command gate reachable from
//! both the HTTP `rpc_handler` and the WebRTC `signaling::dispatch` path
//! without threading a new field through every `CompanionState` constructor.
//!
//! # Source of truth
//!
//! Dexie's `pairedDevices.allowRemoteControl` is the persisted truth. The TS
//! layer mirrors it here: `companion_seed_remote_control` at desktop boot,
//! `companion_set_remote_control` when the owner flips the per-device toggle
//! (biometric-gated). A process restart re-seeds from Dexie.

use std::collections::HashSet;
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::RwLock;

/// Process-global allow list. One companion server per process, so a single
/// shared instance is correct.
static CONTROL_ALLOW_LIST: Lazy<Arc<ControlAllowList>> =
    Lazy::new(|| Arc::new(ControlAllowList::new()));

/// Accessor for the process-global control allow list.
pub fn global() -> &'static Arc<ControlAllowList> {
    &CONTROL_ALLOW_LIST
}

/// Devices permitted to start and drive *external agents* on this host.
///
/// Deliberately a second list rather than a flag on the first. Remote control
/// means steering sessions this host already decided to run; starting an agent
/// means launching a new process. Both are elevated, but granting someone the
/// ability to write files should not silently also grant process execution, and
/// a single toggle labelled "remote control" would do exactly that.
///
/// Same shape as the control list, so it inherits its behaviour and tests.
static AGENT_CONTROL_ALLOW_LIST: Lazy<Arc<ControlAllowList>> =
    Lazy::new(|| Arc::new(ControlAllowList::new()));

/// Accessor for the process-global agent-control allow list.
pub fn agent_control_global() -> &'static Arc<ControlAllowList> {
    &AGENT_CONTROL_ALLOW_LIST
}

/// Devices permitted to create, attach to, and control terminal sessions.
///
/// Terminal access is intentionally independent from remote control and agent
/// control. It exposes an interactive shell, so neither adjacent capability
/// may imply it.
static TERMINAL_ALLOW_LIST: Lazy<Arc<ControlAllowList>> =
    Lazy::new(|| Arc::new(ControlAllowList::new()));

/// Accessor for the process-global terminal allow list.
pub fn terminal_global() -> &'static Arc<ControlAllowList> {
    &TERMINAL_ALLOW_LIST
}

/// Serializes every test that touches the three allow lists above.
///
/// Both are process-global and `reseed` REPLACES, so `cargo test` — one binary,
/// threads in parallel — will happily run a seeding test that wipes the list
/// alongside an RPC gate test that just granted itself a device. Whichever
/// loses the race sees an empty list and passes for the wrong reason: a
/// permission gate that reports "allowed" because the grant vanished is exactly
/// the false green this lock exists to prevent.
///
/// Hold it for the whole test body, and clear the lists before releasing it.
#[cfg(test)]
pub(crate) fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    static ALLOW_LIST_TEST_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> =
        std::sync::OnceLock::new();
    // Poisoning only means an earlier test panicked while holding the guard;
    // the lists are cleared on entry below, so the state is still usable and
    // failing every subsequent test on it would bury the original failure.
    ALLOW_LIST_TEST_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Thread-safe set of device IDs permitted to issue remote-control RPCs.
pub struct ControlAllowList {
    inner: RwLock<HashSet<String>>,
}

impl ControlAllowList {
    /// Construct an empty allow list (no device may control until granted).
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashSet::new()),
        }
    }

    /// Grant `device_id` the remote-control capability.
    ///
    /// Returns `true` if newly granted, `false` if already present (idempotent).
    pub fn allow(&self, device_id: String) -> bool {
        self.inner.write().insert(device_id)
    }

    /// Revoke `device_id`'s remote-control capability.
    ///
    /// Returns `true` if the device was present and removed.
    pub fn disallow(&self, device_id: &str) -> bool {
        self.inner.write().remove(device_id)
    }

    /// Returns `true` if `device_id` may issue remote-control RPCs.
    pub fn is_allowed(&self, device_id: &str) -> bool {
        self.inner.read().contains(device_id)
    }

    /// Replace the entire set with `device_ids`.
    ///
    /// Called at server startup so the Rust layer reflects the persisted Dexie
    /// state. Unlike the deny-list's union `seed`, this is a **replace** so a
    /// capability revoked while the process was down is not silently retained.
    pub fn reseed(&self, device_ids: Vec<String>) {
        let mut set = self.inner.write();
        set.clear();
        for id in device_ids {
            set.insert(id);
        }
    }

    /// Number of devices currently allowed. Test helper.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.read().len()
    }

    /// Drop every entry. Test isolation helper for the process-global instance.
    #[cfg(test)]
    pub fn clear(&self) {
        self.inner.write().clear();
    }
}

impl Default for ControlAllowList {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_list_denies_everyone() {
        let acl = ControlAllowList::new();
        assert!(!acl.is_allowed("dev-1"));
        assert_eq!(acl.len(), 0);
    }

    #[test]
    fn allow_grants_capability() {
        let acl = ControlAllowList::new();
        assert!(acl.allow("dev-1".to_string()));
        assert!(acl.is_allowed("dev-1"));
    }

    #[test]
    fn allow_is_idempotent() {
        let acl = ControlAllowList::new();
        assert!(acl.allow("dev-1".to_string()));
        assert!(!acl.allow("dev-1".to_string()));
        assert_eq!(acl.len(), 1);
    }

    #[test]
    fn disallow_removes_capability() {
        let acl = ControlAllowList::new();
        acl.allow("dev-1".to_string());
        assert!(acl.disallow("dev-1"));
        assert!(!acl.is_allowed("dev-1"));
    }

    #[test]
    fn disallow_absent_returns_false() {
        let acl = ControlAllowList::new();
        assert!(!acl.disallow("never-granted"));
    }

    #[test]
    fn reseed_replaces_not_unions() {
        let acl = ControlAllowList::new();
        acl.allow("stale".to_string());
        acl.reseed(vec!["fresh-1".to_string(), "fresh-2".to_string()]);
        // The stale grant must be gone — reseed is replace, not union, so a
        // capability revoked while the process was down is not retained.
        assert!(!acl.is_allowed("stale"));
        assert!(acl.is_allowed("fresh-1"));
        assert!(acl.is_allowed("fresh-2"));
        assert_eq!(acl.len(), 2);
    }

    #[test]
    fn reseed_empty_clears_all() {
        let acl = ControlAllowList::new();
        acl.allow("dev-1".to_string());
        acl.reseed(vec![]);
        assert_eq!(acl.len(), 0);
    }

    #[test]
    fn global_is_a_shared_singleton() {
        let _guard = test_guard();
        // Two `global()` calls observe the same underlying set.
        global().clear();
        global().allow("shared-dev".to_string());
        assert!(global().is_allowed("shared-dev"));
        global().clear();
        assert!(!global().is_allowed("shared-dev"));
    }

    #[test]
    fn terminal_access_is_independent_from_other_capabilities() {
        let _guard = test_guard();
        global().clear();
        agent_control_global().clear();
        terminal_global().clear();

        terminal_global().allow("terminal-device".to_string());
        assert!(terminal_global().is_allowed("terminal-device"));
        assert!(!global().is_allowed("terminal-device"));
        assert!(!agent_control_global().is_allowed("terminal-device"));

        terminal_global().clear();
    }
}
