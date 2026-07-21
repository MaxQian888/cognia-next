//! cognia — author-facing CLI for cognia plugins.
//!
//! Subcommands:
//!
//!   cognia plugin new [name] [--dir DIR] [--kind wasm|ts|python|hybrid|vscode-extension]
//!     [--author NAME] [--author-email EMAIL] [--description TEXT]
//!     [--with-keygen true|false] [--json]
//!     Stamp a starter project (Rust WASM by default; TypeScript, Python, hybrid, and
//!     VS Code-extension scaffolds also available).
//!
//!   cognia plugin lint [--path .] [--json]
//!     Validate plugin.json against the host's manifest schema. Run by
//!     `build` implicitly; standalone for editor integration.
//!
//!   cognia plugin build [--path .] [--out target.zip] [--skip-build] [--json]
//!     Validate, then run the type-appropriate build/pack path: cargo-component
//!     for wasm, esbuild for frontend, existing-entry bundle packing for
//!     python / hybrid / vscode-extension.
//!
//!   cognia plugin info <bundle.zip|directory> [--detailed] [--json]
//!     Inspect a bundle or unpacked plugin directory: manifest, files, signature, api-version.
//!
//!   cognia plugin sign <bundle> --key <path> [--out sig] [--json]
//!     Ed25519-sign the bundle bytes; writes `<bundle>.sig` unless `--out` is provided.
//!
//!   cognia plugin verify <bundle> [--public-key <b64>] [--signature <path>] [--json]
//!     Verify a `.sig` against the manifest's `author.publicKey` (or override).
//!
//!   cognia plugin keygen [--out-dir .cognia] [--json]
//!     Generate a fresh Ed25519 keypair into `./.cognia/` or a custom directory.
//!
//!   cognia plugin install <bundle.zip|directory> [--json]
//!     Install a bundle or unpacked plugin directory into a running cognia desktop.
//!
//!   cognia plugin uninstall <plugin-id> [--purge-data] [--json]
//!     Uninstall a plugin from a running cognia desktop.
//!
//!   cognia plugin list [--json]
//!     List plugins currently known to a running cognia desktop.
//!
//!   cognia plugin reload [--plugin-id <id>] [--bundle|--path <bundle.zip|directory>] [--json]
//!     Ask the running cognia desktop to hot-reload a plugin.
//!
//!   cognia plugin status [--json]
//!     Probe whether the running cognia desktop bridge is reachable.
//!
//!   cognia plugin dev [--path .] [--reload-url URL] [--once] [--json]
//!     Watch the crate, rebuild on save, and ping a running cognia. `--json`
//!     is accepted only with `--once`.
//!
//!   cognia plugin embed-version <wasm> <ver> [--out wasm] [--json]
//!     Manually inject the api-version custom section (normally automatic).
//!
//!   cognia release-key [--json]
//!     Inspect the embedded public key used for CLI release-artifact verification.
//!
//!   cognia release-verify <artifact> --checksums <checksums.txt> [--artifact-name NAME] [--signature PATH] [--json]
//!     Offline-verify a CLI release artifact against checksums.txt and, once
//!     provisioned, the embedded Ed25519 release key.
//!
//! Global flags (apply to every subcommand):
//!
//!   --color [auto|always|never]   Color mode (default: auto).
//!   --no-color                    Shortcut for `--color=never`.
//!   --quiet, -q                   Suppress non-error output.
//!   --verbose, -v                 Increase log verbosity (repeatable, max -vv).
//!   --yes, -y                     Pre-confirm any prompt; required for CI.
//!
//! Per-command flags marked `--json` switch the human report to a
//! machine-readable JSON payload. `plugin dev --json` requires `--once` so
//! stdout stays a single report; top-level `acp` remains a raw protocol bridge.

use anyhow::Result;
use clap::Parser;

mod cli;
mod commands;
mod engine;
mod shared;
mod ui;

use cli::{dispatch_plugin, Cli, TopCommand};
use shared::exit::{JSON_FAILURE_EXIT_CODE, LINT_ERROR_EXIT_CODE};
use shared::JsonFailureExit;
use ui::runtime::{ColorMode, UiFlags};
use ui::RuntimeUi;

fn main() -> eyre::Result<()> {
    let cli = Cli::parse();

    // Resolve the color mode + install color-eyre BEFORE building any
    // RuntimeUi so its formatter respects the user's choice.
    let color_mode = if cli.no_color {
        ColorMode::Never
    } else {
        ColorMode::parse(&cli.color).map_err(|e| eyre::eyre!(e))?
    };
    let flags = UiFlags {
        color: color_mode,
        quiet: cli.quiet,
        verbose: cli.verbose,
        yes: cli.yes,
        json: false, // set per-command from the subcommand's own --json flag
    };
    let mut ui = RuntimeUi::new(flags);
    ui.apply_color_override();
    ui::error::install()?;

    // Run the command, converting anyhow's chain into an eyre::Report so
    // color-eyre's formatter renders it with severity colors + cause chain
    // + (with RUST_BACKTRACE=1) backtrace.
    let result: Result<()> = match cli.command {
        TopCommand::Plugin { command } => dispatch_plugin(command, &mut ui),
        TopCommand::Acp => {
            ui.verbose("running acp");
            commands::acp::run(&ui)
        }
        TopCommand::ReleaseKey { json } => {
            ui.flags.json = json;
            ui.verbose(format!("running release-key json={json}"));
            commands::release_key::run(json, &mut ui)
        }
        TopCommand::ReleaseVerify {
            artifact,
            checksums,
            artifact_name,
            signature,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running release-verify artifact={} checksums={} artifact_name={} signature={} json={}",
                artifact.display(),
                checksums.display(),
                artifact_name.as_deref().unwrap_or("<auto>"),
                signature
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<auto>".to_string()),
                json
            ));
            commands::release_verify::run(
                artifact,
                checksums,
                artifact_name,
                signature,
                json,
                &mut ui,
            )
        }
    };
    if let Err(err) = result {
        if err.is::<commands::lint::LintError>() {
            std::process::exit(LINT_ERROR_EXIT_CODE);
        }
        if err.is::<JsonFailureExit>() {
            std::process::exit(JSON_FAILURE_EXIT_CODE);
        }
        return Err(anyhow_to_eyre(err));
    }
    Ok(())
}

/// Convert an `anyhow::Error` chain into an `eyre::Report` so the
/// color-eyre formatter installed in `main()` can render it with severity
/// colors and the full cause chain.
fn anyhow_to_eyre(err: anyhow::Error) -> eyre::Report {
    let causes: Vec<String> = err.chain().map(|c| c.to_string()).collect();
    let mut iter = causes.into_iter().rev();
    let innermost = iter.next().unwrap_or_else(|| "unknown error".to_string());
    let mut report = eyre::eyre!("{innermost}");
    for outer in iter {
        report = report.wrap_err(outer);
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anyhow_to_eyre_preserves_chain() {
        let inner = anyhow::anyhow!("primary failure");
        let wrapped = inner.context("during read").context("during init");
        let report = anyhow_to_eyre(wrapped);
        let dbg = format!("{report:?}");
        assert!(dbg.contains("primary failure"), "missing inner: {dbg}");
        assert!(dbg.contains("during read"), "missing mid-cause: {dbg}");
        assert!(dbg.contains("during init"), "missing outer: {dbg}");
    }

    #[test]
    fn anyhow_to_eyre_handles_bare_error() {
        let bare = anyhow::anyhow!("just one");
        let report = anyhow_to_eyre(bare);
        assert!(format!("{report}").contains("just one"));
    }
}
