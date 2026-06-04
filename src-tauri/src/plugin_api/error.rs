//! Plugin API error type.
//!
//! Mirrors the convention in `src-tauri/src/scheduler/error.rs`:
//! a `thiserror`-derived enum that serializes to its display string so
//! Tauri `invoke()` rejections carry a useful message into the frontend.

use thiserror::Error;

/// Errors returned by `plugin_api` Tauri commands.
#[derive(Debug, Error)]
pub enum PluginError {
    #[error("plugin not found: {0}")]
    NotFound(String),

    #[error("permission denied: {plugin_id} requested {permission}")]
    PermissionDenied {
        plugin_id: String,
        permission: String,
    },

    #[error("invalid manifest: {0}")]
    InvalidManifest(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("crypto: {0}")]
    Crypto(String),

    #[error("internal: {0}")]
    Internal(String),

    /// Python interpreter missing or runtime never initialized — the inner
    /// string says which (e.g. "runtime not initialized", "no interpreter
    /// found (looked for: py -3, python3, python)").
    #[error("python unavailable: {0}")]
    PythonUnavailable(String),

    /// Python host subprocess failure: spawn error, protocol corruption,
    /// timeout, unexpected exit, or an error reported by the host itself.
    #[error("python host: {0}")]
    PythonHost(String),
}

impl serde::Serialize for PluginError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<PluginError> for String {
    fn from(err: PluginError) -> Self {
        err.to_string()
    }
}

pub type Result<T> = std::result::Result<T, PluginError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_variants_display_with_prefix() {
        assert_eq!(
            PluginError::PythonUnavailable("runtime not initialized".into()).to_string(),
            "python unavailable: runtime not initialized"
        );
        assert_eq!(
            PluginError::PythonHost("host exited: 1".into()).to_string(),
            "python host: host exited: 1"
        );
    }

    #[test]
    fn python_variants_serialize_to_display_string() {
        let json = serde_json::to_string(&PluginError::PythonUnavailable("x".into())).unwrap();
        assert_eq!(json, r#""python unavailable: x""#);
        let json = serde_json::to_string(&PluginError::PythonHost("boom".into())).unwrap();
        assert_eq!(json, r#""python host: boom""#);
    }
}
