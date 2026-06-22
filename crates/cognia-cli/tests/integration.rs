//! End-to-end smoke tests against the compiled `cognia` binary.
//!
//! Cargo sets `CARGO_BIN_EXE_cognia` to the absolute path of the built
//! binary for any integration test in this directory, so we can shell
//! out without an `assert_cmd` dependency.
//!
//! These tests prove the dispatch chain through `main()` → `clap` →
//! `dispatch_plugin` → `cmd_*::run` works end-to-end. The per-command
//! tests in `crates/cognia-cli/src/cmd_*.rs` cover the deeper behavior.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Resolve the path to the just-built `cognia` binary.
fn cognia_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_cognia"))
}

/// Run `cognia <args>` with `NO_COLOR=1` (deterministic stdout) and
/// `CI=true` (forces the non-interactive prompter path). Returns
/// `(status_code, stdout, stderr)`.
fn run_cognia(args: &[&str]) -> (Option<i32>, String, String) {
    let out = Command::new(cognia_bin())
        .args(args)
        .env("NO_COLOR", "1")
        .env("CI", "true")
        .env_remove("FORCE_COLOR")
        .stdin(Stdio::null())
        .output()
        .expect("spawn cognia");
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// Build a minimal valid plugin.json beside `dir`.
fn write_minimal_manifest(dir: &Path, id: &str) {
    let manifest = format!(
        r#"{{"id":"{id}","name":"X","version":"0.1.0","description":"smoke","type":"frontend","capabilities":["tools"],"main":"dist/index.js"}}"#
    );
    std::fs::write(dir.join("plugin.json"), manifest).unwrap();
}

/// Build a real `.zip` bundle on disk for the `info` / `verify` flow.
fn write_real_bundle(path: &Path, manifest: &str) {
    let f = std::fs::File::create(path).unwrap();
    let mut w = zip::ZipWriter::new(f);
    let opts: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file("plugin.json", opts).unwrap();
    w.write_all(manifest.as_bytes()).unwrap();
    w.finish().unwrap();
}

#[test]
fn help_prints_top_level_usage() {
    let (code, stdout, _stderr) = run_cognia(&["--help"]);
    assert_eq!(code, Some(0));
    assert!(
        stdout.contains("cognia"),
        "missing program name in: {stdout}"
    );
    assert!(stdout.contains("plugin"), "missing subcommand in: {stdout}");
}

#[test]
fn version_flag_prints_semver_string() {
    let (code, stdout, _stderr) = run_cognia(&["--version"]);
    assert_eq!(code, Some(0));
    // Cargo embeds the crate's version; we don't pin a specific one here.
    assert!(stdout.contains("cognia"), "got: {stdout}");
}

#[test]
fn lint_on_clean_manifest_exits_zero() {
    let tmp = tempfile::tempdir().unwrap();
    write_minimal_manifest(tmp.path(), "smoke-clean");
    let (code, _stdout, _stderr) =
        run_cognia(&["plugin", "lint", "--path", tmp.path().to_str().unwrap()]);
    assert_eq!(code, Some(0));
}

#[test]
fn lint_on_broken_manifest_exits_nonzero() {
    let tmp = tempfile::tempdir().unwrap();
    // missing required fields → lint errors
    std::fs::write(tmp.path().join("plugin.json"), r#"{"id":"x"}"#).unwrap();
    let (code, _stdout, _stderr) =
        run_cognia(&["plugin", "lint", "--path", tmp.path().to_str().unwrap()]);
    assert!(code != Some(0), "lint should fail on broken manifest");
}

#[test]
fn lint_json_carries_schema_version() {
    let tmp = tempfile::tempdir().unwrap();
    write_minimal_manifest(tmp.path(), "smoke-json");
    let (code, stdout, _stderr) = run_cognia(&[
        "plugin",
        "lint",
        "--path",
        tmp.path().to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(code, Some(0));
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("lint --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], serde_json::Value::Number(1.into()));
    assert_eq!(parsed["valid"], serde_json::Value::Bool(true));
}

#[test]
fn info_json_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("smoke.zip");
    write_real_bundle(
        &bundle,
        r#"{"id":"smoke-info","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js"}"#,
    );
    let (code, stdout, _stderr) =
        run_cognia(&["plugin", "info", bundle.to_str().unwrap(), "--json"]);
    assert_eq!(code, Some(0));
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("info --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], serde_json::Value::Number(1.into()));
    assert_eq!(
        parsed["signature"]["status"],
        serde_json::Value::String("no-sidecar".into())
    );
}

#[test]
fn info_json_round_trips_for_plugin_directory() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("dist")).unwrap();
    write_minimal_manifest(tmp.path(), "smoke-dir-info");
    std::fs::write(tmp.path().join("dist").join("index.js"), "console.log(1)").unwrap();

    let (code, stdout, stderr) =
        run_cognia(&["plugin", "info", tmp.path().to_str().unwrap(), "--json"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("directory info --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], serde_json::Value::Number(1.into()));
    assert_eq!(
        parsed["inputKind"],
        serde_json::Value::String("directory".into())
    );
    assert_eq!(parsed["manifest"]["id"], "smoke-dir-info");
    assert_eq!(parsed["signature"]["status"], "not-applicable");
    assert!(parsed["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "dist/index.js"));
}

#[test]
fn plugin_info_help_mentions_bundle_or_directory() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "info", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("bundle") && stdout.contains("directory"),
        "info help should mention both supported input forms, got: {stdout}"
    );
}

#[test]
fn plugin_new_without_name_fails_on_non_tty_with_actionable_hint() {
    // CI=true forces non-interactive path → must surface flag hint.
    let tmp = tempfile::tempdir().unwrap();
    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "new",
        "--dir",
        tmp.path().join("nope").to_str().unwrap(),
    ]);
    assert!(
        code != Some(0),
        "expected failure when stdin is non-interactive"
    );
    assert!(
        stderr.contains("plugin name is required") || stderr.contains("name"),
        "expected actionable hint in stderr, got: {stderr}"
    );
}

#[test]
fn plugin_new_with_explicit_args_succeeds() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("smoke-new");
    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "new",
        "smoke-new",
        "--dir",
        target.to_str().unwrap(),
        "--kind",
        "ts",
        "--author",
        "Smoke Tester",
        "--description",
        "smoke",
        "--with-keygen",
        "false",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(target.join("plugin.json").exists());
    assert!(target.join("package.json").exists());
}

#[test]
fn plugin_new_with_python_kind_succeeds() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("smoke-python");
    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "new",
        "smoke-python",
        "--dir",
        target.to_str().unwrap(),
        "--kind",
        "python",
        "--author",
        "Smoke Tester",
        "--description",
        "smoke",
        "--with-keygen",
        "false",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(target.join("plugin.json").exists());
    assert!(target.join("main.py").exists());
    let manifest = std::fs::read_to_string(target.join("plugin.json")).unwrap();
    assert!(manifest.contains(r#""type": "python""#));
    assert!(manifest.contains(r#""pythonMain": "main.py""#));
}

#[test]
fn plugin_new_with_hybrid_kind_succeeds() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("smoke-hybrid");
    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "new",
        "smoke-hybrid",
        "--dir",
        target.to_str().unwrap(),
        "--kind",
        "hybrid",
        "--author",
        "Smoke Tester",
        "--description",
        "smoke",
        "--with-keygen",
        "false",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(target.join("plugin.json").exists());
    assert!(target.join("frontend/index.js").exists());
    assert!(target.join("backend/main.py").exists());
    assert!(target.join("styles.css").exists());
    let manifest = std::fs::read_to_string(target.join("plugin.json")).unwrap();
    assert!(manifest.contains(r#""type": "hybrid""#));
    assert!(manifest.contains(r#""main": "frontend/index.js""#));
    assert!(manifest.contains(r#""pythonMain": "backend/main.py""#));
    assert!(manifest.contains(r#""styles": "styles.css""#));
}

#[test]
fn plugin_new_with_vscode_kind_succeeds() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("smoke-vscode");
    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "new",
        "smoke-vscode",
        "--dir",
        target.to_str().unwrap(),
        "--kind",
        "vscode",
        "--author",
        "Smoke Tester",
        "--description",
        "smoke",
        "--with-keygen",
        "false",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(target.join("plugin.json").exists());
    assert!(target.join("package.json").exists());
    assert!(target.join("extension/out/extension.js").exists());
    assert!(target.join("styles.css").exists());
    let manifest = std::fs::read_to_string(target.join("plugin.json")).unwrap();
    assert!(manifest.contains(r#""type": "vscode-extension""#));
    assert!(manifest.contains(r#""vscodeMain": "extension/out/extension.js""#));
    assert!(manifest.contains(r#""styles": "styles.css""#));
    let manifest_json: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(
        manifest_json["bundle_include"][0],
        serde_json::Value::String("package.json".into())
    );
}

#[test]
fn unknown_subcommand_emits_helpful_error() {
    let (code, _stdout, stderr) = run_cognia(&["plugin", "definitely-not-real"]);
    assert!(code != Some(0));
    assert!(
        stderr.contains("error") || stderr.contains("usage") || stderr.contains("subcommand"),
        "stderr should explain the misuse, got: {stderr}"
    );
}

#[test]
fn plugin_list_help_is_available() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "list", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("installed"),
        "missing installed wording in: {stdout}"
    );
    assert!(stdout.contains("--json"), "missing json flag in: {stdout}");
}

#[test]
fn plugin_reload_help_accepts_id_bundle_or_path() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "reload", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("--plugin-id"),
        "missing plugin id flag in: {stdout}"
    );
    assert!(
        stdout.contains("--bundle"),
        "missing bundle flag in: {stdout}"
    );
    assert!(stdout.contains("--path"), "missing path alias in: {stdout}");
    assert!(
        stdout.contains("directory"),
        "missing directory wording in: {stdout}"
    );
}

#[test]
fn plugin_status_help_is_available() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "status", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("bridge"),
        "missing bridge wording in: {stdout}"
    );
    assert!(stdout.contains("--json"), "missing json flag in: {stdout}");
}

#[test]
fn plugin_install_help_mentions_bundle_or_directory() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "install", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("bundle") && stdout.contains("directory"),
        "install help should mention both supported input forms, got: {stdout}"
    );
}

#[test]
fn no_color_env_strips_ansi_from_lint_output() {
    let tmp = tempfile::tempdir().unwrap();
    write_minimal_manifest(tmp.path(), "smoke-no-color");
    let (code, stdout, _stderr) =
        run_cognia(&["plugin", "lint", "--path", tmp.path().to_str().unwrap()]);
    assert_eq!(code, Some(0));
    assert!(
        !stdout.contains('\u{1b}'),
        "NO_COLOR run should not emit ANSI escapes, got: {stdout:?}"
    );
}
