//! cognia — author-facing CLI for cognia plugins.
//!
//! Subcommands:
//!
//!   cognia plugin new <name> [--kind wasm|ts|python|hybrid|vscode-extension]
//!     Stamp a starter project (Rust WASM by default; TypeScript, Python, hybrid, and
//!     VS Code-extension scaffolds also available).
//!
//!   cognia plugin lint [--path .] [--json]
//!     Validate plugin.json against the host's manifest schema. Run by
//!     `build` implicitly; standalone for editor integration.
//!
//!   cognia plugin build [--path .] [--out target.zip] [--skip-build]
//!     Validate, then run the type-appropriate build/pack path: cargo-component
//!     for wasm, esbuild for frontend, existing-entry bundle packing for
//!     python / hybrid / vscode-extension.
//!
//!   cognia plugin info <bundle.zip|directory>
//!     Inspect a bundle or unpacked plugin directory: manifest, files, signature, api-version.
//!
//!   cognia plugin sign <bundle> --key <path>
//!     Ed25519-sign the bundle bytes; writes `<bundle>.sig`.
//!
//!   cognia plugin verify <bundle> [--public-key <b64>] [--signature <path>]
//!     Verify a `.sig` against the manifest's `author.publicKey` (or override).
//!
//!   cognia plugin keygen [--out-dir .cognia]
//!     Generate a fresh Ed25519 keypair.
//!
//!   cognia plugin install <bundle.zip|directory>
//!     Install a bundle or unpacked plugin directory into a running cognia desktop.
//!
//!   cognia plugin uninstall <plugin-id> [--purge-data]
//!     Uninstall a plugin from a running cognia desktop.
//!
//!   cognia plugin list [--json]
//!     List plugins currently known to a running cognia desktop.
//!
//!   cognia plugin reload [--plugin-id <id>] [--bundle|--path <bundle.zip|directory>]
//!     Ask the running cognia desktop to hot-reload a plugin.
//!
//!   cognia plugin status [--json]
//!     Probe whether the running cognia desktop bridge is reachable.
//!
//!   cognia plugin dev [--reload-url URL]
//!     Watch the crate, rebuild on save, and ping a running cognia.
//!
//!   cognia plugin embed-version <wasm> <ver>
//!     Manually inject the api-version custom section (normally automatic).
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
//! machine-readable JSON payload (currently: `lint`, `info`, `verify`, `list`, `status`).

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use clap::{Parser, Subcommand};
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
mod cmd_reload;
mod cmd_sign;
mod cmd_status;
mod cmd_uninstall;
mod cmd_verify;
mod http_client;
mod packaging;
// Source of truth for the release-signing public key. Mirrored into
// src-tauri + the renderer by scripts/release-sync-keys.mjs. Not yet
// consumed by a CLI subcommand (self-update is future work), so the
// constant + helper are allowed to be unused here.
#[allow(dead_code)]
mod release_key;
mod signing;
mod template;
mod ui;

use ui::runtime::{ColorMode, UiFlags};
use ui::RuntimeUi;

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
    },
    /// Install a bundle or unpacked plugin directory into a running cognia desktop instance.
    Install {
        /// Built `.zip` bundle, or a plugin directory containing `plugin.json`.
        #[arg(value_name = "PATH")]
        path: PathBuf,
    },
    /// Uninstall a plugin from a running cognia desktop instance.
    Uninstall {
        /// Plugin id to remove.
        plugin_id: String,
        /// Also delete the plugin's stored data (Dexie tables, secrets, etc.).
        #[arg(long)]
        purge_data: bool,
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
        TopCommand::Acp => cmd_acp::run(),
    };
    result.map_err(anyhow_to_eyre)?;
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
        } => cmd_new::run(
            name,
            dir,
            kind,
            author,
            author_email,
            description,
            with_keygen,
            ui,
        ),
        PluginCommand::Lint { path, json } => {
            ui.flags.json = json;
            cmd_lint::run(path, json, ui)
        }
        PluginCommand::Build {
            path,
            out,
            skip_build,
        } => cmd_build::run(path, out, skip_build, ui),
        PluginCommand::Info {
            path,
            json,
            detailed,
        } => {
            ui.flags.json = json;
            cmd_info::run(path, json, detailed, ui)
        }
        PluginCommand::Sign { bundle, key, out } => cmd_sign::run(bundle, key, out, ui),
        PluginCommand::Verify {
            bundle,
            public_key,
            signature,
            json,
        } => {
            ui.flags.json = json;
            cmd_verify::run(bundle, public_key, signature, json, ui)
        }
        PluginCommand::Keygen { out_dir } => cmd_keygen::run(out_dir, ui),
        PluginCommand::Install { path } => cmd_install::run(path, ui),
        PluginCommand::Uninstall {
            plugin_id,
            purge_data,
        } => cmd_uninstall::run(plugin_id, purge_data, ui),
        PluginCommand::List { json } => {
            ui.flags.json = json;
            cmd_list::run(json, ui)
        }
        PluginCommand::Reload { bundle, plugin_id } => cmd_reload::run(bundle, plugin_id, ui),
        PluginCommand::Status { json } => {
            ui.flags.json = json;
            cmd_status::run(json, ui)
        }
        PluginCommand::Dev { path, reload_url } => cmd_dev::run(path, reload_url, ui),
        PluginCommand::EmbedVersion { wasm, version, out } => {
            cmd_embed_version(wasm, version, out, ui)
        }
    }
}

fn cmd_embed_version(
    wasm: PathBuf,
    version: String,
    out: Option<PathBuf>,
    _ui: &mut RuntimeUi,
) -> Result<()> {
    if !looks_like_semver(&version) {
        bail!("--version must be MAJOR.MINOR.PATCH (got `{version}`)");
    }
    let bytes = std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display()))?;
    let patched = packaging::embed_api_version(&bytes, &version)?;
    let dest = out.unwrap_or(wasm);
    std::fs::write(&dest, patched).with_context(|| format!("write {}", dest.display()))?;
    println!(
        "embedded cognia:api-version = {version} into {}",
        dest.display()
    );
    Ok(())
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
            command: PluginCommand::Reload { bundle, plugin_id },
        } = cli.command
        else {
            panic!("expected plugin reload command");
        };

        assert_eq!(bundle, Some(PathBuf::from("plugin-dir")));
        assert_eq!(plugin_id, None);
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
