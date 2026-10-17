//! Local operator entry point. Deliberately absent from IPC/RPC manifests.
//! The Host must be stopped: the lifecycle journal's exclusive lock remains
//! authoritative, and smoke never installs the background reconciler.
use std::{
    io::{self, BufRead, IsTerminal, Write},
    path::PathBuf,
    sync::Arc,
};

use async_trait::async_trait;
use cognia_automation::cua_sandbox::managed::{journal::JournalStore, *};

use crate::{
    managed_desktop_release::{load, OciDesktopImageVerifier},
    managed_desktops::{HostSecrets, SECRET_SERVICE},
};

const PERMIT: &str = "--authorize-paid-smoke";
const HELP: &str = "managed-desktop-operator <store-key|smoke|control-smoke|handoff-smoke|workload-smoke|authority-smoke|complete-qualification> --host-kind <headless|desktop-debug|desktop-release> --data-dir <Host journal directory> --config <provider id> [--authorize-paid-smoke] [--handoff-request <private JSON file>]\nstore-key reads a provider key from non-terminal stdin; all diagnostic and qualification commands require the explicit flag; billed operations also require typed approval of each quote. Stop the Host first and match its build profile and secret-store environment. Never use this command without the account owner's permission.";

#[derive(Debug, PartialEq, Eq)]
pub struct OperatorArgs {
    command: String,
    host_kind: String,
    data_dir: PathBuf,
    config_id: String,
    handoff_request: Option<PathBuf>,
}

pub fn parse_args(args: &[String]) -> Result<OperatorArgs> {
    let Some(command) = args
        .first()
        .filter(|s| matches!(s.as_str(), "store-key" | "smoke" | "control-smoke" | "handoff-smoke" | "workload-smoke" | "authority-smoke" | "complete-qualification"))
    else {
        return Err(refused("managed_desktop_operator_usage"));
    };
    let mut directory = None;
    let mut config = None;
    let mut host_kind = None;
    let mut handoff_request = None;
    let mut permit = false;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            PERMIT if !permit => {
                permit = true;
                index += 1;
            }
            flag @ ("--data-dir" | "--config" | "--host-kind" | "--handoff-request") => {
                let value = args
                    .get(index + 1)
                    .filter(|s| !s.is_empty() && !s.starts_with("--"))
                    .ok_or_else(|| refused("managed_desktop_operator_usage"))?;
                let slot = match flag {
                    "--data-dir" => &mut directory,
                    "--config" => &mut config,
                    "--host-kind" => &mut host_kind,
                    _ => &mut handoff_request,
                };
                if slot.replace(value.clone()).is_some() {
                    return Err(refused("managed_desktop_operator_usage"));
                }
                index += 2;
            }
            _ => return Err(refused("managed_desktop_operator_usage")),
        }
    }
    if matches!(command.as_str(), "smoke" | "control-smoke" | "handoff-smoke" | "workload-smoke" | "authority-smoke" | "complete-qualification") != permit {
        return Err(refused(
            "managed_desktop_smoke_explicit_permission_required",
        ));
    }
    if (command == "handoff-smoke") != handoff_request.is_some() {
        return Err(refused("managed_desktop_operator_usage"));
    }
    let data_dir =
        PathBuf::from(directory.ok_or_else(|| refused("managed_desktop_operator_usage"))?);
    let config_id = config.ok_or_else(|| refused("managed_desktop_operator_usage"))?;
    let host_kind = host_kind.ok_or_else(|| refused("managed_desktop_operator_usage"))?;
    if !matches!(
        host_kind.as_str(),
        "headless" | "desktop-debug" | "desktop-release"
    ) {
        return Err(refused("managed_desktop_operator_usage"));
    }
    validate_id(&config_id)?;
    if !data_dir.is_absolute() {
        return Err(refused("managed_desktop_operator_usage"));
    }
    Ok(OperatorArgs {
        command: command.clone(),
        host_kind,
        data_dir,
        config_id,
        handoff_request: handoff_request.map(PathBuf::from),
    })
}

struct OperatorHost {
    directory: PathBuf,
    host_id: String,
    release: DesktopRelease,
    provider: Arc<dyn ManagedDesktopProvider>,
}

