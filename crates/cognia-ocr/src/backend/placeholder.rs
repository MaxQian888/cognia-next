//! Placeholder native OCR backend.
//!
//! Used when the user runs on a platform/feature combination where the real
//! binding isn't linked — Windows without MSIX, macOS without the Apple
//! Vision sidecar, Linux without `tesseract-rs`. The placeholder advertises
//! the same id as the real backend so the dispatch table is dense; calling
//! `extract` returns `MissingBinding` and the frontend surfaces that as
//! "configure a different provider" guidance.

use crate::{NativeBackend, NativeOcrError, NativeOcrInvokePayload, NativeOcrResult};

pub struct PlaceholderBackend {
    id: &'static str,
}

impl PlaceholderBackend {
    pub fn new(id: &'static str) -> Self {
        Self { id }
    }
}

impl NativeBackend for PlaceholderBackend {
    fn id(&self) -> &'static str {
        self.id
    }

    fn extract(
        &self,
        _payload: &NativeOcrInvokePayload,
    ) -> Result<NativeOcrResult, NativeOcrError> {
        Err(NativeOcrError::MissingBinding(self.id))
    }

    /// The whole point of this type: it occupies an id it cannot serve.
    fn is_available(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_round_trips() {
        let backend = PlaceholderBackend::new("tesseract");
        assert_eq!(backend.id(), "tesseract");
    }

    #[test]
    fn extract_always_errors_missing_binding() {
        let backend = PlaceholderBackend::new("tesseract");
        let payload = NativeOcrInvokePayload {
            backend: "tesseract".to_string(),
            bytes: vec![],
            mime_type: "image/png".to_string(),
            languages: vec!["en".to_string()],
        };
        let err = backend.extract(&payload).unwrap_err();
        match err {
            NativeOcrError::MissingBinding(id) => assert_eq!(id, "tesseract"),
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
