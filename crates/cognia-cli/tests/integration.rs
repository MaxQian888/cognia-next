//! End-to-end smoke tests against the compiled `cognia` binary.
//!
//! Cargo sets `CARGO_BIN_EXE_cognia` to the absolute path of the built
//! binary for any integration test in this directory, so we can shell
//! out without an `assert_cmd` dependency.
//!
//! These tests prove the dispatch chain through `main()` → `clap` →
//! `cli::dispatch_plugin` → `commands::*::run` works end-to-end. The per-command
//! tests in `crates/cognia-cli/src/commands/*.rs` cover the deeper behavior.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const MOCK_BRIDGE_TIMEOUT: Duration = Duration::from_secs(15);

/// Resolve the path to the just-built `cognia` binary.
fn cognia_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_cognia"))
}

/// Run `cognia <args>` with `NO_COLOR=1` (deterministic stdout) and
/// `CI=true` (forces the non-interactive prompter path). Returns
/// `(status_code, stdout, stderr)`.
fn run_cognia(args: &[&str]) -> (Option<i32>, String, String) {
    run_cognia_with_env(args, &[])
}

fn run_cognia_with_env(args: &[&str], envs: &[(&str, &str)]) -> (Option<i32>, String, String) {
    let mut cmd = Command::new(cognia_bin());
    cmd.args(args)
        .env("NO_COLOR", "1")
        .env("CI", "true")
        .env_remove("FORCE_COLOR")
        .stdin(Stdio::null());
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let out = cmd.output().expect("spawn cognia");
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// Like `run_cognia`, but runs with `dir` as the working directory (for
/// commands like `doctor` that inspect the current directory).
fn run_cognia_in_dir(dir: &Path, args: &[&str]) -> (Option<i32>, String, String) {
    let mut cmd = Command::new(cognia_bin());
    cmd.args(args)
        .current_dir(dir)
        .env("NO_COLOR", "1")
        .env("CI", "true")
        .env_remove("FORCE_COLOR")
        .stdin(Stdio::null());
    let out = cmd.output().expect("spawn cognia");
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

fn write_minimal_python_manifest(dir: &Path, id: &str, version: &str) {
    let manifest = format!(
        r#"{{"id":"{id}","name":"X","version":"{version}","description":"smoke","type":"python","capabilities":["python"],"pythonMain":"main.py"}}"#
    );
    std::fs::write(dir.join("plugin.json"), manifest).unwrap();
}

fn write_minimal_wasm_manifest(dir: &Path, id: &str, version: &str) {
    let manifest = format!(
        r#"{{"id":"{id}","name":"X","version":"{version}","description":"smoke","type":"wasm","capabilities":["tools"],"wasmMain":"demo.wasm","wasm":{{"apiVersion":"0.1.0"}}}}"#
    );
    std::fs::write(dir.join("plugin.json"), manifest).unwrap();
}

fn minimal_wasm_module() -> Vec<u8> {
    vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
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

fn write_endpoint_file(path: &Path, base_url: &str) {
    let payload = serde_json::json!({
        "baseUrl": base_url,
        "devToken": "tok"
    });
    std::fs::write(path, serde_json::to_vec(&payload).unwrap()).unwrap();
}

fn read_request_body(req: &mut tiny_http::Request) -> serde_json::Value {
    let mut body = String::new();
    std::io::Read::read_to_string(req.as_reader(), &mut body).unwrap();
    serde_json::from_str(&body).unwrap()
}

fn json_response(body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
    )
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
    for command in ["acp", "release-key", "release-verify"] {
        assert!(
            stdout.contains(command),
            "top-level help missing {command}: {stdout}"
        );
    }
}

#[test]
fn plugin_group_help_mentions_every_public_subcommand() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for command in [
        "new",
        "import",
        "lint",
        "build",
        "info",
        "sign",
        "verify",
        "keygen",
        "install",
        "uninstall",
        "list",
        "reload",
        "status",
        "dev",
        "embed-version",
    ] {
        assert!(
            stdout.contains(command),
            "plugin group help missing {command}: {stdout}"
        );
    }
}

#[test]
fn version_flag_prints_semver_string() {
    let (code, stdout, _stderr) = run_cognia(&["--version"]);
    assert_eq!(code, Some(0));
    // Cargo embeds the crate's version; we don't pin a specific one here.
    assert!(stdout.contains("cognia"), "got: {stdout}");
}

#[test]
fn acp_quiet_suppresses_connection_status_without_polluting_protocol_stdout() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_thread = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        loop {
            match ws.read() {
                Ok(tungstenite::Message::Close(_)) => {
                    let _ = ws.close(None);
                    break;
                }
                Ok(_) => {}
                Err(tungstenite::Error::ConnectionClosed)
                | Err(tungstenite::Error::AlreadyClosed) => break,
                Err(err) => panic!("unexpected ACP test websocket error: {err}"),
            }
        }
    });
    let ws_url = format!("ws://127.0.0.1:{port}/ws/v1/acp");

    let (code, stdout, stderr) = run_cognia_with_env(
        &["--quiet", "acp"],
        &[
            ("COGNIA_ACP_URL", ws_url.as_str()),
            ("COGNIA_ACP_TOKEN", "tok"),
        ],
    );
    let _ = server_thread.join();

    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.trim().is_empty(),
        "ACP protocol stdout should stay empty when the server sends no frames: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet ACP should suppress connection status on stderr: {stderr}"
    );
}

