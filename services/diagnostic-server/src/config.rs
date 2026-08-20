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
    pub alert_enabled: bool,
    pub alert_interval: Duration,
    pub alert_batch_size: usize,
    pub alert_timeout: Duration,
    pub alert_webhook_url: Option<reqwest::Url>,
    pub alert_webhook_secret: Option<String>,
    pub alert_smtp_url: Option<String>,
    pub alert_smtp_from: Option<String>,
    pub alert_smtp_to: Option<String>,
    pub migrate_only: bool,
    /// Whether this process applies `sqlx::migrate!()` at startup.
    ///
    /// Exists so the serving pods can run under a database role with no DDL
    /// grant while a separate one-shot Job (or a DBA) owns schema changes.
    /// Defaults to `true`: a standalone binary with no orchestration around it
    /// still has to be able to bring its own schema up.
    pub run_migrations: bool,
    /// Whether the grant-exchange and upload surface is mounted.
    ///
    /// The processing/retention/alert switches only stop work *behind* the
    /// intake — with them off the service still accepts and stores reports.
    /// This is the switch that stops accepting new data, so a privacy incident
    /// can be contained without taking the read/admin API down with it.
    pub ingest_enabled: bool,
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
        let alert_batch_size = env_or("ALERT_BATCH_SIZE", "32")
            .parse()
            .context("parse ALERT_BATCH_SIZE")?;
        if alert_batch_size == 0 || alert_batch_size > 1_000 {
            bail!("ALERT_BATCH_SIZE must be between 1 and 1000");
        }
        let migrate_only = parse_bool(
            "DIAGNOSTIC_MIGRATE_ONLY",
            &env_or("DIAGNOSTIC_MIGRATE_ONLY", "false"),
        )?;
        let run_migrations = parse_bool(
            "DIAGNOSTIC_RUN_MIGRATIONS",
            &env_or("DIAGNOSTIC_RUN_MIGRATIONS", "true"),
        )?;
        validate_migration_switches(migrate_only, run_migrations)?;
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
            alert_enabled: parse_bool("ALERT_ENABLED", &env_or("ALERT_ENABLED", "true"))?,
            alert_interval: Duration::from_millis(
                env_or("ALERT_INTERVAL_MS", "1000")
                    .parse()
                    .context("parse ALERT_INTERVAL_MS")?,
            ),
            alert_batch_size,
            alert_timeout: Duration::from_secs(
                env_or("ALERT_TIMEOUT_SECONDS", "15")
                    .parse()
                    .context("parse ALERT_TIMEOUT_SECONDS")?,
            ),
            alert_webhook_url: optional("ALERT_WEBHOOK_URL")
                .map(|value| value.parse().context("parse ALERT_WEBHOOK_URL"))
                .transpose()?,
            alert_webhook_secret: optional("ALERT_WEBHOOK_SECRET"),
            alert_smtp_url: optional("ALERT_SMTP_URL"),
            alert_smtp_from: optional("ALERT_SMTP_FROM"),
            alert_smtp_to: optional("ALERT_SMTP_TO"),
            migrate_only,
            run_migrations,
            ingest_enabled: parse_bool(
                "DIAGNOSTIC_INGEST_ENABLED",
                &env_or("DIAGNOSTIC_INGEST_ENABLED", "true"),
            )?,
        })
    }

    /// A config with every required field filled and no live dependency.
    ///
    /// Lets the router tests assert which routes are mounted under each
    /// position of the intake switch without an environment, a database, or an
    /// object store — the switch is a routing decision, and that is all these
    /// tests exercise.
    #[cfg(test)]
    pub fn for_router_tests(ingest_enabled: bool) -> Self {
        Self {
            bind_address: "127.0.0.1:0".parse().expect("valid test bind address"),
            database_url: "postgres://diagnostics@127.0.0.1/diagnostics".to_owned(),
            database_max_connections: 1,
            object_store_endpoint: None,
            object_store_bucket: "test".to_owned(),
            object_store_region: "us-east-1".to_owned(),
            object_store_access_key: None,
            object_store_secret_key: None,
            object_store_local_dir: Some(PathBuf::from("/tmp/cognia-diagnostic-test")),
            grant_signing_key: "0".repeat(32),
            oidc_issuer: "https://issuer.test".to_owned(),
            oidc_audience: "cognia-diagnostics".to_owned(),
            oidc_public_key_pem: String::new(),
            processing_enabled: false,
            processing_interval: Duration::from_secs(1),
            processing_batch_size: 1,
            processing_temp_dir: PathBuf::from("/tmp/cognia-diagnostic-test/tmp"),
            minidump_stackwalk_path: PathBuf::from("/nonexistent/minidump-stackwalk"),
            minidump_stackwalk_timeout: Duration::from_secs(1),
            kms_endpoint: "https://kms.test/".parse().expect("valid test KMS url"),
            kms_region: "us-east-1".to_owned(),
            kms_key_id: "alias/test".to_owned(),
            kms_access_key_id: "test".to_owned(),
            kms_secret_access_key: "test".to_owned(),
            kms_session_token: None,
            kms_timeout: Duration::from_secs(1),
            retention_enabled: false,
            retention_interval: Duration::from_secs(1),
            retention_batch_size: 1,
            alert_enabled: false,
            alert_interval: Duration::from_secs(1),
            alert_batch_size: 1,
            alert_timeout: Duration::from_secs(1),
            alert_webhook_url: None,
            alert_webhook_secret: None,
            alert_smtp_url: None,
            alert_smtp_from: None,
            alert_smtp_to: None,
            migrate_only: false,
            run_migrations: false,
            ingest_enabled,
        }
    }
}

/// Reject the one combination of the two migration switches that is a lie.
///
/// A migrate-only process told not to migrate has no work to do, so it would
/// exit 0 having silently skipped the schema — the failure mode that makes a
/// deploy look green while the tables are missing.
fn validate_migration_switches(migrate_only: bool, run_migrations: bool) -> anyhow::Result<()> {
    if migrate_only && !run_migrations {
        bail!("DIAGNOSTIC_MIGRATE_ONLY requires DIAGNOSTIC_RUN_MIGRATIONS to stay enabled");
    }
    Ok(())
}

fn required(name: &str) -> anyhow::Result<String> {
    std::env::var(name).with_context(|| format!("missing required environment variable {name}"))
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
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

    #[test]
    fn a_migration_job_that_cannot_migrate_is_a_configuration_error() {
        let error = validate_migration_switches(true, false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("DIAGNOSTIC_RUN_MIGRATIONS"), "{error}");
    }

    #[test]
    fn serving_pods_may_run_without_ddl_and_a_standalone_binary_may_self_migrate() {
        // The whole point of the switch: a runtime role with no DDL grant.
        assert!(validate_migration_switches(false, false).is_ok());
        // And the migration Job, which is the one that does own DDL.
        assert!(validate_migration_switches(true, true).is_ok());
        // Plus the standalone default, where nothing else applies the schema.
        assert!(validate_migration_switches(false, true).is_ok());
    }
}
