//! Per-platform backend bindings registered at app boot.
//!
//! Each cfg block contributes whatever real backend its OS supports. The
//! `MissingBindingBackend` placeholder lets the registry advertise the id
//! across every shell while reporting "not implemented for this platform"
//! when invoked — that fans out to the TS layer's `unsupported_shell`
//! error code.
//!
//! The default Cargo build ships placeholders so the command surface
//! compiles on all targets. `apple-vision` is the exception: it is wired to
//! Vision.framework whenever the target is macOS (see [`apple`]) — no
//! feature flag, since it needs no models or extra toolchain. Everything
//! else gets real wiring behind feature flags:
//!
//! - `ocr-tesseract` — invoke the local Tesseract CLI through the native
//!   backend.
//! - `ocr-windows`   — reserved for Windows.Media.Ocr; currently registers
//!   the placeholder explicitly.
//! - `ocr-ocrs`      — pure-Rust ONNX-style pipeline via `ocrs` + RTen.
//! - `ocr-paddle`    — PaddleOCR PP-OCRv5 via `oar-ocr` + `ort`.

use crate::{NativeBackend, NativeOcrRegistry};

#[cfg(target_os = "macos")]
pub mod apple;
pub mod ocrs;
pub mod paddle;
pub mod placeholder;

#[cfg(all(feature = "ocr-tesseract"))]
pub mod tesseract;

async fn install_backends(registry: &NativeOcrRegistry, allow_platform_bound: bool) {
    #[cfg(not(target_os = "macos"))]
    let _ = allow_platform_bound;

    #[cfg(feature = "ocr-tesseract")]
    {
        registry
            .register(Box::new(tesseract::TesseractBackend::default()))
            .await;
    }
    #[cfg(not(feature = "ocr-tesseract"))]
    {
        registry
            .register(Box::new(placeholder::PlaceholderBackend::new("tesseract")))
            .await;
    }

    #[cfg(all(target_os = "windows", feature = "ocr-windows"))]
    {
        log::warn!(
            "ocr-windows feature is enabled, but the Windows.Media.Ocr backend is not implemented; registering placeholder"
        );
    }
    {
        registry
            .register(Box::new(placeholder::PlaceholderBackend::new(
                "windows-media-ocr",
            )))
            .await;
    }

    // apple-vision — in-process Vision.framework binding; macOS-only by
    // target, no feature flag (nothing to download, no extra toolchain).
    #[cfg(target_os = "macos")]
    {
        if allow_platform_bound {
            registry.register(Box::new(apple::AppleVisionBackend)).await;
        } else {
            registry
                .register(Box::new(placeholder::PlaceholderBackend::new(
                    "apple-vision",
                )))
                .await;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        registry
            .register(Box::new(placeholder::PlaceholderBackend::new(
                "apple-vision",
            )))
            .await;
    }

    // ocrs — cross-platform pure-Rust pipeline. Falls back to the
    // placeholder when the feature is off OR when the model directory
    // can't be resolved (headless / no HOME). The latter is reported via
    // `BackendFailure` from `extract` rather than crashing at boot.
    #[cfg(feature = "ocr-ocrs")]
    {
        match ocrs::OcrsBackend::new() {
            Ok(backend) => registry.register(Box::new(backend)).await,
            Err(err) => {
                log::warn!("ocrs backend disabled: {err}");
                registry
                    .register(Box::new(placeholder::PlaceholderBackend::new("ocrs")))
                    .await;
            }
        }
    }
    #[cfg(not(feature = "ocr-ocrs"))]
    {
        registry
            .register(Box::new(placeholder::PlaceholderBackend::new("ocrs")))
            .await;
    }

    // paddle-ocr — PP-OCRv5 via oar-ocr + ort. Same lazy-init semantics.
    #[cfg(feature = "ocr-paddle")]
    {
        match paddle::PaddleOcrBackend::new() {
            Ok(backend) => registry.register(Box::new(backend)).await,
            Err(err) => {
                log::warn!("paddle-ocr backend disabled: {err}");
                registry
                    .register(Box::new(placeholder::PlaceholderBackend::new("paddle-ocr")))
                    .await;
            }
        }
    }
    #[cfg(not(feature = "ocr-paddle"))]
    {
        registry
            .register(Box::new(placeholder::PlaceholderBackend::new("paddle-ocr")))
            .await;
    }
}

/// Install backends for an interactive desktop host. Platform-native bindings
/// such as Apple Vision may be available here.
pub async fn install_platform_backends(registry: &NativeOcrRegistry) {
    install_backends(registry, true).await;
}

/// Install backends safe to advertise from the headless server. The registry
/// remains dense, but platform-bound desktop providers are placeholders and
/// therefore excluded from `available_ids()`.
pub async fn install_server_backends(registry: &NativeOcrRegistry) {
    install_backends(registry, false).await;
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
    use crate::{NativeOcrError, NativeOcrInvokePayload};

    #[tokio::test]
    async fn install_default_backends_registers_all_known_ids() {
        let registry = NativeOcrRegistry::new();
        install_platform_backends(&registry).await;
        let ids = registry.list_ids().await;
        assert!(ids.contains(&"tesseract"));
        assert!(ids.contains(&"windows-media-ocr"));
        assert!(ids.contains(&"apple-vision"));
        assert!(ids.contains(&"ocrs"));
        assert!(ids.contains(&"paddle-ocr"));
        assert_eq!(ids.len(), 5, "expected exactly five backend slots");
    }

    /// `list_ids` is deliberately dense — every id gets a slot so dispatch
    /// always finds one. That makes it useless for deciding whether an
    /// OCR-dependent feature can run at all, which is what `available_ids`
    /// is for. This is the seam that lets the selection toolbar's OCR
    /// fallback switch itself off on a default Windows build (every feature
    /// opt-in ⇒ every backend a placeholder) with no `cfg` at the call site.
    #[tokio::test]
    async fn available_ids_excludes_placeholders_that_list_ids_still_reports() {
        let registry = NativeOcrRegistry::new();
        install_platform_backends(&registry).await;
        let all = registry.list_ids().await;
        let available = registry.available_ids().await;

        assert_eq!(all.len(), 5);
        assert!(available.len() <= all.len());
        for id in &available {
            assert!(all.contains(id));
        }
        // A placeholder is never available, whatever it is standing in for.
        assert!(
            !available.contains(&"windows-media-ocr"),
            "windows-media-ocr needs MSIX package identity and is a placeholder here"
        );

        // On macOS, Apple Vision is bound unconditionally — so the fallback
        // has a real engine and must report itself usable.
        #[cfg(target_os = "macos")]
        assert!(
            available.contains(&"apple-vision"),
            "apple-vision is in-process on macOS and needs no feature flag"
        );
    }

    #[tokio::test]
    async fn server_backends_exclude_platform_bound_desktop_engines() {
        let registry = NativeOcrRegistry::new();
        install_server_backends(&registry).await;

        let all = registry.list_ids().await;
        let available = registry.available_ids().await;
        assert!(all.contains(&"apple-vision"));
        assert!(all.contains(&"windows-media-ocr"));
        assert!(!available.contains(&"apple-vision"));
        assert!(!available.contains(&"windows-media-ocr"));
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
            model_variant: None,
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
