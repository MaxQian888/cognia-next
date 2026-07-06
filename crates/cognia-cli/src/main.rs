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

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use clap::{Parser, Subcommand};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

mod build_ts;
mod cmd_acp;
mod cmd_build;
mod cmd_dev;
mod cmd_info;
mod cmd_install;
mod cmd_keygen;
mod cmd_lint;
mod cmd_list;
mod cmd_new;
mod cmd_release_key;
mod cmd_release_verify;
mod cmd_reload;
mod cmd_sign;
mod cmd_status;
mod cmd_uninstall;
mod cmd_verify;
mod http_client;
mod packaging;
// Source of truth for the release-signing public key. Mirrored into
// src-tauri + the renderer by scripts/release-sync-keys.mjs.
mod release_key;
mod signing;
mod template;
mod ui;

use ui::runtime::{ColorMode, UiFlags};
use ui::RuntimeUi;

const LINT_ERROR_EXIT_CODE: i32 = 1;
const JSON_FAILURE_EXIT_CODE: i32 = 1;

#[derive(Debug)]
pub(crate) struct JsonFailureExit;

impl fmt::Display for JsonFailureExit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON failure payload emitted")
    }
}

impl std::error::Error for JsonFailureExit {}

#[derive(Parser, Debug)]
#[command(name = "cognia", version, about, long_about = None)]
struct Cli {
    /// Color mode for stdout/stderr (default: auto — on when a TTY,
    /// off otherwise; respects NO_COLOR and FORCE_COLOR env vars).
    #[arg(long, value_name = "MODE", default_value = "auto", global = true)]
    color: String,
    /// Shortcut for `--color=never`. Higher priority than `--color`.
    #[arg(long, global = true)]
    no_color: bool,
    /// Suppress non-error output (no spinners, no progress, no info chatter).
    #[arg(long, short = 'q', global = true)]
    quiet: bool,
    /// Increase log verbosity (repeatable, e.g. `-vv` for debug-level).
    #[arg(long, short = 'v', global = true, action = clap::ArgAction::Count)]
    verbose: u8,
    /// Pre-confirm every interactive prompt (`uninstall --purge-data`,
    /// overwrite prompts, etc.). Required for CI usage.
    #[arg(long, short = 'y', global = true)]
    yes: bool,

    #[command(subcommand)]
    command: TopCommand,
}

