//! `cognia plugin import` — turn an existing MCP server, agent skill, or
//! CLI binary into a cognia plugin project.
//!
//! The conversion itself runs in Node. That is deliberate: the parsers it
//! needs already exist in TypeScript — thirteen agent-config adapters that
//! each know one editor's MCP quirks (`lib/claude/agents/*`) and the
//! SKILL.md frontmatter parser (`lib/claude/skills-io`). Re-implementing
//! any of them here would create a second surface to keep in sync, which
//! is exactly how `cmd_lint.rs` ended up with four hand-copied parity
//! lists, one of which silently drifted.
//!
//! The converter is bundled to a single self-contained CommonJS file by
//! `pnpm plugin-convert:bundle`, checked in under `assets/`, and embedded
//! here with `include_str!`. So `cognia` stays one binary, and the CI job
//! that runs `cargo test -p cognia-cli` with no Node toolchain keeps
//! working. `pnpm plugin-convert:check` fails the build if the checked-in
//! bundle drifts from the TypeScript sources.
//!
//! Nothing from the source artifact is executed: no MCP server is spawned,
//! no `--help` is run, nothing is fetched. Conversion reads text and
//! writes text.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::shared::read_plugin_manifest;
use crate::ui::{style, RuntimeUi};

/// The bundled converter. Regenerate with `pnpm plugin-convert:bundle`.
const CONVERTER_JS: &str = include_str!("../../assets/plugin-convert.cjs");

/// Options mirrored one-to-one from the clap surface.
#[derive(Debug, Clone, Default)]
pub(crate) struct ImportArgs {
    pub(crate) from: String,
    pub(crate) input: String,
    pub(crate) pick: Option<String>,
    pub(crate) into: Option<PathBuf>,
    pub(crate) dir: Option<PathBuf>,
    pub(crate) list: bool,
    pub(crate) id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) plugin_version: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) author_email: Option<String>,
    pub(crate) license: Option<String>,
    pub(crate) min_app_version: Option<String>,
    pub(crate) no_build: bool,
}

/// One `--pick`-able entry in the supplied input.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) detail: Option<String>,
}

/// The converter's stdout contract. Exactly one of these per invocation.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Default)]
pub(crate) struct ConverterOutput {
    pub(crate) ok: bool,
    #[serde(default)]
    pub(crate) error: Option<String>,
    #[serde(default)]
    pub(crate) mode: Option<String>,
    #[serde(rename = "pluginId", default)]
    pub(crate) plugin_id: Option<String>,
    #[serde(default)]
    pub(crate) dir: Option<String>,
    #[serde(default)]
    pub(crate) files: Vec<String>,
    #[serde(default)]
    pub(crate) candidates: Vec<Candidate>,
    #[serde(default)]
    pub(crate) todos: Vec<String>,
    #[serde(default)]
    pub(crate) warnings: Vec<String>,
    #[serde(rename = "buildTarget", default)]
    pub(crate) build_target: Option<String>,
}

/// Outcome of the trailing build, reported alongside the conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum BuildOutcome {
    /// esbuild ran and produced the bundle.
    Built,
    /// `--no-build`, or nothing to build (list / merge mode).
    Skipped,
    /// esbuild could not run. The project on disk is still complete.
    Unavailable,
}

/// The full command report, emitted as JSON under `--json`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ImportReport {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u32,
    pub(crate) ok: bool,
    pub(crate) action: &'static str,
    pub(crate) mode: String,
    #[serde(rename = "pluginId", skip_serializing_if = "Option::is_none")]
    pub(crate) plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dir: Option<String>,
    pub(crate) files: Vec<String>,
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) todos: Vec<String>,
    pub(crate) warnings: Vec<String>,
    pub(crate) build: BuildOutcome,
    #[serde(rename = "buildError", skip_serializing_if = "Option::is_none")]
    pub(crate) build_error: Option<String>,
}

pub fn run(args: ImportArgs, json: bool, ui: &mut RuntimeUi) -> Result<()> {
    let script = materialize_converter(CONVERTER_JS)?;
    let output = run_converter(&script, &build_argv(&args))?;
    let report = finish(args, output, ui)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else if !ui.flags.quiet {
        print_human(&report);
    }
    Ok(())
}

