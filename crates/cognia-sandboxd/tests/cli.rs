//! The binary end to end: the modes a driver actually invokes, with the exit
//! codes and files it reads back. `init-agent` is exercised here rather than
//! in-process because it installs signal handlers for the whole process.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use cognia_sandboxd::layout::{Arch, Libc};
use cognia_sandboxd::probe::{ProbeCode, ProbeReport};

const BIN: &str = env!("CARGO_BIN_EXE_cognia-sandboxd");

const MANIFEST: &str = r#"{"version":1,"releaseTag":"v9","minGlibc":"2.28","runtimes":[
    {"id":"claude-code","version":"2","libc":["glibc","musl"],
     "commands":[{"name":"claude-agent-acp","package":"@agentclientprotocol/claude-agent-acp"}]},
    {"id":"gemini-cli","version":"1","libc":["glibc"],
     "commands":[{"name":"gemini","package":"@google/gemini-cli"}]}]}"#;

fn sandboxd() -> Command {
    let mut command = Command::new(BIN);
    command.env_remove("COGNIA_SANDBOXD_PROVIDED_ENV");
    command
}

/// A static ELF for this machine: enough for the probe to accept `/bin/sh`.
fn static_elf() -> Vec<u8> {
    let machine = Arch::current()
        .expect("tests run on amd64 or arm64")
        .elf_machine();
    let mut bytes = vec![0u8; 64];
    bytes[..4].copy_from_slice(b"\x7fELF");
    bytes[4] = 2;
    bytes[5] = 1;
    bytes[6] = 1;
    bytes[18..20].copy_from_slice(&machine.to_le_bytes());
    bytes
}

fn bundle(dir: &Path) {
    fs::write(dir.join("bundle-manifest.json"), MANIFEST).unwrap();
    for sub in ["bin", "certs", "common/bin", "glibc/bin", "musl/bin"] {
        fs::create_dir_all(dir.join(sub)).unwrap();
    }
    fs::write(dir.join("bin/cognia-sandboxd"), b"sandboxd").unwrap();
    fs::write(dir.join("common/bin/rg"), b"rg").unwrap();
    fs::write(dir.join("certs/ca-bundle.pem"), b"pem").unwrap();
    fs::write(dir.join("glibc/bin/node"), b"glibc-node").unwrap();
    fs::write(dir.join("musl/bin/node"), b"musl-node").unwrap();
}

fn musl_image(root: &Path) {
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("lib")).unwrap();
    fs::create_dir_all(root.join("etc")).unwrap();
    fs::create_dir_all(root.join("workspace")).unwrap();
    fs::write(root.join("bin/busybox"), static_elf()).unwrap();
    fs::set_permissions(root.join("bin/busybox"), fs::Permissions::from_mode(0o755)).unwrap();
    symlink("/bin/busybox", root.join("bin/sh")).unwrap();
    let loader = match Arch::current().unwrap() {
        Arch::Amd64 => "ld-musl-x86_64.so.1",
        Arch::Arm64 => "ld-musl-aarch64.so.1",
    };
    fs::write(root.join("lib").join(loader), b"ld").unwrap();
    fs::write(root.join("etc/passwd"), "root:x:0:0:root:/root:/bin/sh\n").unwrap();
}

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

#[test]
fn stages_probes_and_stages_the_probed_libc() {
    let bundle_dir = tempfile::tempdir().unwrap();
    bundle(bundle_dir.path());
    let injection = tempfile::tempdir().unwrap();
    let image = tempfile::tempdir().unwrap();
    musl_image(image.path());

    let core = sandboxd()
        .args(["install", "--stage", "core", "--from"])
        .arg(bundle_dir.path())
        .arg("--to")
        .arg(injection.path())
        .output()
        .unwrap();
    assert!(
        core.status.success(),
        "{}",
        String::from_utf8_lossy(&core.stderr)
    );

    let probe = sandboxd()
        .arg("probe")
        .arg("--root")
        .arg(image.path())
        .arg("--bundle")
        .arg(injection.path())
        .args(["--workspace", "/workspace", "--user"])
        .arg(uid().to_string())
        .output()
        .unwrap();
    assert_eq!(
        probe.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&probe.stderr)
    );
    let report: ProbeReport =
        serde_json::from_slice(&fs::read(injection.path().join("probe.json")).unwrap()).unwrap();
    assert_eq!(report.libc, Some(Libc::Musl));
    assert_eq!(report.runtimes, ["claude-code"]);
    assert_eq!(
        serde_json::from_slice::<ProbeReport>(&probe.stdout).unwrap(),
        report
    );

    // No --libc: the stage reads it from probe.json.
    let libc = sandboxd()
        .args(["install", "--stage", "libc", "--from"])
        .arg(bundle_dir.path())
        .arg("--to")
        .arg(injection.path())
        .output()
        .unwrap();
    assert!(
        libc.status.success(),
        "{}",
        String::from_utf8_lossy(&libc.stderr)
    );
    assert_eq!(
        fs::read(injection.path().join("musl/bin/node")).unwrap(),
        b"musl-node"
    );
    assert!(!injection.path().join("glibc").exists());
}