#[async_trait]
impl ManagedDesktopSmokeHost for OperatorHost {
    fn provider(&self) -> Arc<dyn ManagedDesktopProvider> {
        self.provider.clone()
    }
    fn open(&self, provider: Arc<dyn ManagedDesktopProvider>) -> Result<ManagedDesktopService> {
        ManagedDesktopService::open(
            &self.directory,
            self.host_id.clone(),
            provider,
            Arc::new(HostSecrets),
            Some(self.release.clone()),
        )
    }
    async fn approve_quote(
        &self,
        quote: &ManagedDesktopQuote,
        purpose: AuthorizationPurpose,
    ) -> Result<()> {
        let purpose = match purpose {
            AuthorizationPurpose::PrepareTemplate => "template",
            AuthorizationPurpose::Smoke => "smoke",
            AuthorizationPurpose::Create => return Err(refused("managed_desktop_operator_usage")),
        };
        eprintln!("{purpose}: {} vCPU, {} MiB; {} {} micros/hour; {} seconds; maximum compute {} micros. Template-build charges and account subscriptions are separate.",
            quote.cpu_count, quote.memory_mb, quote.currency, quote.hourly_rate_micros,
            quote.lifetime_seconds, quote.maximum_compute_cost_micros);
        let expected = format!("approve {} {purpose}", quote.id);
        eprintln!("Type `{expected}` to authorize this operation:");
        io::stderr()
            .flush()
            .map_err(|_| refused("managed_desktop_operator_io"))?;
        let answer = tokio::task::spawn_blocking(|| bounded_line(io::stdin().lock(), 512))
            .await
            .map_err(|_| refused("managed_desktop_operator_io"))??;
        if answer != expected {
            return Err(refused("managed_desktop_operator_cancelled"));
        }
        Ok(())
    }
}

fn bounded_line<R: BufRead>(mut input: R, max: usize) -> Result<String> {
    let mut bytes = Vec::new();
    loop {
        let available = input
            .fill_buf()
            .map_err(|_| refused("managed_desktop_operator_io"))?;
        if available.is_empty() {
            break;
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1);
        if bytes.len() + count > max {
            return Err(refused("managed_desktop_operator_input_limit"));
        }
        bytes.extend_from_slice(&available[..count]);
        let done = bytes.last() == Some(&b'\n');
        input.consume(count);
        if done {
            break;
        }
    }
    String::from_utf8(bytes)
        .map(|s| s.trim_end_matches(['\r', '\n']).to_owned())
        .map_err(|_| refused("managed_desktop_operator_io"))
}

pub async fn run(args: Vec<String>) -> Result<()> {
    if args.as_slice() == ["--help"] {
        println!("{HELP}");
        return Ok(());
    }
    // Reject missing permission before accessing secrets or making a client.
    let args = parse_args(&args)?;
    let store = JournalStore::open(&args.data_dir)?;
    let mut matches = store
        .registry()?
        .providers
        .into_iter()
        .filter(|c| c.id == args.config_id);
    let config = matches
        .next()
        .ok_or_else(|| refused("managed_desktop_config_missing"))?;
    if matches.next().is_some() {
        return Err(refused("managed_desktop_config_ambiguous"));
    }
    initialize_secrets(&args)?;
    if args.command == "store-key" {
        if io::stdin().is_terminal() {
            return Err(refused("managed_desktop_key_requires_private_stdin"));
        }
        let key = bounded_line(io::stdin().lock(), 4096)?;
        if key.is_empty() || key.chars().any(char::is_whitespace) {
            return Err(refused("managed_desktop_missing_credentials"));
        }
        cognia_secrets::secret_store::set(SECRET_SERVICE, &config.secret_ref(), &key)
            .map_err(|_| refused("managed_desktop_secret_unavailable"))?;
        println!("Provider key stored in the Host secret store.");
        return Ok(());
    }
    let release =
        load(&args.data_dir)?.ok_or_else(|| refused("managed_desktop_release_missing"))?;
    let principal = ManagedDesktopPrincipal {
        owner_principal_id: config.owner_principal_id,
        principal_id: "native-smoke-operator".into(),
        host_id: config.host_id.clone(),
        authority: ManagedDesktopAuthority::Administrator,
    };
    drop(store);
    cognia_net::proxy_config::apply_from_environment()
        .map_err(|_| refused("managed_desktop_operator_proxy"))?;
    let host = OperatorHost {
        directory: args.data_dir.clone(),
        host_id: config.host_id,
        release,
        provider: Arc::new(E2bDesktopProvider::new(Arc::new(OciDesktopImageVerifier))),
    };
    let permit = ExplicitPaidSmokeAuthorization::from_operator_flag(PERMIT)?;
    let receipt = if args.command == "handoff-smoke" {
        Ok(crate::managed_desktop_handoff_operator::run(
            &host, &principal, &args.data_dir, &args.config_id,
            args.handoff_request.ok_or_else(|| refused("managed_desktop_operator_usage"))?, permit,
        ).await?)
    } else if args.command == "workload-smoke" {
        serde_json::to_value(cognia_automation::cua_sandbox::managed::service::qualification::run_workload_qualification_smoke(
            &host,&principal,&args.config_id,permit).await?)
    } else if args.command == "authority-smoke" {
        let receipt = crate::managed_desktops::authority_operator::run(
            &host,&principal,&args.data_dir,&args.config_id,permit).await?;
        let service=host.open(host.provider())?;
        service.record_authority_qualification_smoke(&principal,&args.config_id,receipt.clone(),
            ExplicitPaidSmokeAuthorization::from_operator_flag(PERMIT)?).await?;
        serde_json::to_value(receipt)
    } else if args.command == "complete-qualification" {
        let service=host.open(host.provider())?;
        serde_json::to_value(service.complete_native_qualification(&principal,&args.config_id,permit).await?)
    } else if args.command == "control-smoke" {
        serde_json::to_value(
            run_control_qualification_smoke(&host, &principal, &args.config_id, permit).await?,
        )
    } else {
        serde_json::to_value(
            run_qualification_smoke(&host, &principal, &args.config_id, permit).await?,
        )
    }
    .map_err(|_| refused("managed_desktop_invalid_response"))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&receipt)
            .map_err(|_| refused("managed_desktop_invalid_response"))?
    );
    Ok(())
}

