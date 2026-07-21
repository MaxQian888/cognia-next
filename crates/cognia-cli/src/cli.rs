//! Clap command surface and the plugin-subcommand dispatcher.
//!
//! `main()` owns process setup (color mode, error reporter, exit codes) and
//! the top-level [`TopCommand`] match; everything under `cognia plugin …`
//! routes through [`dispatch_plugin`], which sets the per-command `--json`
//! flag, emits a `-v` trace line, and calls the matching `commands::*::run`.

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

use crate::commands;
use crate::ui::RuntimeUi;

#[derive(Parser, Debug)]
#[command(name = "cognia", version, about, long_about = None)]
pub(crate) struct Cli {
    /// Color mode for stdout/stderr (default: auto — on when a TTY,
    /// off otherwise; respects NO_COLOR and FORCE_COLOR env vars).
    #[arg(long, value_name = "MODE", default_value = "auto", global = true)]
    pub(crate) color: String,
    /// Shortcut for `--color=never`. Higher priority than `--color`.
    #[arg(long, global = true)]
    pub(crate) no_color: bool,
    /// Suppress non-error output (no spinners, no progress, no info chatter).
    #[arg(long, short = 'q', global = true)]
    pub(crate) quiet: bool,
    /// Increase log verbosity (repeatable, e.g. `-vv` for debug-level).
    #[arg(long, short = 'v', global = true, action = clap::ArgAction::Count)]
    pub(crate) verbose: u8,
    /// Pre-confirm every interactive prompt (`uninstall --purge-data`,
    /// overwrite prompts, etc.). Required for CI usage.
    #[arg(long, short = 'y', global = true)]
    pub(crate) yes: bool,

    #[command(subcommand)]
    pub(crate) command: TopCommand,
}

#[derive(Subcommand, Debug)]
pub(crate) enum TopCommand {
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
        /// Template kind: `ts` (default, frontend TypeScript), `wasm` (Rust +
        /// cargo-component), `python`, `hybrid`, or `vscode-extension`
        /// (`vscode` alias accepted).
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
    /// Convert an existing MCP server, agent skill, or CLI binary into a
    /// cognia plugin project.
    ///
    /// Nothing from the source is executed: no MCP server is spawned, no
    /// `--help` is run, nothing is fetched. Credentials in the source
    /// config are never copied — they become user-filled preset fields.
    Import {
        /// What kind of artifact `--input` points at: `mcp` (an agent's MCP
        /// config file), `skill` (a SKILL.md file or its folder), or `cli`
        /// (the name of a binary on PATH).
        #[arg(long, value_name = "KIND")]
        from: String,
        /// The MCP config file, skill folder / SKILL.md, or binary name.
        #[arg(long, value_name = "PATH_OR_NAME")]
        input: String,
        /// Which entry to convert. Required when the input holds several;
        /// run with `--list` to see the choices.
        #[arg(long, value_name = "ID")]
        pick: Option<String>,
        /// List what could be picked out of `--input`, then exit.
        #[arg(long)]
        list: bool,
        /// Add the contribution to the plugin in this directory instead of
        /// creating a new project. Refuses on an id collision.
        #[arg(long, value_name = "DIR")]
        into: Option<PathBuf>,
        /// Directory to create. Defaults to ./<derived-plugin-id>.
        #[arg(long)]
        dir: Option<PathBuf>,
        /// Override the derived plugin id. With `--into`, renames the imported
        /// contribution instead (the plugin id is fixed by the target directory).
        #[arg(long)]
        id: Option<String>,
        /// Override the derived display name.
        #[arg(long)]
        name: Option<String>,
        /// Override the derived description.
        #[arg(long)]
        description: Option<String>,
        /// Plugin version to record. Defaults to 0.1.0.
        #[arg(long, value_name = "SEMVER")]
        plugin_version: Option<String>,
        /// Author display name. Defaults to `git config user.name`.
        #[arg(long)]
        author: Option<String>,
        /// Author email (recorded in plugin.json `author.email`).
        #[arg(long)]
        author_email: Option<String>,
        /// SPDX license id. Defaults to MIT.
        #[arg(long)]
        license: Option<String>,
        /// Minimum host version the plugin declares. Defaults to 0.1.0.
        #[arg(long, value_name = "SEMVER")]
        min_app_version: Option<String>,
        /// Skip the trailing esbuild refresh. The project already ships a
        /// generated `dist/index.js`, so it stays installable either way.
        #[arg(long)]
        no_build: bool,
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
        /// Treat warnings as errors: exit non-zero if any warning is present
        /// (notices never gate). Useful in CI to keep warnings from rotting.
        #[arg(short = 'W', long = "warnings-as-errors")]
        warnings_as_errors: bool,
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
    /// Check the build toolchain, desktop bridge, and (inside a plugin dir)
    /// the signing-key gitignore invariant + manifest lint.
    Doctor {
        /// Apply the auto-fixable remedies (rustup target add, gitignore the
        /// signing key) instead of only reporting them.
        #[arg(long)]
        fix: bool,
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

pub(crate) fn dispatch_plugin(command: PluginCommand, ui: &mut RuntimeUi) -> Result<()> {
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
            commands::new::run(
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
        PluginCommand::Import {
            from,
            input,
            pick,
            list,
            into,
            dir,
            id,
            name,
            description,
            plugin_version,
            author,
            author_email,
            license,
            min_app_version,
            no_build,
            json,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin import from={from} input={input} pick={} list={list} into={} dir={} no_build={no_build} json={json}",
                pick.as_deref().unwrap_or("<auto>"),
                into.as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<none>".to_string()),
                dir.as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<default>".to_string()),
            ));
            commands::import::run(
                commands::import::ImportArgs {
                    from,
                    input,
                    pick,
                    into,
                    dir,
                    list,
                    id,
                    name,
                    description,
                    plugin_version,
                    author,
                    author_email,
                    license,
                    min_app_version,
                    no_build,
                },
                json,
                ui,
            )
        }
        PluginCommand::Lint {
            path,
            json,
            warnings_as_errors,
        } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin lint path={} json={json} warnings_as_errors={warnings_as_errors}",
                path.display()
            ));
            commands::lint::run(path, json, warnings_as_errors, ui)
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
            commands::build::run(path, out, skip_build, ui)
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
            commands::info::run(path, json, detailed, ui)
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
            commands::sign::run(bundle, key, out, ui)
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
            commands::verify::run(bundle, public_key, signature, json, ui)
        }
        PluginCommand::Keygen { out_dir, json } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin keygen out_dir={} json={json}",
                out_dir.display()
            ));
            commands::keygen::run(out_dir, ui)
        }
        PluginCommand::Install { path, json } => {
            ui.flags.json = json;
            ui.verbose(format!(
                "running plugin install path={} json={json}",
                path.display()
            ));
            commands::install::run(path, ui)
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
            commands::uninstall::run(plugin_id, purge_data, ui)
        }
        PluginCommand::List { json } => {
            ui.flags.json = json;
            ui.verbose(format!("running plugin list json={json}"));
            commands::list::run(json, ui)
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
            commands::reload::run(bundle, plugin_id, ui)
        }
        PluginCommand::Status { json } => {
            ui.flags.json = json;
            ui.verbose(format!("running plugin status json={json}"));
            commands::status::run(json, ui)
        }
        PluginCommand::Doctor { fix, json } => {
            ui.flags.json = json;
            ui.verbose(format!("running plugin doctor fix={fix} json={json}"));
            commands::doctor::run(fix, json, ui)
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
            commands::dev::run(path, reload_url, once, ui)
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
            commands::embed_version::run(wasm, version, out, ui)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