#[derive(Subcommand, Debug)]
enum TopCommand {
    /// Plugin-author subcommands.
    Plugin {
        #[command(subcommand)]
        command: PluginCommand,
    },
    /// Bridge stdio to the cognia ACP server so ACP clients (Zed, Neovim,
    /// JetBrains) can drive cognia. Configure your editor with
    /// `{"command": "cognia", "args": ["acp"]}`.
    Acp,
    /// Inspect the embedded public key used to verify downloaded cognia CLI releases.
    ReleaseKey {
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Offline-verify a downloaded cognia CLI release artifact.
    ReleaseVerify {
        /// Release artifact to verify, for example `cognia-x86_64-pc-windows-msvc.tar.gz`.
        artifact: PathBuf,
        /// Path to the release `checksums.txt` file in sha256sum format.
        #[arg(long)]
        checksums: PathBuf,
        /// Override the artifact filename to match inside `checksums.txt`.
        #[arg(long)]
        artifact_name: Option<String>,
        /// Detached Ed25519 signature file. Defaults to `<artifact>.sig`; required after
        /// the release key is provisioned.
        #[arg(long)]
        signature: Option<PathBuf>,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum PluginCommand {
    /// Scaffold a new plugin from a bundled template.
    New {
        /// Name of the plugin (becomes the crate/package name and plugin.json id).
        /// Optional: when omitted on a TTY, an interactive wizard collects it.
        name: Option<String>,
        /// Directory to create. Defaults to ./<name>.
        #[arg(long)]
        dir: Option<PathBuf>,
        /// Template kind: `wasm` (default), `ts` (frontend TypeScript), `python`, `hybrid`,
        /// or `vscode-extension` (`vscode` alias accepted).
        #[arg(long)]
        kind: Option<String>,
        /// Author display name (recorded in plugin.json `author.name`).
        #[arg(long)]
        author: Option<String>,
        /// Author email (recorded in plugin.json `author.email`).
        #[arg(long)]
        author_email: Option<String>,
        /// Plugin description (recorded in plugin.json `description`).
        #[arg(long)]
        description: Option<String>,
        /// Run `keygen` and embed the public key in plugin.json (yes/no).
        /// When omitted on a TTY, the wizard asks; non-TTY defaults to false.
        #[arg(long)]
        with_keygen: Option<bool>,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Validate plugin.json against the host's manifest schema.
    Lint {
        /// Path to the plugin crate. Defaults to the current directory.
        #[arg(long, default_value = ".")]
        path: PathBuf,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Build or package the plugin into a `.zip` bundle.
    Build {
        /// Path to the plugin crate. Defaults to the current directory.
        #[arg(long, default_value = ".")]
        path: PathBuf,
        /// Output bundle path. Defaults to `target/cognia/<id>-<version>.zip`.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Skip the compiler/bundler step where the runtime has one.
        #[arg(long)]
        skip_build: bool,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Inspect a built bundle or unpacked plugin directory.
    Info {
        /// Built `.zip` bundle, or a plugin directory containing `plugin.json`.
        #[arg(value_name = "PATH")]
        path: PathBuf,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
        /// Show every detail (full file list, signature breakdown).
        #[arg(long)]
        detailed: bool,
    },
    /// Sign a bundle with an Ed25519 private key, producing `<bundle>.sig`.
    Sign {
        bundle: PathBuf,
        /// Path to the private key file (32 raw bytes, base64-encoded one
        /// line). Use `cognia plugin keygen` to generate one.
        #[arg(long)]
        key: PathBuf,
        /// Output signature path. Defaults to `<bundle>.sig`.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Verify a bundle's `<bundle>.sig` against the public key embedded in
    /// the bundle's `plugin.json` (`author.publicKey`).
    Verify {
        bundle: PathBuf,
        /// Override the public key (base64). Defaults to reading from the
        /// bundle's `plugin.json` `author.publicKey`.
        #[arg(long)]
        public_key: Option<String>,
        /// Optional explicit `.sig` path. Defaults to `<bundle>.sig`.
        #[arg(long)]
        signature: Option<PathBuf>,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Generate a fresh Ed25519 keypair. Saves the private key to `.cognia/`
    /// and prints the public key (base64) for embedding in `plugin.json`.
    Keygen {
        /// Output directory for the keypair files. Defaults to `./.cognia`.
        #[arg(long, default_value = ".cognia")]
        out_dir: PathBuf,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Install a bundle or unpacked plugin directory into a running cognia desktop instance.
    Install {
        /// Built `.zip` bundle, or a plugin directory containing `plugin.json`.
        #[arg(value_name = "PATH")]
        path: PathBuf,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Uninstall a plugin from a running cognia desktop instance.
    Uninstall {
        /// Plugin id to remove.
        plugin_id: String,
        /// Also delete the plugin's stored data (Dexie tables, secrets, etc.).
        #[arg(long)]
        purge_data: bool,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// List plugins currently installed in a running cognia desktop instance.
    List {
        /// Emit a machine-readable JSON report instead of a human table.
        #[arg(long)]
        json: bool,
    },
    /// Ask a running cognia desktop instance to hot-reload a plugin.
    Reload {
        /// Built `.zip` bundle, or a plugin directory to install and reload in place.
        #[arg(long, visible_alias = "path", value_name = "PATH")]
        bundle: Option<PathBuf>,
        /// Existing plugin id to reload from its current install path.
        #[arg(long)]
        plugin_id: Option<String>,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Probe whether the running cognia desktop bridge is reachable.
    Status {
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
    /// Watch the plugin crate for changes, rebuild on save, and (when
    /// a running cognia is discoverable) ping it to hot-reload in place.
    Dev {
        #[arg(long, default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        reload_url: Option<String>,
        /// Build once, optionally hot-reload, then exit instead of watching.
        #[arg(long)]
        once: bool,
        /// Emit a machine-readable JSON report for `--once`.
        #[arg(long)]
        json: bool,
    },
    /// Embed the contract version as a `cognia:api-version` custom section
    /// in a built `.wasm`. Normally run automatically by `cognia plugin build`.
    EmbedVersion {
        /// `.wasm` file to patch.
        wasm: PathBuf,
        /// API version string (e.g. `0.1.0`).
        version: String,
        /// Output path. Defaults to overwriting `wasm` in place.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Emit a machine-readable JSON report instead of human prose.
        #[arg(long)]
        json: bool,
    },
}

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
            cmd_acp::run(&ui)
        }
        TopCommand::ReleaseKey { json } => {
            ui.flags.json = json;
            ui.verbose(format!("running release-key json={json}"));
            cmd_release_key::run(json, &mut ui)
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
            cmd_release_verify::run(artifact, checksums, artifact_name, signature, json, &mut ui)
        }
    };
    if let Err(err) = result {
        if err.is::<cmd_lint::LintError>() {
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

fn dispatch_plugin(command: PluginCommand, ui: &mut RuntimeUi) -> Result<()> {
    match command {
        PluginCommand::New {
            name,
            dir,
            kind,
            author,
            author_email,
            description,
            with_keygen,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin new name={} dir={} kind={} author={} author_email={} with_keygen={} json={}",
                name.as_deref().unwrap_or("<prompt>"),
                dir.as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<default>".to_string()),
                kind.as_deref().unwrap_or("<default>"),
                author.as_deref().unwrap_or("<prompt-or-default>"),
                author_email.as_deref().unwrap_or("<none>"),
                with_keygen
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "<prompt-or-default>".to_string()),
                json
            ));
            cmd_new::run(
                name,
                dir,
                kind,
                author,
                author_email,
                description,
                with_keygen,
                ui,
            )
        }
        PluginCommand::Lint { path, json } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin lint path={} json={json}",
                path.display()
            ));
            cmd_lint::run(path, json, ui)
        }
        PluginCommand::Build {
            path,
            out,
            skip_build,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin build path={} out={} skip_build={} json={}",
                path.display(),
                out.as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<default>".to_string()),
                skip_build,
                json
            ));
            cmd_build::run(path, out, skip_build, ui)
        }
        PluginCommand::Info {
            path,
            json,
            detailed,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin info path={} detailed={} json={}",
                path.display(),
                detailed,
                json
            ));
            cmd_info::run(path, json, detailed, ui)
        }
        PluginCommand::Sign {
            bundle,
            key,
            out,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin sign bundle={} key={} out={} json={}",
                bundle.display(),
                key.display(),
                out.as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<default>".to_string()),
                json
            ));
            cmd_sign::run(bundle, key, out, ui)
        }
        PluginCommand::Verify {
            bundle,
            public_key,
            signature,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin verify bundle={} public_key={} signature={} json={}",
                bundle.display(),
                public_key.as_deref().unwrap_or("<manifest>"),
                signature
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<default>".to_string()),
                json
            ));
            cmd_verify::run(bundle, public_key, signature, json, ui)
        }
        PluginCommand::Keygen { out_dir, json } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin keygen out_dir={} json={json}",
                out_dir.display()
            ));
            cmd_keygen::run(out_dir, ui)
        }
        PluginCommand::Install { path, json } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin install path={} json={json}",
                path.display()
            ));
            cmd_install::run(path, ui)
        }
        PluginCommand::Uninstall {
            plugin_id,
            purge_data,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin uninstall plugin_id={} purge_data={} json={}",
                plugin_id, purge_data, json
            ));
            cmd_uninstall::run(plugin_id, purge_data, ui)
        }
        PluginCommand::List { json } => {
            ui.flags.json = json;
            ui.verbose(format!("running plugin list json={json}"));
            cmd_list::run(json, ui)
        }
        PluginCommand::Reload {
            bundle,
            plugin_id,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin reload bundle={} plugin_id={} json={}",
                bundle
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<none>".to_string()),
                plugin_id.as_deref().unwrap_or("<none>"),
                json
            ));
            cmd_reload::run(bundle, plugin_id, ui)
        }
        PluginCommand::Status { json } => {
            ui.flags.json = json;
            ui.verbose(format!("running plugin status json={json}"));
            cmd_status::run(json, ui)
        }
        PluginCommand::Dev {
            path,
            reload_url,
            once,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin dev path={} reload_url={} once={} json={}",
                path.display(),
                reload_url.as_deref().unwrap_or("<auto>"),
                once,
                json
            ));
            cmd_dev::run(path, reload_url, once, ui)
        }
        PluginCommand::EmbedVersion {
            wasm,
            version,
            out,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin embed-version wasm={} version={} out={} json={}",
                wasm.display(),
                version,
                out.as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<in-place>".to_string()),
                json
            ));
            cmd_embed_version(wasm, version, out, ui)
        }
    }
}

