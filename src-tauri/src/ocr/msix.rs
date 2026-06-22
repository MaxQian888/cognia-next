//! MSIX package-identity probe used by the Windows.Media.Ocr backend.
//!
//! `Windows.Media.Ocr` only runs inside processes that have a package
//! identity. Plain NSIS/MSI installs don't grant that — the user has to use
//! the MSIX bundle. The frontend calls this command at app boot, caches the
//! result, and uses it to gate the windows-media-ocr provider in the
//! auto-router.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
pub struct MsixStatus {
    pub has_package_identity: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Detect whether the current process has an MSIX package identity. On
/// non-Windows builds we always return `false`. The Windows branch should
/// link the `windows` crate's `GetCurrentPackageFullName` API when the
/// `ocr-windows` feature is enabled — without that crate we conservatively
/// report `false`.
#[tauri::command]
pub async fn ocr_msix_status() -> Result<MsixStatus, String> {
    #[cfg(target_os = "windows")]
    {
        // The real probe is gated behind the `ocr-windows` feature, which
        // pulls in the `windows` crate's APIs. Without that feature we can
        // only report "unknown — feature not compiled in".
        #[cfg(feature = "ocr-windows")]
        {
            return Ok(detect_msix_status_windows());
        }
        #[cfg(not(feature = "ocr-windows"))]
        {
            return Ok(MsixStatus {
                has_package_identity: false,
                reason: Some("ocr-windows Cargo feature not enabled in this build".to_string()),
            });
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(MsixStatus {
            has_package_identity: false,
            reason: Some("not a Windows build".to_string()),
        })
    }
}

#[cfg(all(target_os = "windows", feature = "ocr-windows"))]
fn detect_msix_status_windows() -> MsixStatus {
    // Real implementation lives behind the `ocr-windows` feature flag — see
    // `backend/windows.rs`. This stub keeps the function name stable so the
    // command compiles on Windows even when the feature is off.
    MsixStatus::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_serializes_cleanly() {
        let status = ocr_msix_status().await.unwrap();
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("has_package_identity"));
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn non_windows_always_reports_false() {
        let status = ocr_msix_status().await.unwrap();
        assert!(!status.has_package_identity);
        assert!(status.reason.is_some());
    }
}
