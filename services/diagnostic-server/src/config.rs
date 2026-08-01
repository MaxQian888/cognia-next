use std::{net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{bail, Context};

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind_address: SocketAddr,
    pub database_url: String,
    pub database_max_connections: u32,
    pub object_store_endpoint: Option<String>,
    pub object_store_bucket: String,
    pub object_store_region: String,
    pub object_store_access_key: Option<String>,
    pub object_store_secret_key: Option<String>,
    pub object_store_local_dir: Option<PathBuf>,
    pub grant_signing_key: String,
    pub oidc_issuer: String,
    pub oidc_audience: String,
    pub oidc_public_key_pem: String,
    pub processing_enabled: bool,
    pub processing_interval: Duration,
    pub processing_batch_size: usize,
    pub processing_temp_dir: PathBuf,
    pub minidump_stackwalk_path: PathBuf,
    pub minidump_stackwalk_timeout: Duration,
    pub kms_endpoint: reqwest::Url,
    pub kms_region: String,
    pub kms_key_id: String,
    pub kms_access_key_id: String,
    pub kms_secret_access_key: String,
    pub kms_session_token: Option<String>,
    pub kms_timeout: Duration,
    pub retention_enabled: bool,
    pub retention_interval: Duration,
    pub retention_batch_size: usize,
    pub migrate_only: bool,
}

impl ServerConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind_address = env_or("DIAGNOSTIC_BIND", "0.0.0.0:8080")
            .parse()
            .context("parse DIAGNOSTIC_BIND")?;
        let database_url = required("DATABASE_URL")?;
        let database_max_connections = env_or("DATABASE_MAX_CONNECTIONS", "20")
            .parse()
            .context("parse DATABASE_MAX_CONNECTIONS")?;
        let object_store_local_dir = std::env::var_os("OBJECT_STORE_LOCAL_DIR").map(PathBuf::from);
        let object_store_endpoint = std::env::var("S3_ENDPOINT").ok();
        if object_store_local_dir.is_none() && object_store_endpoint.is_none() {
            bail!("configure OBJECT_STORE_LOCAL_DIR or S3_ENDPOINT");
        }
        let grant_signing_key = required("GRANT_SIGNING_KEY")?;
        if grant_signing_key.len() < 32 {
            bail!("GRANT_SIGNING_KEY must contain at least 32 bytes");
        }
        let processing_batch_size = env_or("PROCESSING_BATCH_SIZE", "32")
            .parse()
            .context("parse PROCESSING_BATCH_SIZE")?;
        if processing_batch_size == 0 || processing_batch_size > 1_000 {
            bail!("PROCESSING_BATCH_SIZE must be between 1 and 1000");
        }
        let retention_batch_size = env_or("RETENTION_BATCH_SIZE", "32")
            .parse()
            .context("parse RETENTION_BATCH_SIZE")?;
        if retention_batch_size == 0 || retention_batch_size > 1_000 {
            bail!("RETENTION_BATCH_SIZE must be between 1 and 1000");
        }
        let kms_region = env_or("KMS_REGION", "us-east-1");
        let kms_endpoint = env_or(
            "KMS_ENDPOINT",
            &format!("https://kms.{kms_region}.amazonaws.com/"),
        )
        .parse()
        .context("parse KMS_ENDPOINT")?;
        Ok(Self {
            bind_address,
            database_url,
            database_max_connections,
            object_store_endpoint,
            object_store_bucket: env_or("S3_BUCKET", "cognia-diagnostics"),
            object_store_region: env_or("S3_REGION", "us-east-1"),
            object_store_access_key: std::env::var("S3_ACCESS_KEY").ok(),
            object_store_secret_key: std::env::var("S3_SECRET_KEY").ok(),
            object_store_local_dir,
            grant_signing_key,
            oidc_issuer: required("OIDC_ISSUER")?,
            oidc_audience: required("OIDC_AUDIENCE")?,
            oidc_public_key_pem: required("OIDC_PUBLIC_KEY_PEM")?.replace("\\n", "\n"),
            processing_enabled: parse_bool(
                "PROCESSING_ENABLED",
                &env_or("PROCESSING_ENABLED", "true"),
            )?,
            processing_interval: Duration::from_millis(
                env_or("PROCESSING_INTERVAL_MS", "1000")
                    .parse()
                    .context("parse PROCESSING_INTERVAL_MS")?,
            ),
            processing_batch_size,
            processing_temp_dir: std::env::var_os("PROCESSING_TEMP_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::temp_dir().join("cognia-diagnostic-processing")),
            minidump_stackwalk_path: PathBuf::from(env_or(
                "MINIDUMP_STACKWALK_PATH",
                "/usr/local/bin/minidump-stackwalk",
            )),
            minidump_stackwalk_timeout: Duration::from_secs(
                env_or("MINIDUMP_STACKWALK_TIMEOUT_SECONDS", "120")
                    .parse()
                    .context("parse MINIDUMP_STACKWALK_TIMEOUT_SECONDS")?,
            ),
            kms_endpoint,
            kms_region,
            kms_key_id: required("KMS_KEY_ID")?,
            kms_access_key_id: required("KMS_ACCESS_KEY_ID")?,
            kms_secret_access_key: required("KMS_SECRET_ACCESS_KEY")?,
            kms_session_token: std::env::var("KMS_SESSION_TOKEN").ok(),
            kms_timeout: Duration::from_secs(
                env_or("KMS_TIMEOUT_SECONDS", "15")
                    .parse()
                    .context("parse KMS_TIMEOUT_SECONDS")?,
            ),
            retention_enabled: parse_bool(
                "RETENTION_ENABLED",
                &env_or("RETENTION_ENABLED", "true"),
            )?,
            retention_interval: Duration::from_millis(
                env_or("RETENTION_INTERVAL_MS", "5000")
                    .parse()
                    .context("parse RETENTION_INTERVAL_MS")?,
            ),
            retention_batch_size,
            migrate_only: parse_bool(
                "DIAGNOSTIC_MIGRATE_ONLY",
                &env_or("DIAGNOSTIC_MIGRATE_ONLY", "false"),
            )?,
        })
    }
}

fn required(name: &str) -> anyhow::Result<String> {
    std::env::var(name).with_context(|| format!("missing required environment variable {name}"))
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn parse_bool(name: &str, value: &str) -> anyhow::Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("{name} must be a boolean"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_explicit_boolean_forms_and_rejects_ambiguous_values() {
        assert!(parse_bool("FLAG", "yes").unwrap());
        assert!(!parse_bool("FLAG", "OFF").unwrap());
        assert!(parse_bool("FLAG", "sometimes").is_err());
    }
}