#[test]
fn probe_exit_codes_are_the_driver_contract() {
    let injection = tempfile::tempdir().unwrap();
    fs::write(injection.path().join("bundle-manifest.json"), MANIFEST).unwrap();
    let image = tempfile::tempdir().unwrap();
    musl_image(image.path());

    let missing_user = sandboxd()
        .arg("probe")
        .arg("--root")
        .arg(image.path())
        .arg("--bundle")
        .arg(injection.path())
        .args(["--user", "vscode"])
        .output()
        .unwrap();
    assert_eq!(
        missing_user.status.code(),
        Some(ProbeCode::UserMissing.exit_code())
    );

    fs::remove_file(image.path().join("bin/sh")).unwrap();
    let no_shell = sandboxd()
        .arg("probe")
        .arg("--root")
        .arg(image.path())
        .arg("--bundle")
        .arg(injection.path())
        .arg("--user")
        .arg(uid().to_string())
        .output()
        .unwrap();
    assert_eq!(no_shell.status.code(), Some(ProbeCode::NoShell.exit_code()));

    let no_manifest = sandboxd()
        .arg("probe")
        .arg("--root")
        .arg(image.path())
        .arg("--bundle")
        .arg(image.path())
        .output()
        .unwrap();
    assert_eq!(no_manifest.status.code(), Some(1));
}

#[test]
fn init_agent_passes_the_exit_status_through() {
    let status = |script: &str| {
        sandboxd()
            .args([
                "init-agent",
                "--bundle",
                "/nonexistent",
                "--",
                "/bin/sh",
                "-c",
                script,
            ])
            .status()
            .unwrap()
            .code()
    };
    assert_eq!(status("exit 0"), Some(0));
    assert_eq!(status("exit 3"), Some(3));
    assert_eq!(status("kill -9 $$"), Some(128 + 9));
}

#[test]
fn init_agent_forwards_sigterm_to_the_agent() {
    let mut child = sandboxd()
        .args([
            "init-agent",
            "--bundle",
            "/nonexistent",
            "--",
            "/bin/sh",
            "-c",
            "trap 'exit 7' TERM; echo ready; while :; do sleep 0.05; done",
        ])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    // Wait until the trap is installed.
    let mut stdout = child.stdout.take().unwrap();
    let mut buffer = [0u8; 6];
    std::io::Read::read_exact(&mut stdout, &mut buffer).unwrap();
    assert_eq!(&buffer, b"ready\n");

    // SAFETY: kill with a valid pid of our own child.
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(7));
            break;
        }
        assert!(
            Instant::now() < deadline,
            "init-agent did not forward SIGTERM"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn init_agent_cleans_the_environment() {
    let bundle_dir = tempfile::tempdir().unwrap();
    // A staged probe with a CA store and a musl image, so the result does not
    // depend on what the machine running the tests has in `/`.
    fs::write(
        bundle_dir.path().join("probe.json"),
        r#"{"version":1,"arch":"amd64","libc":"musl","workspaceWritable":true,
            "caBundle":"/etc/ssl/cert.pem","runtimes":[],"problems":[]}"#,
    )
    .unwrap();
    let output = sandboxd()
        .arg("init-agent")
        .arg("--bundle")
        .arg(bundle_dir.path())
        .args([
            "--",
            "/bin/sh",
            "-c",
            "printf '%s|%s|%s|%s|%s' \"${OPENAI_API_KEY-unset}\" \"${ANTHROPIC_AUTH_TOKEN-unset}\" \"${COGNIA_SANDBOXD_SECRET-unset}\" \"$SSL_CERT_FILE\" \"$PATH\"",
        ])
        .env("OPENAI_API_KEY", "from-the-image")
        .env("ANTHROPIC_AUTH_TOKEN", "ticket")
        .env("COGNIA_SANDBOXD_SECRET", "claim")
        .env("COGNIA_SANDBOXD_PROVIDED_ENV", "ANTHROPIC_AUTH_TOKEN")
        .env("PATH", "/usr/bin:/bin")
        .env_remove("SSL_CERT_FILE")
        .env_remove("GIT_SSL_CAINFO")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    let dir = |sub: &str| bundle_dir.path().join(sub).display().to_string();
    assert_eq!(
        text,
        format!(
            "unset|ticket|unset|/etc/ssl/cert.pem|/usr/bin:/bin:{}:{}:{}",
            dir("bin"),
            dir("musl/bin"),
            dir("common/bin")
        )
    );
}

