//! Desktop integration for the shared build-pinned native bridge verifier.
use cognia_external_agent::native_bridge::NativeBridgeLaunch;
use tauri::AppHandle;

#[tauri::command]
pub fn resolve_bundled_agent_bridge(
    app: AppHandle,
    id: String,
) -> Result<NativeBridgeLaunch, String> {
    let sidecar = crate::claude::sidecar::sidecar_dir(&app)?;
    let node = cognia_core::node_runtime::configured_node_executable()
        .ok_or("Native bridge host Node runtime has not been initialized")?
        .map_err(|error| error.to_string())?;
    cognia_external_agent::native_bridge::resolve_in_sidecar_dir(&sidecar, &node, &id)
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_packaged_assets_fail_closed() {
        let sidecar = tempfile::tempdir().unwrap();
        let node = std::env::current_exe().unwrap();
        let error = cognia_external_agent::native_bridge::resolve_in_sidecar_dir(
            sidecar.path(),
            &node,
            "codebuff",
        )
        .unwrap_err();
        assert!(error.contains("rebuild/reinstall"));
    }
}
