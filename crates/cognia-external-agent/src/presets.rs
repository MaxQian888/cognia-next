//! `SpawnPolicy` — the preset allowlist gating the RCE-grade headless
//! external-agent RPC arms (ADR-0059 D6 / R11).
//!
//! `spawn_external_agent` over the companion RPC surface is remote code
//! execution by construction. On the desktop the surface never existed (the
//! WebView calls the Tauri command locally); headless it is reachable with
//! the brain's service token, so every spawn request is validated against a
//! **preset-only** policy before it touches the exec backend:
//!
//! - the command must be a bare binary name (no path separators) from the
//!   agent-CLI allowlist, or `npx` with an allowlisted package, or the smoke
//!   stub (only when `COGNIA_SMOKE_AGENT=1`);
//! - the working directory must canonicalize under the workspaces root
//!   (`COGNIA_WORKSPACES_DIR`, default `<data_dir>/workspaces`);
//! - env keys are allowlisted (provider credentials + proxy), with the
//!   `LD_PRELOAD` class default-denied. Dropped keys are reported so the
//!   audit log records them.
//!
//! Every allow AND deny is written to the append-only audit log
//! (`companion_api::audit`) by the RPC arm.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::process::ExternalAgentSpawnConfig;

/// Env var that admits the smoke stub agent (`stub-acp-agent.mjs`) run via
/// `node`. Never set it outside the tier-2 smoke environment.
pub const SMOKE_AGENT_ENV: &str = "COGNIA_SMOKE_AGENT";

/// Env var naming the workspaces root external agents may run under.
pub const WORKSPACES_DIR_ENV: &str = "COGNIA_WORKSPACES_DIR";

/// Bare binary names an external-agent spawn may execute (ADR-0048/0049
/// ecosystem; resolution itself goes through `command_resolver`).
const BINARY_ALLOWLIST: &[&str] = &[
    "claude",
    "claude-code-acp",
    "codex",
    "codex-acp",
    "opencode",
    "cursor-agent",
    "cline",
    "gemini",
    "copilot",
    "kiro-cli",
    "droid",
];

/// Packages `npx` may execute (`npx [-y|--yes] <package> …`).
const NPX_PACKAGE_ALLOWLIST: &[&str] = &[
    "@agentclientprotocol/claude-agent-acp",
    "@zed-industries/claude-code-acp",
    "@zed-industries/codex-acp",
    "@anthropic-ai/claude-code",
    "@google/gemini-cli",
    "@qwen-code/qwen-code",
    "pi-acp",
    "opencode-ai",
];

/// Exact env keys always allowed through.
const ENV_KEY_ALLOWLIST: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "TERM",
    "LANG",
    "LC_ALL",
];

/// Env key prefixes allowed through (provider credentials + agent config).
const ENV_PREFIX_ALLOWLIST: &[&str] = &[
    "ANTHROPIC_",
    "CLAUDE_",
    "OPENAI_",
    "CODEX_",
    "GEMINI_",
    "GOOGLE_",
    "OPENCODE_",
    "CURSOR_",
    "COPILOT_",
    "GITHUB_",
    "GH_",
    "QWEN_",
    "KIRO_",
    "FACTORY_",
    "DROID_",
    "ACP_",
    "COGNIA_AGENT_",
];

/// A policy violation. The message is safe to surface to the caller and to
/// the audit log (it never echoes env values).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyViolation(pub String);

impl std::fmt::Display for PolicyViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Validated + sanitized spawn request.
#[derive(Debug)]
pub struct ValidatedSpawn {
    pub config: ExternalAgentSpawnConfig,
    /// Env keys removed by the allowlist — recorded in the audit trail.
    pub dropped_env_keys: Vec<String>,
}

/// The spawn policy for one server process.
#[derive(Debug, Clone)]
pub struct SpawnPolicy {
    workspaces_dir: PathBuf,
    smoke_agent_enabled: bool,
}

impl SpawnPolicy {
    pub fn new(workspaces_dir: PathBuf, smoke_agent_enabled: bool) -> Self {
        Self {
            workspaces_dir,
            smoke_agent_enabled,
        }
    }

