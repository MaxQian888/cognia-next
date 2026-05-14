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

use wasmtime::{Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{DirPerms, FilePerms, ResourceTable, WasiCtx, WasiCtxBuilder, WasiView};

use super::engine::engine;

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

impl CapabilitySet {
    pub fn from_iter<I: IntoIterator<Item = String>>(iter: I) -> Self {
        Self {
            granted: iter.into_iter().collect(),
        }
    }

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
    pub call_timeout_ms: u64,
    pub limits: StoreLimits,
    pub table: ResourceTable,
    pub wasi: WasiCtx,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> &mut WasiCtx {
        &mut self.wasi
    }
    fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
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
    let mut wasi_builder = WasiCtxBuilder::new();
    wasi_builder
        .inherit_stdio()
        // The plugin gets a sanitized $PATH-free env; we pass nothing.
        .args(&[plugin_id.into() as String]);

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
            plugin_id: String::new(), // overwritten below for clarity
            capabilities,
            call_timeout_ms,
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
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(store.data().call_timeout_ms, DEFAULT_CALL_TIMEOUT_MS);
    }
}
