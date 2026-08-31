//! Per-plugin `Store<HostState>` builder.
//!
//! Carries everything one WASM plugin instance needs:
//! - its `WasiCtx` (preopens, env, args),
//! - a `ResourceTable` for WASI resources,
//! - the cognia-side capability gate snapshot,
//! - the plugin id (for log + audit tagging).
//!
//! Memory + table caps are enforced via `StoreLimitsBuilder`. Epoch
//! deadlines are set per-call by `host.rs`, not here.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use wasmtime::{Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{
    DirPerms, FilePerms, ResourceTable, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView,
};

use super::engine::engine;
use super::services::WasmHostServices;

/// Default linear-memory cap in MiB. Override via `manifest.wasm.memoryLimitMb`.
pub const DEFAULT_MEMORY_LIMIT_MB: u32 = 64;
pub const DEFAULT_TABLE_ELEMENTS: u32 = 10_000;
pub const DEFAULT_CALL_TIMEOUT_MS: u64 = 30_000;
/// One epoch tick = 100 ms. 30 s / 100 ms = 300 ticks.
pub const fn deadline_from_timeout_ms(ms: u64) -> u64 {
    let ticks = ms.div_ceil(super::engine::EPOCH_TICK_MS);
    if ticks == 0 {
        1
    } else {
        ticks
    }
}

/// The granted capabilities a plugin instance carries. Each cognia
/// capability handler checks against this set on every call. Membership
/// is the *granted* set, not the *declared* set; a missing entry traps
/// the guest.
#[derive(Debug, Clone, Default)]
pub struct CapabilitySet {
    granted: HashSet<String>,
}

impl FromIterator<String> for CapabilitySet {
    fn from_iter<I: IntoIterator<Item = String>>(iter: I) -> Self {
        Self {
            granted: iter.into_iter().collect(),
        }
    }
}

impl CapabilitySet {
    pub fn allows(&self, capability: &str) -> bool {
        self.granted.contains(capability)
    }

    pub fn add(&mut self, capability: impl Into<String>) {
        self.granted.insert(capability.into());
    }

    pub fn snapshot(&self) -> Vec<String> {
        let mut out: Vec<String> = self.granted.iter().cloned().collect();
        out.sort();
        out
    }
}

