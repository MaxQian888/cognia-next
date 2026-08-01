use std::{net::SocketAddr, path::PathBuf};

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
        })
    }
}

fn required(name: &str) -> anyhow::Result<String> {
    std::env::var(name).with_context(|| format!("missing required environment variable {name}"))
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}
