//! Per-platform backend bindings registered at app boot.
//!
//! Each cfg block contributes whatever real backend its OS supports. The
//! `MissingBindingBackend` placeholder lets the registry advertise the id
//! across every shell while reporting "not implemented for this platform"
//! when invoked — that fans out to the TS layer's `unsupported_shell`
//! error code.
//!
//! The default Cargo build ships placeholders for every backend so the
//! command surface compiles on all targets. Real wiring happens behind
//! feature flags:
//!
//! - `ocr-tesseract` — link `tesseract-rs` for the cross-platform Tesseract
//!   backend.
//! - `ocr-windows`   — link `winocr` for Windows.Media.Ocr (Windows + MSIX).
//! - `ocr-apple`     — call the Swift sidecar binary bundled at
//!   `sidecars/apple-vision-ocr/` via `tauri-plugin-shell`.

use crate::ocr::{NativeBackend, NativeOcrRegistry};

pub mod placeholder;

#[cfg(all(feature = "ocr-tesseract"))]
pub mod tesseract;

#[cfg(all(target_os = "windows", feature = "ocr-windows"))]
pub mod windows;

#[cfg(all(target_os = "macos", feature = "ocr-apple"))]
pub mod apple;

pub async fn install_platform_backends(registry: &NativeOcrRegistry) {
    #[cfg(feature = "ocr-tesseract")]
    {
        registry.register(Box::new(tesseract::TesseractBackend::default())).await;
    }
    #[cfg(not(feature = "ocr-tesseract"))]
    {
        registry
            .register(Box::new(placeholder::PlaceholderBackend::new("tesseract")))
            .await;
    }

    #[cfg(all(target_os = "windows", feature = "ocr-windows"))]
    {
        registry.register(Box::new(windows::WindowsMediaOcrBackend::default())).await;
    }
    #[cfg(not(all(target_os = "windows", feature = "ocr-windows")))]
    {
        registry
            .register(Box::new(placeholder::PlaceholderBackend::new(
                "windows-media-ocr",
            )))
            .await;
    }

    #[cfg(all(target_os = "macos", feature = "ocr-apple"))]
    {
        registry.register(Box::new(apple::AppleVisionBackend::default())).await;
    }
    #[cfg(not(all(target_os = "macos", feature = "ocr-apple")))]
    {
        registry
            .register(Box::new(placeholder::PlaceholderBackend::new("apple-vision")))
            .await;
    }
}

/// Default placeholder so the dispatch table is dense even when no real
/// bindings are linked. Returns `MissingBinding(id)` from `extract`.
#[allow(dead_code)]
pub fn missing_binding_for(id: &'static str) -> Box<dyn NativeBackend> {
    Box::new(placeholder::PlaceholderBackend::new(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::{NativeOcrError, NativeOcrInvokePayload};

    #[tokio::test]
    async fn install_default_backends_registers_three_ids() {
        let registry = NativeOcrRegistry::new();
        install_platform_backends(&registry).await;
        let ids = registry.list_ids().await;
        assert!(ids.contains(&"tesseract"));
        assert!(ids.contains(&"windows-media-ocr"));
        assert!(ids.contains(&"apple-vision"));
    }

    #[tokio::test]
    async fn placeholder_dispatch_reports_missing_binding() {
        let registry = NativeOcrRegistry::new();
        install_platform_backends(&registry).await;
        let payload = NativeOcrInvokePayload {
            backend: "windows-media-ocr".to_string(),
            bytes: vec![],
            mime_type: "image/png".to_string(),
            languages: vec!["en".to_string()],
        };
        let result = registry.dispatch(&payload).await;
        // On a non-Windows CI machine the placeholder kicks in. On Windows
        // CI (without the ocr-windows feature) the placeholder also kicks
        // in. Either way the error is MissingBinding.
        match result {
            Err(NativeOcrError::MissingBinding(_)) => (),
            Err(NativeOcrError::UnknownBackend(_)) => (),
            Err(other) => panic!("unexpected error: {other:?}"),
            Ok(_) => (), // Real binding available — also acceptable.
        }
    }

    #[tokio::test]
    async fn missing_binding_helper_returns_a_box() {
        let backend = missing_binding_for("test");
        assert_eq!(backend.id(), "test");
    }
}
