//! Authenticated request identity shared by companion and domain route handlers.
#[derive(Clone, Debug)]
pub struct DeviceContext {
    pub device_id: String,
    pub tenant_id: String,
    /// Scope string from the JWT claims (`"device"`).  Reserved for M2.5+
    /// handlers that may need to inspect the scope.
    #[allow(dead_code)]
    pub scope: String,
    /// OAuth/OIDC permission scopes granted to this caller. Legacy paired
    /// device/service tokens leave this empty and use their existing device
    /// permission gate; OIDC routes enforce these values explicitly.
    pub granted_scopes: Vec<String>,
    /// Canonical remote-command capabilities loaded by the authenticating
    /// adapter. `Some`, including `Some(Vec::new())`, is an authoritative
    /// authorization snapshot. `None` lets adapters that have not yet loaded
    /// a snapshot fall back to the shared security store.
    pub authorization_capabilities: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    #[test]
    fn empty_snapshot_is_distinct_from_unloaded_authorization() {
        let context = super::DeviceContext {
            device_id: "d".into(),
            tenant_id: "a".into(),
            scope: "device".into(),
            granted_scopes: vec![],
            authorization_capabilities: Some(vec![]),
        };
        assert_ne!(context.authorization_capabilities, None);
        assert!(context.authorization_capabilities.unwrap().is_empty());
    }
}