fn initialize_secrets(args: &OperatorArgs) -> Result<()> {
    use cognia_secrets::secret_store;
    if args.host_kind == "headless" {
        return secret_store::init_headless(&args.data_dir)
            .map_err(|_| refused("managed_desktop_secret_unavailable"));
    }
    // Desktop and headless have distinct stores. Never qualify a release
    // Host with an operator that silently selected the development store.
    if (args.host_kind == "desktop-debug") != cfg!(debug_assertions) {
        return Err(refused("managed_desktop_operator_profile_mismatch"));
    }
    if secret_store::ensure_initialized() != secret_store::Readiness::Ready {
        return Err(refused("managed_desktop_secret_unavailable"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }
    #[test]
    fn smoke_requires_literal_explicit_permission_and_closed_arguments() {
        let base = args(&[
            "smoke",
            "--host-kind",
            "headless",
            "--data-dir",
            "/tmp/host",
            "--config",
            "e2b",
        ]);
        assert!(parse_args(&base).is_err());
        let mut approved = base.clone();
        approved.push(PERMIT.into());
        assert!(parse_args(&approved).is_ok());
        let mut control = base.clone();
        control[0] = "control-smoke".into();
        assert!(parse_args(&control).is_err());
        control.push(PERMIT.into());
        assert!(parse_args(&control).is_ok());
        for command in ["workload-smoke", "authority-smoke", "complete-qualification"] {
            let mut input=base.clone();input[0]=command.into();
            assert!(parse_args(&input).is_err());
            input.push(PERMIT.into());assert!(parse_args(&input).is_ok());
            input.extend(args(&["--receipt", "/tmp/untrusted.json"]));
            assert!(parse_args(&input).is_err());
        }
        for extra in ["--confirmed", "--api-key", PERMIT, "--config"] {
            let mut invalid = approved.clone();
            invalid.push(extra.into());
            assert!(parse_args(&invalid).is_err());
        }
        assert!(parse_args(&args(&[
            "store-key",
            "--host-kind",
            "headless",
            "--data-dir",
            "/tmp/host",
            "--config",
            "e2b"
        ]))
        .is_ok());
    }
    #[test]
    fn handoff_smoke_requires_private_request_and_explicit_paid_permission() {
        let base = args(&["handoff-smoke", "--host-kind", "headless", "--data-dir", "/tmp/host", "--config", "e2b"]);
        assert!(parse_args(&base).is_err());
        let mut input = base;
        input.extend(args(&["--handoff-request", "/tmp/request.json"]));
        assert!(parse_args(&input).is_err());
        input.push(PERMIT.into());
        assert!(parse_args(&input).is_ok());
        input[0] = "smoke".into();
        assert!(parse_args(&input).is_err());
    }
    #[test]
    fn operator_input_is_bounded_and_does_not_consume_the_next_approval() {
        let mut input = io::Cursor::new(b"first\nsecond\n");
        assert_eq!(bounded_line(&mut input, 10).unwrap(), "first");
        assert_eq!(bounded_line(&mut input, 10).unwrap(), "second");
        assert!(bounded_line(io::Cursor::new(b"long input"), 3).is_err());
    }
}