/// Translate `ImportArgs` into the converter's argv.
pub(crate) fn build_argv(args: &ImportArgs) -> Vec<String> {
    let mut argv = vec![
        "--from".to_string(),
        args.from.clone(),
        "--input".to_string(),
        args.input.clone(),
    ];
    let mut push = |flag: &str, value: &Option<String>| {
        if let Some(value) = value {
            argv.push(flag.to_string());
            argv.push(value.clone());
        }
    };
    push("--pick", &args.pick);
    push("--id", &args.id);
    push("--name", &args.name);
    push("--description", &args.description);
    push("--plugin-version", &args.plugin_version);
    push("--author", &args.author);
    push("--author-email", &args.author_email);
    push("--license", &args.license);
    push("--min-app-version", &args.min_app_version);
    if let Some(into) = &args.into {
        argv.push("--into".to_string());
        argv.push(into.to_string_lossy().into_owned());
    }
    if let Some(dir) = &args.dir {
        argv.push("--dir".to_string());
        argv.push(dir.to_string_lossy().into_owned());
    }
    if args.list {
        argv.push("--list".to_string());
    }
    argv
}

/// Path the embedded converter is cached at, keyed by its own contents so a
/// CLI upgrade never runs a stale script and repeated runs never re-write.
pub(crate) fn converter_cache_path(contents: &str) -> PathBuf {
    let digest = Sha256::digest(contents.as_bytes());
    let short = hex::encode(&digest[..8]);
    std::env::temp_dir().join(format!("cognia-plugin-convert-{short}.cjs"))
}

/// Write the embedded converter to its content-addressed cache path.
pub(crate) fn materialize_converter(contents: &str) -> Result<PathBuf> {
    let path = converter_cache_path(contents);
    let fresh = std::fs::read_to_string(&path)
        .map(|existing| existing == contents)
        .unwrap_or(false);
    if !fresh {
        std::fs::write(&path, contents)
            .with_context(|| format!("write converter to {}", path.display()))?;
    }
    Ok(path)
}

/// Run the converter and parse its single JSON line.
fn run_converter(script: &Path, argv: &[String]) -> Result<ConverterOutput> {
    let output = Command::new(node_program())
        .arg(script)
        .args(argv)
        .output()
        .map_err(|err| {
            anyhow!(
                "could not run Node.js: {err}. `cognia plugin import` converts through a bundled \
                 Node script; install Node.js 20+ and make sure `node` is on PATH."
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_converter_output(&stdout, &String::from_utf8_lossy(&output.stderr))
}

fn node_program() -> &'static str {
    // Node ships as `node` (no `.cmd` shim) on every platform, unlike npx.
    "node"
}

/// Turn the converter's stdout into a result, or a diagnosable error.
pub(crate) fn parse_converter_output(stdout: &str, stderr: &str) -> Result<ConverterOutput> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        bail!(
            "the converter produced no output{}",
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", stderr.trim())
            }
        );
    }
    let parsed: ConverterOutput = serde_json::from_str(trimmed).with_context(|| {
        format!("converter emitted output that is not the expected JSON report: {trimmed}")
    })?;
    if !parsed.ok {
        bail!(parsed
            .error
            .unwrap_or_else(|| "conversion failed without a reason".to_string()));
    }
    Ok(parsed)
}

/// Run the trailing build and assemble the report.
fn finish(args: ImportArgs, output: ConverterOutput, ui: &mut RuntimeUi) -> Result<ImportReport> {
    let mode = output.mode.clone().unwrap_or_else(|| "create".to_string());
    let mut build = BuildOutcome::Skipped;
    let mut build_error = None;

    let should_build =
        !args.no_build && mode == "create" && output.build_target.is_some() && output.dir.is_some();
    if should_build {
        let dir = PathBuf::from(output.dir.clone().unwrap_or_default());
        ui.verbose(format!("building {}", dir.display()));
        match build_generated_project(&dir) {
            Ok(()) => build = BuildOutcome::Built,
            Err(err) => {
                // The conversion succeeded and the project is on disk; only
                // the bundling step could not run. Reporting it as a hard
                // failure would throw away correct work, and reporting
                // nothing would hand the author a directory that silently
                // cannot be installed. So: surfaced, named, and actionable.
                build = BuildOutcome::Unavailable;
                build_error = Some(format!("{err:#}"));
            }
        }
    }

    Ok(ImportReport {
        schema_version: 1,
        ok: true,
        action: "import",
        mode,
        plugin_id: output.plugin_id,
        dir: output.dir,
        files: output.files,
        candidates: output.candidates,
        todos: output.todos,
        warnings: output.warnings,
        build,
        build_error,
    })
}

