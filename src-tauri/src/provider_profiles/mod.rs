//! Provider Profile Store — headless same-port store (ADR-0090 Phase 1).
//!
//! Rust counterpart of the renderer's Dexie v121 tables
//! (`lib/db/provider-profiles.ts`): the same secret-free JSON documents
//! (serde camelCase mirrors of `@cognia/provider-types/provider-profile`)
//! persisted in SQLite for `cognia-server`, with the same CAS
//! `profile_version` semantics the Gateway snapshot authority check (R3)
//! keys off. Secrets never enter these tables — credentials are references
//! into the encrypted secret store / env.

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bump together with `PROFILE_STORE_SCHEMA_VERSION` on the TS side.
pub const PROFILE_STORE_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum ProfileStoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("version conflict: expected {expected}, current {current}")]
    VersionConflict { expected: u64, current: u64 },
}

// ---- Document mirrors -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileDoc {
    pub id: String,
    pub display_name: String,
    pub deployment_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentProfileDoc {
    pub id: String,
    pub provider_ref: String,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub transport_profile_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_profile_ref: Option<Value>,
    pub models: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_roles: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportProfileDoc {
    pub id: String,
    pub protocol: String,
    pub auth: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub static_headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarded_semantic_headers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDocs {
    pub provider_profiles: Vec<ProviderProfileDoc>,
    pub deployment_profiles: Vec<DeploymentProfileDoc>,
    pub transport_profiles: Vec<TransportProfileDoc>,
    #[serde(default)]
    pub legacy_aliases: std::collections::BTreeMap<String, String>,
}

// ---- Validation -------------------------------------------------------------

/// Exact secret-shaped field names (mirror of the TS `SECRET_FIELD_NAMES`).
fn is_secret_field_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "apikey" | "api_key" | "secret" | "token" | "password" | "bearertoken" | "authorization"
    )
}

fn find_secret_paths(value: &Value, path: &str, out: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                find_secret_paths(item, &format!("{path}[{index}]"), out);
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                if is_secret_field_name(key) {
                    out.push(child_path.clone());
                }
                find_secret_paths(child, &child_path, out);
            }
        }
        _ => {}
    }
}

fn validate_docs(docs: &ProfileDocs) -> Result<(), ProfileStoreError> {
    let as_value = serde_json::to_value(docs)?;
    let mut secret_paths = Vec::new();
    find_secret_paths(&as_value, "", &mut secret_paths);
    if !secret_paths.is_empty() {
        return Err(ProfileStoreError::Validation(format!(
            "secret material is not allowed at: {}",
            secret_paths.join(", ")
        )));
    }
    for transport in &docs.transport_profiles {
        if let Some(headers) = &transport.static_headers {
            let violations = cognia_gateway::header_policy::validate_static_headers(
                headers.iter().map(|(k, v)| (k.as_str(), v.as_str())),
            );
            if !violations.is_empty() {
                let detail = violations
                    .iter()
                    .map(|(name, reason)| format!("{name} ({reason})"))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(ProfileStoreError::Validation(format!(
                    "transport {} carries blocked static headers: {detail}",
                    transport.id
                )));
            }
        }
    }
    for deployment in &docs.deployment_profiles {
        if deployment.id.is_empty()
            || deployment.provider_ref.is_empty()
            || deployment.endpoint.is_empty()
            || deployment.transport_profile_ref.is_empty()
        {
            return Err(ProfileStoreError::Validation(format!(
                "deployment {} is missing required fields",
                deployment.id
            )));
        }
    }
    Ok(())
}

// ---- Store trait ------------------------------------------------------------

pub trait ProviderProfileStore: Send + Sync {
    fn load_all(&self) -> Result<ProfileDocs, ProfileStoreError>;
    /// Replace the whole document set. `expected_version` enables CAS: pass
    /// the version you read; `None` skips the check (single-writer paths).
    fn replace_all(
        &self,
        docs: &ProfileDocs,
        expected_version: Option<u64>,
    ) -> Result<u64, ProfileStoreError>;
    fn profile_version(&self) -> Result<u64, ProfileStoreError>;
    /// Watch receiver that fires with the new version on every write.
    fn subscribe(&self) -> tokio::sync::watch::Receiver<u64>;
    fn export_redacted(&self) -> Result<Value, ProfileStoreError>;
    fn import(&self, payload: &Value) -> Result<u64, ProfileStoreError>;
}

// ---- SQLite implementation --------------------------------------------------

