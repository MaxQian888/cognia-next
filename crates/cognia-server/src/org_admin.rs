//! Loopback operator fallback for org credentials and agent policy.
use clap::Subcommand;
use serde_json::{json, Value};
use std::io::Read;

#[derive(Debug, Subcommand)]
pub enum CredentialsCommand {
    List { #[arg(long)] org: String, #[arg(long)] provider: Option<String> },
    /// Read the API key from stdin. It is never accepted in argv.
    Set { #[arg(long)] org: String, #[arg(long)] provider: String },
    Delete { #[arg(long)] org: String, #[arg(long)] provider: String },
}

#[derive(Debug, Subcommand)]
pub enum AgentsCommand {
    Get { #[arg(long)] org: String },
    Set {
        #[arg(long)] org: String,
        #[arg(long, value_delimiter = ',')] allow: Vec<String>,
        #[arg(long)] default: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum OrgUsageCommand {
    Get { #[arg(long)] org: String, #[arg(long)] month: Option<String> },
    SetDefault { #[arg(long)] org: String, #[arg(long, value_parser = org_usage_default_tokens)] tokens: String },
    SetMember { #[arg(long)] org: String, #[arg(long)] user: String, #[arg(long, value_parser = org_usage_member_tokens)] tokens: String },
}
fn org_usage_default_tokens(value: &str) -> Result<String, String> { org_usage_parse_tokens(value, false).map(|_| value.into()) }
fn org_usage_member_tokens(value: &str) -> Result<String, String> { org_usage_parse_tokens(value, true).map(|_| value.into()) }
fn org_usage_parse_tokens(value: &str, allow_default: bool) -> Result<Value, String> {
    match value {
        "unlimited" => Ok(Value::Null),
        "default" if allow_default => Ok(json!("default")),
        value => value.parse::<u64>().ok().filter(|n| *n <= cognia_gateway::org_usage::MAX_MONTHLY_TOKENS)
            .map(|n| json!(n)).ok_or_else(|| "tokens must be a bounded nonnegative integer or unlimited (member also accepts default)".into()),
    }
}
pub async fn org_usage(command: OrgUsageCommand, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let (operation, args) = match command {
        OrgUsageCommand::Get { org, month } => {
            let mut args = json!({"orgId":org});
            if let Some(month) = month {
                if !cognia_gateway::org_usage::valid_month(&month) { return Err("month must be YYYY-MM".into()); }
                args["month"] = month.into();
            }
            ("get", args)
        },
        OrgUsageCommand::SetDefault { org, tokens } => ("set-default", json!({"orgId":org,"defaultMonthlyTokens":org_usage_parse_tokens(&tokens, false)?})),
        OrgUsageCommand::SetMember { org, user, tokens } => ("set-member", json!({"orgId":org,"userId":user,"monthlyTokens":org_usage_parse_tokens(&tokens, true)?})),
    };
    let body = call("org-usage", operation, args, port).await?;
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

fn read_key(reader: impl std::io::Read) -> Result<String, Box<dyn std::error::Error>> {
    let mut key = String::new();
    reader.take(64 * 1024 + 1).read_to_string(&mut key)?;
    if key.len() > 64 * 1024 || key.trim().is_empty() { return Err("stdin API key must contain 1..65536 bytes".into()); }
    Ok(key.trim_end_matches(['\r', '\n']).to_string())
}

async fn call(family: &str, operation: &str, args: Value, port: u16) -> Result<Value, Box<dyn std::error::Error>> {
    let signing_secret = cognia_companion::secret::load_or_generate()?;
    let tenant = cognia_companion::host_identity::current_tenant_or_unbound();
    let (token, _) = cognia_companion::jwt::issue_service_jwt(&signing_secret, &tenant)?;
    let client = reqwest::Client::builder().danger_accept_invalid_certs(true).no_proxy()
        .timeout(std::time::Duration::from_secs(120)).build()?;
    let response = client.post(format!("https://127.0.0.1:{port}/internal/{family}/{operation}"))
        .bearer_auth(token).header("Idempotency-Key", uuid::Uuid::new_v4().to_string()).json(&args).send().await?;
    let status = response.status();
    let body: Value = response.json().await?;
    if !status.is_success() { return Err(format!("organization administration: {status}: {body}").into()); }
    Ok(body)
}

pub async fn credentials(command: CredentialsCommand, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let (operation, args, filter) = match command {
        CredentialsCommand::List { org, provider } => ("list", json!({"orgId":org}), provider),
        CredentialsCommand::Set { org, provider } => ("set", json!({"orgId":org,"provider":provider,"apiKey":read_key(std::io::stdin().lock())?}), None),
        CredentialsCommand::Delete { org, provider } => ("delete", json!({"orgId":org,"provider":provider}), None),
    };
    let mut body = call("org-credentials", operation, args, port).await?;
    if let (Some(provider), Some(entries)) = (filter, body.as_array_mut()) { entries.retain(|entry| entry["provider"] == provider); }
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

pub async fn agents(command: AgentsCommand, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let (operation, args) = match command {
        AgentsCommand::Get { org } => ("get", json!({"orgId":org})),
        AgentsCommand::Set { org, allow, default } => ("set", json!({"orgId":org,"allowedAgents":allow,"defaultAgent":default})),
    };
    let body = call("org-agents", operation, args, port).await?;
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[test]
    fn p6b_org_usage_cli_parse_and_token_validation() {
        use crate::{Cli, CliCommand};
        let cli = Cli::try_parse_from(["cognia-server", "org-usage", "--port", "27891", "get", "--org", "org_p6b", "--month", "2026-10"]).unwrap();
        assert!(matches!(cli.command, CliCommand::OrgUsage { command: OrgUsageCommand::Get { org, month }, port: Some(27891) } if org == "org_p6b" && month.as_deref() == Some("2026-10")));
        for tokens in ["0", "100", "unlimited"] {
            assert!(Cli::try_parse_from(["cognia-server", "org-usage", "set-default", "--org", "org_p6b", "--tokens", tokens]).is_ok());
        }
        for tokens in ["0", "100", "unlimited", "default"] {
            assert!(Cli::try_parse_from(["cognia-server", "org-usage", "set-member", "--org", "org_p6b", "--user", "usr_p6b", "--tokens", tokens]).is_ok());
        }
        for tokens in ["default", "-1", "1.5", "1000000000001"] {
            assert!(Cli::try_parse_from(["cognia-server", "org-usage", "set-default", "--org", "org_p6b", "--tokens", tokens]).is_err());
        }
        assert!(Cli::try_parse_from(["cognia-server", "org-usage", "get"]).is_err());
        assert!(Cli::try_parse_from(["cognia-server", "org-usage", "set-member", "--org", "org_p6b", "--tokens", "default"]).is_err());
        assert_eq!(org_usage_parse_tokens("unlimited", false).unwrap(), Value::Null);
        assert_eq!(org_usage_parse_tokens("default", true).unwrap(), json!("default"));
    }

    #[test]
    fn p6a_org_cli_has_explicit_identity_port_and_stdin_only_keys() {
        use crate::{Cli, CliCommand};
        for argv in [vec!["cognia-server", "org-credentials", "set", "--org", "org_aaa", "--provider", "openai"],
            vec!["cognia-server", "org-credentials", "delete", "--org", "org_aaa", "--provider", "openai"],
            vec!["cognia-server", "org-credentials", "list", "--org", "org_aaa"],
            vec!["cognia-server", "org-agents", "get", "--org", "org_aaa"]] { assert!(Cli::try_parse_from(argv).is_ok()); }
        let cli = Cli::try_parse_from(["cognia-server", "org-agents", "--port", "27891", "set", "--org", "org_aaa", "--allow", "pi,codex-acp", "--default", "pi"]).unwrap();
        assert!(matches!(cli.command, CliCommand::OrgAgents { command: AgentsCommand::Set { org, allow, default }, port: Some(27891) } if org == "org_aaa" && allow == ["pi", "codex-acp"] && default.as_deref() == Some("pi")));
        assert!(Cli::try_parse_from(["cognia-server", "org-credentials", "list"]).is_err());
        assert!(Cli::try_parse_from(["cognia-server", "org-credentials", "set", "--org", "org_aaa", "--provider", "openai", "--api-key", "secret"]).is_err());
        assert_eq!(read_key("secret\n".as_bytes()).unwrap(), "secret");
        assert!(read_key(" \n".as_bytes()).is_err());
        assert!(read_key(vec![b'x'; 65537].as_slice()).is_err());
    }
}