/// Tauri-managed state a single WASM plugin instance holds. Owned by its
/// `Store`. Cloning is forbidden (`!Clone`) so the store retains exclusive
/// access.
pub struct HostState {
    pub plugin_id: String,
    pub capabilities: CapabilitySet,
    /// Declared shell-command allowlist (program names) from the plugin's
    /// manifest `shellCommands`, mirrored from `PluginRuntimeState` at
    /// activation. DENY-by-default gate for `process.exec` — parity with the
    /// TS-plugin `shell:execute` gate. Empty ⇒ no program may be spawned.
    pub shell_allowlist: Vec<String>,
    pub call_timeout_ms: u64,
    /// Host surfaces this instance may reach (clipboard, notifications, the
    /// renderer bridge). `None` is the headless posture: every cognia
    /// capability that needs a backend answers `HOST_UNAVAILABLE`, while
    /// logger / secrets / process / WASI keep working. Installed by
    /// `build_activation_store` from `WasmPluginState::services`.
    pub services: Option<Arc<dyn WasmHostServices>>,
    pub limits: StoreLimits,
    pub table: ResourceTable,
    pub wasi: WasiCtx,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

/// Construct a fresh `Store<HostState>` ready for component instantiation.
/// `data_dir` is preopened read+write as `/`; the plugin sees it as its
/// filesystem root. Extra preopens are layered on top.
pub fn build_store(
    plugin_id: impl Into<String>,
    data_dir: &Path,
    extra_preopens: &[std::path::PathBuf],
    capabilities: CapabilitySet,
    memory_limit_mb: u32,
    call_timeout_ms: u64,
) -> wasmtime::Result<Store<HostState>> {
    let plugin_id = plugin_id.into();
    let mut wasi_builder = WasiCtxBuilder::new();
    wasi_builder
        // Guest stdout/stderr remain closed so plugins cannot bypass the
        // host-owned structured logger or create unmanaged transports.
        // The plugin gets a sanitized $PATH-free env; we pass nothing.
        .args(std::slice::from_ref(&plugin_id));

    if !data_dir.exists() {
        std::fs::create_dir_all(data_dir).map_err(|e| {
            wasmtime::Error::msg(format!("create plugin data dir {data_dir:?}: {e}"))
        })?;
    }
    wasi_builder.preopened_dir(data_dir, "/", DirPerms::all(), FilePerms::all())?;
    for extra in extra_preopens {
        // Skip non-existent extra preopens silently — the user may have
        // granted a path that no longer exists, and a hard failure here
        // would prevent the plugin from booting entirely.
        if !extra.exists() {
            continue;
        }
        let guest_path = format!("/extra/{}", sanitize_extra_label(extra));
        wasi_builder.preopened_dir(extra, &guest_path, DirPerms::all(), FilePerms::all())?;
    }

    let memory_bytes = (memory_limit_mb as usize).saturating_mul(1024 * 1024);
    let limits = StoreLimitsBuilder::new()
        .memory_size(memory_bytes)
        .table_elements(DEFAULT_TABLE_ELEMENTS as usize)
        .instances(1)
        .tables(4)
        .memories(1)
        .build();

    let mut store = Store::new(
        engine(),
        HostState {
            plugin_id,
            capabilities,
            // Empty by default; `build_activation_store` mirrors the plugin's
            // declared `shellCommands` in after construction.
            shell_allowlist: Vec::new(),
            call_timeout_ms,
            // Headless-safe default; `build_activation_store` installs the real
            // set when the host has one.
            services: None,
            limits,
            table: ResourceTable::new(),
            wasi: wasi_builder.build(),
        },
    );
    store.limiter(|s| &mut s.limits);
    store.set_epoch_deadline(deadline_from_timeout_ms(call_timeout_ms));
    Ok(store)
}

/// Produce a directory-name-safe label for a preopen, used to form the
/// guest-visible path under `/extra/<label>`. Multiple distinct host paths
/// would collide on the same trailing component but that's acceptable for
/// v0.1 — the user is the one approving the preopen list.
fn sanitize_extra_label(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "root".to_string())
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Build a bare `HostState` for unit tests.
///
/// Before v0.2 this struct was rebuilt as a full literal in eight places, so
/// adding a single field meant editing eight files — which is exactly why the
/// v0.1 linker could not be frozen while it still lived in the module tree.
/// Route every test through here instead: the next field addition touches this
/// file and nothing else.
#[cfg(test)]
pub(crate) fn test_host_state(plugin_id: &str, caps: &[&str]) -> HostState {
    test_host_state_with(plugin_id, caps, None, DEFAULT_CALL_TIMEOUT_MS)
}

#[cfg(test)]
pub(crate) fn test_host_state_with(
    plugin_id: &str,
    caps: &[&str],
    services: Option<Arc<dyn WasmHostServices>>,
    call_timeout_ms: u64,
) -> HostState {
    HostState {
        plugin_id: plugin_id.into(),
        capabilities: CapabilitySet::from_iter(caps.iter().map(|s| (*s).to_string())),
        shell_allowlist: Vec::new(),
        call_timeout_ms,
        services,
        limits: StoreLimitsBuilder::new().build(),
        table: ResourceTable::new(),
        wasi: WasiCtxBuilder::new().build(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_host_state_defaults_to_the_headless_posture() {
        let st = test_host_state("demo", &["notification"]);
        assert_eq!(st.plugin_id, "demo");
        assert!(st.capabilities.allows("notification"));
        assert!(st.shell_allowlist.is_empty());
        assert_eq!(st.call_timeout_ms, DEFAULT_CALL_TIMEOUT_MS);
        assert!(
            st.services.is_none(),
            "a bare test state must not silently gain host surfaces"
        );
    }

    #[test]
    fn capability_set_membership_round_trips() {
        let mut caps = CapabilitySet::default();
        assert!(!caps.allows("network:fetch"));
        caps.add("network:fetch");
        caps.add("filesystem:read");
        assert!(caps.allows("network:fetch"));
        assert!(caps.allows("filesystem:read"));
        assert!(!caps.allows("process:spawn"));
        let snap = caps.snapshot();
        assert_eq!(snap, vec!["filesystem:read", "network:fetch"]);
    }

    #[test]
    fn deadline_from_timeout_ms_rounds_up() {
        assert_eq!(deadline_from_timeout_ms(0), 1);
        assert_eq!(deadline_from_timeout_ms(50), 1); // <100ms still gets 1 tick
        assert_eq!(deadline_from_timeout_ms(100), 1);
        assert_eq!(deadline_from_timeout_ms(101), 2);
        assert_eq!(deadline_from_timeout_ms(30_000), 300);
    }

    #[test]
    fn sanitize_extra_label_strips_unsafe_chars() {
        use std::path::PathBuf;
        let p = PathBuf::from("/var/tmp/my project!");
        assert_eq!(sanitize_extra_label(&p), "my_project_");
        let blank = PathBuf::from("/");
        assert_eq!(sanitize_extra_label(&blank), "root");
    }

    #[tokio::test]
    async fn build_store_creates_data_dir_and_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_id = "test.plugin";
        let caps = CapabilitySet::from_iter(["notification".into()]);
        let store = build_store(
            plugin_id,
            tmp.path(),
            &[],
            caps,
            DEFAULT_MEMORY_LIMIT_MB,
            DEFAULT_CALL_TIMEOUT_MS,
        )
        .expect("store builds");
        assert!(store.data().capabilities.allows("notification"));
        assert_eq!(store.data().plugin_id, plugin_id);
        assert_eq!(store.data().call_timeout_ms, DEFAULT_CALL_TIMEOUT_MS);
        // `build_store` is the headless-safe constructor: host surfaces are
        // installed later, by `build_activation_store`, only when one exists.
        assert!(store.data().services.is_none());
    }
}
