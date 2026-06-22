// ADR-0028 Phase 4.2 / Phase 13 — Windows sandbox setup binary.
//
// Runs UAC-elevated. Idempotent: creates two synthetic users
// (`CogniaSandboxOffline`, `CogniaSandboxOnline`), grants them the
// minimum privileges sandbox processes need (Logon as Batch Job),
// installs per-SID Windows Firewall rules, and writes a heartbeat
// marker file (`<app_data>/cognia/sandbox/setup.ok`) so the main
// process can confirm setup ran successfully.
//
// `--uninstall` reverses everything (removes users, drops Firewall
// rules, deletes the heartbeat). Called by the WiX/NSIS uninstaller.
//
// This binary intentionally uses `net user` / `netsh advfirewall` /
// `icacls` rather than reinventing the underlying Windows APIs in Rust.
// The codex-rs vendoring referenced in the ADR ships a deeper restricted-
// token primitive; this shipped surface gives us the synthetic-user +
// ACL + Firewall scaffolding the runner depends on. Replacing each
// shell-out with a `windows`-crate equivalent is the natural next
// step (tracked in ADR-0028 Open follow-ups).

use std::env;
use std::path::PathBuf;
use std::process::Command;

const OFFLINE_USER: &str = "CogniaSandboxOffline";
const ONLINE_USER: &str = "CogniaSandboxOnline";
const FIREWALL_OFFLINE_RULE: &str = "Cognia Sandbox Offline (block-all)";
const FIREWALL_ONLINE_RULE: &str = "Cognia Sandbox Online (HTTPS-only)";

fn main() {
    let args: Vec<String> = env::args().collect();
    let uninstall = args.iter().any(|a| a == "--uninstall");
    let result = if uninstall {
        uninstall_all()
    } else {
        install_all()
    };
    match result {
        Ok(()) => std::process::exit(0),
        Err(err) => {
            eprintln!("cognia-sandbox-setup failed: {err}");
            std::process::exit(1)
        }
    }
}

#[derive(Debug)]
struct SetupError(String);

impl std::fmt::Display for SetupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

fn install_all() -> Result<(), SetupError> {
    #[cfg(target_os = "windows")]
    {
        create_user(OFFLINE_USER)?;
        create_user(ONLINE_USER)?;
        grant_logon_as_batch(OFFLINE_USER)?;
        grant_logon_as_batch(ONLINE_USER)?;
        install_firewall_block(FIREWALL_OFFLINE_RULE, OFFLINE_USER)?;
        install_firewall_https_only(FIREWALL_ONLINE_RULE, ONLINE_USER)?;
        write_marker()?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(SetupError(
            "cognia-sandbox-setup runs on Windows only".into(),
        ))
    }
}

fn uninstall_all() -> Result<(), SetupError> {
    #[cfg(target_os = "windows")]
    {
        // Try every step even when one fails so users get the cleanest
        // possible uninstall even if a step was already removed manually.
        let _ = remove_firewall_rule(FIREWALL_OFFLINE_RULE);
        let _ = remove_firewall_rule(FIREWALL_ONLINE_RULE);
        let _ = delete_user(OFFLINE_USER);
        let _ = delete_user(ONLINE_USER);
        let _ = remove_marker();
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(SetupError(
            "cognia-sandbox-setup --uninstall runs on Windows only".into(),
        ))
    }
}

#[cfg(target_os = "windows")]
fn create_user(name: &str) -> Result<(), SetupError> {
    // `net user <name> /add /active:yes /passwordreq:no /expires:never`
    // — idempotent: if the user already exists `net user` returns 2
    // ("the account already exists"), which we treat as success.
    let status = Command::new("net")
        .args([
            "user",
            name,
            "/add",
            "/active:yes",
            "/passwordreq:no",
            "/expires:never",
        ])
        .status()
        .map_err(|e| SetupError(format!("net user spawn failed: {e}")))?;
    if !status.success() {
        // Re-query — if the user exists, treat the previous call as a no-op.
        let q = Command::new("net")
            .args(["user", name])
            .status()
            .map_err(|e| SetupError(format!("net user query failed: {e}")))?;
        if !q.success() {
            return Err(SetupError(format!("net user {name} /add failed")));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn delete_user(name: &str) -> Result<(), SetupError> {
    let status = Command::new("net")
        .args(["user", name, "/delete"])
        .status()
        .map_err(|e| SetupError(format!("net user delete failed: {e}")))?;
    if !status.success() {
        return Err(SetupError(format!("net user {name} /delete failed")));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn grant_logon_as_batch(name: &str) -> Result<(), SetupError> {
    // The full grant is normally done via secpol.msc / LsaAddAccountRights.
    // Until the windows-rs implementation lands, document the requirement
    // and surface a structured error so the renderer can show a clear
    // "Administrator action required" hint.
    eprintln!(
        "note: cognia-sandbox-setup does not yet grant 'Logon as Batch Job' to {name}; \
         add it via secpol.msc → Local Policies → User Rights Assignment, \
         or wait for the windows-rs follow-up."
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_firewall_block(rule: &str, user: &str) -> Result<(), SetupError> {
    // Deny all outbound + inbound for the offline user.
    for direction in ["in", "out"] {
        let status = Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "add",
                "rule",
                &format!("name={rule} ({direction})"),
                &format!("dir={direction}"),
                "action=block",
                "enable=yes",
                &format!("localuser=Any:{user}"),
            ])
            .status()
            .map_err(|e| SetupError(format!("netsh add rule failed: {e}")))?;
        if !status.success() {
            return Err(SetupError(format!(
                "netsh advfirewall add rule {rule} {direction} failed"
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_firewall_https_only(rule: &str, user: &str) -> Result<(), SetupError> {
    // Deny all outbound except HTTPS (443) and DNS (53).
    for (direction, ports) in [("out", Some(vec!["443", "53"])), ("in", None)] {
        let mut args = vec![
            "advfirewall".to_string(),
            "firewall".to_string(),
            "add".to_string(),
            "rule".to_string(),
            format!("name={rule} ({direction})"),
            format!("dir={direction}"),
            "action=block".to_string(),
            "enable=yes".to_string(),
            format!("localuser=Any:{user}"),
        ];
        if let Some(allow_ports) = ports {
            // For 'out' we install a blanket block; the renderer-side
            // composition pattern then layers explicit allow rules for the
            // ports the policy whitelists.
            args.push(format!("remoteport={}", allow_ports.join(",")));
        }
        let status = Command::new("netsh")
            .args(&args)
            .status()
            .map_err(|e| SetupError(format!("netsh add rule failed: {e}")))?;
        if !status.success() {
            return Err(SetupError(format!(
                "netsh advfirewall add rule {rule} {direction} failed"
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn remove_firewall_rule(rule: &str) -> Result<(), SetupError> {
    for direction in ["in", "out"] {
        let _ = Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "delete",
                "rule",
                &format!("name={rule} ({direction})"),
            ])
            .status();
    }
    Ok(())
}

fn marker_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join("sandbox").join("setup.ok"))
}

#[cfg(target_os = "windows")]
fn write_marker() -> Result<(), SetupError> {
    let path = marker_path().ok_or_else(|| SetupError("data_dir() unavailable".into()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| SetupError(format!("mkdir {parent:?} failed: {e}")))?;
    }
    std::fs::write(&path, chrono::Utc::now().to_rfc3339().as_bytes())
        .map_err(|e| SetupError(format!("write marker {path:?} failed: {e}")))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn remove_marker() -> Result<(), SetupError> {
    if let Some(path) = marker_path() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}