/// Bundle the generated entry with the same esbuild invocation `plugin build` uses.
fn build_generated_project(dir: &Path) -> Result<()> {
    let (manifest, _path) = read_plugin_manifest(dir)?;
    crate::engine::frontend_build::build_only(dir, &manifest)
}

fn print_human(report: &ImportReport) {
    if report.mode == "list" {
        println!("{}", style::bold("Available entries"));
        for candidate in &report.candidates {
            match &candidate.detail {
                Some(detail) => println!("  {}  {}", style::bold(&candidate.id), detail),
                None => println!("  {}", style::bold(&candidate.id)),
            }
        }
        println!();
        println!("Re-run with --pick <id> to convert one.");
        return;
    }

    let id = report.plugin_id.as_deref().unwrap_or("<unknown>");
    if report.mode == "merge" {
        println!("{} {}", style::ok("Merged into"), style::bold(id));
    } else {
        println!("{} {}", style::ok("Created"), style::bold(id));
    }
    if let Some(dir) = &report.dir {
        println!("  {dir}");
    }
    for file in &report.files {
        println!("    {file}");
    }

    if !report.warnings.is_empty() {
        println!();
        println!("{}", style::bold("Warnings"));
        for warning in &report.warnings {
            println!("  - {warning}");
        }
    }

    if !report.todos.is_empty() {
        println!();
        println!("{}", style::bold("Before this plugin works"));
        for todo in &report.todos {
            println!("  - {todo}");
        }
    }

    println!();
    match report.build {
        BuildOutcome::Built => {
            println!("{}", style::bold("Next steps"));
            println!(
                "  cognia plugin lint --path {}",
                report.dir.as_deref().unwrap_or(".")
            );
            println!(
                "  cognia plugin install {}",
                report.dir.as_deref().unwrap_or(".")
            );
        }
        BuildOutcome::Unavailable => {
            // The project already ships a generated `dist/index.js`, so it
            // installs either way; esbuild would only have refreshed it.
            println!(
                "{}",
                style::warn("esbuild unavailable — kept the generated dist/index.js")
            );
            if let Some(err) = &report.build_error {
                println!("  {}", style::dim(err));
            }
            println!();
            println!("{}", style::bold("Next steps"));
            println!(
                "  cognia plugin lint --path {}",
                report.dir.as_deref().unwrap_or(".")
            );
            println!(
                "  cognia plugin install {}",
                report.dir.as_deref().unwrap_or(".")
            );
            println!(
                "  {}",
                style::dim("run `pnpm install && pnpm build` there before you edit src/index.ts")
            );
        }
        BuildOutcome::Skipped => {
            println!("{}", style::bold("Next steps"));
            println!(
                "  cognia plugin lint --path {}",
                report.dir.as_deref().unwrap_or(".")
            );
            println!(
                "  cognia plugin install {}",
                report.dir.as_deref().unwrap_or(".")
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> ImportArgs {
        ImportArgs {
            from: "mcp".to_string(),
            input: "/a/mcp.json".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn build_argv_emits_required_flags() {
        assert_eq!(
            build_argv(&args()),
            vec!["--from", "mcp", "--input", "/a/mcp.json"]
        );
    }

    #[test]
    fn build_argv_forwards_every_optional_flag() {
        let mut a = args();
        a.pick = Some("github".to_string());
        a.id = Some("my.id".to_string());
        a.name = Some("My Name".to_string());
        a.description = Some("desc".to_string());
        a.plugin_version = Some("2.0.0".to_string());
        a.author = Some("Ada".to_string());
        a.author_email = Some("ada@example.com".to_string());
        a.license = Some("Apache-2.0".to_string());
        a.min_app_version = Some("0.9.0".to_string());
        a.dir = Some(PathBuf::from("/out"));

        let argv = build_argv(&a);
        for expected in [
            "--pick",
            "github",
            "--id",
            "my.id",
            "--name",
            "My Name",
            "--description",
            "desc",
            "--plugin-version",
            "2.0.0",
            "--author",
            "Ada",
            "--author-email",
            "ada@example.com",
            "--license",
            "Apache-2.0",
            "--min-app-version",
            "0.9.0",
            "--dir",
            "/out",
        ] {
            assert!(argv.iter().any(|a| a == expected), "missing {expected}");
        }
        assert!(!argv.iter().any(|a| a == "--list"));
    }

    #[test]
    fn build_argv_passes_list_and_into() {
        let mut a = args();
        a.list = true;
        a.into = Some(PathBuf::from("/plugins/mine"));
        let argv = build_argv(&a);
        assert!(argv.iter().any(|a| a == "--list"));
        let idx = argv.iter().position(|a| a == "--into").expect("--into");
        assert_eq!(argv[idx + 1], "/plugins/mine");
    }

    #[test]
    fn build_argv_omits_absent_optionals() {
        let argv = build_argv(&args());
        for flag in ["--pick", "--id", "--author", "--into", "--dir", "--list"] {
            assert!(!argv.iter().any(|a| a == flag), "unexpected {flag}");
        }
    }

    #[test]
    fn converter_cache_path_is_content_addressed() {
        let a = converter_cache_path("console.log(1)");
        let b = converter_cache_path("console.log(2)");
        assert_ne!(a, b, "different bundles must not share a cache file");
        assert_eq!(a, converter_cache_path("console.log(1)"));
        assert!(a
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("cognia-plugin-convert-"));
    }

    #[test]
    fn materialize_converter_writes_then_reuses() {
        let contents = format!("// {}\n", std::process::id());
        let path = materialize_converter(&contents).expect("write");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), contents);
        // Second call must be a no-op that still yields the same path.
        assert_eq!(materialize_converter(&contents).expect("reuse"), path);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_embedded_bundle_is_the_real_converter() {
        assert!(CONVERTER_JS.contains("GENERATED FILE"));
        assert!(!CONVERTER_JS.is_empty());
    }

    #[test]
    fn parse_converter_output_reads_a_success_report() {
        let parsed = parse_converter_output(
            r#"{"ok":true,"mode":"create","pluginId":"github-mcp","dir":"/out","files":["plugin.json"],"todos":["fill token"],"buildTarget":"dist/index.js"}"#,
            "",
        )
        .expect("parse");
        assert!(parsed.ok);
        assert_eq!(parsed.plugin_id.as_deref(), Some("github-mcp"));
        assert_eq!(parsed.build_target.as_deref(), Some("dist/index.js"));
        assert_eq!(parsed.todos, vec!["fill token"]);
    }

    #[test]
    fn parse_converter_output_surfaces_the_converter_error() {
        let err = parse_converter_output(r#"{"ok":false,"error":"--pick is required"}"#, "")
            .expect_err("must fail");
        assert!(err.to_string().contains("--pick is required"));
    }

    #[test]
    fn parse_converter_output_reports_empty_stdout_with_stderr_context() {
        let err = parse_converter_output("", "node: bad flag").expect_err("must fail");
        assert!(err.to_string().contains("no output"));
        assert!(err.to_string().contains("node: bad flag"));
    }

    #[test]
    fn parse_converter_output_rejects_non_json() {
        let err = parse_converter_output("not json at all", "").expect_err("must fail");
        assert!(err.to_string().contains("not the expected JSON report"));
    }

    #[test]
    fn parse_converter_output_reads_a_candidate_listing() {
        let parsed = parse_converter_output(
            r#"{"ok":true,"mode":"list","candidates":[{"id":"a","label":"a","detail":"stdio · npx"}]}"#,
            "",
        )
        .expect("parse");
        assert_eq!(parsed.candidates.len(), 1);
        assert_eq!(parsed.candidates[0].id, "a");
        assert_eq!(parsed.candidates[0].detail.as_deref(), Some("stdio · npx"));
    }
}
