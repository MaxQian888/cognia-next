//! cognia — author-facing CLI for cognia plugins.
//!
//! Subcommands:
//!
//!   cognia plugin new <name> [--kind wasm|ts]
//!     Stamp a starter project (Rust WASM by default, TypeScript with --kind ts).
//!
//!   cognia plugin lint [--path .] [--json]
//!     Validate plugin.json against the host's manifest schema. Run by
//!     `build` implicitly; standalone for editor integration.
//!
//!   cognia plugin build [--path .] [--out target.zip] [--skip-build]
//!     Validate, then run the type-appropriate build (cargo-component
//!     for wasm, esbuild for frontend) and pack the bundle.
//!
//!   cognia plugin info <bundle.zip>
//!     Inspect a built bundle: manifest, files, signature, api-version.
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
//!   cognia plugin install <bundle.zip>
//!     Install a bundle into a running cognia desktop (via CLI bridge).
//!
//!   cognia plugin uninstall <plugin-id> [--purge-data]
//!     Uninstall a plugin from a running cognia desktop.
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
//! machine-readable JSON payload (currently: `lint`, `info`, `verify`).

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::process::Command;

mod build_ts;
mod cmd_build;
mod cmd_dev;
mod cmd_info;
mod cmd_install;
mod cmd_keygen;
mod cmd_lint;
mod cmd_new;
mod cmd_sign;
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
        /// Template kind: `wasm` (default) or `ts` (frontend TypeScript).
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
    /// Build the plugin and package the artifact into a `.zip` bundle.
    Build {
        /// Path to the plugin crate. Defaults to the current directory.
        #[arg(long, default_value = ".")]
        path: PathBuf,
        /// Output bundle path. Defaults to `target/cognia/<id>-<version>.zip`.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Skip the build step (use an existing artifact).
        #[arg(long)]
        skip_build: bool,
    },
    /// Inspect a built bundle.
    Info {
        /// Bundle to inspect.
        bundle: PathBuf,
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
    /// Install a bundle into a running cognia desktop instance.
    Install {
        /// Built bundle to install.
        bundle: PathBuf,
    },
    /// Uninstall a plugin from a running cognia desktop instance.
    Uninstall {
        /// Plugin id to remove.
        plugin_id: String,
        /// Also delete the plugin's stored data (Dexie tables, secrets, etc.).
        #[arg(long)]
        purge_data: bool,
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
            bundle,
            json,
            detailed,
        } => {
            ui.flags.json = json;
            cmd_info::run(bundle, json, detailed, ui)
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
        PluginCommand::Install { bundle } => cmd_install::run(bundle, ui),
        PluginCommand::Uninstall {
            plugin_id,
            purge_data,
        } => cmd_uninstall::run(plugin_id, purge_data, ui),
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
    println!("embedded cognia:api-version = {version} into {}", dest.display());
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