    /// Standard construction: workspaces root from `COGNIA_WORKSPACES_DIR`
    /// (default `<data_dir>/workspaces`), smoke stub gated on
    /// `COGNIA_SMOKE_AGENT=1`.
    pub fn from_env(data_dir: &Path) -> Self {
        let workspaces_dir = std::env::var(WORKSPACES_DIR_ENV)
            .ok()
            .filter(|raw| !raw.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("workspaces"));
        let smoke = std::env::var(SMOKE_AGENT_ENV)
            .map(|v| v == "1")
            .unwrap_or(false);
        Self::new(workspaces_dir, smoke)
    }

    /// Validate a spawn request. Returns the sanitized config (allowlisted
    /// env, canonicalized cwd) or the violation that denies it.
    pub fn validate(
        &self,
        mut config: ExternalAgentSpawnConfig,
    ) -> Result<ValidatedSpawn, PolicyViolation> {
        self.validate_command(&config.command, &config.args)?;
        config.cwd = Some(self.validate_cwd(config.cwd.as_deref())?);
        let (env, dropped) = filter_env(std::mem::take(&mut config.env));
        config.env = env;
        Ok(ValidatedSpawn {
            config,
            dropped_env_keys: dropped,
        })
    }

    fn validate_command(&self, command: &str, args: &[String]) -> Result<(), PolicyViolation> {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return Err(PolicyViolation("empty command".into()));
        }
        if trimmed.contains('/') || trimmed.contains('\\') {
            return Err(PolicyViolation(format!(
                "command must be a bare allowlisted binary name, got a path: {trimmed:?}"
            )));
        }
        let lower = trimmed.to_ascii_lowercase();
        let base = lower
            .strip_suffix(".exe")
            .or_else(|| lower.strip_suffix(".cmd"))
            .or_else(|| lower.strip_suffix(".bat"))
            .unwrap_or(&lower);

        if BINARY_ALLOWLIST.contains(&base) {
            return Ok(());
        }
        if base == "npx" {
            return validate_npx_args(args);
        }
        if base == "node" {
            if self.smoke_agent_enabled && is_smoke_stub_invocation(args) {
                return Ok(());
            }
            return Err(PolicyViolation(
                "node is only admitted for the smoke stub (COGNIA_SMOKE_AGENT=1 + stub-acp-agent.mjs)"
                    .into(),
            ));
        }
        Err(PolicyViolation(format!(
            "binary {trimmed:?} is not in the external-agent allowlist"
        )))
    }

    /// The cwd must exist and canonicalize under the workspaces root.
    /// `None` resolves to the workspaces root itself (created on demand).
    fn validate_cwd(&self, cwd: Option<&str>) -> Result<String, PolicyViolation> {
        std::fs::create_dir_all(&self.workspaces_dir)
            .map_err(|e| PolicyViolation(format!("workspaces dir unavailable: {e}")))?;
        let root = self
            .workspaces_dir
            .canonicalize()
            .map_err(|e| PolicyViolation(format!("workspaces dir canonicalize: {e}")))?;

        let requested = match cwd {
            None => return Ok(root.display().to_string()),
            Some(raw) => {
                let p = PathBuf::from(raw);
                if p.is_absolute() {
                    p
                } else {
                    root.join(p)
                }
            }
        };
        let canonical = requested.canonicalize().map_err(|e| {
            PolicyViolation(format!(
                "cwd {:?} does not resolve: {e}",
                requested.display()
            ))
        })?;
        if !canonical.starts_with(&root) {
            return Err(PolicyViolation(format!(
                "cwd {:?} escapes the workspaces root {:?}",
                canonical.display(),
                root.display()
            )));
        }
        Ok(canonical.display().to_string())
    }
}

/// `npx [-y|--yes|--no-install] <package> …` — the first non-flag argument
/// must be an allowlisted package.
fn validate_npx_args(args: &[String]) -> Result<(), PolicyViolation> {
    let package = args.iter().find(|a| !a.starts_with('-'));
    match package {
        Some(pkg) if NPX_PACKAGE_ALLOWLIST.contains(&pkg.as_str()) => Ok(()),
        Some(pkg) => Err(PolicyViolation(format!(
            "npx package {pkg:?} is not in the allowlist"
        ))),
        None => Err(PolicyViolation("npx invocation names no package".into())),
    }
}