fn cmd_embed_version(
    wasm: PathBuf,
    version: String,
    out: Option<PathBuf>,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let input = wasm.display().to_string();
    let dest = out.unwrap_or_else(|| wasm.clone());
    if !looks_like_semver(&version) {
        let err = anyhow!("--version must be MAJOR.MINOR.PATCH (got `{version}`)");
        if ui.flags.json {
            return emit_embed_version_json_failure(&input, &dest, &version, "input", err);
        }
        return Err(err);
    }
    let bytes = match std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display())) {
        Ok(bytes) => bytes,
        Err(err) if ui.flags.json => {
            return emit_embed_version_json_failure(&input, &dest, &version, "read", err);
        }
        Err(err) => return Err(err),
    };
    let patched = match packaging::embed_api_version(&bytes, &version) {
        Ok(patched) => patched,
        Err(err) if ui.flags.json => {
            return emit_embed_version_json_failure(&input, &dest, &version, "embed", err);
        }
        Err(err) => return Err(err),
    };
    if let Err(err) =
        std::fs::write(&dest, patched).with_context(|| format!("write {}", dest.display()))
    {
        if ui.flags.json {
            return emit_embed_version_json_failure(&input, &dest, &version, "write", err);
        }
        return Err(err);
    }
    if ui.flags.json {
        let payload = EmbedVersionJsonPayload {
            schema_version: 1,
            ok: true,
            action: "embed-version",
            version,
            input,
            output: dest.display().to_string(),
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        println!(
            "embedded cognia:api-version = {version} into {}",
            dest.display()
        );
    }
    Ok(())
}

