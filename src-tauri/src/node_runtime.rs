//! Desktop Node.js runtime profile initialization.
//!
//! The normal desktop build resolves the verified runtime copied into Tauri
//! resources. The `system-node-runtime` build feature instead resolves one
//! system installation, validates Node.js >= 26, and records an actionable
//! installation error without preventing the native shell from opening.

#[cfg(any(not(feature = "system-node-runtime"), test))]
use std::path::{Path, PathBuf};

#[cfg(not(feature = "system-node-runtime"))]
use cognia_core::node_runtime::{bundled_node_missing_error, validate_bundled_node};
use cognia_core::node_runtime::{install_desktop_runtime, NodeRuntimeError, NodeRuntimeInfo};
#[cfg(feature = "system-node-runtime")]
use cognia_core::node_runtime::{
    system_node_missing_error, validate_system_node, NODE_DOWNLOAD_URL,
};
use tauri::AppHandle;
#[cfg(not(feature = "system-node-runtime"))]
use tauri::Manager;
#[cfg(feature = "system-node-runtime")]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[cfg(any(not(feature = "system-node-runtime"), test))]
fn bundled_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = Vec::new();
    if let Some(resource_dir) = resource_dir {
        candidates.push(
            resource_dir
                .join("resources/plugin-node/bin")
                .join(executable),
        );
        candidates.push(resource_dir.join("plugin-node/bin").join(executable));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/plugin-node/bin")
            .join(executable),
    );
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("COGNIA_PLUGIN_NODE_PATH") {
        candidates.push(PathBuf::from(path));
    }
    candidates
}

#[cfg(not(feature = "system-node-runtime"))]
fn resolve_desktop_runtime(app: &AppHandle) -> Result<NodeRuntimeInfo, NodeRuntimeError> {
    let resource_dir = app.path().resource_dir().ok();
    let Some(executable) = bundled_candidates(resource_dir.as_deref())
        .into_iter()
        .find(|candidate| candidate.is_file())
    else {
        return Err(bundled_node_missing_error());
    };
    validate_bundled_node(executable)
}

#[cfg(feature = "system-node-runtime")]
fn resolve_desktop_runtime(_app: &AppHandle) -> Result<NodeRuntimeInfo, NodeRuntimeError> {
    let executable = crate::external_agent::command_resolver::resolve_command_path("node")
        .ok_or_else(system_node_missing_error)?;
    validate_system_node(executable)
}

pub fn initialize(app: &AppHandle) {
    let runtime = resolve_desktop_runtime(app);
    match &runtime {
        Ok(runtime) => log::info!(
            "desktop Node.js runtime ready: mode={} version={} executable={}",
            mode(),
            runtime.version,
            runtime.executable.display()
        ),
        Err(error) => log::warn!(
            "desktop Node.js runtime unavailable: mode={} error={error}",
            mode()
        ),
    }
    #[cfg(feature = "system-node-runtime")]
    if let Err(error) = &runtime {
        show_system_node_install_guidance(app, error);
    }
    if let Err(error) = install_desktop_runtime(runtime) {
        log::warn!("desktop Node.js runtime setup skipped: {error}");
    }
}

#[cfg(feature = "system-node-runtime")]
fn show_system_node_install_guidance(app: &AppHandle, error: &NodeRuntimeError) {
    app.dialog()
        .message(error.to_string())
        .title("Node.js is required")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Download Node.js".into(),
            "Later".into(),
        ))
        .show(|download| {
            if download {
                if let Err(error) = tauri_plugin_opener::open_url(NODE_DOWNLOAD_URL, None::<&str>) {
                    log::warn!("failed to open the Node.js download page: {error}");
                }
            }
        });
}

pub const fn mode() -> &'static str {
    if cfg!(feature = "system-node-runtime") {
        "system-node"
    } else {
        "bundled"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_candidates_cover_both_tauri_resource_layouts() {
        let root = Path::new("/tmp/cognia-resources");
        let candidates = bundled_candidates(Some(root));
        let executable = if cfg!(windows) { "node.exe" } else { "node" };

        assert_eq!(
            candidates[0],
            root.join("resources/plugin-node/bin").join(executable)
        );
        assert_eq!(candidates[1], root.join("plugin-node/bin").join(executable));
    }

    #[test]
    fn build_exposes_one_explicit_runtime_mode() {
        assert!(matches!(mode(), "bundled" | "system-node"));
    }
}
