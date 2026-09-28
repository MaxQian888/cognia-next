//! Legacy telemetry credentials shared by migration and desktop commands.
pub const TELEMETRY_SECRET_NAMESPACE: &str = "telemetry";
pub const LANGFUSE_SECRET_KEY: &str = "langfuse-secret-key";

pub fn legacy_langfuse_secret() -> Result<Option<String>, String> {
    crate::secret_store::get(TELEMETRY_SECRET_NAMESPACE, LANGFUSE_SECRET_KEY)
}

pub fn clear_legacy_langfuse_secret() -> Result<(), String> {
    crate::secret_store::delete(TELEMETRY_SECRET_NAMESPACE, LANGFUSE_SECRET_KEY)
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "test-inmemory")]
    #[test]
    fn cleanup_removes_only_the_legacy_langfuse_secret() {
        use super::*;
        crate::secret_store::set(TELEMETRY_SECRET_NAMESPACE, LANGFUSE_SECRET_KEY, "legacy")
            .unwrap();
        crate::secret_store::set(TELEMETRY_SECRET_NAMESPACE, "migration-control", "preserve")
            .unwrap();
        assert_eq!(legacy_langfuse_secret().unwrap().as_deref(), Some("legacy"));
        clear_legacy_langfuse_secret().unwrap();
        assert_eq!(legacy_langfuse_secret().unwrap(), None);
        assert_eq!(
            crate::secret_store::get(TELEMETRY_SECRET_NAMESPACE, "migration-control")
                .unwrap()
                .as_deref(),
            Some("preserve")
        );
        crate::secret_store::delete(TELEMETRY_SECRET_NAMESPACE, "migration-control").unwrap();
    }
}
