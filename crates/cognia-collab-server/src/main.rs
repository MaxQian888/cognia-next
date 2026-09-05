//! Binary entry point for the collaboration plane.

use std::sync::Arc;

use clap::Parser;
use cognia_collab_server::api::AccountControlConfig;
use cognia_collab_server::chat_attachment_store::ObjectStoreChatAttachments;
use cognia_collab_server::logto_management::{
    HttpLogtoManagement, LogtoManagementConfig, UnconfiguredLogtoManagement,
};
use cognia_collab_server::{router, AppState, PgStore};
use cognia_tenant_auth::grant::GrantSigner;
use cognia_tenant_auth::oidc::{OidcAuthenticator, OidcConfig};
use tracing_subscriber::EnvFilter;

// No `Debug`: the arguments carry the M2M client secret and the grant key.
#[derive(Parser)]
#[command(name = "cognia-collab-server", about = "Cognia collaboration plane")]
struct Args {
    #[arg(long, env = "COLLAB_BIND", default_value = "0.0.0.0:8080")]
    bind: String,
    #[arg(long, env = "COLLAB_DATABASE_URL")]
    database_url: String,
    #[arg(long, env = "COLLAB_DB_MAX_CONNECTIONS", default_value_t = 16)]
    db_max_connections: usize,
    /// Hex-encoded HMAC key for grant signing, at least 32 bytes.
    #[arg(long, env = "COLLAB_GRANT_KEY")]
    grant_key: String,
    /// The Logto issuer whose access tokens may be exchanged for a grant.
    #[arg(long, env = "COLLAB_OIDC_ISSUER")]
    oidc_issuer: String,
    /// The audience this service is registered under (RFC 8707 `resource`).
    #[arg(long, env = "COLLAB_OIDC_AUDIENCE")]
    oidc_audience: String,
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
    let key = decode_hex(&args.grant_key)
        .ok_or_else(|| anyhow::anyhow!("COLLAB_GRANT_KEY must be hex-encoded"))?;
    let signer = GrantSigner::new(&key)?;

    let oidc = OidcAuthenticator::new(OidcConfig {
        issuer: args.oidc_issuer,
        audience: args.oidc_audience,
        tenant_claim: args.oidc_tenant_claim,
        jwks_ttl: std::time::Duration::from_secs(args.jwks_ttl_seconds),
    })?;

    let store = Arc::new(PgStore::connect(&args.database_url, args.db_max_connections).await?);
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
        bootstrap_credential_sha256: bootstrap_credential_hash(
            args.account_bootstrap_credential_sha256.as_deref(),
        )?,
        owner_role_name: args.logto_owner_role,
        member_role_name: args.logto_member_role,
    };
    let state = AppState::new(store.clone(), signer, Arc::new(oidc))
        .with_canvas_store(store.clone())
        .with_chat_store(store)
        .with_chat_attachments(Arc::new(attachment_store))
        .with_shared_chat_enabled(args.shared_chat_enabled)
        .with_canvas_enabled(args.canvas_enabled)
        .with_logto_management(logto)
        .with_account_control(account_control);

    let listener = tokio::net::TcpListener::bind(&args.bind).await?;
    tracing::info!(bind = %args.bind, "collaboration plane listening");
    axum::serve(listener, router(state))
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

/// The credential hash is compared byte for byte against a hex digest, so a
/// value that is not one can never match. Refuse it at startup rather than
/// run a bootstrap that answers 403 forever.
fn bootstrap_credential_hash(value: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !is_sha256_hex(value) {
        anyhow::bail!(
            "COLLAB_ACCOUNT_BOOTSTRAP_CREDENTIAL_SHA256 must be 64 hex characters (got {})",
            value.len()
        );
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    use super::{bootstrap_credential_hash, decode_hex};

    #[test]
    fn the_bootstrap_credential_hash_must_be_a_sha256_digest() {
        let digest = "A".repeat(64);
        assert_eq!(
            bootstrap_credential_hash(Some(&format!("  {digest}  "))).unwrap(),
            Some("a".repeat(64))
        );
        assert_eq!(bootstrap_credential_hash(None).unwrap(), None);
        assert_eq!(bootstrap_credential_hash(Some("   ")).unwrap(), None);
        // The clear credential pasted where its hash belongs.
        assert!(bootstrap_credential_hash(Some("hunter2")).is_err());
        assert!(bootstrap_credential_hash(Some(&"a".repeat(63))).is_err());
        assert!(bootstrap_credential_hash(Some(&"g".repeat(64))).is_err());
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