#[test]
fn init_agent_refuses_what_it_cannot_do_with_125() {
    let image = tempfile::tempdir().unwrap();
    musl_image(image.path());

    let missing = sandboxd()
        .arg("init-agent")
        .arg("--root")
        .arg(image.path())
        .args(["--user", "vscode", "--", "/bin/true"])
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(125));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("vscode"));

    let not_found = sandboxd()
        .args([
            "init-agent",
            "--bundle",
            "/nonexistent",
            "--",
            "/definitely/not/here",
        ])
        .output()
        .unwrap();
    assert_eq!(not_found.status.code(), Some(125));

    if uid() != 0 {
        let switch = sandboxd()
            .arg("init-agent")
            .arg("--root")
            .arg(image.path())
            .args(["--user", "0", "--", "/bin/true"])
            .output()
            .unwrap();
        assert_eq!(switch.status.code(), Some(125));
        assert!(String::from_utf8_lossy(&switch.stderr).contains("needs root"));
    }
}

/// The probe a Docker driver runs: every volume read-only, the report read
/// from stdout, commands listed for the spawn mapping.
#[test]
fn probe_to_stdout_writes_no_file_and_lists_commands() {
    let injection = tempfile::tempdir().unwrap();
    fs::write(injection.path().join("bundle-manifest.json"), MANIFEST).unwrap();
    let image = tempfile::tempdir().unwrap();
    musl_image(image.path());

    let output = sandboxd()
        .arg("probe")
        .arg("--root")
        .arg(image.path())
        .arg("--bundle")
        .arg(injection.path())
        .args(["--out", "-", "--user"])
        .arg(uid().to_string())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!injection.path().join("probe.json").exists());
    assert!(!Path::new("-").exists());
    let report: ProbeReport = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report
            .commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>(),
        ["claude-agent-acp"]
    );
}

/// A named user whose uid is not the workspace owner's runs as the owner,
/// keeping its name and home — the devcontainer `updateRemoteUserUID` rule.
#[test]
fn a_named_user_is_matched_to_the_workspace_owner_by_probe_and_init() {
    let injection = tempfile::tempdir().unwrap();
    fs::write(injection.path().join("bundle-manifest.json"), MANIFEST).unwrap();
    let image = tempfile::tempdir().unwrap();
    musl_image(image.path());
    fs::write(
        image.path().join("etc/passwd"),
        "root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\n",
    )
    .unwrap();
    fs::create_dir_all(image.path().join("home/node")).unwrap();
    let me = uid();
    if me != 0 {
        // A non-root fixture cannot discard the test runner's supplementary
        // groups. Model its actual identity in the image's group database.
        let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
        assert!(count >= 0);
        let mut groups = vec![0; count as usize];
        assert!(unsafe { libc::getgroups(count, groups.as_mut_ptr()) } >= 0);
        let group_file = groups
            .into_iter()
            .enumerate()
            .map(|(index, gid)| format!("fixture{index}:x:{gid}:node\n"))
            .collect::<String>();
        fs::write(image.path().join("etc/group"), group_file).unwrap();
    }

    let probe = sandboxd()
        .arg("probe")
        .arg("--root")
        .arg(image.path())
        .arg("--bundle")
        .arg(injection.path())
        .args(["--out", "-", "--user", "node", "--match-workspace-owner"])
        .output()
        .unwrap();
    let report: ProbeReport = serde_json::from_slice(&probe.stdout).unwrap();
    let expected_uid = if me == 0 { 1000 } else { me };
    assert_eq!(
        report.user.as_ref().map(|user| user.uid),
        Some(expected_uid)
    );
    assert_eq!(report.user_remapped_from.is_some(), me != 0 && me != 1000);

    let init = sandboxd()
        .arg("init-agent")
        .arg("--root")
        .arg(image.path())
        .arg("--bundle")
        .arg(injection.path())
        .args([
            "--user",
            "node",
            "--match-owner-of",
            "/workspace",
            "--",
            "/bin/sh",
            "-c",
            "printf '%s|%s' \"$(id -u)\" \"$HOME\"",
        ])
        .output()
        .unwrap();
    assert!(
        init.status.success(),
        "{}",
        String::from_utf8_lossy(&init.stderr)
    );
    assert_eq!(
        String::from_utf8(init.stdout).unwrap(),
        format!("{expected_uid}|/home/node")
    );
}
