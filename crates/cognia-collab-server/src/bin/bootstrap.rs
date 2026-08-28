//! Operator-only, idempotent collaboration-plane bootstrap.

use clap::Parser;
use cognia_collab_server::{OperatorBootstrap, PgStore};
use cognia_tenant_auth::UserId;

#[derive(Debug, Parser)]
#[command(
    name = "cognia-collab-bootstrap",
    about = "Seed one collaboration org, owner identity, and workspace"
)]
struct Args {
    /// Admin connection. Distinct from the server's `COLLAB_DATABASE_URL`
    /// because the seed needs a role that bypasses row-level security, which
    /// the least-privilege request role deliberately does not have.
    #[arg(long, env = "COLLAB_BOOTSTRAP_DATABASE_URL")]
    database_url: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_ORG_ID")]
    org_id: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_ORG_NAME")]
    org_name: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_LOGTO_ORG_ID")]
    logto_organization_id: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_USER_ID")]
    user_id: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_USER_NAME")]
    user_name: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_USER_EMAIL")]
    user_email: Option<String>,
    #[arg(long, env = "COLLAB_BOOTSTRAP_IDENTITY_ID")]
    identity_id: String,
    #[arg(
        long,
        env = "COLLAB_BOOTSTRAP_IDENTITY_PROVIDER",
        default_value = "logto"
    )]
    identity_provider: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_IDENTITY_SUBJECT")]
    identity_subject: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_WORKSPACE_ID")]
    workspace_id: String,
    #[arg(long, env = "COLLAB_BOOTSTRAP_WORKSPACE_NAME")]
    workspace_name: String,
}

fn validate(args: &Args) -> anyhow::Result<()> {
    if !args.org_id.starts_with("org_") || args.org_id.len() < 8 {
        anyhow::bail!("--org-id must use the org_ namespace")
    }
    if !UserId::is_valid(&args.user_id) {
        anyhow::bail!("--user-id must be a valid usr_ id")
    }
    for (name, value) in [
        ("org-name", args.org_name.as_str()),
        ("logto-organization-id", args.logto_organization_id.as_str()),
        ("identity-id", args.identity_id.as_str()),
        ("identity-provider", args.identity_provider.as_str()),
        ("identity-subject", args.identity_subject.as_str()),
        ("workspace-id", args.workspace_id.as_str()),
        ("workspace-name", args.workspace_name.as_str()),
    ] {
        if value.trim().is_empty() {
            anyhow::bail!("--{name} must not be blank")
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("a rustls crypto provider was already installed"))?;
    let args = Args::parse();
    validate(&args)?;
    let store = PgStore::connect(&args.database_url, 2).await?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;
    store
        .bootstrap_operator(&OperatorBootstrap {
            org_id: args.org_id,
            org_name: args.org_name,
            logto_organization_id: args.logto_organization_id,
            user_id: args.user_id,
            user_name: args.user_name,
            user_email: args.user_email,
            identity_id: args.identity_id,
            identity_provider: args.identity_provider,
            identity_subject: args.identity_subject,
            workspace_id: args.workspace_id,
            workspace_name: args.workspace_name,
            now,
        })
        .await?;
    println!("collaboration bootstrap applied");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> Args {
        Args {
            database_url: "postgres://localhost/cognia".into(),
            org_id: "org_01234567".into(),
            org_name: "Acme".into(),
            logto_organization_id: "logto-acme".into(),
            user_id: "usr_0123456789abcdef01234567".into(),
            user_name: "Operator".into(),
            user_email: None,
            identity_id: "identity-logto-operator".into(),
            identity_provider: "logto".into(),
            identity_subject: "operator-subject".into(),
            workspace_id: "workspace-main".into(),
            workspace_name: "Main".into(),
        }
    }

    #[test]
    fn validates_stable_namespaced_ids() {
        assert!(validate(&args()).is_ok());
        let mut invalid = args();
        invalid.user_id = "local-user".into();
        assert!(validate(&invalid).is_err());
    }

    #[test]
    fn refuses_blank_identity_fields() {
        let mut invalid = args();
        invalid.identity_subject = "  ".into();
        assert!(validate(&invalid).is_err());
    }
}