#[test]
fn acp_help_is_available() {
    let (code, stdout, stderr) = run_cognia(&["acp", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("ACP") || stdout.contains("acp"),
        "help should describe the ACP bridge: {stdout}"
    );
    assert!(
        stdout.contains("--quiet"),
        "global quiet flag should be visible on ACP help: {stdout}"
    );
}

#[test]
fn release_key_help_is_available() {
    let (code, stdout, stderr) = run_cognia(&["release-key", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(stdout.contains("--json"), "missing json flag: {stdout}");
    assert!(
        stdout.contains("release"),
        "help should describe release-key status: {stdout}"
    );
}

#[test]
fn release_key_json_reports_placeholder_status_and_fingerprint() {
    let (code, stdout, stderr) = run_cognia(&["release-key", "--json"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("release-key --json should emit valid JSON");

    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "release-key");
    assert_eq!(parsed["placeholder"], true);
    assert_eq!(parsed["publicKey"].as_str().unwrap().len(), 44);
    assert_eq!(parsed["fingerprint"].as_str().unwrap().len(), 64);
    assert_eq!(
        parsed["signaturePolicy"],
        "sha256-only-until-release-key-is-provisioned"
    );
    assert!(
        !stdout.contains("Release key"),
        "stdout must be JSON only: {stdout}"
    );
}

#[test]
fn release_verify_help_is_available() {
    let (code, stdout, stderr) = run_cognia(&["release-verify", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("--checksums"),
        "missing checksums flag: {stdout}"
    );
    assert!(
        stdout.contains("--artifact-name"),
        "missing artifact-name flag: {stdout}"
    );
    assert!(
        stdout.contains("--signature"),
        "missing signature flag: {stdout}"
    );
    assert!(
        stdout.contains("Defaults to"),
        "signature help should mention a default sidecar path: {stdout}"
    );
    assert!(
        stdout.contains("<artifact>.sig"),
        "signature help should document the default sidecar path: {stdout}"
    );
    assert!(stdout.contains("--json"), "missing json flag: {stdout}");
}

#[test]
fn release_verify_json_reports_checksum_success_and_skipped_signature_for_placeholder_key() {
    let tmp = tempfile::tempdir().unwrap();
    let artifact = tmp.path().join("cognia-x86_64-pc-windows-msvc.tar.gz");
    let artifact_bytes = b"release artifact bytes\n";
    std::fs::write(&artifact, artifact_bytes).unwrap();
    let expected_sha256 = sha256_hex(artifact_bytes);
    let checksums = tmp.path().join("checksums.txt");
    std::fs::write(
        &checksums,
        format!("{expected_sha256}  cognia-x86_64-pc-windows-msvc.tar.gz\n"),
    )
    .unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
        "--json",
    ]);

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("release-verify --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "release-verify");
    assert_eq!(
        parsed["artifact"].as_str(),
        Some(artifact.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["artifactName"],
        "cognia-x86_64-pc-windows-msvc.tar.gz"
    );
    assert_eq!(
        parsed["checksums"].as_str(),
        Some(checksums.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["expectedSha256"], expected_sha256);
    assert_eq!(parsed["actualSha256"], expected_sha256);
    assert_eq!(parsed["checksumVerified"], true);
    assert_eq!(parsed["signature"], serde_json::Value::Null);
    assert_eq!(parsed["signatureVerified"], false);
    assert_eq!(parsed["signatureStatus"], "skipped-placeholder-key");
    assert_eq!(parsed["releaseKeyPlaceholder"], true);
    assert_eq!(parsed["releaseKeyFingerprint"].as_str().unwrap().len(), 64);
    assert!(
        !stdout.contains("checksum verified"),
        "stdout must be JSON only: {stdout}"
    );
}

#[test]
fn release_verify_json_uses_artifact_name_override_for_checksum_lookup() {
    let tmp = tempfile::tempdir().unwrap();
    let artifact = tmp.path().join("downloaded.tar.gz");
    let artifact_bytes = b"release artifact bytes\n";
    std::fs::write(&artifact, artifact_bytes).unwrap();
    let expected_sha256 = sha256_hex(artifact_bytes);
    let checksums = tmp.path().join("checksums.txt");
    std::fs::write(
        &checksums,
        format!("{expected_sha256}  cognia-x86_64-pc-windows-msvc.tar.gz\n"),
    )
    .unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
        "--artifact-name",
        "cognia-x86_64-pc-windows-msvc.tar.gz",
        "--json",
    ]);

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("release-verify --json should emit valid JSON");
    assert_eq!(
        parsed["artifactName"],
        "cognia-x86_64-pc-windows-msvc.tar.gz"
    );
    assert_eq!(parsed["expectedSha256"], expected_sha256);
    assert_eq!(parsed["checksumVerified"], true);
    assert_eq!(parsed["signatureStatus"], "skipped-placeholder-key");
}

#[test]
fn release_verify_json_rejects_path_artifact_name_override() {
    let tmp = tempfile::tempdir().unwrap();
    let artifact = tmp.path().join("downloaded.tar.gz");
    let artifact_bytes = b"release artifact bytes\n";
    std::fs::write(&artifact, artifact_bytes).unwrap();
    let checksums = tmp.path().join("checksums.txt");
    std::fs::write(
        &checksums,
        format!(
            "{}  cognia-x86_64-pc-windows-msvc.tar.gz\n",
            sha256_hex(artifact_bytes)
        ),
    )
    .unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
        "--artifact-name",
        "dist/cognia-x86_64-pc-windows-msvc.tar.gz",
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "release-verify should fail when artifact-name is a path"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("release-verify invalid artifact-name should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "release-verify");
    assert_eq!(
        parsed["artifactName"],
        "dist/cognia-x86_64-pc-windows-msvc.tar.gz"
    );
    assert_eq!(parsed["actualSha256"], "");
    assert_eq!(parsed["expectedSha256"], serde_json::Value::Null);
    assert_eq!(parsed["checksumVerified"], false);
    assert_eq!(parsed["signatureStatus"], "not-checked");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("artifact name"),
        "payload should carry artifact-name validation error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "release-verify --json artifact-name failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn release_verify_json_reports_checksum_mismatch_as_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let artifact = tmp.path().join("cognia-x86_64-pc-windows-msvc.tar.gz");
    let artifact_bytes = b"release artifact bytes\n";
    std::fs::write(&artifact, artifact_bytes).unwrap();
    let checksums = tmp.path().join("checksums.txt");
    let wrong_sha256 = "0".repeat(64);
    std::fs::write(
        &checksums,
        format!("{wrong_sha256}  cognia-x86_64-pc-windows-msvc.tar.gz\n"),
    )
    .unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "release-verify should fail for checksum mismatch"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("release-verify --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "release-verify");
    assert_eq!(parsed["expectedSha256"], wrong_sha256);
    assert_eq!(parsed["actualSha256"], sha256_hex(artifact_bytes));
    assert_eq!(parsed["checksumVerified"], false);
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("checksum mismatch"),
        "payload should carry checksum mismatch: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "release-verify --json failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn release_verify_json_reports_missing_checksum_entry_as_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let artifact = tmp.path().join("cognia-x86_64-pc-windows-msvc.tar.gz");
    let artifact_bytes = b"release artifact bytes\n";
    std::fs::write(&artifact, artifact_bytes).unwrap();
    let checksums = tmp.path().join("checksums.txt");
    std::fs::write(
        &checksums,
        format!(
            "{}  cognia-aarch64-apple-darwin.tar.gz\n",
            sha256_hex(artifact_bytes)
        ),
    )
    .unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "release-verify should fail when checksums.txt lacks the artifact"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("release-verify missing checksum should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "release-verify");
    assert_eq!(parsed["expectedSha256"], serde_json::Value::Null);
    assert_eq!(parsed["actualSha256"], sha256_hex(artifact_bytes));
    assert_eq!(parsed["checksumVerified"], false);
    assert_eq!(parsed["signatureStatus"], "not-checked");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no checksum for cognia-x86_64-pc-windows-msvc.tar.gz"),
        "payload should carry missing checksum error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "release-verify --json missing-checksum payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn release_verify_json_missing_artifact_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let artifact = tmp.path().join("missing-artifact.tar.gz");
    let checksums = tmp.path().join("checksums.txt");
    std::fs::write(
        &checksums,
        format!("{}  missing-artifact.tar.gz\n", "0".repeat(64)),
    )
    .unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "release-verify should fail when the artifact cannot be read"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("release-verify --json read failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "release-verify");
    assert_eq!(
        parsed["artifact"].as_str(),
        Some(artifact.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["artifactName"], "missing-artifact.tar.gz",
        "payload should preserve the default artifact name even when the file is unreadable"
    );
    assert_eq!(
        parsed["checksums"].as_str(),
        Some(checksums.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["checksumVerified"], false);
    assert_eq!(parsed["signatureStatus"], "not-checked");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("read"),
        "payload should carry file read error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON read failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn release_verify_json_missing_artifact_name_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let artifact = tmp.path().ancestors().last().unwrap();
    let checksums = tmp.path().join("checksums.txt");
    std::fs::write(&checksums, "").unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "release-verify should fail when artifact name cannot be inferred"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("release-verify --json input failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "release-verify");
    assert_eq!(
        parsed["artifact"].as_str(),
        Some(artifact.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["artifactName"], "");
    assert_eq!(
        parsed["checksums"].as_str(),
        Some(checksums.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["checksumVerified"], false);
    assert_eq!(parsed["signatureStatus"], "not-checked");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("artifact name"),
        "payload should carry the missing artifact-name error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "release-verify --json input failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn release_verify_json_missing_checksums_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let artifact = tmp.path().join("cognia-x86_64-pc-windows-msvc.tar.gz");
    let artifact_bytes = b"release artifact bytes\n";
    std::fs::write(&artifact, artifact_bytes).unwrap();
    let checksums = tmp.path().join("missing-checksums.txt");

    let (code, stdout, stderr) = run_cognia(&[
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "release-verify should fail when checksums.txt cannot be read"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("release-verify --json checksums read failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "release-verify");
    assert_eq!(parsed["actualSha256"], sha256_hex(artifact_bytes));
    assert_eq!(parsed["expectedSha256"], serde_json::Value::Null);
    assert_eq!(parsed["checksumVerified"], false);
    assert_eq!(parsed["signatureStatus"], "not-checked");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("read"),
        "payload should carry checksums read error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON read failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_doctor_json_reports_checks() {
    let tmp = tempfile::tempdir().unwrap();
    // A non-plugin directory has no project checks, so nothing can hard-fail
    // (environment gaps are warnings) → exit 0.
    let (code, stdout, _stderr) = run_cognia_in_dir(tmp.path(), &["plugin", "doctor", "--json"]);
    assert_eq!(
        code,
        Some(0),
        "doctor in a clean dir should exit 0: {stdout}"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("doctor --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["action"], "doctor");
    assert_eq!(parsed["ok"], true);
    let checks = parsed["checks"].as_array().expect("checks is an array");
    assert!(
        !checks.is_empty(),
        "doctor should run at least the env checks"
    );
    assert!(
        checks
            .iter()
            .all(|c| c["name"].is_string() && c["status"].is_string()),
        "each check carries a name + status: {parsed}"
    );
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
    assert_eq!(parsed["schemaVersion"], serde_json::Value::Number(2.into()));
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "lint");
    assert_eq!(parsed["valid"], serde_json::Value::Bool(true));
    // Unified shape (W2.5): camelCase manifestPath + always-present stage.
    assert_eq!(parsed["stage"], "validate");
    assert!(
        parsed["manifestPath"].is_string(),
        "success payload must carry manifestPath: {parsed}"
    );
}

#[test]
fn lint_warnings_as_errors_flips_the_exit() {
    let tmp = tempfile::tempdir().unwrap();
    // Exactly one warning (name > 50 chars) and no errors; empty capabilities
    // avoids the field cross-check.
    let manifest = format!(
        r#"{{"id":"warnprobe","name":"{}","version":"0.1.0","description":"smoke","type":"frontend","capabilities":[],"main":"dist/index.js"}}"#,
        "a".repeat(60)
    );
    std::fs::write(tmp.path().join("plugin.json"), manifest).unwrap();
    let path = tmp.path().to_str().unwrap();

    // Default: a warning does not gate.
    let (code, _o, _e) = run_cognia(&["plugin", "lint", "--path", path]);
    assert_eq!(code, Some(0), "a warning alone must not fail lint");

    // -W: the same warning gates.
    let (code_w, _o, _e) = run_cognia(&["plugin", "lint", "--path", path, "-W"]);
    assert_ne!(
        code_w,
        Some(0),
        "--warnings-as-errors must fail on a warning"
    );

    // The payload marks the run not-ok while the manifest stays valid.
    let (_c, stdout, _e) = run_cognia(&["plugin", "lint", "--path", path, "-W", "--json"]);
    let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(parsed["schemaVersion"], 2);
    assert_eq!(parsed["valid"], true, "no errors → manifest is valid");
    assert_eq!(parsed["ok"], false, "-W escalates the warning → run not ok");
}

#[test]
fn lint_json_failure_exits_nonzero_without_extra_error_report() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("plugin.json"), r#"{"id":"x"}"#).unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "lint",
        "--path",
        tmp.path().to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(code, Some(0), "lint should fail on broken manifest");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("lint --json failure should emit valid JSON only");
    assert_eq!(parsed["schemaVersion"], 2);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "lint");
    assert_eq!(parsed["valid"], false);
    assert!(
        parsed["diagnostics"].as_array().unwrap().len() >= 4,
        "expected manifest diagnostics in payload: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "lint diagnostics are already in stdout; stderr should not get an extra fatal report: {stderr}"
    );
}

#[test]
fn plugin_lint_json_missing_path_emits_input_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("missing-plugin");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "lint",
        "--path",
        missing.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(code, Some(0), "lint should fail for a missing plugin path");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("lint --json input failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 2);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "lint");
    assert_eq!(parsed["stage"], "input");
    // Unified with the success payload: the failed manifest path is under
    // `manifestPath` (was `path`), so a consumer reads one key on both shapes.
    assert_eq!(
        parsed["manifestPath"].as_str(),
        Some(missing.to_string_lossy().as_ref())
    );
    assert!(!parsed["valid"].as_bool().unwrap_or(true));
    assert!(
        parsed["diagnostics"]
            .as_array()
            .expect("diagnostics should be an array")
            .iter()
            .any(|diag| diag["code"] == "lint.input.unreadable"),
        "payload should carry an input diagnostic: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "lint --json input failure payload is already actionable; stderr should stay empty: {stderr}"
    );
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
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "info");
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
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "info");
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
fn plugin_info_json_missing_path_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("missing.zip");

    let (code, stdout, stderr) =
        run_cognia(&["plugin", "info", missing.to_str().unwrap(), "--json"]);

    assert_ne!(code, Some(0), "info should fail for a missing input path");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("info --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "info");
    assert_eq!(parsed["stage"], "inspect");
    assert_eq!(
        parsed["path"].as_str(),
        Some(missing.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("stat"),
        "payload should carry the missing path error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "info --json failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn verbose_emits_human_diagnostics_without_polluting_quiet_or_json() {
    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("verbose-info.zip");
    write_real_bundle(
        &bundle,
        r#"{"id":"verbose-info","name":"Verbose","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js"}"#,
    );

    let (code, stdout, stderr) = run_cognia(&[
        "--verbose",
        "plugin",
        "info",
        bundle.to_str().unwrap(),
        "--detailed",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("Manifest") && stdout.contains("Files:"),
        "verbose human info should preserve normal stdout report: {stdout}"
    );
    assert!(
        stderr.contains("cognia: running plugin info"),
        "verbose human info should emit a command diagnostic on stderr: {stderr}"
    );
    assert!(
        stderr.contains("detailed=true"),
        "verbose info diagnostic should include useful option context: {stderr}"
    );

    let (code, stdout, stderr) = run_cognia(&[
        "--verbose",
        "plugin",
        "info",
        bundle.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    serde_json::from_str::<serde_json::Value>(&stdout)
        .expect("verbose info --json should keep stdout parseable");
    assert!(
        stderr.trim().is_empty(),
        "verbose must not pollute JSON-mode stderr: {stderr}"
    );

    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "--verbose",
        "plugin",
        "info",
        bundle.to_str().unwrap(),
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.trim().is_empty(),
        "quiet should still suppress human stdout under verbose: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet should suppress verbose diagnostics: {stderr}"
    );
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
fn plugin_new_help_mentions_author_keygen_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "new", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in [
        "--kind",
        "--author",
        "--author-email",
        "--description",
        "--with-keygen",
        "--json",
    ] {
        assert!(stdout.contains(flag), "new help missing {flag}: {stdout}");
    }
}

#[test]
fn plugin_lint_help_mentions_path_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "lint", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in ["--path", "--json"] {
        assert!(stdout.contains(flag), "lint help missing {flag}: {stdout}");
    }
}

#[test]
fn plugin_build_help_mentions_path_out_skip_build_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "build", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in ["--path", "--out", "--skip-build", "--json"] {
        assert!(stdout.contains(flag), "build help missing {flag}: {stdout}");
    }
}

#[test]
fn plugin_sign_help_mentions_key_out_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "sign", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in ["--key", "--out", "--json"] {
        assert!(stdout.contains(flag), "sign help missing {flag}: {stdout}");
    }
}

#[test]
fn plugin_verify_help_mentions_public_key_signature_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "verify", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in ["--public-key", "--signature", "--json"] {
        assert!(
            stdout.contains(flag),
            "verify help missing {flag}: {stdout}"
        );
    }
}

#[test]
fn plugin_keygen_help_mentions_out_dir_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "keygen", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in ["--out-dir", "--json"] {
        assert!(
            stdout.contains(flag),
            "keygen help missing {flag}: {stdout}"
        );
    }
}

#[test]
fn plugin_dev_help_mentions_path_reload_url_once_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "dev", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in ["--path", "--reload-url", "--once", "--json"] {
        assert!(stdout.contains(flag), "dev help missing {flag}: {stdout}");
    }
}

#[test]
fn plugin_embed_version_help_mentions_out_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "embed-version", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in ["--out", "--json"] {
        assert!(
            stdout.contains(flag),
            "embed-version help missing {flag}: {stdout}"
        );
    }
}

#[test]
fn quiet_suppresses_local_success_output_without_hiding_side_effects() {
    let lint_dir = tempfile::tempdir().unwrap();
    write_minimal_manifest(lint_dir.path(), "quiet-lint");
    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "plugin",
        "lint",
        "--path",
        lint_dir.path().to_str().unwrap(),
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.trim().is_empty(),
        "quiet lint success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet lint success should not print stderr: {stderr}"
    );

    let info_dir = tempfile::tempdir().unwrap();
    let bundle = info_dir.path().join("quiet-info.zip");
    write_real_bundle(
        &bundle,
        r#"{"id":"quiet-info","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js"}"#,
    );
    let (code, stdout, stderr) =
        run_cognia(&["--quiet", "plugin", "info", bundle.to_str().unwrap()]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.trim().is_empty(),
        "quiet info success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet info success should not print stderr: {stderr}"
    );

    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("quiet-new");
    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "plugin",
        "new",
        "quiet-new",
        "--dir",
        target.to_str().unwrap(),
        "--kind",
        "python",
        "--author",
        "Quiet Tester",
        "--description",
        "quiet",
        "--with-keygen",
        "false",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(target.join("plugin.json").exists());
    assert!(target.join("main.py").exists());
    assert!(
        stdout.trim().is_empty(),
        "quiet new success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet new success should not print stderr: {stderr}"
    );

    let build_dir = tempfile::tempdir().unwrap();
    write_minimal_python_manifest(build_dir.path(), "quiet-build", "0.1.0");
    std::fs::write(build_dir.path().join("main.py"), "print('quiet')\n").unwrap();
    let expected_bundle = build_dir
        .path()
        .join("target")
        .join("cognia")
        .join("quiet-build-0.1.0.zip");
    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "plugin",
        "build",
        "--path",
        build_dir.path().to_str().unwrap(),
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(expected_bundle.exists());
    assert!(
        stdout.trim().is_empty(),
        "quiet build success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet build success should not print stderr: {stderr}"
    );

    let wasm = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(wasm.path(), minimal_wasm_module()).unwrap();
    let patched_wasm = build_dir.path().join("quiet-version.wasm");
    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "plugin",
        "embed-version",
        wasm.path().to_str().unwrap(),
        "1.2.3",
        "--out",
        patched_wasm.to_str().unwrap(),
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(patched_wasm.exists());
    assert!(
        stdout.trim().is_empty(),
        "quiet embed-version success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet embed-version success should not print stderr: {stderr}"
    );

    let key_root = tempfile::tempdir().unwrap();
    let key_dir = key_root.path().join("keys");
    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "plugin",
        "keygen",
        "--out-dir",
        key_dir.to_str().unwrap(),
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(key_dir.join("plugin.private.b64").exists());
    assert!(key_dir.join("plugin.public.b64").exists());
    assert!(
        stdout.trim().is_empty(),
        "quiet keygen success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet keygen success should not print stderr: {stderr}"
    );
}

#[test]
fn quiet_suppresses_sign_verify_release_success_output_without_hiding_side_effects() {
    let tmp = tempfile::tempdir().unwrap();
    let key_dir = tmp.path().join("keys");
    let (keygen_code, keygen_stdout, keygen_stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        key_dir.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(keygen_code, Some(0), "stderr: {keygen_stderr}");
    let keygen: serde_json::Value =
        serde_json::from_str(&keygen_stdout).expect("keygen --json should emit valid JSON");

    let bundle = tmp.path().join("quiet-sign.zip");
    let manifest = format!(
        r#"{{"id":"quiet-sign","name":"Quiet Sign","version":"0.1.0","description":"quiet","type":"frontend","capabilities":["tools"],"main":"dist/index.js","author":{{"publicKey":"{}"}}}}"#,
        keygen["publicKey"].as_str().unwrap()
    );
    write_real_bundle(&bundle, &manifest);
    let signature = tmp.path().join("quiet-sign.zip.sig");

    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "plugin",
        "sign",
        bundle.to_str().unwrap(),
        "--key",
        key_dir.join("plugin.private.b64").to_str().unwrap(),
        "--out",
        signature.to_str().unwrap(),
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(signature.exists());
    assert!(
        stdout.trim().is_empty(),
        "quiet sign success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet sign success should not print stderr: {stderr}"
    );

    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "plugin",
        "verify",
        bundle.to_str().unwrap(),
        "--signature",
        signature.to_str().unwrap(),
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.trim().is_empty(),
        "quiet verify success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet verify success should not print stderr: {stderr}"
    );

    let (code, stdout, stderr) = run_cognia(&["--quiet", "release-key"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.trim().is_empty(),
        "quiet release-key success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet release-key success should not print stderr: {stderr}"
    );

    let artifact = tmp.path().join("cognia-test.tar.gz");
    let artifact_bytes = b"quiet release artifact";
    std::fs::write(&artifact, artifact_bytes).unwrap();
    let checksums = tmp.path().join("checksums.txt");
    std::fs::write(
        &checksums,
        format!(
            "{}  {}\n",
            sha256_hex(artifact_bytes),
            artifact.file_name().unwrap().to_string_lossy()
        ),
    )
    .unwrap();
    let (code, stdout, stderr) = run_cognia(&[
        "--quiet",
        "release-verify",
        artifact.to_str().unwrap(),
        "--checksums",
        checksums.to_str().unwrap(),
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.trim().is_empty(),
        "quiet release-verify success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet release-verify success should not print stderr: {stderr}"
    );
}

#[test]
fn quiet_suppresses_dev_once_success_output_without_hiding_bundle() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("missing-endpoint.json");
    let plugin_dir = tmp.path().join("plugin");
    std::fs::create_dir(&plugin_dir).unwrap();
    write_minimal_python_manifest(&plugin_dir, "quiet-dev-once", "0.1.0");
    std::fs::write(plugin_dir.join("main.py"), "print('quiet')\n").unwrap();
    let expected_bundle = plugin_dir
        .join("target")
        .join("cognia")
        .join("quiet-dev-once-0.1.0.zip");

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "--quiet",
            "plugin",
            "dev",
            "--path",
            plugin_dir.to_str().unwrap(),
            "--once",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );

    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(expected_bundle.exists());
    assert!(
        stdout.trim().is_empty(),
        "quiet dev --once success should not print stdout: {stdout}"
    );
    assert!(
        stderr.trim().is_empty(),
        "quiet dev --once success should not print stderr: {stderr}"
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
fn plugin_new_json_emits_schema_payload_and_suppresses_human_output() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("json-new");
    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "new",
        "json-new",
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
        "--json",
    ]);

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("new --json should emit valid JSON only");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "new");
    assert_eq!(parsed["pluginId"], "json-new");
    assert_eq!(parsed["pluginType"], "python");
    assert_eq!(
        parsed["directory"].as_str(),
        Some(target.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["manifestPath"].as_str(),
        Some(target.join("plugin.json").to_string_lossy().as_ref())
    );
    assert_eq!(parsed["keygen"]["generated"], false);
    let files = parsed["files"]
        .as_array()
        .expect("files should be an array");
    assert!(files.iter().any(|file| file == "plugin.json"));
    assert!(files.iter().any(|file| file == "main.py"));
    assert!(
        !stdout.contains("Created"),
        "stdout must be JSON only: {stdout}"
    );
    assert!(target.join("plugin.json").exists());
    assert!(target.join("main.py").exists());
}

#[test]
fn plugin_new_json_missing_name_emits_payload_without_human_noise() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("json-new-missing-name");

    let (code, stdout, stderr) =
        run_cognia(&["plugin", "new", "--dir", target.to_str().unwrap(), "--json"]);

    assert_ne!(code, Some(0), "new should fail without a name in CI");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("new --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "new");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(
        parsed["directory"].as_str(),
        Some(target.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("plugin name is required"),
        "payload should carry the input error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "new --json failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_new_json_non_empty_target_emits_payload_without_human_noise() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("occupied-json-new");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("seed.txt"), "seed").unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "new",
        "occupied-json-new",
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
        "--json",
    ]);

    assert_ne!(code, Some(0), "new should fail for a non-empty target dir");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("new --json scaffold failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "new");
    assert_eq!(parsed["stage"], "scaffold");
    assert_eq!(
        parsed["directory"].as_str(),
        Some(target.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("not empty"),
        "payload should carry the scaffold error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "new --json scaffold failure payload is already actionable; stderr should stay empty: {stderr}"
    );
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
fn plugin_list_json_http_failure_emits_bridge_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Get);
            assert_eq!(req.url(), "/api/v1/dev/plugins/installed");
            let response =
                tiny_http::Response::from_string("bridge unavailable").with_status_code(500);
            let _ = req.respond(response);
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &["plugin", "list", "--json"],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(code, Some(0), "list should fail on bridge HTTP errors");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("list --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "list");
    assert_eq!(parsed["stage"], "bridge");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("HTTP 500"),
        "payload should carry bridge HTTP error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON bridge failure should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_list_json_missing_endpoint_emits_endpoint_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("missing-endpoint.json");

    let (code, stdout, stderr) = run_cognia_with_env(
        &["plugin", "list", "--json"],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );

    assert_ne!(
        code,
        Some(0),
        "list should fail when endpoint discovery fails"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("list --json endpoint failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "list");
    assert_eq!(parsed["stage"], "endpoint");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no running cognia detected"),
        "payload should carry endpoint discovery error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON endpoint failure should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_list_json_success_uses_consistent_envelope_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Get);
            assert_eq!(req.url(), "/api/v1/dev/plugins/installed");
            let body = r#"{"ok":true,"plugins":[{"pluginId":"demo","version":"1.2.3","status":"installed","installPath":"C:/plugins/demo"}]}"#;
            let response = tiny_http::Response::from_string(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
            );
            let _ = req.respond(response);
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &["plugin", "list", "--json"],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_eq!(code, Some(0), "list should succeed: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("list --json success should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "list");
    assert_eq!(parsed["plugins"][0]["pluginId"], "demo");
    assert_eq!(parsed["plugins"][0]["installPath"], "C:/plugins/demo");
    assert!(
        stderr.trim().is_empty(),
        "JSON list success should not duplicate human diagnostics on stderr: {stderr}"
    );
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
fn plugin_status_json_unavailable_emits_report_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("missing-endpoint.json");

    let (code, stdout, stderr) = run_cognia_with_env(
        &["plugin", "status", "--json"],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );

    assert_ne!(
        code,
        Some(0),
        "status should fail when the bridge is unavailable"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("status --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "status");
    assert_eq!(parsed["running"], false);
    assert_eq!(
        parsed["endpointFile"].as_str(),
        Some(endpoint_file.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["baseUrl"], serde_json::Value::Null);
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no running cognia detected"),
        "payload should carry unavailable bridge error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "status --json has a structured unavailable report; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_dev_once_json_builds_once_without_starting_watcher() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("missing-endpoint.json");
    let plugin_dir = tmp.path().join("python-plugin");
    std::fs::create_dir(&plugin_dir).unwrap();
    write_minimal_python_manifest(&plugin_dir, "dev-once-json", "0.1.0");
    std::fs::write(plugin_dir.join("main.py"), "print('hello')\n").unwrap();

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "dev",
            "--path",
            plugin_dir.to_str().unwrap(),
            "--once",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );

    assert_eq!(code, Some(0), "dev --once --json should succeed: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("dev --once --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "dev");
    assert_eq!(parsed["mode"], "once");
    assert_eq!(parsed["pluginId"], "dev-once-json");
    assert_eq!(parsed["version"], "0.1.0");
    assert_eq!(parsed["pluginType"], "python");
    assert_eq!(parsed["reload"]["attempted"], false);
    assert_eq!(parsed["reload"]["skippedReason"], "no-endpoint");
    let bundle = parsed["bundle"].as_str().unwrap_or_default();
    assert!(
        bundle.ends_with("target\\cognia\\dev-once-json-0.1.0.zip")
            || bundle.ends_with("target/cognia/dev-once-json-0.1.0.zip"),
        "bundle path should point at the generated package: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "dev --once --json should keep stderr empty on success: {stderr}"
    );
}

#[test]
fn plugin_dev_json_requires_once_with_input_payload_without_human_noise() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "dev", "--json"]);

    assert_ne!(code, Some(0), "dev --json should fail without --once");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("dev --json input failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "dev");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(parsed["mode"], "watch");
    assert_eq!(parsed["path"], ".");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("--once"),
        "payload should carry the once-mode requirement: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "dev --json input failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_dev_once_json_missing_path_emits_input_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("missing-plugin");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "dev",
        "--path",
        missing.to_str().unwrap(),
        "--once",
        "--json",
    ]);

    assert_ne!(code, Some(0), "dev --once should fail for missing paths");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("dev --json path failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "dev");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(parsed["mode"], "once");
    assert_eq!(
        parsed["path"].as_str(),
        Some(missing.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("resolve"),
        "payload should carry the path resolution error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "dev --json path failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_dev_once_json_bridge_rejection_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let plugin_dir = tmp.path().join("python-plugin");
    std::fs::create_dir(&plugin_dir).unwrap();
    write_minimal_python_manifest(&plugin_dir, "dev-once-rejected", "0.1.0");
    std::fs::write(plugin_dir.join("main.py"), "print('hello')\n").unwrap();

    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/reload");
            let body = read_request_body(&mut req);
            assert_eq!(body["plugin_id"], "dev-once-rejected");
            assert!(
                body["bundle_path"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("dev-once-rejected-0.1.0.zip"),
                "reload body should include built bundle path: {body}"
            );
            let _ = req.respond(json_response(
                r#"{"ok":false,"error":"reload target not installed"}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "dev",
            "--path",
            plugin_dir.to_str().unwrap(),
            "--once",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(
        code,
        Some(0),
        "dev --once --json should fail when reload is rejected"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("dev --once --json reload failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "dev");
    assert_eq!(parsed["mode"], "once");
    assert_eq!(parsed["stage"], "reload");
    assert_eq!(parsed["pluginId"], "dev-once-rejected");
    assert_eq!(parsed["version"], "0.1.0");
    assert_eq!(parsed["pluginType"], "python");
    assert_eq!(parsed["reload"]["attempted"], true);
    assert_eq!(parsed["reload"]["ok"], false);
    assert_eq!(parsed["error"], "reload target not installed");
    assert!(
        stderr.trim().is_empty(),
        "dev --once --json reload rejection should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_dev_once_json_build_failure_emits_dev_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("missing-endpoint.json");
    let plugin_dir = tmp.path().join("broken-plugin");
    std::fs::create_dir(&plugin_dir).unwrap();
    std::fs::write(plugin_dir.join("plugin.json"), r#"{"id":"x"}"#).unwrap();

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "dev",
            "--path",
            plugin_dir.to_str().unwrap(),
            "--once",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );

    assert_ne!(
        code,
        Some(0),
        "dev --once should fail when the nested build fails"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("dev --json build failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "dev");
    assert_eq!(parsed["mode"], "once");
    assert_eq!(parsed["stage"], "build");
    assert_eq!(
        parsed["path"].as_str(),
        Some(
            plugin_dir
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        )
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("manifest lint failed"),
        "payload should label the manifest lint failure: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "dev --json build failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_install_help_mentions_bundle_or_directory() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "install", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("bundle") && stdout.contains("directory"),
        "install help should mention both supported input forms, got: {stdout}"
    );
    assert!(stdout.contains("--json"), "missing json flag in: {stdout}");
}

#[test]
fn plugin_uninstall_help_mentions_purge_data_and_json_flags() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "uninstall", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(
        stdout.contains("<PLUGIN_ID>") || stdout.contains("PLUGIN_ID"),
        "uninstall help should mention the plugin id argument, got: {stdout}"
    );
    for flag in ["--purge-data", "--json"] {
        assert!(
            stdout.contains(flag),
            "uninstall help missing {flag}: {stdout}"
        );
    }
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

#[test]
fn plugin_install_json_emits_schema_payload_for_directory_install() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join("plugin");
    std::fs::create_dir_all(plugin_dir.join("dist")).unwrap();
    write_minimal_manifest(&plugin_dir, "json-install");
    std::fs::write(plugin_dir.join("dist").join("index.js"), "console.log(1)").unwrap();

    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_plugin_dir = plugin_dir.clone();
    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Get);
            assert_eq!(req.url(), "/api/v1/dev/plugins/installed");
            let _ = req.respond(json_response(r#"{"ok":true,"plugins":[]}"#));
        }
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/install-directory");
            let body = read_request_body(&mut req);
            assert_eq!(
                body["source_dir"],
                server_plugin_dir
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            );
            let _ = req.respond(json_response(
                r#"{"ok":true,"pluginId":"json-install","warnings":["reload recommended"]}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "install",
            plugin_dir.to_str().unwrap(),
            "--json",
            "--yes",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("install --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "install");
    assert_eq!(parsed["pluginId"], "json-install");
    assert_eq!(parsed["inputKind"], "directory");
    assert_eq!(parsed["warnings"][0], "reload recommended");
}

#[test]
fn plugin_install_json_keeps_local_preflight_warnings_in_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join("plugin");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(plugin_dir.join("plugin.json"), "{not json").unwrap();

    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_plugin_dir = plugin_dir.clone();
    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/install-directory");
            let body = read_request_body(&mut req);
            assert_eq!(
                body["source_dir"],
                server_plugin_dir
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            );
            let _ = req.respond(json_response(
                r#"{"ok":true,"pluginId":"json-install-local-warning","warnings":["bridge warning"]}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "install",
            plugin_dir.to_str().unwrap(),
            "--json",
            "--yes",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("install --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "install");
    assert_eq!(parsed["pluginId"], "json-install-local-warning");
    assert_eq!(parsed["inputKind"], "directory");
    let warnings = parsed["warnings"]
        .as_array()
        .expect("warnings should be an array");
    assert!(
        warnings
            .iter()
            .any(|warning| warning.as_str() == Some("bridge warning")),
        "bridge warning missing from payload: {parsed}"
    );
    assert!(
        warnings.iter().any(|warning| {
            warning
                .as_str()
                .unwrap_or_default()
                .contains("could not pre-read bundle manifest")
        }),
        "local preflight warning missing from payload: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON mode should keep local preflight warnings in stdout payload only: {stderr}"
    );
}

#[test]
fn plugin_install_json_failure_emits_bridge_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join("plugin");
    std::fs::create_dir_all(plugin_dir.join("dist")).unwrap();
    write_minimal_manifest(&plugin_dir, "json-install-rejected");
    std::fs::write(plugin_dir.join("dist").join("index.js"), "console.log(1)").unwrap();

    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Get);
            assert_eq!(req.url(), "/api/v1/dev/plugins/installed");
            let _ = req.respond(json_response(r#"{"ok":true,"plugins":[]}"#));
        }
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/install-directory");
            let _ = req.respond(json_response(
                r#"{"ok":false,"error":"manifest invalid: missing contribution"}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "install",
            plugin_dir.to_str().unwrap(),
            "--json",
            "--yes",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(code, Some(0), "install should fail on bridge rejection");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("install --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "install");
    assert_eq!(parsed["stage"], "bridge");
    assert_eq!(parsed["inputKind"], "directory");
    assert_eq!(
        parsed["error"].as_str(),
        Some("manifest invalid: missing contribution")
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON bridge rejection should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_install_json_http_failure_emits_bridge_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join("plugin");
    std::fs::create_dir_all(plugin_dir.join("dist")).unwrap();
    write_minimal_manifest(&plugin_dir, "json-install-http-failure");
    std::fs::write(plugin_dir.join("dist").join("index.js"), "console.log(1)").unwrap();

    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Get);
            assert_eq!(req.url(), "/api/v1/dev/plugins/installed");
            let _ = req.respond(json_response(r#"{"ok":true,"plugins":[]}"#));
        }
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/install-directory");
            let response =
                tiny_http::Response::from_string("bridge write failed").with_status_code(500);
            let _ = req.respond(response);
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "install",
            plugin_dir.to_str().unwrap(),
            "--json",
            "--yes",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(code, Some(0), "install should fail on bridge HTTP errors");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("install --json HTTP failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "install");
    assert_eq!(parsed["stage"], "bridge");
    assert_eq!(parsed["inputKind"], "directory");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("HTTP 500"),
        "payload should carry bridge HTTP error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON bridge HTTP failure should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_install_json_missing_endpoint_emits_endpoint_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join("plugin");
    std::fs::create_dir_all(plugin_dir.join("dist")).unwrap();
    write_minimal_manifest(&plugin_dir, "json-install-missing-endpoint");
    std::fs::write(plugin_dir.join("dist").join("index.js"), "console.log(1)").unwrap();
    let endpoint_file = tmp.path().join("missing-endpoint.json");

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "install",
            plugin_dir.to_str().unwrap(),
            "--json",
            "--yes",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );

    assert_ne!(
        code,
        Some(0),
        "install should fail when endpoint discovery fails"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("install --json endpoint failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "install");
    assert_eq!(parsed["stage"], "endpoint");
    assert_eq!(parsed["inputKind"], "directory");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no running cognia detected"),
        "payload should carry endpoint discovery error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON endpoint failure should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_install_json_missing_path_emits_input_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("missing-plugin.zip");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "install",
        missing.to_str().unwrap(),
        "--json",
        "--yes",
    ]);

    assert_ne!(code, Some(0), "install should fail for a missing input");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("install --json input failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "install");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(parsed["inputKind"], "unknown");
    assert_eq!(
        parsed["path"].as_str(),
        Some(missing.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("resolve"),
        "payload should carry the input resolution error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "install --json input failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_install_json_replace_prompt_abort_emits_confirm_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join("plugin");
    std::fs::create_dir_all(plugin_dir.join("dist")).unwrap();
    write_minimal_manifest(&plugin_dir, "json-install-confirm");
    std::fs::write(plugin_dir.join("dist").join("index.js"), "console.log(1)").unwrap();

    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Get);
            assert_eq!(req.url(), "/api/v1/dev/plugins/installed");
            let _ = req.respond(json_response(
                r#"{"ok":true,"plugins":[{"pluginId":"json-install-confirm","version":"0.0.1","status":"installed","installPath":"/p"}]}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &["plugin", "install", plugin_dir.to_str().unwrap(), "--json"],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(
        code,
        Some(0),
        "install should fail when replacement is not confirmed"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("install --json confirm failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "install");
    assert_eq!(parsed["stage"], "confirm");
    assert_eq!(parsed["inputKind"], "directory");
    assert_eq!(
        parsed["path"].as_str(),
        Some(
            plugin_dir
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        )
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("--yes"),
        "payload should carry the noninteractive confirmation hint: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "install --json confirm failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_uninstall_json_emits_schema_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/uninstall");
            let body = read_request_body(&mut req);
            assert_eq!(body["plugin_id"], "json-uninstall");
            assert_eq!(body["purge_data"], false);
            let _ = req.respond(json_response(r#"{"ok":true}"#));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &["plugin", "uninstall", "json-uninstall", "--json"],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("uninstall --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "uninstall");
    assert_eq!(parsed["pluginId"], "json-uninstall");
    assert_eq!(parsed["purgeData"], false);
}

#[test]
fn plugin_uninstall_json_failure_emits_bridge_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/uninstall");
            let body = read_request_body(&mut req);
            assert_eq!(body["plugin_id"], "missing-plugin");
            assert_eq!(body["purge_data"], false);
            let _ = req.respond(json_response(
                r#"{"ok":false,"error":"plugin not installed"}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &["plugin", "uninstall", "missing-plugin", "--json"],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(code, Some(0), "uninstall should fail on bridge rejection");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("uninstall --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "uninstall");
    assert_eq!(parsed["stage"], "bridge");
    assert_eq!(parsed["pluginId"], "missing-plugin");
    assert_eq!(parsed["purgeData"], false);
    assert_eq!(parsed["error"].as_str(), Some("plugin not installed"));
    assert!(
        stderr.trim().is_empty(),
        "JSON bridge rejection should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_uninstall_json_http_failure_emits_bridge_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/uninstall");
            let body = read_request_body(&mut req);
            assert_eq!(body["plugin_id"], "json-uninstall-http-failure");
            assert_eq!(body["purge_data"], false);
            let response =
                tiny_http::Response::from_string("bridge write failed").with_status_code(500);
            let _ = req.respond(response);
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "uninstall",
            "json-uninstall-http-failure",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(code, Some(0), "uninstall should fail on bridge HTTP errors");
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("uninstall --json HTTP failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "uninstall");
    assert_eq!(parsed["stage"], "bridge");
    assert_eq!(parsed["pluginId"], "json-uninstall-http-failure");
    assert_eq!(parsed["purgeData"], false);
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("HTTP 500"),
        "payload should carry bridge HTTP error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON bridge HTTP failure should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_uninstall_json_missing_endpoint_emits_endpoint_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("missing-endpoint.json");

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "uninstall",
            "json-uninstall-missing-endpoint",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );

    assert_ne!(
        code,
        Some(0),
        "uninstall should fail when endpoint discovery fails"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("uninstall --json endpoint failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "uninstall");
    assert_eq!(parsed["stage"], "endpoint");
    assert_eq!(parsed["pluginId"], "json-uninstall-missing-endpoint");
    assert_eq!(parsed["purgeData"], false);
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no running cognia detected"),
        "payload should carry endpoint discovery error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON endpoint failure should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_uninstall_json_empty_plugin_id_emits_input_payload_without_human_noise() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "uninstall", "", "--json"]);

    assert_ne!(
        code,
        Some(0),
        "uninstall should fail for an empty plugin id"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("uninstall --json input failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "uninstall");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(parsed["pluginId"], "");
    assert_eq!(parsed["purgeData"], false);
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("plugin_id is empty"),
        "payload should carry the empty id error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "uninstall --json input failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_uninstall_json_purge_prompt_abort_emits_confirm_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Get);
            assert_eq!(req.url(), "/api/v1/dev/plugins/installed");
            let _ = req.respond(json_response(
                r#"{"ok":true,"plugins":[{"pluginId":"json-uninstall-confirm","version":"1.0.0","status":"installed","installPath":"/p"}]}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "uninstall",
            "json-uninstall-confirm",
            "--purge-data",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(
        code,
        Some(0),
        "uninstall should fail when purge is not confirmed"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("uninstall --json confirm failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "uninstall");
    assert_eq!(parsed["stage"], "confirm");
    assert_eq!(parsed["pluginId"], "json-uninstall-confirm");
    assert_eq!(parsed["purgeData"], true);
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("--yes"),
        "payload should carry the noninteractive confirmation hint: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "uninstall --json confirm failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_reload_json_emits_schema_payload_for_path_alias() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join("plugin");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    write_minimal_manifest(&plugin_dir, "json-reload");

    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_plugin_dir = plugin_dir.clone();
    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/reload");
            let body = read_request_body(&mut req);
            assert_eq!(
                body["source_dir"],
                server_plugin_dir
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            );
            let _ = req.respond(json_response(
                r#"{"ok":true,"pluginId":"json-reload","warnings":["hot reload complete"]}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "reload",
            "--path",
            plugin_dir.to_str().unwrap(),
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("reload --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "reload");
    assert_eq!(parsed["pluginId"], "json-reload");
    assert_eq!(parsed["inputKind"], "directory");
    assert_eq!(parsed["warnings"][0], "hot reload complete");
}

#[test]
fn plugin_reload_json_failure_emits_bridge_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/reload");
            let body = read_request_body(&mut req);
            assert_eq!(body["plugin_id"], "missing-plugin");
            let _ = req.respond(json_response(
                r#"{"ok":false,"error":"plugin not installed"}"#,
            ));
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "reload",
            "--plugin-id",
            "missing-plugin",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(code, Some(0), "reload should fail on bridge rejection");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("reload --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "reload");
    assert_eq!(parsed["stage"], "bridge");
    assert_eq!(parsed["pluginId"], "missing-plugin");
    assert_eq!(parsed["error"].as_str(), Some("plugin not installed"));
    assert!(
        parsed.get("inputKind").is_none(),
        "id-only reload failure should omit absent inputKind: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON bridge rejection should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_reload_json_http_failure_emits_bridge_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("endpoint.json");
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    write_endpoint_file(&endpoint_file, &format!("http://127.0.0.1:{port}"));

    let server_thread = std::thread::spawn(move || {
        if let Ok(Some(mut req)) = server.recv_timeout(MOCK_BRIDGE_TIMEOUT) {
            assert_eq!(req.method(), &tiny_http::Method::Post);
            assert_eq!(req.url(), "/api/v1/dev/plugins/reload");
            let body = read_request_body(&mut req);
            assert_eq!(body["plugin_id"], "json-reload-http-failure");
            let response =
                tiny_http::Response::from_string("bridge write failed").with_status_code(500);
            let _ = req.respond(response);
        }
    });

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "reload",
            "--plugin-id",
            "json-reload-http-failure",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );
    let _ = server_thread.join();

    assert_ne!(code, Some(0), "reload should fail on bridge HTTP errors");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("reload --json HTTP failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "reload");
    assert_eq!(parsed["stage"], "bridge");
    assert_eq!(parsed["pluginId"], "json-reload-http-failure");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("HTTP 500"),
        "payload should carry bridge HTTP error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON bridge HTTP failure should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_reload_json_missing_endpoint_emits_endpoint_error_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint_file = tmp.path().join("missing-endpoint.json");

    let (code, stdout, stderr) = run_cognia_with_env(
        &[
            "plugin",
            "reload",
            "--plugin-id",
            "json-reload-missing-endpoint",
            "--json",
        ],
        &[("COGNIA_CLI_ENDPOINT_FILE", endpoint_file.to_str().unwrap())],
    );

    assert_ne!(
        code,
        Some(0),
        "reload should fail when endpoint discovery fails"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("reload --json endpoint failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "reload");
    assert_eq!(parsed["stage"], "endpoint");
    assert_eq!(parsed["pluginId"], "json-reload-missing-endpoint");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no running cognia detected"),
        "payload should carry endpoint discovery error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON endpoint failure should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_reload_json_missing_input_emits_input_payload_without_human_noise() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "reload", "--json"]);

    assert_ne!(
        code,
        Some(0),
        "reload should fail without plugin id or input path"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("reload --json input failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "reload");
    assert_eq!(parsed["stage"], "input");
    assert!(parsed.get("pluginId").is_none(), "got: {parsed}");
    assert!(parsed.get("inputKind").is_none(), "got: {parsed}");
    assert!(parsed.get("path").is_none(), "got: {parsed}");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("requires --plugin-id, --bundle, or --path"),
        "payload should carry the input error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "reload --json input failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_reload_json_missing_path_emits_input_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("missing-plugin");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "reload",
        "--path",
        missing.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(code, Some(0), "reload should fail for a missing input path");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("reload --json path failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "reload");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(
        parsed["path"].as_str(),
        Some(missing.to_string_lossy().as_ref())
    );
    assert!(parsed.get("inputKind").is_none(), "got: {parsed}");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("resolve"),
        "payload should carry the path resolution error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "reload --json path failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_keygen_json_emits_paths_and_public_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let out_dir = tmp.path().join("keys");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        out_dir.to_str().unwrap(),
        "--json",
    ]);

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("keygen --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "keygen");
    assert_eq!(
        parsed["privateKeyPath"].as_str(),
        Some(
            out_dir
                .join("plugin.private.b64")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        parsed["publicKeyPath"].as_str(),
        Some(out_dir.join("plugin.public.b64").to_string_lossy().as_ref())
    );
    assert_eq!(parsed["publicKey"].as_str().unwrap().len(), 44);
    assert_eq!(parsed["fingerprint"].as_str().unwrap().len(), 64);
    assert!(out_dir.join("plugin.private.b64").exists());
    assert!(out_dir.join("plugin.public.b64").exists());
}

#[test]
fn plugin_keygen_json_overwrite_abort_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let out_dir = tmp.path().join("keys");
    std::fs::create_dir_all(&out_dir).unwrap();
    std::fs::write(out_dir.join("plugin.private.b64"), "seeded").unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        out_dir.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(code, Some(0), "keygen should fail before clobbering keys");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("keygen --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "keygen");
    assert_eq!(parsed["stage"], "overwrite");
    assert_eq!(
        parsed["privateKeyPath"].as_str(),
        Some(
            out_dir
                .join("plugin.private.b64")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        parsed["publicKeyPath"].as_str(),
        Some(out_dir.join("plugin.public.b64").to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("--yes"),
        "payload should carry the overwrite hint: {parsed}"
    );
    assert_eq!(
        std::fs::read_to_string(out_dir.join("plugin.private.b64")).unwrap(),
        "seeded"
    );
    assert!(
        stderr.trim().is_empty(),
        "keygen --json overwrite failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_keygen_json_write_failure_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let out_dir = tmp.path().join("keys");
    let private_key_path = out_dir.join("plugin.private.b64");
    std::fs::create_dir_all(&private_key_path).unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "--yes",
        "plugin",
        "keygen",
        "--out-dir",
        out_dir.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "keygen should fail when a key path is a directory"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("keygen --json write failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "keygen");
    assert_eq!(parsed["stage"], "write");
    assert_eq!(
        parsed["privateKeyPath"].as_str(),
        Some(private_key_path.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["publicKeyPath"].as_str(),
        Some(out_dir.join("plugin.public.b64").to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("write"),
        "payload should carry the key write error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "keygen --json write failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_sign_json_emits_signature_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let key_dir = tmp.path().join("keys");
    let (keygen_code, keygen_stdout, keygen_stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        key_dir.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(keygen_code, Some(0), "stderr: {keygen_stderr}");
    let keygen: serde_json::Value =
        serde_json::from_str(&keygen_stdout).expect("keygen --json should emit valid JSON");

    let bundle = tmp.path().join("plugin.zip");
    std::fs::write(&bundle, b"bundle bytes").unwrap();
    let signature = tmp.path().join("plugin.zip.sig");
    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "sign",
        bundle.to_str().unwrap(),
        "--key",
        key_dir.join("plugin.private.b64").to_str().unwrap(),
        "--out",
        signature.to_str().unwrap(),
        "--json",
    ]);

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("sign --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "sign");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(bundle.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["signature"].as_str(),
        Some(signature.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["publicKey"], keygen["publicKey"]);
    assert_eq!(parsed["fingerprint"], keygen["fingerprint"]);
    assert!(signature.exists());
}

#[test]
fn plugin_sign_json_overwrite_abort_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let key_dir = tmp.path().join("keys");
    let (keygen_code, _keygen_stdout, keygen_stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        key_dir.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(keygen_code, Some(0), "stderr: {keygen_stderr}");

    let bundle = tmp.path().join("plugin.zip");
    std::fs::write(&bundle, b"bundle bytes").unwrap();
    let signature = tmp.path().join("plugin.zip.sig");
    std::fs::write(&signature, "pre-existing").unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "sign",
        bundle.to_str().unwrap(),
        "--key",
        key_dir.join("plugin.private.b64").to_str().unwrap(),
        "--out",
        signature.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "sign should fail before clobbering signatures"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("sign --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "sign");
    assert_eq!(parsed["stage"], "overwrite");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(bundle.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["signature"].as_str(),
        Some(signature.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("--yes"),
        "payload should carry the overwrite hint: {parsed}"
    );
    assert_eq!(std::fs::read_to_string(&signature).unwrap(), "pre-existing");
    assert!(
        stderr.trim().is_empty(),
        "sign --json overwrite failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_sign_json_missing_bundle_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let key_dir = tmp.path().join("keys");
    let (keygen_code, _keygen_stdout, keygen_stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        key_dir.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(keygen_code, Some(0), "stderr: {keygen_stderr}");
    let bundle = tmp.path().join("missing.zip");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "sign",
        bundle.to_str().unwrap(),
        "--key",
        key_dir.join("plugin.private.b64").to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "sign should fail when the bundle cannot be read"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("sign --json read failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "sign");
    assert_eq!(parsed["stage"], "read");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(bundle.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["signature"].as_str(),
        Some(
            tmp.path()
                .join("missing.zip.sig")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("read"),
        "payload should carry the bundle read error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "sign --json read failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_verify_json_reports_invalid_signature_as_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let key_dir = tmp.path().join("keys");
    let (keygen_code, keygen_stdout, keygen_stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        key_dir.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(keygen_code, Some(0), "stderr: {keygen_stderr}");
    let keygen: serde_json::Value =
        serde_json::from_str(&keygen_stdout).expect("keygen --json should emit valid JSON");

    let bundle = tmp.path().join("plugin.zip");
    let manifest = format!(
        r#"{{"id":"verify-json","name":"Verify JSON","version":"0.1.0","description":"smoke","type":"frontend","capabilities":["tools"],"main":"dist/index.js","author":{{"publicKey":"{}"}}}}"#,
        keygen["publicKey"].as_str().unwrap()
    );
    write_real_bundle(&bundle, &manifest);

    let other_bundle = tmp.path().join("other.zip");
    let other_manifest = manifest.replace("Verify JSON", "Other Verify JSON");
    write_real_bundle(&other_bundle, &other_manifest);
    let signature = tmp.path().join("plugin.zip.sig");
    let (sign_code, _sign_stdout, sign_stderr) = run_cognia(&[
        "plugin",
        "sign",
        other_bundle.to_str().unwrap(),
        "--key",
        key_dir.join("plugin.private.b64").to_str().unwrap(),
        "--out",
        signature.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(sign_code, Some(0), "stderr: {sign_stderr}");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "verify",
        bundle.to_str().unwrap(),
        "--signature",
        signature.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "verify should fail for a mismatched signature"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("verify --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "verify");
    assert_eq!(parsed["stage"], "verify");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(bundle.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["signature"].as_str(),
        Some(signature.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["publicKey"], keygen["publicKey"]);
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("signature verification failed"),
        "payload should carry the verification error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "verify --json failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_verify_json_missing_signature_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let key_dir = tmp.path().join("keys");
    let (keygen_code, keygen_stdout, keygen_stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        key_dir.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(keygen_code, Some(0), "stderr: {keygen_stderr}");
    let keygen: serde_json::Value =
        serde_json::from_str(&keygen_stdout).expect("keygen --json should emit valid JSON");

    let bundle = tmp.path().join("plugin.zip");
    let manifest = format!(
        r#"{{"id":"verify-json-missing-sig","name":"Verify JSON","version":"0.1.0","description":"smoke","type":"frontend","capabilities":["tools"],"main":"dist/index.js","author":{{"publicKey":"{}"}}}}"#,
        keygen["publicKey"].as_str().unwrap()
    );
    write_real_bundle(&bundle, &manifest);
    let missing_signature = tmp.path().join("missing.sig");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "verify",
        bundle.to_str().unwrap(),
        "--signature",
        missing_signature.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "verify should fail when the signature file cannot be read"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("verify --json read failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "verify");
    assert_eq!(parsed["stage"], "signature");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(bundle.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["signature"].as_str(),
        Some(missing_signature.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["publicKey"], keygen["publicKey"]);
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("read"),
        "payload should carry signature read error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "verify --json read failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_verify_json_missing_bundle_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("missing.zip");
    let expected_signature = tmp.path().join("missing.zip.sig");

    let (code, stdout, stderr) =
        run_cognia(&["plugin", "verify", bundle.to_str().unwrap(), "--json"]);

    assert_ne!(
        code,
        Some(0),
        "verify should fail when the bundle file cannot be read"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("verify --json bundle failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "verify");
    assert_eq!(parsed["stage"], "bundle");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(bundle.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["signature"].as_str(),
        Some(expected_signature.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["publicKey"], "");
    assert_eq!(parsed["fingerprint"], "<unavailable>");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("read"),
        "payload should carry bundle read error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "verify --json bundle failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_verify_json_missing_embedded_public_key_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("plugin.zip");
    let manifest = r#"{"id":"verify-json-no-key","name":"Verify JSON","version":"0.1.0","description":"smoke","type":"frontend","capabilities":["tools"],"main":"dist/index.js"}"#;
    write_real_bundle(&bundle, manifest);

    let (code, stdout, stderr) =
        run_cognia(&["plugin", "verify", bundle.to_str().unwrap(), "--json"]);

    assert_ne!(
        code,
        Some(0),
        "verify should fail when the bundle has no embedded public key"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("verify --json key failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "verify");
    assert_eq!(parsed["stage"], "public-key");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(bundle.to_string_lossy().as_ref())
    );
    assert_eq!(parsed["publicKey"], "");
    assert_eq!(parsed["fingerprint"], "<unavailable>");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("author.publicKey"),
        "payload should tell CI to pass --public-key explicitly: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "verify --json public-key failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_verify_json_invalid_explicit_public_key_emits_stage_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let key_dir = tmp.path().join("keys");
    let (keygen_code, _keygen_stdout, keygen_stderr) = run_cognia(&[
        "plugin",
        "keygen",
        "--out-dir",
        key_dir.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(keygen_code, Some(0), "stderr: {keygen_stderr}");

    let bundle = tmp.path().join("plugin.zip");
    let manifest = r#"{"id":"verify-json-invalid-explicit-key","name":"Verify JSON","version":"0.1.0","description":"smoke","type":"frontend","capabilities":["tools"],"main":"dist/index.js"}"#;
    write_real_bundle(&bundle, manifest);
    let signature = tmp.path().join("plugin.zip.sig");
    let (sign_code, _sign_stdout, sign_stderr) = run_cognia(&[
        "plugin",
        "sign",
        bundle.to_str().unwrap(),
        "--key",
        key_dir.join("plugin.private.b64").to_str().unwrap(),
        "--out",
        signature.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(sign_code, Some(0), "stderr: {sign_stderr}");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "verify",
        bundle.to_str().unwrap(),
        "--signature",
        signature.to_str().unwrap(),
        "--public-key",
        "not-valid-base64",
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "verify should fail when the explicit public key is invalid"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("verify --json key failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "verify");
    assert_eq!(parsed["stage"], "public-key");
    assert_eq!(parsed["publicKey"], "not-valid-base64");
    assert_eq!(parsed["fingerprint"], "<invalid base64>");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("base64"),
        "payload should carry invalid public-key decode error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "verify --json invalid public-key payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_build_json_emits_bundle_metadata_for_python_plugin() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("main.py"), "def activate(ctx): pass\n").unwrap();
    write_minimal_python_manifest(tmp.path(), "json-build", "0.2.0");
    let out = tmp.path().join("json-build.zip");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "build",
        "--path",
        tmp.path().to_str().unwrap(),
        "--out",
        out.to_str().unwrap(),
        "--skip-build",
        "--json",
    ]);

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("build --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "build");
    assert_eq!(parsed["pluginId"], "json-build");
    assert_eq!(parsed["version"], "0.2.0");
    assert_eq!(parsed["pluginType"], "python");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(out.to_string_lossy().as_ref())
    );
    assert!(out.exists());
}

#[test]
fn plugin_build_json_emits_clean_bundle_metadata_for_frontend_skip_build() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("dist")).unwrap();
    std::fs::write(
        tmp.path().join("dist/index.js"),
        "exports.activate = () => {}\n",
    )
    .unwrap();
    write_minimal_manifest(tmp.path(), "json-build-frontend");
    let out = tmp.path().join("json-build-frontend.zip");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "build",
        "--path",
        tmp.path().to_str().unwrap(),
        "--out",
        out.to_str().unwrap(),
        "--skip-build",
        "--json",
    ]);

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("build --json frontend success should be JSON only");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "build");
    assert_eq!(parsed["pluginId"], "json-build-frontend");
    assert_eq!(parsed["version"], "0.1.0");
    assert_eq!(parsed["pluginType"], "frontend");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(out.to_string_lossy().as_ref())
    );
    assert!(
        stderr.trim().is_empty(),
        "successful build --json should not emit human diagnostics on stderr: {stderr}"
    );
    assert!(out.exists());
}

#[test]
fn plugin_build_json_failure_emits_manifest_diagnostics_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("plugin.json"), r#"{"id":"x"}"#).unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "build",
        "--path",
        tmp.path().to_str().unwrap(),
        "--skip-build",
        "--json",
    ]);

    assert_ne!(code, Some(0), "build should fail on invalid manifest");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("build --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "build");
    assert_eq!(parsed["stage"], "lint");
    assert_eq!(parsed["manifest"]["valid"], false);
    assert!(
        parsed["manifest"]["diagnostics"].as_array().unwrap().len() >= 4,
        "expected manifest diagnostics in payload: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "JSON mode should not duplicate human diagnostics on stderr: {stderr}"
    );
}

#[test]
fn plugin_build_json_missing_path_emits_input_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("missing-plugin");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "build",
        "--path",
        missing.to_str().unwrap(),
        "--skip-build",
        "--json",
    ]);

    assert_ne!(code, Some(0), "build should fail for a missing plugin path");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("build --json input failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "build");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(parsed["path"], missing.to_string_lossy().as_ref());
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("resolve"),
        "payload should carry the input resolution failure: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "build --json input failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_build_json_missing_manifest_emits_input_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "build",
        "--path",
        tmp.path().to_str().unwrap(),
        "--skip-build",
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "build should fail when plugin.json is missing"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("build --json input failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "build");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(parsed["path"], tmp.path().to_string_lossy().as_ref());
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("plugin.json"),
        "payload should carry the manifest read failure: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "build --json missing-manifest payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_build_json_pack_failure_emits_stage_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    write_minimal_python_manifest(tmp.path(), "json-build-missing-entry", "0.3.0");
    let out = tmp.path().join("json-build-missing-entry.zip");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "build",
        "--path",
        tmp.path().to_str().unwrap(),
        "--out",
        out.to_str().unwrap(),
        "--skip-build",
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "build should fail when a declared entry file is missing"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("build --json pack failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "build");
    assert_eq!(parsed["stage"], "pack");
    assert_eq!(parsed["pluginId"], "json-build-missing-entry");
    assert_eq!(parsed["version"], "0.3.0");
    assert_eq!(parsed["pluginType"], "python");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(out.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("pythonMain"),
        "payload should carry the packaging failure: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "build --json pack failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_build_json_frontend_pack_failure_emits_stage_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    write_minimal_manifest(tmp.path(), "json-build-frontend-missing-entry");
    let out = tmp.path().join("json-build-frontend-missing-entry.zip");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "build",
        "--path",
        tmp.path().to_str().unwrap(),
        "--out",
        out.to_str().unwrap(),
        "--skip-build",
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "build should fail when frontend skip-build output is missing"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("build --json frontend pack failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "build");
    assert_eq!(parsed["stage"], "pack");
    assert_eq!(parsed["pluginId"], "json-build-frontend-missing-entry");
    assert_eq!(parsed["version"], "0.1.0");
    assert_eq!(parsed["pluginType"], "frontend");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(out.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("expected bundled output"),
        "payload should carry the frontend packaging failure: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "build --json frontend pack failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_build_json_wasm_pack_failure_emits_stage_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    write_minimal_wasm_manifest(tmp.path(), "json-build-wasm-missing-artifact", "0.4.0");
    let out = tmp.path().join("json-build-wasm-missing-artifact.zip");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "build",
        "--path",
        tmp.path().to_str().unwrap(),
        "--out",
        out.to_str().unwrap(),
        "--skip-build",
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "build should fail when wasm skip-build artifact is missing"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("build --json wasm pack failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "build");
    assert_eq!(parsed["stage"], "pack");
    assert_eq!(parsed["pluginId"], "json-build-wasm-missing-artifact");
    assert_eq!(parsed["version"], "0.4.0");
    assert_eq!(parsed["pluginType"], "wasm");
    assert_eq!(
        parsed["bundle"].as_str(),
        Some(out.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("could not locate a built .wasm"),
        "payload should carry the wasm packaging failure: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "build --json wasm pack failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_embed_version_json_emits_output_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let wasm = tmp.path().join("input.wasm");
    let out = tmp.path().join("output.wasm");
    std::fs::write(&wasm, minimal_wasm_module()).unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "embed-version",
        wasm.to_str().unwrap(),
        "1.2.3",
        "--out",
        out.to_str().unwrap(),
        "--json",
    ]);

    assert_eq!(code, Some(0), "stderr: {stderr}");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("embed-version --json should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["action"], "embed-version");
    assert_eq!(parsed["version"], "1.2.3");
    assert_eq!(
        parsed["input"].as_str(),
        Some(wasm.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["output"].as_str(),
        Some(out.to_string_lossy().as_ref())
    );
    assert!(out.exists());
}

#[test]
fn plugin_embed_version_json_invalid_version_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let wasm = tmp.path().join("input.wasm");
    std::fs::write(&wasm, minimal_wasm_module()).unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "embed-version",
        wasm.to_str().unwrap(),
        "1.2",
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "embed-version should reject non-semver values"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("embed-version --json failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "embed-version");
    assert_eq!(parsed["stage"], "input");
    assert_eq!(parsed["version"], "1.2");
    assert_eq!(
        parsed["input"].as_str(),
        Some(wasm.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["output"].as_str(),
        Some(wasm.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("MAJOR.MINOR.PATCH"),
        "payload should carry the version error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "embed-version --json input failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

#[test]
fn plugin_embed_version_json_missing_wasm_emits_payload_without_human_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let wasm = tmp.path().join("missing.wasm");
    let out = tmp.path().join("output.wasm");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "embed-version",
        wasm.to_str().unwrap(),
        "1.2.3",
        "--out",
        out.to_str().unwrap(),
        "--json",
    ]);

    assert_ne!(
        code,
        Some(0),
        "embed-version should fail when input cannot be read"
    );
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .expect("embed-version --json read failure should emit valid JSON");
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["action"], "embed-version");
    assert_eq!(parsed["stage"], "read");
    assert_eq!(parsed["version"], "1.2.3");
    assert_eq!(
        parsed["input"].as_str(),
        Some(wasm.to_string_lossy().as_ref())
    );
    assert_eq!(
        parsed["output"].as_str(),
        Some(out.to_string_lossy().as_ref())
    );
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("read"),
        "payload should carry the read error: {parsed}"
    );
    assert!(
        stderr.trim().is_empty(),
        "embed-version --json read failure payload is already actionable; stderr should stay empty: {stderr}"
    );
}

// ── `cognia plugin import` ────────────────────────────────────────────────
//
// These drive the real chain: clap → the embedded Node converter → the
// files on disk. They are skipped when `node` is absent so the Node-free
// `cargo-test-cli` CI job stays green; `#[test]` bodies that silently do
// nothing are a known trap, so the skip is loud in the test output.

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// A config holding three servers: one plain, one with a live-looking
/// credential, one with a machine-specific absolute path.
const MCP_FIXTURE: &str = r#"{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_INTEGRATION_SECRET" }
    },
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/integration/Docs"]
    }
  }
}"#;

#[test]
fn plugin_import_help_is_available() {
    let (code, stdout, stderr) = run_cognia(&["plugin", "import", "--help"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for flag in [
        "--from",
        "--input",
        "--pick",
        "--list",
        "--into",
        "--no-build",
    ] {
        assert!(
            stdout.contains(flag),
            "import help missing {flag}: {stdout}"
        );
    }
}

#[test]
fn plugin_import_lists_every_server_in_a_config() {
    if !node_available() {
        eprintln!("SKIP plugin_import_lists_every_server_in_a_config: node not on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("mcp.json");
    std::fs::write(&config, MCP_FIXTURE).unwrap();

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "mcp",
        "--input",
        config.to_str().unwrap(),
        "--list",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for name in ["playwright", "github", "files"] {
        assert!(stdout.contains(name), "listing missing {name}: {stdout}");
    }
}

#[test]
fn plugin_import_writes_an_installable_project_without_leaking_secrets() {
    if !node_available() {
        eprintln!("SKIP plugin_import_writes_an_installable_project: node not on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("mcp.json");
    std::fs::write(&config, MCP_FIXTURE).unwrap();
    let out = tmp.path().join("generated");

    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "mcp",
        "--input",
        config.to_str().unwrap(),
        "--pick",
        "github",
        "--dir",
        out.to_str().unwrap(),
        "--no-build",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");

    // `main` points at dist/index.js, so it must exist for the plugin to
    // be installable straight out of the converter.
    for file in [
        "plugin.json",
        "src/index.ts",
        "dist/index.js",
        "package.json",
        "tsconfig.json",
        "README.md",
        ".gitignore",
    ] {
        assert!(out.join(file).exists(), "missing generated file {file}");
    }

    // No value from the source config may survive anywhere in the output.
    for file in ["plugin.json", "dist/index.js", "package.json", "README.md"] {
        let body = std::fs::read_to_string(out.join(file)).unwrap();
        assert!(
            !body.contains("ghp_INTEGRATION_SECRET"),
            "{file} leaked the source credential"
        );
    }

    let manifest = std::fs::read_to_string(out.join("plugin.json")).unwrap();
    assert!(manifest.contains("\"mcp-server-preset\""));
    assert!(manifest.contains("\"GITHUB_TOKEN\""));
    assert!(manifest.contains("\"secret\": true"));
    // A stdio server cannot run in the browser or on mobile.
    assert!(manifest.contains("\"blocked\""));
}

#[test]
fn plugin_import_output_passes_plugin_lint() {
    if !node_available() {
        eprintln!("SKIP plugin_import_output_passes_plugin_lint: node not on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("mcp.json");
    std::fs::write(&config, MCP_FIXTURE).unwrap();
    let out = tmp.path().join("generated");

    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "mcp",
        "--input",
        config.to_str().unwrap(),
        "--pick",
        "playwright",
        "--dir",
        out.to_str().unwrap(),
        "--no-build",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");

    let (lint_code, lint_out, lint_err) =
        run_cognia(&["plugin", "lint", "--path", out.to_str().unwrap(), "-W"]);
    assert_eq!(
        lint_code,
        Some(0),
        "generated plugin failed its own lint: {lint_out} {lint_err}"
    );
}

#[test]
fn plugin_import_tokenizes_machine_specific_paths() {
    if !node_available() {
        eprintln!("SKIP plugin_import_tokenizes_machine_specific_paths: node not on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("mcp.json");
    std::fs::write(&config, MCP_FIXTURE).unwrap();
    let out = tmp.path().join("generated");

    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "mcp",
        "--input",
        config.to_str().unwrap(),
        "--pick",
        "files",
        "--dir",
        out.to_str().unwrap(),
        "--no-build",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");

    let manifest = std::fs::read_to_string(out.join("plugin.json")).unwrap();
    assert!(
        !manifest.contains("/Users/integration"),
        "the author's absolute path survived into the manifest: {manifest}"
    );
    assert!(
        manifest.contains("<DOCS>"),
        "expected an arg-replace token: {manifest}"
    );
    assert!(manifest.contains("\"arg-replace\""));
}

#[test]
fn plugin_import_refuses_a_non_empty_target_directory() {
    if !node_available() {
        eprintln!("SKIP plugin_import_refuses_a_non_empty_target_directory: node not on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("mcp.json");
    std::fs::write(&config, MCP_FIXTURE).unwrap();
    let out = tmp.path().join("occupied");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("mine.txt"), "do not clobber").unwrap();

    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "mcp",
        "--input",
        config.to_str().unwrap(),
        "--pick",
        "playwright",
        "--dir",
        out.to_str().unwrap(),
        "--no-build",
    ]);
    assert_eq!(code, Some(1), "expected a refusal");
    assert!(stderr.contains("not empty"), "stderr: {stderr}");
    assert_eq!(
        std::fs::read_to_string(out.join("mine.txt")).unwrap(),
        "do not clobber"
    );
}

#[test]
fn plugin_import_into_appends_and_refuses_collisions() {
    if !node_available() {
        eprintln!("SKIP plugin_import_into_appends_and_refuses_collisions: node not on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("mcp.json");
    std::fs::write(&config, MCP_FIXTURE).unwrap();
    let out = tmp.path().join("generated");

    let (code, _o, e) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "mcp",
        "--input",
        config.to_str().unwrap(),
        "--pick",
        "playwright",
        "--dir",
        out.to_str().unwrap(),
        "--no-build",
    ]);
    assert_eq!(code, Some(0), "stderr: {e}");
    let before = std::fs::read_to_string(out.join("src/index.ts")).unwrap();

    let merge = |pick: &str, extra: &[&str]| {
        let mut args = vec![
            "plugin",
            "import",
            "--from",
            "mcp",
            "--input",
            config.to_str().unwrap(),
            "--pick",
            pick,
            "--into",
            out.to_str().unwrap(),
        ];
        args.extend_from_slice(extra);
        run_cognia(&args)
    };

    let (code, _o, e) = merge("github", &[]);
    assert_eq!(code, Some(0), "stderr: {e}");
    let manifest = std::fs::read_to_string(out.join("plugin.json")).unwrap();
    assert!(manifest.contains("\"playwright\""));
    assert!(manifest.contains("\"github\""));
    // The merge touches plugin.json only.
    assert_eq!(
        std::fs::read_to_string(out.join("src/index.ts")).unwrap(),
        before
    );

    let (code, _o, stderr) = merge("github", &[]);
    assert_eq!(code, Some(1), "a duplicate id must be refused");
    assert!(
        stderr.contains("already contains an entry"),
        "stderr: {stderr}"
    );

    // `--id` renames the imported contribution so the collision is fixable.
    let (code, _o, e) = merge("github", &["--id", "github-2"]);
    assert_eq!(code, Some(0), "stderr: {e}");
    let manifest = std::fs::read_to_string(out.join("plugin.json")).unwrap();
    assert!(manifest.contains("\"github-2\""));
}

#[test]
fn plugin_import_skill_folder_inlines_and_bundles() {
    if !node_available() {
        eprintln!("SKIP plugin_import_skill_folder_inlines_and_bundles: node not on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let skill = tmp.path().join("code-review");
    std::fs::create_dir_all(skill.join("references")).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: Code Review\ndescription: Review a diff.\n---\n\nRead the diff.\n",
    )
    .unwrap();

    // Without resources → inline, portable everywhere.
    let inline_out = tmp.path().join("inline");
    let (code, _o, e) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "skill",
        "--input",
        skill.join("SKILL.md").to_str().unwrap(),
        "--dir",
        inline_out.to_str().unwrap(),
        "--no-build",
    ]);
    assert_eq!(code, Some(0), "stderr: {e}");
    let manifest = std::fs::read_to_string(inline_out.join("plugin.json")).unwrap();
    assert!(manifest.contains("\"inline\""), "{manifest}");

    // With resources → local-bundle, files copied in, desktop-only.
    std::fs::write(skill.join("references").join("checklist.md"), "- check\n").unwrap();
    let bundle_out = tmp.path().join("bundle");
    let (code, _o, e) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "skill",
        "--input",
        skill.to_str().unwrap(),
        "--dir",
        bundle_out.to_str().unwrap(),
        "--no-build",
    ]);
    assert_eq!(code, Some(0), "stderr: {e}");
    let manifest = std::fs::read_to_string(bundle_out.join("plugin.json")).unwrap();
    assert!(manifest.contains("\"local-bundle\""), "{manifest}");
    assert!(manifest.contains("\"skills/code-review\""), "{manifest}");
    assert!(bundle_out.join("skills/code-review/SKILL.md").exists());
    assert!(bundle_out
        .join("skills/code-review/references/checklist.md")
        .exists());
}

#[test]
fn plugin_import_cli_emits_an_unfinished_skeleton_lint_can_see() {
    if !node_available() {
        eprintln!("SKIP plugin_import_cli_emits_an_unfinished_skeleton: node not on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("rg-tools");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "cli",
        "--input",
        "rg",
        "--dir",
        out.to_str().unwrap(),
        "--no-build",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(stdout.contains("field_missing"), "stdout: {stdout}");

    let manifest = std::fs::read_to_string(out.join("plugin.json")).unwrap();
    assert!(manifest.contains("\"cli-tools\""));
    assert!(manifest.contains("\"cli:execute\""));
    assert!(manifest.contains("\"cliTools\": []"), "{manifest}");

    // An empty contribution table is a warning, not an error: the project
    // is structurally valid, just unfinished.
    let (code, _o, _e) = run_cognia(&["plugin", "lint", "--path", out.to_str().unwrap()]);
    assert_eq!(code, Some(0));
    let (code, _o, _e) = run_cognia(&["plugin", "lint", "--path", out.to_str().unwrap(), "-W"]);
    assert_eq!(code, Some(1), "-W must gate on the unfinished tool table");
}

#[test]
fn plugin_import_rejects_a_binary_name_that_is_a_command_line() {
    if !node_available() {
        eprintln!("SKIP plugin_import_rejects_a_binary_name_that_is_a_command_line: node absent");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (code, _stdout, stderr) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "cli",
        "--input",
        "rg; rm -rf /",
        "--dir",
        tmp.path().join("bad").to_str().unwrap(),
    ]);
    assert_eq!(code, Some(1));
    assert!(stderr.contains("bare binary name"), "stderr: {stderr}");
}

#[test]
fn plugin_import_json_reports_the_machine_readable_contract() {
    if !node_available() {
        eprintln!("SKIP plugin_import_json_reports_the_machine_readable_contract: node absent");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("mcp.json");
    std::fs::write(&config, MCP_FIXTURE).unwrap();
    let out = tmp.path().join("generated");

    let (code, stdout, stderr) = run_cognia(&[
        "plugin",
        "import",
        "--from",
        "mcp",
        "--input",
        config.to_str().unwrap(),
        "--pick",
        "github",
        "--dir",
        out.to_str().unwrap(),
        "--no-build",
        "--json",
    ]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let report: serde_json::Value = serde_json::from_str(&stdout).expect("valid JSON report");
    assert_eq!(report["ok"], serde_json::json!(true));
    assert_eq!(report["action"], serde_json::json!("import"));
    assert_eq!(report["mode"], serde_json::json!("create"));
    assert_eq!(report["pluginId"], serde_json::json!("github-mcp"));
    assert_eq!(report["build"], serde_json::json!("skipped"));
    assert!(report["files"].as_array().unwrap().len() >= 7);
    assert!(!report["todos"].as_array().unwrap().is_empty());
    assert!(!stdout.contains("ghp_INTEGRATION_SECRET"));
}
