//! Host credential configuration (A16).
//!
//! `COLLAB_INTERNAL_SERVICE_CREDENTIAL_SHA256` accepts one digest or a comma-separated
//! list. `COLLAB_INTERNAL_SERVICE_CREDENTIAL_SCOPES`, when set, is a JSON object
//! mapping configured lowercase SHA-256 digests to arrays of org ids. Missing
//! entries deny access. `"*"` grants every org and is the only scoped permission
//! for deployment-wide `/internal/shared-chat-metrics`. Unset scopes preserve
//! the existing deployment-wide authority of every configured credential.

use std::collections::HashMap;

pub type CredentialScopes = HashMap<String, Vec<String>>;

pub fn parse_hashes(value: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else { return Ok(None) };
    let mut hashes = Vec::new();
    for hash in value.split(',').map(str::trim) {
        anyhow::ensure!(hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "COLLAB_INTERNAL_SERVICE_CREDENTIAL_SHA256 must contain 64-character SHA-256 hex digests");
        hashes.push(hash.to_ascii_lowercase());
    }
    Ok(Some(hashes.join(",")))
}

pub fn parse_scopes(value: Option<&str>, configured: Option<&str>) -> anyhow::Result<Option<CredentialScopes>> {
    let Some(value) = value else { return Ok(None) };
    let scopes: CredentialScopes = serde_json::from_str(value)
        .map_err(|_| anyhow::anyhow!("COLLAB_INTERNAL_SERVICE_CREDENTIAL_SCOPES must be a JSON object mapping hashes to org-id arrays"))?;
    for (hash, orgs) in &scopes {
        anyhow::ensure!(hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && configured.is_some_and(|list| list.split(',').any(|known| known == hash)),
            "COLLAB_INTERNAL_SERVICE_CREDENTIAL_SCOPES contains a hash not among the configured lowercase credential hashes");
        for org in orgs {
            anyhow::ensure!(org == "*" || cognia_tenant_auth::OrgId::parse(org).is_ok(),
                "COLLAB_INTERNAL_SERVICE_CREDENTIAL_SCOPES contains an invalid org id");
        }
    }
    Ok(Some(scopes))
}

pub fn allows(scopes: Option<&CredentialScopes>, hash: &str, org: Option<&str>) -> bool {
    scopes.is_none_or(|scopes| scopes.get(hash).is_some_and(|orgs| {
        orgs.iter().any(|allowed| allowed == "*" || org == Some(allowed.as_str()))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hashes_preserve_single_credential_and_accept_lists() {
        let a = "ab".repeat(32);
        let b = "cd".repeat(32);
        assert_eq!(parse_hashes(None).unwrap(), None);
        assert_eq!(parse_hashes(Some("  ")).unwrap(), None);
        assert_eq!(parse_hashes(Some(&a.to_uppercase())).unwrap(), Some(a.clone()));
        assert_eq!(parse_hashes(Some(&format!(" {a}, {b} "))).unwrap(), Some(format!("{a},{b}")));
        for bad in ["clear-credential".into(), "gg".repeat(32), format!("{a},"), format!("{a},bad")] {
            assert!(parse_hashes(Some(&bad)).is_err());
        }
    }

    #[test]
    fn scope_parse_and_org_and_deployment_wide_authority() {
        let a = "ab".repeat(32);
        let b = "cd".repeat(32);
        let configured = format!("{a},{b}");
        assert!(parse_scopes(None, Some(&configured)).unwrap().is_none());
        assert!(allows(None, &a, Some("org_other")));
        assert!(allows(None, &a, None));
        let raw = json!({a.clone(): ["org_alpha"]}).to_string();
        let scopes = parse_scopes(Some(&raw), Some(&configured)).unwrap().unwrap();
        assert!(allows(Some(&scopes), &a, Some("org_alpha")));
        assert!(!allows(Some(&scopes), &a, Some("org_other")));
        assert!(!allows(Some(&scopes), &b, Some("org_alpha")));
        assert!(!allows(Some(&scopes), &a, None));
        let raw = json!({a.clone(): ["*"]}).to_string();
        let scopes = parse_scopes(Some(&raw), Some(&configured)).unwrap().unwrap();
        assert!(allows(Some(&scopes), &a, None));
        assert!(allows(Some(&scopes), &a, Some("org_other")));
        assert!(!allows(Some(&CredentialScopes::new()), &a, Some("org_alpha")));
        for bad in ["".into(), "null".into(), "[]".into(), "{}x".into(),
            json!({a.clone(): "org_alpha"}).to_string(), json!({a.clone(): [1]}).to_string(),
            json!({a.to_uppercase(): []}).to_string(), json!({"ef".repeat(32): []}).to_string(),
            json!({a.clone(): ["invalid/path"]}).to_string()] {
            assert!(parse_scopes(Some(&bad), Some(&configured)).is_err(), "{bad}");
        }
        assert!(parse_scopes(Some(&raw), None).is_err());
    }
}