fn emit_embed_version_json_failure(
    input: &str,
    output: &Path,
    version: &str,
    stage: &'static str,
    err: anyhow::Error,
) -> Result<()> {
    let payload = EmbedVersionFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "embed-version",
        stage,
        version: version.to_string(),
        input: input.to_string(),
        output: output.display().to_string(),
        error: err.to_string(),
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(JsonFailureExit.into())
}

#[derive(Debug, serde::Serialize)]
struct EmbedVersionJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    version: String,
    input: String,
    output: String,
}

#[derive(Debug, serde::Serialize)]
struct EmbedVersionFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    version: String,
    input: String,
    output: String,
    error: String,
}

pub(crate) fn looks_like_semver(s: &str) -> bool {
    let mut parts = s.split('.');
    let major = parts.next();
    let minor = parts.next();
    let patch = parts.next();
    let rest = parts.next();
    if rest.is_some() {
        return false;
    }
    matches!(
        (
            major.and_then(|p| p.parse::<u32>().ok()),
            minor.and_then(|p| p.parse::<u32>().ok()),
            patch.and_then(|p| p.parse::<u32>().ok())
        ),
        (Some(_), Some(_), Some(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_predicate_accepts_well_formed() {
        assert!(looks_like_semver("0.1.0"));
        assert!(looks_like_semver("1.2.3"));
        assert!(looks_like_semver("12.34.56"));
    }

    #[test]
    fn semver_predicate_rejects_bad_inputs() {
        assert!(!looks_like_semver("0.1"));
        assert!(!looks_like_semver("0.1.0.0"));
        assert!(!looks_like_semver("v0.1.0"));
        assert!(!looks_like_semver("0.1.0-beta"));
        assert!(!looks_like_semver(""));
    }

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

    #[test]
    fn reload_path_alias_maps_to_bundle_input() {
        let cli = Cli::try_parse_from(["cognia", "plugin", "reload", "--path", "plugin-dir"])
            .expect("--path should parse as the reload file-or-directory input");
        let TopCommand::Plugin {
            command:
                PluginCommand::Reload {
                    bundle,
                    plugin_id,
                    json,
                },
        } = cli.command
        else {
            panic!("expected plugin reload command");
        };

        assert_eq!(bundle, Some(PathBuf::from("plugin-dir")));
        assert_eq!(plugin_id, None);
        assert!(!json);
    }

    #[test]
    fn embed_version_json_payload_is_schema_versioned() {
        let payload = EmbedVersionJsonPayload {
            schema_version: 1,
            ok: true,
            action: "embed-version",
            version: "1.2.3".into(),
            input: "input.wasm".into(),
            output: "output.wasm".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], true);
        assert_eq!(json["action"], "embed-version");
        assert_eq!(json["version"], "1.2.3");
        assert_eq!(json["input"], "input.wasm");
        assert_eq!(json["output"], "output.wasm");
    }
}

/// Helper used across subcommands: read a plugin.json given a directory,
/// returning the parsed value plus the absolute path that was opened.
pub(crate) fn read_plugin_manifest(dir: &Path) -> Result<(serde_json::Value, PathBuf)> {
    let mut path = dir.join("plugin.json");
    if !path.exists() {
        // Allow running from the crate root where plugin.json sits next to
        // Cargo.toml; or from one level deeper if the user organized files.
        let alt = dir.join("manifest").join("plugin.json");
        if alt.exists() {
            path = alt;
        } else {
            bail!("plugin.json not found in {}", dir.display());
        }
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok((parsed, path))
}

/// Shell helper used by `build` + `dev` to run a subprocess and stream
/// its stdout/stderr to the user.
pub(crate) fn run_streaming(mut cmd: Command, label: &str) -> Result<()> {
    let status = cmd
        .status()
        .with_context(|| format!("spawn `{label}` failed"))?;
    if !status.success() {
        return Err(anyhow!("`{label}` exited with status {:?}", status.code()));
    }
    Ok(())
}

/// Encode a base64 string. Centralized so swaps between standard / no-pad
/// (e.g. for the public-key field in `plugin.json`) stay consistent.
pub(crate) fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub(crate) fn b64_decode(s: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim().as_bytes())
        .map_err(|e| anyhow!("invalid base64: {e}"))
}

#[cfg(test)]
pub(crate) mod test_env {
    use std::ffi::OsString;
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn lock() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn restore(key: &str, value: Option<OsString>) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}