/// `node <path ending in stub-acp-agent.mjs> …`.
fn is_smoke_stub_invocation(args: &[String]) -> bool {
    args.first()
        .map(|entry| {
            Path::new(entry)
                .file_name()
                .map(|f| f == "stub-acp-agent.mjs")
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Keep allowlisted env keys; drop everything else (default-deny — this is
/// what keeps `LD_PRELOAD`/`DYLD_*`/`NODE_OPTIONS` out). Returns the kept
/// map and the dropped key names for the audit record.
fn filter_env(env: HashMap<String, String>) -> (HashMap<String, String>, Vec<String>) {
    let mut kept = HashMap::new();
    let mut dropped = Vec::new();
    for (key, value) in env {
        let allowed = ENV_KEY_ALLOWLIST.contains(&key.as_str())
            || ENV_PREFIX_ALLOWLIST
                .iter()
                .any(|prefix| key.starts_with(prefix));
        if allowed {
            kept.insert(key, value);
        } else {
            dropped.push(key);
        }
    }
    dropped.sort();
    (kept, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(command: &str, args: &[&str]) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: "a1".into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: HashMap::new(),
            cwd: None,
        }
    }

    fn policy(smoke: bool) -> (tempfile::TempDir, SpawnPolicy) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let policy = SpawnPolicy::new(tmp.path().join("workspaces"), smoke);
        (tmp, policy)
    }

    // ── Policy matrix: command ───────────────────────────────────────────────

    #[test]
    fn allowlisted_binaries_pass() {
        let (_tmp, p) = policy(false);
        for bin in [
            "claude",
            "codex",
            "opencode",
            "cursor-agent",
            "cline",
            "gemini",
            "claude-code-acp",
            "copilot",
            "kiro-cli",
            "droid",
        ] {
            assert!(p.validate(config(bin, &[])).is_ok(), "{bin} must pass");
        }
        // Windows shims normalize.
        assert!(p.validate(config("claude.CMD", &[])).is_ok());
        assert!(p.validate(config("codex.exe", &[])).is_ok());
    }

    #[test]
    fn arbitrary_binaries_and_paths_are_denied() {
        let (_tmp, p) = policy(false);
        assert!(p.validate(config("bash", &[])).is_err());
        assert!(p.validate(config("rm", &["-rf", "/"])).is_err());
        assert!(p.validate(config("", &[])).is_err());
        // Paths are rejected even when the file name is allowlisted.
        assert!(p.validate(config("/usr/bin/claude", &[])).is_err());
        assert!(p.validate(config("..\\claude", &[])).is_err());
    }

    #[test]
    fn npx_requires_an_allowlisted_package() {
        let (_tmp, p) = policy(false);
        assert!(p
            .validate(config(
                "npx",
                &["-y", "@agentclientprotocol/claude-agent-acp"]
            ))
            .is_ok());
        assert!(p
            .validate(config("npx", &["-y", "@google/gemini-cli", "--acp"]))
            .is_ok());
        assert!(p
            .validate(config("npx", &["-y", "@qwen-code/qwen-code", "--acp"]))
            .is_ok());
        assert!(p.validate(config("npx", &["-y", "pi-acp"])).is_ok());
        assert!(p
            .validate(config("npx", &["--yes", "opencode-ai", "--acp"]))
            .is_ok());
        assert!(p.validate(config("npx", &["-y", "evil-package"])).is_err());
        assert!(p.validate(config("npx", &["-y"])).is_err());
    }

    #[test]
    fn smoke_stub_is_gated_on_the_env() {
        let (_tmp, without) = policy(false);
        assert!(without
            .validate(config("node", &["/opt/cognia/smoke/stub-acp-agent.mjs"]))
            .is_err());

        let (_tmp2, with) = policy(true);
        assert!(with
            .validate(config("node", &["/opt/cognia/smoke/stub-acp-agent.mjs"]))
            .is_ok());
        // Even with the gate, arbitrary node scripts stay denied.
        assert!(with.validate(config("node", &["evil.mjs"])).is_err());
        assert!(with.validate(config("node", &[])).is_err());
    }

    // ── Policy matrix: cwd ───────────────────────────────────────────────────

    #[test]
    fn cwd_defaults_to_the_workspaces_root_and_escapes_are_denied() {
        let (tmp, p) = policy(false);

        // None → workspaces root (created on demand).
        let validated = p.validate(config("claude", &[])).expect("default cwd");
        let root = tmp.path().join("workspaces").canonicalize().unwrap();
        assert_eq!(
            PathBuf::from(validated.config.cwd.unwrap())
                .canonicalize()
                .unwrap(),
            root
        );

        // A subdir under the root passes (relative resolution).
        std::fs::create_dir_all(tmp.path().join("workspaces").join("proj")).unwrap();
        let mut cfg = config("claude", &[]);
        cfg.cwd = Some("proj".into());
        assert!(p.validate(cfg).is_ok());

        // Escaping the root is denied — both via absolute path and via `..`.
        let mut cfg = config("claude", &[]);
        cfg.cwd = Some(tmp.path().display().to_string());
        assert!(p.validate(cfg).is_err(), "workspace parent must be outside");
        let mut cfg = config("claude", &[]);
        cfg.cwd = Some("proj/../..".into());
        assert!(p.validate(cfg).is_err(), "dot-dot escape must be denied");
    }

    // ── Policy matrix: env ───────────────────────────────────────────────────

    #[test]
    fn env_is_default_deny_with_provider_allowlist() {
        let (_tmp, p) = policy(false);
        let mut cfg = config("claude", &[]);
        cfg.env = HashMap::from([
            ("ANTHROPIC_API_KEY".to_string(), "sk".to_string()),
            ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "oat".to_string()),
            ("GH_TOKEN".to_string(), "gh".to_string()),
            ("QWEN_API_KEY".to_string(), "qwen".to_string()),
            ("FACTORY_API_KEY".to_string(), "factory".to_string()),
            ("HTTPS_PROXY".to_string(), "http://p".to_string()),
            ("LD_PRELOAD".to_string(), "/evil.so".to_string()),
            ("NODE_OPTIONS".to_string(), "--require evil".to_string()),
            (
                "DYLD_INSERT_LIBRARIES".to_string(),
                "/evil.dylib".to_string(),
            ),
            ("PATH".to_string(), "/evil".to_string()),
        ]);
        let validated = p.validate(cfg).expect("valid command");
        assert!(validated.config.env.contains_key("ANTHROPIC_API_KEY"));
        assert!(validated.config.env.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(validated.config.env.contains_key("GH_TOKEN"));
        assert!(validated.config.env.contains_key("QWEN_API_KEY"));
        assert!(validated.config.env.contains_key("FACTORY_API_KEY"));
        assert!(validated.config.env.contains_key("HTTPS_PROXY"));
        assert_eq!(
            validated.dropped_env_keys,
            vec![
                "DYLD_INSERT_LIBRARIES",
                "LD_PRELOAD",
                "NODE_OPTIONS",
                "PATH"
            ]
        );
        assert_eq!(validated.config.env.len(), 6);
    }

    #[test]
    fn from_env_reads_smoke_gate_and_workspaces_dir() {
        // Only this test touches these vars.
        let prev_ws = std::env::var(WORKSPACES_DIR_ENV).ok();
        let prev_smoke = std::env::var(SMOKE_AGENT_ENV).ok();

        std::env::set_var(WORKSPACES_DIR_ENV, "X:/ws");
        std::env::set_var(SMOKE_AGENT_ENV, "1");
        let p = SpawnPolicy::from_env(Path::new("/data"));
        assert_eq!(p.workspaces_dir, PathBuf::from("X:/ws"));
        assert!(p.smoke_agent_enabled);

        std::env::remove_var(WORKSPACES_DIR_ENV);
        std::env::set_var(SMOKE_AGENT_ENV, "0");
        let p = SpawnPolicy::from_env(Path::new("/data"));
        assert_eq!(p.workspaces_dir, PathBuf::from("/data").join("workspaces"));
        assert!(!p.smoke_agent_enabled);

        match prev_ws {
            Some(v) => std::env::set_var(WORKSPACES_DIR_ENV, v),
            None => std::env::remove_var(WORKSPACES_DIR_ENV),
        }
        match prev_smoke {
            Some(v) => std::env::set_var(SMOKE_AGENT_ENV, v),
            None => std::env::remove_var(SMOKE_AGENT_ENV),
        }
    }
}
