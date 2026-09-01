//! Integrated terminal subsystem — `portable-pty` + xterm.js bridge.
//!
//! This module owns the Rust half of the VS Code-style terminal panel
//! described in the approved plan at
//! `~/.claude/plans/vscode-vivid-wilkinson.md`:
//!
//!   * `osc633` — streaming OSC 633 parser (per-spawn nonce gated).
//!   * `integration` — per-shell argv + env builder for the bundled
//!     shell-integration scripts at `src-tauri/resources/terminal/`.
//!   * `session` — `PtySession` wrapping `portable_pty::PtyPair` and the
//!     reader / waiter threads. First user of `tauri::ipc::Channel<T>`.
//!   * `commands` — Tauri commands exported through
//!     `lib.rs::generate_handler!`.
//!
//! The renderer pre-flights every spawn through
//! `lib/plugin/messaging/hooks-system.ts::dispatchTerminalWillSpawn` so
//! plugins can veto, modify, or audit. Rust stays narrow: spawn / write /
//! resize / kill / list. Audit fan-out happens on the TS side via
//! `loggers.ui` (user-driven) or the plugin permission-guard audit pipe
//! (extension-driven).

pub mod commands;
pub mod complete;
pub mod exec;
pub mod headless;
pub mod host;
pub mod host_capabilities;
pub mod host_wire;
pub mod integration;
pub mod multiplexer;
pub mod osc633;
pub mod path_scan;
pub mod protocol;
pub mod replay;
pub mod serial;
pub mod session;
pub mod ssh;
pub mod ssh_forward;
// ADR-0067 Tier C — the durable terminal-host service moved in from
// `app_lib` (it had zero `crate::` deps there and already built on this
// crate's host/host_wire/session). `app_lib` re-aliases it so
// `crate::terminal_host_service::…` (companion_api, terminal_host_bridge,
// bin/cognia-server) resolves unchanged.
pub mod terminal_host_service;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

// Re-export the public session API so downstream Rust consumers (e.g.
// the LAN terminal WebSocket handler can `use …::terminal::*`
// without reaching into a sub-module. The unused-import lint fires for
// the types this crate itself doesn't reference today — they're still
// part of the module's stable surface.
#[allow(unused_imports)]
pub use replay::ReplayBuffer;
#[allow(unused_imports)]
pub use session::{PtySession, SessionOrigin, SpawnRequest, TerminalEvent, TerminalSessionInfo};

/// In-process registry of live PTY sessions. Stored as a Tauri-managed
/// state and looked up by every terminal_* command. Multi-thread safe;
/// the per-session `Arc<PtySession>` is cloned cheaply for the (rare)
/// case where a long-running operation needs to outlive the map lock.
#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, session: Arc<PtySession>) {
        self.sessions.lock().insert(session.id.clone(), session);
    }

    pub fn get(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().remove(id)
    }

    /// Snapshot the sessions belonging to `project_id`. Returns infos
    /// ordered by insertion (HashMap iteration order isn't stable across
    /// versions, but the dock sorts by its own creation timestamps).
    pub fn list_for_project(&self, project_id: &str) -> Vec<TerminalSessionInfo> {
        self.sessions
            .lock()
            .values()
            .filter(|s| s.project_id.as_deref() == Some(project_id))
            .map(|s| s.info())
            .collect()
    }

    /// Snapshot of every live session — used by the cross-project audit
    /// view and by tests.
    pub fn list_all(&self) -> Vec<TerminalSessionInfo> {
        self.sessions.lock().values().map(|s| s.info()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_session(id: &str, project: Option<&str>) -> Arc<PtySession> {
        // Direct struct construction is fine here — `PtySession`'s
        // pub fields cover the metadata the store cares about, and the
        // mutex-wrapped IO handles are only touched on real Tauri calls.
        //
        // We build a dummy MasterPty/Writer/Killer via portable_pty's
        // native_pty_system so the Drop impl has something coherent to
        // operate on. This DOES briefly open a real PTY pair, but the
        // pair is closed on Drop with no child attached so it's cheap.
        use portable_pty::{native_pty_system, PtySize};
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let writer = pair.master.take_writer().expect("writer");
        let session = PtySession {
            id: id.to_string(),
            project_id: project.map(str::to_string),
            extension_id: None,
            origin: SessionOrigin::Local,
            shell: "/test/stub".to_string(),
            master: std::sync::Mutex::new(pair.master),
            write_tx: session::spawn_writer_thread(id, writer),
            // Test-only: build a dummy killer that's a no-op. We can't
            // construct a real `ChildKiller` without spawning a child, so
            // we wrap a tiny adapter. Easiest is to spawn `sh -c true` /
            // `cmd /C exit` and clone its killer; we don't need the child
            // alive for the store-only tests.
            killer: std::sync::Mutex::new(make_dummy_killer()),
            pid: None,
            tempdir: None,
            alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            replay: Arc::new(ReplayBuffer::new()),
            channel_slot: session::detached_desk_channel(),
            // No reader thread here, so the gate is inert — it exists only so
            // `Drop` has something coherent to close.
            flow: session::FlowGate::new(),
        };
        Arc::new(session)
    }

    fn make_dummy_killer() -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 1,
                cols: 1,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty for dummy");
        // Pick a shell that exits immediately.
        let cmd = if cfg!(target_os = "windows") {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg("exit");
            c
        } else {
            let mut c = CommandBuilder::new("/bin/sh");
            c.arg("-c");
            c.arg("exit 0");
            c
        };
        let child = pair.slave.spawn_command(cmd).expect("dummy child spawn");
        child.clone_killer()
    }

    #[test]
    fn store_insert_and_get_roundtrip() {
        let store = TerminalState::new();
        let s = fake_session("id-1", Some("proj-a"));
        store.insert(s);
        let got = store.get("id-1").expect("found");
        assert_eq!(got.id, "id-1");
    }

    #[test]
    fn store_list_for_project_filters() {
        let store = TerminalState::new();
        store.insert(fake_session("a1", Some("proj-a")));
        store.insert(fake_session("a2", Some("proj-a")));
        store.insert(fake_session("b1", Some("proj-b")));
        store.insert(fake_session("orphan", None));

        let mut ids: Vec<String> = store
            .list_for_project("proj-a")
            .into_iter()
            .map(|i| i.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["a1", "a2"]);
    }

    #[test]
    fn store_remove_returns_session_then_misses() {
        let store = TerminalState::new();
        store.insert(fake_session("once", Some("p")));
        assert!(store.remove("once").is_some());
        assert!(store.get("once").is_none());
        assert!(store.remove("once").is_none());
    }

    #[test]
    fn store_list_all_returns_every_session() {
        let store = TerminalState::new();
        store.insert(fake_session("a", Some("p1")));
        store.insert(fake_session("b", None));
        let all = store.list_all();
        assert_eq!(all.len(), 2);
    }
}
