//! Vector store error types.
//!
//! Mirrors `scheduler::error::SchedulerError` (custom Serialize → string,
//! `From<VectorError> for String`, `Result<T>` alias). Variants come from
//! spec §"Error taxonomy".

use thiserror::Error;

/// Errors that can occur during vector store operations.
#[derive(Error, Debug)]
pub enum VectorError {
    #[error("Vector store not available: {0}")]
    NotAvailable(String),

    #[error("Collection not found: {0}")]
    CollectionNotFound(String),

    #[error("Collection already exists: {0}")]
    CollectionAlreadyExists(String),

    #[error("Dimension mismatch: collection={collection} expected={expected} got={actual}")]
    DimensionMismatch {
        collection: String,
        expected: usize,
        actual: usize,
    },

    #[error("Invalid filter: {0}")]
    InvalidFilter(String),

    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    #[error("SQLite error: {0}")]
    Sqlite(String),

    #[error("Migration failed: {0}")]
    Migration(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("authentication / keyring error: {0}")]
    Auth(String),

    #[error("configuration error: {0}")]
    Configuration(String),

    #[error("upstream not found: {0}")]
    NotFound(String),

    #[error("HTTP error ({status}): {message}")]
    Http { status: u16, message: String },
}

impl From<VectorError> for String {
    fn from(err: VectorError) -> Self {
        err.to_string()
    }
}

impl serde::Serialize for VectorError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, VectorError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_includes_context() {
        let err = VectorError::DimensionMismatch {
            collection: "docs".into(),
            expected: 1536,
            actual: 768,
        };
        let msg = err.to_string();
        assert!(msg.contains("docs"));
        assert!(msg.contains("1536"));
        assert!(msg.contains("768"));
    }

    #[test]
    fn from_vector_error_for_string() {
        let err = VectorError::CollectionNotFound("docs".into());
        let s: String = err.into();
        assert!(s.contains("docs"));
        assert!(s.contains("Collection not found"));
    }

    #[test]
    fn serialize_to_string() {
        let err = VectorError::NotAvailable("disabled".into());
        let json = serde_json::to_string(&err).expect("serialize");
        // Custom Serialize impl flattens to a single string, not a tagged enum.
        assert!(json.starts_with('"'));
        assert!(json.contains("disabled"));
    }

    #[test]
    fn io_error_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let err: VectorError = io_err.into();
        assert!(matches!(err, VectorError::Io(_)));
    }
}
