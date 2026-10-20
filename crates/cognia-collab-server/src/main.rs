//! Binary entry point for the collaboration plane.

use std::sync::Arc;

use clap::{Parser, Subcommand};
use cognia_collab_server::api::AccountControlConfig;
use cognia_collab_server::chat_attachment_store::ObjectStoreChatAttachments;
use cognia_collab_server::logto_management::{
    HttpLogtoManagement, LogtoManagementConfig, UnconfiguredLogtoManagement,
};
use cognia_collab_server::store::{PgConnectOptions, Store};
use cognia_collab_server::rollout::{FeatureKey, FeaturePolicy, validate_document};
use cognia_collab_server::{router, AppState, PgStore};
use cognia_tenant_auth::grant::GrantSigner;
use cognia_tenant_auth::oidc::{OidcAuthenticator, OidcConfig};
use tracing_subscriber::EnvFilter;

// No `Debug`: the arguments carry the M2M client secret and the grant key.
#[derive(Parser)]
#[command(name = "cognia-collab-server", about = "Cognia collaboration plane", subcommand_negates_reqs = true)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long, env = "COLLAB_BIND", default_value = "0.0.0.0:8080")]
    bind: String,
    #[arg(long, env = "COLLAB_DATABASE_URL", global = true)]
    database_url: Option<String>,
    /// Admin connection used only for migrations and application-role grants.
    #[arg(long, env = "COLLAB_MIGRATION_DATABASE_URL")]
    migration_database_url: Option<String>,
    #[arg(long, env = "COLLAB_APP_DB_ROLE")]
    app_db_role: Option<String>,
    #[arg(long, env = "COLLAB_APP_DB_PASSWORD")]
    app_db_password: Option<String>,
    #[arg(long, env = "COLLAB_ALLOW_PRIVILEGED_DB_ROLE", default_value_t = false)]
    allow_privileged_db_role: bool,
    /// Operator connection (audit-standing requires SUPERUSER or BYPASSRLS).
    #[arg(long, env = "COLLAB_OPERATOR_DATABASE_URL", global = true)]
    operator_database_url: Option<String>,
    #[arg(long, env = "COLLAB_DB_MAX_CONNECTIONS", default_value_t = 16)]
    db_max_connections: usize,
    /// Hex-encoded HMAC key for grant signing, at least 32 bytes.
    #[arg(long, env = "COLLAB_GRANT_KEY")]
    grant_key: Option<String>,
    /// The Logto issuer whose access tokens may be exchanged for a grant.
    #[arg(long, env = "COLLAB_OIDC_ISSUER")]
    oidc_issuer: Option<String>,
    /// The audience this service is registered under (RFC 8707 `resource`).
    #[arg(long, env = "COLLAB_OIDC_AUDIENCE")]
    oidc_audience: Option<String>,
    /// The claim carrying the Logto organization id.
    #[arg(
        long,
        env = "COLLAB_OIDC_TENANT_CLAIM",
        default_value = "organization_id"
    )]
    oidc_tenant_claim: String,
    /// How long a fetched JWKS is reused before rediscovery.
    #[arg(long, env = "COLLAB_JWKS_TTL_SECONDS", default_value_t = 300)]
    jwks_ttl_seconds: u64,
    #[arg(long, env = "COLLAB_OBJECT_STORE_LOCAL_DIR")]
    object_store_local_dir: Option<std::path::PathBuf>,
    #[arg(long, env = "COLLAB_S3_ENDPOINT")]
    s3_endpoint: Option<String>,
    #[arg(long, env = "COLLAB_S3_BUCKET", default_value = "cognia-collab")]
    s3_bucket: String,
    #[arg(long, env = "COLLAB_S3_REGION", default_value = "us-east-1")]
    s3_region: String,
    #[arg(long, env = "COLLAB_S3_ACCESS_KEY")]
    s3_access_key: Option<String>,
    #[arg(long, env = "COLLAB_S3_SECRET_KEY")]
    s3_secret_key: Option<String>,
    /// Rollout gate for server-authoritative shared chat routes.
    #[arg(long, env = "COLLAB_SHARED_CHAT_ENABLED", default_value_t = false)]
    shared_chat_enabled: bool,
    /// Rollout gate for server-authoritative Canvas documents.
    #[arg(long, env = "COLLAB_CANVAS_ENABLED", default_value_t = false)]
    canvas_enabled: bool,
    /// The per-organisation change feed (ADR-0206). On by default: it makes
    /// existing reads fresher and grants nothing new.
    #[arg(long, env = "COLLAB_FEED_ENABLED", default_value_t = true, action = clap::ArgAction::Set)]
    feed_enabled: bool,
    /// Rollout gate for the account control plane: membership discovery,
    /// first-owner bootstrap and generic invitation acceptance.
    #[arg(
        long,
        env = "COLLAB_ACCOUNT_BOOTSTRAP_ENABLED",
        default_value_t = false
    )]
    account_bootstrap_enabled: bool,
    /// SHA-256 (hex) of the one-time deployment bootstrap credential. Mint the
    /// credential with `openssl rand -base64 32`, hash it with
    /// `printf %s "$CRED" | sha256sum`, and hand the clear value to the first owner.
    #[arg(long, env = "COLLAB_ACCOUNT_BOOTSTRAP_CREDENTIAL_SHA256")]
    account_bootstrap_credential_sha256: Option<String>,
    /// SHA-256 (hex) of the credential a tenant Host presents on `/internal`
    /// routes — today, to ask what one person may do in one workspace before
    /// it acts on their behalf (ADR-0182 approvals). Unset means every
    /// `/internal` authorization route answers 401, which is the safe default:
    /// the Host then has no approver to verify and refuses the approval.
    ///
    /// Mint it with `openssl rand -base64 32`, hash it with
    /// `printf %s "$CRED" | sha256sum`, and hand the clear value to the Host
    /// as `COGNIA_COLLAB_SERVICE_CREDENTIAL`.
    #[arg(long, env = "COLLAB_INTERNAL_SERVICE_CREDENTIAL_SHA256")]
    internal_service_credential_sha256: Option<String>,
    /// Logto's public base URL (NOT the `/oidc` issuer), for the Management API.
    #[arg(long, env = "COLLAB_LOGTO_ENDPOINT")]
    logto_endpoint: Option<String>,
    /// Machine-to-machine application id with `all` on the management resource.
    #[arg(long, env = "COLLAB_LOGTO_M2M_CLIENT_ID")]
    logto_m2m_client_id: Option<String>,
    #[arg(long, env = "COLLAB_LOGTO_M2M_CLIENT_SECRET")]
    logto_m2m_client_secret: Option<String>,
    /// The Management API resource indicator. The OSS default is right for a
    /// self-hosted Logto.
    #[arg(
        long,
        env = "COLLAB_LOGTO_MANAGEMENT_RESOURCE",
        default_value = "https://default.logto.app/api"
    )]
    logto_management_resource: String,
    /// Logto organization role NAME assigned to the first owner.
    #[arg(long, env = "COLLAB_LOGTO_OWNER_ROLE", default_value = "owner")]
    logto_owner_role: String,
    /// Logto organization role NAME assigned to an invited member.
    #[arg(long, env = "COLLAB_LOGTO_MEMBER_ROLE", default_value = "member")]
    logto_member_role: String,
    /// Exact browser origins allowed to call this service cross-origin, comma
    /// separated (e.g. `https://cognia.example.com`). Empty means same-origin
    /// and non-browser clients only. Never a wildcard.
    #[arg(long, env = "COLLAB_ALLOWED_ORIGINS")]
    allowed_origins: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Inspect or apply deployment feature policies without running migrations.
    Rollout {
        #[command(subcommand)]
        command: RolloutCommand,
    },
    /// Report stale non-guest session standing; optionally repair in batches.
    AuditStanding {
        #[arg(long)]
        apply: bool,
        #[arg(long, default_value_t = 100)]
        batch_size: usize,
    },
}

