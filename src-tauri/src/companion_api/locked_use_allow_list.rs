//! Per-device grant for opt-in macOS Locked Use.
//!
//! # This list is INTENTIONALLY DORMANT — nothing reads it yet
//!
//! Unlike the remote-control / agent-control / terminal grants, this one was
//! **not** superseded by the SecurityStore. It is waiting on its enforcement
//! point, which is not in this repository yet.
//!
//! Its reader is
//! [`cognia_automation::automation::locked_use::LockedUseController`], which
//! refuses an unlock or an action unless the authenticated tool turn carries
//! `locked_use_granted` (and `remote_control_granted`) — see
//! `LockedUseError::DeviceNotGranted`. That controller is a complete, tested,
//! fail-closed policy core, but nothing constructs an `AuthenticatedToolTurn`
//! in production, because the macOS edges it sits behind — the XPC service, the
//! guardian windows, and the Authorization Plugin — have not shipped
//! (`crates/cognia-automation/native/macos/` contains only `screen_capture.m`).
//!
//! So the honest state is: the grant channel is built, the policy core is
//! built, the native edge is not. Until it lands:
//!
//! * **the type** says so — this doc block;
//! * **the UI** says so — the Locked Use switch in the device console's
//!   Access tab (`components/devices/tabs/access-tab.tsx`, fed by
//!   `LOCKED_USE_AVAILABLE` in `lib/devices/grant-capabilities.ts`) renders
//!   disabled with an "unavailable in this build" note, so it cannot imply
//!   that toggling it grants anything;
//! * **a test** says so — [`tests::nothing_reads_this_list_in_production`]
//!   below fails the moment a reader appears, which is the signal to enable
//!   the UI switch and delete this section.
//!
//! Do **not** "fix" the dormancy by deleting this module: that would leave the
//! controller's `locked_use_granted` input with no way to ever be set. The fix
//! is the native edge.
//!
//! # Why not a SecurityStore capability
//!
//! Locked Use is not authorization for an RPC. The controller consumes it as
//! one fact among several on a signed, 30-second, task-bound unlock lease
//! (`UnlockLeaseClaims`), alongside the sender's code requirement and the live
//! tool turn. Modelling it as an assignable device capability would invite the
//! generic capability gate to treat it as sufficient on its own, which is
//! precisely what that controller is built to refuse.

use std::collections::HashSet;
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::RwLock;

static LOCKED_USE_ALLOW_LIST: Lazy<Arc<LockedUseAllowList>> =
    Lazy::new(|| Arc::new(LockedUseAllowList::default()));

pub fn global() -> &'static Arc<LockedUseAllowList> {
    &LOCKED_USE_ALLOW_LIST
}

/// Devices the owner has granted Locked Use to.
///
/// Dormant — see the module docs. Every method here is exercised by tests and
/// written by [`super::commands::companion_set_locked_computer_use`]; none is
/// read by a production code path yet.
#[derive(Default)]
pub struct LockedUseAllowList {
    inner: RwLock<HashSet<String>>,
}

impl LockedUseAllowList {
    pub fn allow(&self, device_id: String) -> bool {
        self.inner.write().insert(device_id)
    }

    pub fn disallow(&self, device_id: &str) -> bool {
        self.inner.write().remove(device_id)
    }

    /// Reserved for `LockedUseController`'s `locked_use_granted` input. Not
    /// called outside tests yet — see the module docs.
    pub fn is_allowed(&self, device_id: &str) -> bool {
        self.inner.read().contains(device_id)
    }

    pub fn reseed(&self, device_ids: Vec<String>) {
        *self.inner.write() = device_ids.into_iter().collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_deny_and_reseed_replaces() {
        let list = LockedUseAllowList::default();
        assert!(!list.is_allowed("device"));
        list.allow("stale".into());
        list.reseed(vec!["fresh".into()]);
        assert!(!list.is_allowed("stale"));
        assert!(list.is_allowed("fresh"));
        assert!(list.disallow("fresh"));
        assert!(!list.is_allowed("fresh"));
    }

    /// Pins the dormancy itself, so it stays a *documented* state rather than
    /// decaying back into an unnoticed one.
    ///
    /// Asserts the exact set of files that mention this module. Today that is
    /// the module declaration and the two writer commands — no reader. Any new
    /// reference fails here, which is the prompt to update all three axes
    /// together rather than only the one being worked on.
    ///
    /// If the new reference is the real reader (the Locked Use native edge
    /// landing), the change is: add its file below, flip
    /// `LOCKED_USE_AVAILABLE` in `lib/devices/grant-capabilities.ts` (which
    /// drops the `unavailable` treatment from the Access tab's switch) along
    /// with the dormancy assertions in `grant-capabilities.test.ts` and
    /// `access-tab.test.tsx`, and delete the dormancy section from this
    /// module's docs.
    #[test]
    fn the_set_of_files_touching_this_list_is_writers_only() {
        const OWN_FILE: &str = "locked_use_allow_list.rs";
        // Writers only. A reader added here without the UI and the docs moving
        // with it is the exact three-axis violation this pin guards.
        const EXPECTED: &[&str] = &[
            // `pub mod locked_use_allow_list;`
            "mod.rs",
            // `companion_set_locked_computer_use` / `companion_seed_locked_computer_use`
            "commands.rs",
        ];

        let root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut found = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|ext| ext != "rs")
                    || path.ends_with(OWN_FILE)
                    || !std::fs::read_to_string(&path)
                        .is_ok_and(|body| body.contains("locked_use_allow_list"))
                {
                    continue;
                }
                found.push(
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default()
                        .to_string(),
                );
            }
        }
        found.sort();
        found.dedup();

        let mut expected = EXPECTED.to_vec();
        expected.sort();
        assert_eq!(
            found, expected,
            "the files touching the Locked Use allow list changed — see this test's docs"
        );
    }
}