const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS provider_profile_docs (
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
    );
    CREATE TABLE IF NOT EXISTS provider_profile_meta (
        id TEXT PRIMARY KEY,
        profile_version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        migrated_at TEXT
    );
";

pub struct SqliteProfileStore {
    conn: Arc<Mutex<Connection>>,
    version_tx: tokio::sync::watch::Sender<u64>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Canonical location of the headless store beneath the server data dir.
/// Both `HeadlessServices` (via the plugin dir's parent, `<data>/.cognia`)
/// and the `cognia-server profiles` admin subcommands resolve through this
/// single helper so they can never diverge.
pub fn headless_store_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(".cognia").join("provider-profiles.sqlite")
}

impl SqliteProfileStore {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Arc<Self>, ProfileStoreError> {
        if let Some(parent) = path.as_ref().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// In-memory store — tests and `stub_for_tests`.
    pub fn in_memory() -> Result<Arc<Self>, ProfileStoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Arc<Self>, ProfileStoreError> {
        conn.execute_batch(SCHEMA_SQL)?;
        let initial = read_version(&conn)?;
        let (version_tx, _) = tokio::sync::watch::channel(initial);
        Ok(Arc::new(Self {
            conn: Arc::new(Mutex::new(conn)),
            version_tx,
        }))
    }
}

fn read_version(conn: &Connection) -> Result<u64, ProfileStoreError> {
    let version: Option<i64> = conn
        .query_row(
            "SELECT profile_version FROM provider_profile_meta WHERE id = 'singleton'",
            [],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(version.unwrap_or(0).max(0) as u64)
}

fn load_kind<T: for<'de> Deserialize<'de>>(
    conn: &Connection,
    kind: &str,
) -> Result<Vec<T>, ProfileStoreError> {
    let mut stmt =
        conn.prepare("SELECT doc FROM provider_profile_docs WHERE kind = ?1 ORDER BY id ASC")?;
    let rows = stmt.query_map(params![kind], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for raw in rows {
        out.push(serde_json::from_str(&raw?)?);
    }
    Ok(out)
}

impl ProviderProfileStore for SqliteProfileStore {
    fn load_all(&self) -> Result<ProfileDocs, ProfileStoreError> {
        let conn = self.conn.lock();
        let provider_profiles: Vec<ProviderProfileDoc> = load_kind(&conn, "provider")?;
        let deployment_profiles: Vec<DeploymentProfileDoc> = load_kind(&conn, "deployment")?;
        let transport_profiles: Vec<TransportProfileDoc> = load_kind(&conn, "transport")?;
        let mut legacy_aliases = std::collections::BTreeMap::new();
        for deployment in &deployment_profiles {
            if let Some(legacy) = &deployment.legacy_provider_id {
                legacy_aliases.insert(legacy.clone(), deployment.id.clone());
            }
        }
        Ok(ProfileDocs {
            provider_profiles,
            deployment_profiles,
            transport_profiles,
            legacy_aliases,
        })
    }

    fn replace_all(
        &self,
        docs: &ProfileDocs,
        expected_version: Option<u64>,
    ) -> Result<u64, ProfileStoreError> {
        validate_docs(docs)?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let current = read_version(&tx)?;
        if let Some(expected) = expected_version {
            if expected != current {
                return Err(ProfileStoreError::VersionConflict { expected, current });
            }
        }
        let next = current + 1;
        tx.execute("DELETE FROM provider_profile_docs", [])?;
        let now = now_ms();
        {
            let mut insert = tx.prepare(
                "INSERT INTO provider_profile_docs (id, kind, doc, updated_at) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for doc in &docs.provider_profiles {
                insert.execute(params![
                    doc.id,
                    "provider",
                    serde_json::to_string(doc)?,
                    now
                ])?;
            }
            for doc in &docs.deployment_profiles {
                insert.execute(params![
                    doc.id,
                    "deployment",
                    serde_json::to_string(doc)?,
                    now
                ])?;
            }
            for doc in &docs.transport_profiles {
                insert.execute(params![
                    doc.id,
                    "transport",
                    serde_json::to_string(doc)?,
                    now
                ])?;
            }
        }
        tx.execute(
            "INSERT INTO provider_profile_meta (id, profile_version, schema_version, migrated_at)
             VALUES ('singleton', ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
               profile_version = excluded.profile_version,
               schema_version = excluded.schema_version,
               migrated_at = excluded.migrated_at",
            params![
                next as i64,
                PROFILE_STORE_SCHEMA_VERSION,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        tx.commit()?;
        drop(conn);
        let _ = self.version_tx.send(next);
        Ok(next)
    }

    fn profile_version(&self) -> Result<u64, ProfileStoreError> {
        read_version(&self.conn.lock())
    }

    fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.version_tx.subscribe()
    }

    fn export_redacted(&self) -> Result<Value, ProfileStoreError> {
        let docs = self.load_all()?;
        let version = self.profile_version()?;
        let mut value = serde_json::to_value(&docs)?;
        if let Value::Object(map) = &mut value {
            map.insert(
                "schemaVersion".into(),
                Value::from(PROFILE_STORE_SCHEMA_VERSION),
            );
            map.insert("profileVersion".into(), Value::from(version));
        }
        Ok(value)
    }

    fn import(&self, payload: &Value) -> Result<u64, ProfileStoreError> {
        let schema_version = payload
            .get("schemaVersion")
            .and_then(Value::as_i64)
            .ok_or_else(|| ProfileStoreError::Validation("schemaVersion missing".into()))?;
        if schema_version > PROFILE_STORE_SCHEMA_VERSION {
            return Err(ProfileStoreError::Validation(format!(
                "schemaVersion {schema_version} is newer than supported {PROFILE_STORE_SCHEMA_VERSION}"
            )));
        }
        let docs: ProfileDocs = serde_json::from_value(payload.clone())?;
        self.replace_all(&docs, None)
    }
}

// ---- Gateway snapshot projection (ADR-0090 Phase 2) -------------------------

/// Well-known default endpoints for `builtin:<id>` sentinel deployments.
fn builtin_default_endpoint(protocol: &str) -> Option<&'static str> {
    match protocol {
        "anthropic" => Some("https://api.anthropic.com/v1"),
        "openai" => Some("https://api.openai.com/v1"),
        _ => None,
    }
}

/// Resolve a credential REFERENCE to its secret value for the gateway
/// snapshot (Rust memory only — same contract as the renderer's inline
/// projection). Desktop-only kinds (`legacy-provider-settings`,
/// `subscription-vault`) resolve to `None` headless; admins use
/// `secret-store` / `env` references there.
pub fn resolve_credential_ref(reference: &Value) -> Option<String> {
    use cognia_gateway::credentials::{
        CredentialResolver, CredentialSource, EnvResolver, SecretStoreResolver,
    };
    match reference.get("kind").and_then(Value::as_str)? {
        "secret-store" => {
            let id = reference.get("secretId").and_then(Value::as_str)?;
            SecretStoreResolver {
                service: "com.cognia.provider-credentials".into(),
            }
            .resolve(&CredentialSource::SecretStore { id })
            .ok()
            .map(|r| r.secret)
        }
        "env" => {
            let var = reference.get("var").and_then(Value::as_str)?;
            EnvResolver
                .resolve(&CredentialSource::Env { var })
                .ok()
                .map(|r| r.secret)
        }
        _ => None,
    }
}

/// Project the Provider Profile Store into a gateway `RoutingSnapshot` JSON
/// (authority: profile-store). Pure over its inputs — the credential
/// resolver is injected so tests never touch the secret store.
pub fn gateway_snapshot_json(
    docs: &ProfileDocs,
    profile_version: u64,
    generated_at_ms: i64,
    resolve: &dyn Fn(&Value) -> Option<String>,
) -> Value {
    let transports: std::collections::HashMap<&str, &TransportProfileDoc> = docs
        .transport_profiles
        .iter()
        .map(|t| (t.id.as_str(), t))
        .collect();

    let providers: Vec<Value> = docs
        .deployment_profiles
        .iter()
        .filter(|d| d.enabled != Some(false))
        .filter_map(|deployment| {
            let transport = transports.get(deployment.transport_profile_ref.as_str())?;
            let base_url = if let Some(rest) = deployment.endpoint.strip_prefix("builtin:") {
                let _ = rest;
                builtin_default_endpoint(&transport.protocol)?.to_string()
            } else {
                deployment.endpoint.clone()
            };
            let api_key = deployment
                .credential_profile_ref
                .as_ref()
                .and_then(|reference| resolve(reference));
            let (auth_scheme, auth_header_name) =
                match transport.auth.get("scheme").and_then(Value::as_str) {
                    Some("custom-header") => (
                        "custom-header",
                        transport.auth.get("name").and_then(Value::as_str),
                    ),
                    Some("bearer") => ("bearer", None),
                    _ => ("x-api-key", None),
                };
            let static_headers: Vec<Value> = transport
                .static_headers
                .as_ref()
                .map(|headers| {
                    headers
                        .iter()
                        .map(|(k, v)| serde_json::json!([k, v]))
                        .collect()
                })
                .unwrap_or_default();
            let models: Vec<Value> = deployment
                .models
                .iter()
                .filter_map(|m| m.get("id").cloned())
                .collect();
            Some(serde_json::json!({
                "id": deployment.id,
                "protocol": transport.protocol,
                "baseUrl": base_url,
                "apiKey": api_key,
                "enabled": true,
                "models": models,
                "deploymentId": deployment.id,
                "transport": {
                    "authScheme": auth_scheme,
                    "authHeaderName": auth_header_name,
                    "staticHeaders": static_headers,
                    "forwardedSemanticHeaders":
                        transport.forwarded_semantic_headers.clone().unwrap_or_default(),
                },
            }))
        })
        .collect();

    serde_json::json!({
        "aliases": [],
        "providers": providers,
        "generatedAtMs": generated_at_ms,
        "profileVersion": profile_version,
        "authority": "profile-store",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn docs() -> ProfileDocs {
        ProfileDocs {
            provider_profiles: vec![ProviderProfileDoc {
                id: "zhipu".into(),
                display_name: "Zhipu".into(),
                deployment_refs: vec!["glm-anthropic".into()],
            }],
            deployment_profiles: vec![DeploymentProfileDoc {
                id: "glm-anthropic".into(),
                provider_ref: "zhipu".into(),
                endpoint: "https://open.bigmodel.cn/api/anthropic".into(),
                region: None,
                transport_profile_ref: "tp-anthropic-x-api-key".into(),
                credential_profile_ref: Some(serde_json::json!({
                    "kind": "secret-store", "secretId": "sec-glm"
                })),
                models: vec![serde_json::json!({ "id": "glm-4.6" })],
                model_roles: Some(serde_json::json!({ "primary": "glm-4.6" })),
                legacy_provider_id: Some("glm-anthropic".into()),
                enabled: Some(true),
            }],
            transport_profiles: vec![TransportProfileDoc {
                id: "tp-anthropic-x-api-key".into(),
                protocol: "anthropic".into(),
                auth: serde_json::json!({ "scheme": "x-api-key" }),
                static_headers: None,
                forwarded_semantic_headers: None,
            }],
            legacy_aliases: Default::default(),
        }
    }

    #[test]
    fn replace_load_roundtrip_bumps_version_and_rebuilds_aliases() {
        let store = SqliteProfileStore::in_memory().unwrap();
        assert_eq!(store.profile_version().unwrap(), 0);

        let v1 = store.replace_all(&docs(), None).unwrap();
        assert_eq!(v1, 1);

        let loaded = store.load_all().unwrap();
        assert_eq!(loaded.provider_profiles, docs().provider_profiles);
        assert_eq!(
            loaded.legacy_aliases.get("glm-anthropic"),
            Some(&"glm-anthropic".to_string())
        );

        // Whole-set replace: dropped docs disappear.
        let mut fewer = docs();
        fewer.transport_profiles.clear();
        let v2 = store.replace_all(&fewer, None).unwrap();
        assert_eq!(v2, 2);
        assert!(store.load_all().unwrap().transport_profiles.is_empty());
    }

    #[test]
    fn cas_conflict_is_rejected() {
        let store = SqliteProfileStore::in_memory().unwrap();
        store.replace_all(&docs(), Some(0)).unwrap();
        let err = store.replace_all(&docs(), Some(0)).unwrap_err();
        match err {
            ProfileStoreError::VersionConflict { expected, current } => {
                assert_eq!(expected, 0);
                assert_eq!(current, 1);
            }
            other => panic!("expected VersionConflict, got {other}"),
        }
    }

    #[test]
    fn secret_material_and_blocked_headers_are_refused() {
        let store = SqliteProfileStore::in_memory().unwrap();

        let mut with_secret = docs();
        with_secret.deployment_profiles[0].credential_profile_ref =
            Some(serde_json::json!({ "kind": "inline", "apiKey": "sk-live" }));
        let err = store.replace_all(&with_secret, None).unwrap_err();
        assert!(matches!(err, ProfileStoreError::Validation(_)));

        // `authorization` as a static header trips the secret-material scan
        // first (same as the TS validators) — also a rejection.
        let mut with_auth_header = docs();
        with_auth_header.transport_profiles[0].static_headers = Some(
            [("authorization".to_string(), "Bearer sk".to_string())]
                .into_iter()
                .collect(),
        );
        assert!(matches!(
            store.replace_all(&with_auth_header, None).unwrap_err(),
            ProfileStoreError::Validation(_)
        ));

        // A non-secret-shaped blocked name exercises the header policy path.
        let mut with_bad_header = docs();
        with_bad_header.transport_profiles[0].static_headers = Some(
            [("x-cognia-run".to_string(), "1".to_string())]
                .into_iter()
                .collect(),
        );
        let err = store.replace_all(&with_bad_header, None).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("internal-header"), "unexpected error: {text}");
        // Nothing was written by the failed attempts.
        assert_eq!(store.profile_version().unwrap(), 0);
    }

    #[test]
    fn export_import_roundtrip_and_newer_schema_refusal() {
        let store = SqliteProfileStore::in_memory().unwrap();
        store.replace_all(&docs(), None).unwrap();
        let exported = store.export_redacted().unwrap();
        assert_eq!(exported["profileVersion"], 1);
        assert!(!exported.to_string().to_lowercase().contains("\"apikey\""));

        let second = SqliteProfileStore::in_memory().unwrap();
        let imported_version = second.import(&exported).unwrap();
        assert_eq!(imported_version, 1);
        assert_eq!(second.load_all().unwrap().provider_profiles.len(), 1);

        let mut newer = exported.clone();
        newer["schemaVersion"] = Value::from(PROFILE_STORE_SCHEMA_VERSION + 1);
        assert!(matches!(
            second.import(&newer),
            Err(ProfileStoreError::Validation(_))
        ));
    }

    #[test]
    fn subscribe_observes_version_bumps() {
        let store = SqliteProfileStore::in_memory().unwrap();
        let rx = store.subscribe();
        assert_eq!(*rx.borrow(), 0);
        store.replace_all(&docs(), None).unwrap();
        assert_eq!(*rx.borrow(), 1);
    }

    #[test]
    fn gateway_projection_maps_deployments_transports_and_versions() {
        let mut d = docs();
        d.transport_profiles[0].static_headers = Some(
            [("anthropic-beta".to_string(), "computer-use".to_string())]
                .into_iter()
                .collect(),
        );
        let resolver = |reference: &Value| -> Option<String> {
            (reference["kind"] == "secret-store").then(|| "sk-resolved-xyz".to_string())
        };
        let snapshot = gateway_snapshot_json(&d, 7, 1234, &resolver);
        assert_eq!(snapshot["authority"], "profile-store");
        assert_eq!(snapshot["profileVersion"], 7);
        let provider = &snapshot["providers"][0];
        assert_eq!(provider["id"], "glm-anthropic");
        assert_eq!(provider["deploymentId"], "glm-anthropic");
        assert_eq!(provider["protocol"], "anthropic");
        assert_eq!(provider["apiKey"], "sk-resolved-xyz");
        assert_eq!(provider["transport"]["authScheme"], "x-api-key");
        assert_eq!(
            provider["transport"]["staticHeaders"][0][0],
            "anthropic-beta"
        );
        // It deserializes into the gateway's RoutingSnapshot and validates.
        let parsed: cognia_gateway::snapshot::RoutingSnapshot =
            serde_json::from_value(snapshot).unwrap();
        parsed.validate().unwrap();
        assert!(parsed.provider_by_deployment("glm-anthropic").is_some());
    }

    #[test]
    fn gateway_projection_skips_disabled_and_unresolvable_builtin_endpoints() {
        let mut d = docs();
        d.deployment_profiles[0].enabled = Some(false);
        let none = |_: &Value| -> Option<String> { None };
        let snapshot = gateway_snapshot_json(&d, 1, 0, &none);
        assert_eq!(snapshot["providers"].as_array().unwrap().len(), 0);

        // builtin: sentinel resolves for anthropic/openai, else the row drops.
        let mut d2 = docs();
        d2.deployment_profiles[0].endpoint = "builtin:glm-anthropic".into();
        let snapshot2 = gateway_snapshot_json(&d2, 1, 0, &none);
        assert_eq!(
            snapshot2["providers"][0]["baseUrl"],
            "https://api.anthropic.com/v1"
        );
        // Credential unresolvable -> apiKey null, provider still projected.
        assert!(snapshot2["providers"][0]["apiKey"].is_null());
    }
}
