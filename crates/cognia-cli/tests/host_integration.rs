//! Process-level contract tests for the Agent-first Headless CLI surface.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn cognia_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_cognia"))
}

fn run(args: &[&str], envs: &[(&str, &str)]) -> (Option<i32>, String, String) {
    run_in(args, envs, None)
}

fn run_in(
    args: &[&str],
    envs: &[(&str, &str)],
    current_dir: Option<&Path>,
) -> (Option<i32>, String, String) {
    let mut command = Command::new(cognia_bin());
    command
        .args(args)
        .env("NO_COLOR", "1")
        .env("CI", "true")
        .env_remove("FORCE_COLOR")
        .stdin(Stdio::null());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }
    for (key, value) in envs {
        command.env(key, value);
    }
    let output = command.output().expect("run cognia host");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn init_git_repo(path: &Path) {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["init", "--quiet"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .expect("initialize Git repository");
    assert!(
        output.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn global_yes_help_requires_exact_user_approval() {
    let (code, stdout, stderr) = run(&["--help"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(stdout.contains("exact invocation"), "stdout: {stdout}");
    assert!(
        !stdout.contains("Required for CI usage"),
        "stdout: {stdout}"
    );
}

#[test]
fn skill_install_help_requires_an_explicit_standard_scope() {
    let (code, stdout, stderr) = run(&["host", "skills", "install", "--help"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(stdout.contains("--scope <SCOPE>"), "stdout: {stdout}");
    assert!(stdout.contains("user, project"), "stdout: {stdout}");

    let (code, stdout, stderr) = run(&["host", "skills", "install"], &[]);
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    assert!(stderr.contains("--scope <SCOPE>"), "stderr: {stderr}");
}

#[test]
fn host_help_exposes_the_agent_first_surface() {
    let (code, stdout, stderr) = run(&["host", "--help"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for command in [
        "categories",
        "resources",
        "commands",
        "schema",
        "call",
        "doctor",
        "events",
        "skills",
    ] {
        assert!(stdout.contains(command), "missing {command}: {stdout}");
    }
}

#[test]
fn command_discovery_and_schema_are_offline_json() {
    let (code, stdout, stderr) = run(
        &[
            "host",
            "commands",
            "--query",
            "session_list",
            "--format",
            "json",
        ],
        &[("COGNIA_SERVICE_TOKEN", "must-not-be-needed")],
    );
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["count"], 1);
    assert_eq!(payload["commands"][0]["name"], "session_list");
    assert_eq!(payload["commands"][0]["category"], "sessions");
    assert_eq!(payload["commands"][0]["resource"], "session");

    let (code, stdout, stderr) = run(&["host", "schema", "session_list"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(payload["inputSchema"]["additionalProperties"], false);
    assert_eq!(payload["outputTyped"], false);
    assert_eq!(payload["meta"]["resource"], "session");
}

#[test]
fn categories_and_domain_skills_are_discoverable_offline() {
    let (code, stdout, stderr) = run(&["host", "categories"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(payload["count"], 9);
    let sessions = payload["categories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|category| category["id"] == "sessions")
        .unwrap();
    assert_eq!(sessions["skill"], "cognia-host-sessions");
    assert!(sessions["commandCount"].as_u64().unwrap() > 0);

    let (code, stdout, stderr) = run(&["host", "commands", "--category", "knowledge"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert!(payload["commands"]
        .as_array()
        .unwrap()
        .iter()
        .all(|command| command["category"] == "knowledge"));

    let (code, stdout, stderr) = run(
        &[
            "host",
            "skills",
            "list",
            "--category",
            "development",
            "--kind",
            "domain",
        ],
        &[],
    );
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(payload["count"], 1);
    assert_eq!(payload["bundleVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(payload["skills"][0]["name"], "cognia-host-development");
    assert_eq!(
        payload["skills"][0]["contentHash"].as_str().unwrap().len(),
        64
    );
    assert!(payload["skills"][0].get("version").is_none());

    let (code, stdout, stderr) = run(&["host", "skills", "read", "cognia-host-development"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(stdout.contains("# Cognia Host Development"));
}

#[test]
fn resources_and_workflow_skills_are_discoverable_offline() {
    let (code, stdout, stderr) = run(&["host", "resources", "--category", "development"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    let resources = payload["resources"].as_array().unwrap();
    assert!(resources
        .iter()
        .all(|resource| resource["category"] == "development"));
    assert!(resources.iter().any(|resource| resource["id"] == "git"));

    let (code, stdout, stderr) = run(&["host", "commands", "--resource", "git"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert!(payload["commands"]
        .as_array()
        .unwrap()
        .iter()
        .all(|command| command["resource"] == "git"));

    let (code, stdout, stderr) = run(&["host", "skills", "list", "--kind", "workflow"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(payload["count"], 6);
    assert!(payload["skills"]
        .as_array()
        .unwrap()
        .iter()
        .all(|skill| skill["kind"] == "workflow"));

    let (code, stdout, stderr) = run(&["host", "skills", "read", "cognia-host-safe-git"], &[]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(stdout.contains("# Safe Git Through Cognia Host"));
}

#[test]
fn project_skill_install_is_standard_complete_and_idempotent() {
    let temp = tempfile::tempdir().expect("temp dir");
    init_git_repo(temp.path());
    let nested = temp.path().join("packages/app");
    fs::create_dir_all(&nested).expect("nested cwd");

    let args = ["host", "skills", "install", "--scope", "project"];
    let (code, stdout, stderr) = run_in(&args, &[], Some(&nested));
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).expect("install JSON");
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["action"], "skills_install");
    assert_eq!(payload["scope"], "project");
    assert_eq!(payload["bundleVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(payload["installed"].as_array().unwrap().len(), 17);
    assert_eq!(payload["updated"].as_array().unwrap().len(), 0);
    assert_eq!(payload["unchanged"].as_array().unwrap().len(), 0);
    assert_eq!(payload["removed"].as_array().unwrap().len(), 0);

    let skills_root = temp
        .path()
        .canonicalize()
        .expect("canonical temp root")
        .join(".agents/skills");
    assert_eq!(payload["root"], skills_root.display().to_string());
    let installed = payload["installed"].as_array().unwrap();
    assert_eq!(
        installed
            .iter()
            .filter(|path| path.as_str().unwrap().ends_with("/SKILL.md"))
            .count(),
        16
    );
    for relative in installed {
        assert!(
            skills_root.join(relative.as_str().unwrap()).is_file(),
            "missing installed path: {relative}"
        );
    }
    assert!(skills_root.join("cognia-host/SKILL.md").is_file());
    assert!(skills_root
        .join("cognia-host/references/output-contract.md")
        .is_file());
    assert!(skills_root
        .join("cognia-host-connector-delivery/SKILL.md")
        .is_file());
    assert!(skills_root.join(".cognia-host-manifest.json").is_file());

    let (code, stdout, stderr) = run_in(&args, &[], Some(&nested));
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stdout).expect("reinstall JSON");
    assert_eq!(payload["installed"].as_array().unwrap().len(), 0);
    assert_eq!(payload["updated"].as_array().unwrap().len(), 0);
    assert_eq!(payload["unchanged"].as_array().unwrap().len(), 17);
    assert_eq!(payload["removed"].as_array().unwrap().len(), 0);
}

#[test]
fn project_skill_install_conflicts_before_writing_any_file() {
    let temp = tempfile::tempdir().expect("temp dir");
    init_git_repo(temp.path());
    let args = ["host", "skills", "install", "--scope", "project"];
    let (code, _, stderr) = run_in(&args, &[], Some(temp.path()));
    assert_eq!(code, Some(0), "stderr: {stderr}");

    let skills_root = temp
        .path()
        .canonicalize()
        .expect("canonical temp root")
        .join(".agents/skills");
    let modified = skills_root.join("cognia-host/SKILL.md");
    let missing = skills_root.join("cognia-host-agents/SKILL.md");
    let manifest_path = skills_root.join(".cognia-host-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).expect("manifest bytes"))
            .expect("manifest JSON");
    manifest["files"]
        .as_object_mut()
        .expect("manifest files")
        .remove("cognia-host-agents/SKILL.md");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("updated manifest"),
    )
    .expect("write updated manifest");
    fs::write(&modified, "user-owned\n").expect("modify managed skill");
    fs::remove_file(&missing).expect("remove managed skill");

    let (code, stdout, stderr) = run_in(&args, &[], Some(temp.path()));
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stderr).expect("conflict JSON");
    assert_eq!(payload["action"], "skills_install");
    assert_eq!(payload["error"]["code"], "skill_install_conflict");
    assert_eq!(
        fs::read_to_string(&modified).expect("modified skill remains"),
        "user-owned\n"
    );
    assert!(!missing.exists(), "preflight must prevent partial repair");
}

#[test]
fn project_skill_install_reports_corrupt_manifest_conflicts() {
    let temp = tempfile::tempdir().expect("temp dir");
    init_git_repo(temp.path());
    let skills_root = temp.path().join(".agents/skills");
    fs::create_dir_all(&skills_root).expect("skills root");
    fs::write(skills_root.join(".cognia-host-manifest.json"), "not-json")
        .expect("corrupt manifest");

    let args = ["host", "skills", "install", "--scope", "project"];
    let (code, stdout, stderr) = run_in(&args, &[], Some(temp.path()));
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stderr).expect("conflict JSON");
    assert_eq!(payload["action"], "skills_install");
    assert_eq!(payload["error"]["code"], "skill_install_conflict");
}

#[cfg(unix)]
#[test]
fn project_skill_install_rejects_a_symlinked_agents_parent() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temp dir");
    init_git_repo(temp.path());
    let outside = tempfile::tempdir().expect("outside dir");
    symlink(outside.path(), temp.path().join(".agents")).expect("agents symlink");

    let args = ["host", "skills", "install", "--scope", "project"];
    let (code, stdout, stderr) = run_in(&args, &[], Some(temp.path()));
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stderr).expect("conflict JSON");
    assert_eq!(payload["action"], "skills_install");
    assert_eq!(payload["error"]["code"], "skill_install_conflict");
    assert!(outside.path().read_dir().unwrap().next().is_none());
}

#[test]
fn unknown_categories_use_stable_validation_errors() {
    let (code, stdout, stderr) = run(&["host", "commands", "--category", "does-not-exist"], &[]);
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stderr).unwrap();
    assert_eq!(payload["action"], "commands");
    assert_eq!(payload["error"]["code"], "invalid_filter");

    let (code, stdout, stderr) = run(
        &["host", "skills", "list", "--category", "does-not-exist"],
        &[],
    );
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stderr).unwrap();
    assert_eq!(payload["action"], "skills");
    assert_eq!(payload["error"]["code"], "unknown_skill_category");

    let (code, stdout, stderr) = run(&["host", "commands", "--resource", "does-not-exist"], &[]);
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stderr).unwrap();
    assert_eq!(payload["action"], "commands");
    assert_eq!(payload["error"]["code"], "invalid_filter");
}

#[test]
fn dry_run_redacts_values_and_never_needs_credentials() {
    let secret = "value-that-must-not-appear";
    let body = format!(r#"{{"input":{{"namespace":"test","key":"{secret}"}}}}"#);
    let (code, stdout, stderr) = run(
        &[
            "host",
            "call",
            "secret_store_get",
            "--data",
            &body,
            "--dry-run",
        ],
        &[("COGNIA_SERVICE_TOKEN", "token-that-must-not-appear")],
    );
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(!stdout.contains(secret));
    assert!(!stdout.contains("token-that-must-not-appear"));
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(payload["state"], "dry-run");
    assert_eq!(payload["meta"]["confirmationRequired"], true);
    assert_eq!(payload["meta"]["resource"], "secrets");
}

#[test]
fn high_risk_noninteractive_call_stops_before_network_access() {
    let (code, stdout, stderr) = run(
        &[
            "host",
            "--server-url",
            "https://127.0.0.1:9",
            "call",
            "secret_store_get",
            "--data",
            r#"{"input":{"namespace":"test","key":"key"}}"#,
        ],
        &[],
    );
    assert_eq!(code, Some(4), "stdout: {stdout}\nstderr: {stderr}");
    assert!(stdout.trim().is_empty());
    let payload: serde_json::Value = serde_json::from_str(&stderr).unwrap();
    assert_eq!(payload["action"], "call");
    assert_eq!(payload["rpcCommand"], "secret_store_get");
    assert_eq!(payload["error"]["type"], "confirmation");
    assert_eq!(payload["error"]["code"], "confirmation_required");
}

#[test]
fn local_validation_uses_stable_exit_two() {
    let (code, stdout, stderr) = run(
        &[
            "host",
            "call",
            "session_list",
            "--data",
            r#"{"limit":1,"offset":0,"unknown":true}"#,
        ],
        &[],
    );
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stderr).unwrap();
    assert_eq!(payload["error"]["type"], "validation");
    assert_eq!(payload["error"]["code"], "invalid_request_body");
}

#[test]
fn skill_reader_rejects_non_allowlisted_paths() {
    let (code, stdout, stderr) = run(&["host", "skills", "read", "cognia-host", "../secret"], &[]);
    assert_eq!(code, Some(2), "stdout: {stdout}\nstderr: {stderr}");
    let payload: serde_json::Value = serde_json::from_str(&stderr).unwrap();
    assert_eq!(payload["error"]["code"], "skill_path_forbidden");
}
