//! Desktop command shell for shared Pi extension integrity verification.
pub use cognia_sidecar::pi_extension::*;
use std::path::PathBuf;
use tauri::AppHandle;

/// Resolve and verify the bundled Pi extension on this desktop host.
///
/// Returns a verdict rather than an error for every "we looked and it is not
/// usable" case: the adapter turns that into a refused session with a message
/// naming the cause, which `extension_handshake_failed` could not do (it could
/// not tell "never shipped" from "tampered" from "timed out").
#[tauri::command]
pub fn resolve_pi_extension(app: AppHandle) -> Result<PiExtensionVerdict, String> {
    let dir: PathBuf = crate::claude::sidecar::sidecar_dir(&app)?;
    Ok(verify_in_sidecar_dir(&dir))
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_host_assets_never_produce_a_verified_extension() {
        assert_eq!(
            super::verify_for_host(None),
            super::PiExtensionVerdict::Missing
        );
    }
}