#[derive(Subcommand)]
enum RolloutCommand {
    Show {
        #[arg(long)]
        feature: Option<FeatureKey>,
    },
    Apply {
        #[arg(long)]
        file: std::path::PathBuf,
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..i64::MAX))]
        base_revision: i64,
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        reason: String,
    },
}

fn read_rollout_policy(path: &std::path::Path) -> anyhow::Result<FeaturePolicy> {
    Ok(validate_document(&std::fs::read_to_string(path)?)?)
}

fn rollout_database_url<'a>(operator: Option<&'a str>, fallback: Option<&'a str>) -> anyhow::Result<&'a str> {
    operator.or(fallback).ok_or_else(|| anyhow::anyhow!(
        "rollout requires COLLAB_OPERATOR_DATABASE_URL or --database-url"
    ))
}

async fn run_rollout(command: &RolloutCommand, database_url: &str, max_connections: usize) -> anyhow::Result<()> {
    // Refuse malformed documents before opening a database connection.
    let document = match command {
        RolloutCommand::Apply { file, operation_id, reason, .. } => {
            anyhow::ensure!(!operation_id.trim().is_empty() && !reason.trim().is_empty(), "operation-id and reason must be non-empty");
            Some(read_rollout_policy(file)?)
        }
        RolloutCommand::Show { .. } => None,
    };
    let store = PgStore::connect_rollout(database_url, max_connections).await?;
    let output = match command {
        RolloutCommand::Show { feature: Some(key) } => serde_json::to_value(store.feature_policy(*key).await?)?,
        RolloutCommand::Show { feature: None } => serde_json::to_value(store.feature_policies().await?)?,
        RolloutCommand::Apply { base_revision, operation_id, reason, .. } => {
            let principal = store.rollout_principal().await?;
            serde_json::to_value(store.apply_feature_policy(
                document.expect("apply document was validated"), *base_revision, operation_id, reason, &principal,
            ).await?)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    // Installed once, before any TLS connector is built. `PgStore::connect`
    // builds a rustls `ClientConfig`, which needs a process-wide provider.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("a rustls crypto provider was already installed"))?;

    let args = Args::parse();
    if let Some(Command::Rollout { command }) = &args.command {
        let url = rollout_database_url(args.operator_database_url.as_deref(), args.database_url.as_deref())?;
        return run_rollout(command, url, args.db_max_connections).await;
    }
    if let Some(Command::AuditStanding { apply, batch_size }) = args.command {
        let database_url = audit_database_url(args.operator_database_url.as_deref(), args.database_url.as_deref())?;
        let store = PgStore::connect_operator(database_url, args.db_max_connections).await?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as i64;
        let report = cognia_collab_server::standing_audit::audit_standing(&store, apply, batch_size, now).await?;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    let database_url = args.database_url.as_deref().ok_or_else(|| anyhow::anyhow!("COLLAB_DATABASE_URL or --database-url is required"))?;
    let grant_key = args.grant_key.as_deref().ok_or_else(|| anyhow::anyhow!("COLLAB_GRANT_KEY is required"))?;
    let key = decode_hex(grant_key)
        .ok_or_else(|| anyhow::anyhow!("COLLAB_GRANT_KEY must be hex-encoded"))?;
    let signer = GrantSigner::new(&key)?;

    let oidc = OidcAuthenticator::new(OidcConfig {
        issuer: args.oidc_issuer.ok_or_else(|| anyhow::anyhow!("COLLAB_OIDC_ISSUER is required"))?,
        audience: args.oidc_audience.ok_or_else(|| anyhow::anyhow!("COLLAB_OIDC_AUDIENCE is required"))?,
        tenant_claim: args.oidc_tenant_claim,
        jwks_ttl: std::time::Duration::from_secs(args.jwks_ttl_seconds),
    })?;

    let store = Arc::new(PgStore::connect_with_options(database_url, args.db_max_connections, PgConnectOptions {
        migration_database_url: args.migration_database_url.as_deref(),
        app_db_role: args.app_db_role.as_deref(),
        app_db_password: args.app_db_password.as_deref(),
        allow_privileged_db_role: args.allow_privileged_db_role,
    }).await?);
    let attachment_store = if let Some(root) = args.object_store_local_dir {
        ObjectStoreChatAttachments::local(root)?
    } else if args.s3_endpoint.is_some()
        || (args.s3_access_key.is_some() && args.s3_secret_key.is_some())
    {
        ObjectStoreChatAttachments::s3(
            &args.s3_bucket,
            &args.s3_region,
            args.s3_endpoint.as_deref(),
            args.s3_access_key.as_deref(),
            args.s3_secret_key.as_deref(),
        )?
    } else {
        ObjectStoreChatAttachments::local(std::path::PathBuf::from("./data/collab-attachments"))?
    };
    let logto: Arc<dyn cognia_collab_server::logto_management::LogtoManagement> = match (
        args.logto_endpoint,
        args.logto_m2m_client_id,
        args.logto_m2m_client_secret,
    ) {
        (Some(endpoint), Some(client_id), Some(client_secret)) => {
            Arc::new(HttpLogtoManagement::new(LogtoManagementConfig {
                endpoint,
                client_id,
                client_secret,
                resource: args.logto_management_resource,
            })?)
        }
        _ => {
            if args.account_bootstrap_enabled {
                tracing::warn!(
                    "account bootstrap is enabled but COLLAB_LOGTO_ENDPOINT / \
                     COLLAB_LOGTO_M2M_CLIENT_ID / COLLAB_LOGTO_M2M_CLIENT_SECRET are not all set; \
                     bootstrap and invitation acceptance will answer 503"
                );
            }
            Arc::new(UnconfiguredLogtoManagement)
        }
    };
    let account_control = AccountControlConfig {
        enabled: args.account_bootstrap_enabled,
        bootstrap_credential_sha256: credential_hash(
            "COLLAB_ACCOUNT_BOOTSTRAP_CREDENTIAL_SHA256",
            args.account_bootstrap_credential_sha256.as_deref(),
        )?,
        owner_role_name: args.logto_owner_role,
        member_role_name: args.logto_member_role,
    };
    let state = AppState::new(store.clone(), signer, Arc::new(oidc))
        .with_canvas_store(store.clone())
        .with_notification_store(store.clone())
        .with_file_sharing_store(store.clone())
        .with_session_files_store(store.clone())
        .with_chat_store(store)
        .with_chat_attachments(Arc::new(attachment_store))
        .with_shared_chat_enabled(args.shared_chat_enabled)
        .with_canvas_enabled(args.canvas_enabled)
        .with_feed_enabled(args.feed_enabled)
        .with_logto_management(logto)
        .with_account_control(account_control)
        .with_internal_service_credential(credential_hash(
            "COLLAB_INTERNAL_SERVICE_CREDENTIAL_SHA256",
            args.internal_service_credential_sha256.as_deref(),
        )?);

    let (allowed_origins, rejected_origins) =
        cognia_collab_server::cors::parse_allowed_origins(args.allowed_origins.as_deref());
    for rejected in &rejected_origins {
        tracing::warn!(origin = %rejected, "COLLAB_ALLOWED_ORIGINS entry is not an origin; ignored");
    }
    let app = match cognia_collab_server::cors::cors_layer(&allowed_origins) {
        Some(cors) => {
            tracing::info!(
                count = allowed_origins.len(),
                "cross-origin browser access enabled"
            );
            router(state).layer(cors)
        }
        None => router(state),
    };

    let listener = tokio::net::TcpListener::bind(&args.bind).await?;
    tracing::info!(bind = %args.bind, "collaboration plane listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// Decode without pulling in `hex` for one call site.
fn decode_hex(value: &str) -> Option<Vec<u8>> {
    let value = value.trim();
    if !value.len().is_multiple_of(2) || value.is_empty() {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
        .collect()
}

/// A credential hash is compared byte for byte against a hex digest, so a
/// value that is not one can never match. Refuse it at startup rather than run
/// an endpoint that answers 403 forever — the shape this catches is the clear
/// credential pasted where its hash belongs.
fn credential_hash(variable: &str, value: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !is_sha256_hex(value) {
        anyhow::bail!("{variable} must be 64 hex characters (got {})", value.len());
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn audit_database_url<'a>(operator_url: Option<&'a str>, database_url: Option<&'a str>) -> anyhow::Result<&'a str> {
    operator_url.or(database_url).ok_or_else(|| anyhow::anyhow!(
        "audit-standing requires COLLAB_OPERATOR_DATABASE_URL or --database-url with a SUPERUSER or BYPASSRLS role"
    ))
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    #[test]
    fn rollout_args_accept_show_apply_and_reject_unknown_features() {
        use clap::Parser;
        use super::{Args, Command, RolloutCommand};
        let parse = |tail: &[&str]| Args::try_parse_from(std::iter::once("cognia-collab-server").chain(tail.iter().copied()));
        let args = parse(&["rollout", "show"]).unwrap();
        assert!(matches!(args.command, Some(Command::Rollout { command: RolloutCommand::Show { feature: None } })));
        let args = parse(&["rollout", "show", "--feature", "shared-chat", "--database-url", "postgresql://operator/db"]).unwrap();
        assert_eq!(args.database_url.as_deref(), Some("postgresql://operator/db"));
        assert!(matches!(args.command, Some(Command::Rollout { command: RolloutCommand::Show { feature: Some(super::FeatureKey::SharedChat) } })));
        assert!(parse(&["rollout", "show", "--feature", "unknown"]).is_err());
        let args = parse(&["rollout", "apply", "--file", "policy.json", "--base-revision", "0", "--operation-id", "op", "--reason", "launch"]).unwrap();
        assert!(matches!(args.command, Some(Command::Rollout { command: RolloutCommand::Apply { base_revision: 0, .. } })));
        assert!(parse(&["rollout", "apply", "--file", "policy.json"]).is_err());
        for base in ["-1", "9223372036854775807"] {
            assert!(parse(&["rollout", "apply", "--file", "p.json", "--base-revision", base, "--operation-id", "op", "--reason", "launch"]).is_err());
        }
        assert_eq!(super::rollout_database_url(Some("operator"), Some("app")).unwrap(), "operator");
        assert_eq!(super::rollout_database_url(None, Some("fallback")).unwrap(), "fallback");
        assert!(super::rollout_database_url(None, None).is_err());
    }

    #[tokio::test]
    async fn rollout_apply_validates_the_file_before_connecting() {
        let file = std::env::temp_dir().join(format!("rollout-{}.json", uuid::Uuid::new_v4()));
        let valid = serde_json::json!({
            "feature_key": "shared-chat", "schema_version": 1, "revision": 0,
            "phase": "canary", "kill": false, "allow_org_ids": [], "deny_org_ids": [],
            "deny_workspace_ids": [], "percentage_basis_points": 5000,
            "cohort_salt": "s1", "hash_version": 1, "minimum_contract_version": 1, "requires": []
        });
        std::fs::write(&file, valid.to_string()).unwrap();
        assert!(super::read_rollout_policy(&file).is_ok());
        for (key, value) in [
            ("unexpected", serde_json::json!(true)), ("schema_version", serde_json::json!(2)),
            ("cohort_salt", serde_json::json!("")), ("requires", serde_json::json!(["unknown"])),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            std::fs::write(&file, invalid.to_string()).unwrap();
            let command = super::RolloutCommand::Apply { file: file.clone(), base_revision: 0, operation_id: "op".into(), reason: "launch".into() };
            let error = super::run_rollout(&command, "invalid database URL", 1).await.unwrap_err().to_string();
            assert!(error.contains("invalid feature policy"), "{error}");
        }
        std::fs::remove_file(&file).unwrap();
    }

    use super::{credential_hash, decode_hex};

    #[test]
    fn standing_audit_prefers_operator_url_and_allows_it_without_an_app_url() {
        use clap::Parser;
        let args = super::Args::try_parse_from([
            "cognia-collab-server", "audit-standing",
            "--operator-database-url", "postgresql://operator@localhost/collab",
        ]).unwrap();
        assert_eq!(args.operator_database_url.as_deref(), Some("postgresql://operator@localhost/collab"));
        assert_eq!(super::audit_database_url(Some("operator"), Some("app")).unwrap(), "operator");
        assert_eq!(super::audit_database_url(Some("operator"), None).unwrap(), "operator");
        assert_eq!(super::audit_database_url(None, Some("admin")).unwrap(), "admin");
        assert!(super::audit_database_url(None, None).is_err());
    }

    #[test]
    fn audit_is_optional_and_does_not_require_server_credentials() {
        use clap::Parser;
        let args = super::Args::try_parse_from(["cognia-collab-server", "audit-standing", "--database-url", "postgresql://localhost/collab", "--apply", "--batch-size", "2"]).unwrap();
        assert!(matches!(args.command, Some(super::Command::AuditStanding { apply: true, batch_size: 2 })));
        let args = super::Args::try_parse_from(["cognia-collab-server", "--database-url", "postgresql://localhost/collab", "--grant-key", "00", "--oidc-issuer", "https://issuer", "--oidc-audience", "collab"]).unwrap();
        assert!(args.command.is_none());
    }

    #[test]
    fn a_credential_hash_must_be_a_sha256_digest() {
        let variable = "COLLAB_ACCOUNT_BOOTSTRAP_CREDENTIAL_SHA256";
        let hash = |value: Option<&str>| credential_hash(variable, value);
        let digest = "A".repeat(64);
        assert_eq!(
            hash(Some(&format!("  {digest}  "))).unwrap(),
            Some("a".repeat(64))
        );
        assert_eq!(hash(None).unwrap(), None);
        assert_eq!(hash(Some("   ")).unwrap(), None);
        // The clear credential pasted where its hash belongs.
        assert!(hash(Some("hunter2")).is_err());
        assert!(hash(Some(&"a".repeat(63))).is_err());
        assert!(hash(Some(&"g".repeat(64))).is_err());
        // The variable the operator has to go fix is named in the error.
        let error = hash(Some("hunter2")).unwrap_err().to_string();
        assert!(error.contains(variable), "{error}");
    }

    #[test]
    fn hex_decoding_refuses_the_shapes_a_misconfiguration_produces() {
        assert_eq!(decode_hex("00ff10"), Some(vec![0, 255, 16]));
        // An odd length is a truncated secret, not a short one.
        assert_eq!(decode_hex("abc"), None);
        assert_eq!(decode_hex(""), None);
        assert_eq!(decode_hex("zz"), None);
        assert_eq!(decode_hex("  00ff  "), Some(vec![0, 255]));
    }
}
