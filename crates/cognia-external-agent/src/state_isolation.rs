//! Per-configuration agent state roots (ADR-0216, "State-root launch contract").
//!
//! An `isolated` external-agent configuration must not share the CLI's login,
//! sessions or settings with the user's own install or with another Cognia
//! configuration of the same runtime. The TypeScript launch path asks for that
//! by setting [`AGENT_STATE_KEY_ENV`] to the configuration id; every spawn
//! backend that sees the key:
//!
//! 1. validates it ([`state_key_valid`]) and refuses the spawn otherwise;
//! 2. resolves `<data_dir>/cognia/external-agents/<key>` from the HOST
//!    environment ([`agent_state_data_dir`]), never from the child env;
//! 3. creates the root and the rule's subdirectories, owner-only on unix;
//! 4. inserts the rule's env mapping (`CODEX_HOME=<root>/codex`, …);
//! 5. under the sandbox (see [`crate::sandbox::wrap_with_sandbox`]) grants the
//!    root as writable, withdraws the runtime's shared default roots from the
//!    writable set and denies reading them, so the CLI cannot fall back to the
//!    host login.
//!
//! The key itself never reaches the child.
//!
//! The rule table mirrors `agentStateIsolation.rules` in
//! `protocol/external-agent-security-policy.json`, as compiled-in literals for
//! the same reason [`crate::sandbox::agent_state_writable_roots`] mirrors its
//! table: a security policy must not depend on parsing a file at runtime.
//! `pnpm audit:agent-capabilities` fails when the two disagree.
//!
//! A launch that already owns a private home — a Bot-isolated spawn
//! (`COGNIA_BOT_ISOLATION=1`) or a gateway task (`COGNIA_GATEWAY_TASK_CONFIG`)
//! — ignores the key: both already keep every runtime's state out of the
//! user's roots, and layering a second home on top would only fight them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::process::ExternalAgentSpawnConfig;

/// The env variable a configuration sets to ask for a private state root.
/// Same name as `AGENT_STATE_KEY_ENV` in
/// `lib/ai/agent/external/policy/security-policy.ts`.
pub const AGENT_STATE_KEY_ENV: &str = "COGNIA_AGENT_STATE_KEY";

/// How a rule's `values` are compared, exactly as `agentStateWritableRoots`
/// resolves them: `Contains` against the launch target (the npx package when
/// the command is `npx`), `Base` against the bare command, `Target` equal to
/// the launch target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IsolationMatch {
    Contains,
    Base,
    Target,
}

/// One row of `agentStateIsolation.rules`.
#[derive(Debug, Clone, Copy)]
pub struct AgentStateIsolationRule {
    pub match_kind: IsolationMatch,
    pub values: &'static [&'static str],
    /// Env key → path relative to the configuration's state root.
    pub env: &'static [(&'static str, &'static str)],
    /// Home-relative default state roots the isolated launch must not write.
    pub shared_roots: &'static [&'static str],
    /// Home-relative roots the isolated launch must not read.
    pub deny_readable: &'static [&'static str],
}

/// Mirrors `agentStateIsolation.rules` in
/// `protocol/external-agent-security-policy.json`, row for row and in order.
/// Only documented home variables are listed; a runtime with no row cannot be
/// isolated and its isolated launch is refused.
pub const AGENT_STATE_ISOLATION_RULES: &[AgentStateIsolationRule] = &[
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Contains,
        values: &["codex"],
        env: &[("CODEX_HOME", "codex")],
        shared_roots: &[".codex"],
        deny_readable: &[".codex"],
    },
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Contains,
        values: &["claude"],
        env: &[("CLAUDE_CONFIG_DIR", "claude")],
        shared_roots: &[".claude", ".claude.json", ".claude.json.backup"],
        deny_readable: &[".claude", ".claude.json", ".claude.json.backup"],
    },
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Contains,
        values: &["qwen"],
        env: &[("QWEN_HOME", "qwen"), ("QWEN_RUNTIME_DIR", "qwen-runtime")],
        shared_roots: &[".qwen"],
        deny_readable: &[".qwen"],
    },
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Base,
        values: &["pi"],
        env: &[("PI_CODING_AGENT_DIR", "pi")],
        shared_roots: &[".pi"],
        deny_readable: &[".pi"],
    },
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Base,
        values: &["kimi"],
        env: &[("KIMI_CODE_HOME", "kimi")],
        shared_roots: &[".kimi-code"],
        deny_readable: &[".kimi-code", ".kimi"],
    },
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Base,
        values: &["cline"],
        env: &[("CLINE_DIR", "cline")],
        shared_roots: &[".cline"],
        deny_readable: &[".cline"],
    },
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Base,
        values: &["qoder"],
        env: &[("QODER_CONFIG_DIR", "qoder")],
        shared_roots: &[".qoder"],
        deny_readable: &[],
    },
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Contains,
        values: &["copilot"],
        env: &[("COPILOT_HOME", "copilot")],
        shared_roots: &[".copilot"],
        deny_readable: &[".copilot"],
    },
    AgentStateIsolationRule {
        match_kind: IsolationMatch::Contains,
        values: &["opencode"],
        env: &[
            ("OPENCODE_CONFIG_DIR", "config/opencode"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CACHE_HOME", "cache"),
        ],
        shared_roots: &[".config/opencode", ".local/share/opencode"],
        deny_readable: &[".config/opencode", ".local/share/opencode"],
    },
];

/// The merged isolation rule for one launch. Several matching rows merge (a
/// target naming two families gets both homes); a later row wins an env key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedAgentStateIsolation {
    /// Env key → root-relative path, in rule order.
    pub env: Vec<(String, String)>,
    pub shared_roots: Vec<String>,
    pub deny_readable: Vec<String>,
}

/// What the sandbox wrapper needs from an applied isolation: every path is
/// absolute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolationPlan {
    /// `<data_dir>/cognia/external-agents/<key>`.
    pub root: PathBuf,
    /// The runtime's shared default state roots under the user's home. They
    /// must leave the writable set.
    pub shared_roots: Vec<PathBuf>,
    /// Roots under the user's home the agent must not read.
    pub deny_readable: Vec<PathBuf>,
}

/// Disk facts about one configuration's state root, for the settings UI.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateRootInfo {
    pub path: String,
    pub exists: bool,
    /// Total size of the regular files under the root. Symlinks are counted
    /// as themselves and never followed.
    pub bytes: u64,
}

/// A state key is a configuration id, never a path: `^[A-Za-z0-9_-]{1,128}$`
/// (`AGENT_STATE_KEY_PATTERN` on the TypeScript side).
pub fn state_key_valid(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The per-user data directory the desktop app already uses
/// (`dirs::data_dir()`): `~/Library/Application Support` on macOS,
/// `$XDG_DATA_HOME` (only when absolute) or `~/.local/share` on Linux,
/// `%APPDATA%` on Windows. Pure, so every platform is testable on any host.
pub fn agent_state_data_dir(
    os: &str,
    home: Option<&Path>,
    xdg_data_home: Option<&Path>,
    appdata: Option<&Path>,
) -> Option<PathBuf> {
    let home = home.filter(|path| path.is_absolute());
    match os {
        "macos" => Some(home?.join("Library").join("Application Support")),
        "linux" => match xdg_data_home.filter(|path| path.is_absolute()) {
            Some(xdg) => Some(xdg.to_path_buf()),
            None => Some(home?.join(".local").join("share")),
        },
        "windows" => appdata
            .filter(|path| path.is_absolute())
            .map(Path::to_path_buf),
        _ => None,
    }
}

fn current_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unsupported"
    }
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The host's own home directory (`HOME`, then `USERPROFILE`).
pub fn host_home() -> Option<PathBuf> {
    non_empty_env_path("HOME").or_else(|| non_empty_env_path("USERPROFILE"))
}

/// [`agent_state_data_dir`] for this process, read from the HOST environment.
pub fn host_agent_state_data_dir() -> Option<PathBuf> {
    agent_state_data_dir(
        current_os(),
        host_home().as_deref(),
        non_empty_env_path("XDG_DATA_HOME").as_deref(),
        non_empty_env_path("APPDATA").as_deref(),
    )
}

/// `<data_dir>/cognia/external-agents/<key>`. The key must already be valid.
pub fn agent_state_root(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join("cognia").join("external-agents").join(key)
}

/// Strip a Windows executable suffix and lower-case, as both launchers do.
fn base_command(command: &str) -> String {
    let lower = command.trim().to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat"] {
        if let Some(stripped) = lower.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    lower
}

/// `npx <package>` runs the package, so the state belongs to the package.
fn launch_target(command: &str, args: &[String]) -> (String, String) {
    let base = base_command(command);
    let target = if base == "npx" {
        args.iter()
            .find(|arg| !arg.starts_with('-'))
            .cloned()
            .unwrap_or_else(|| base.clone())
    } else {
        base.clone()
    };
    (base, target)
}

fn rule_matches(rule: &AgentStateIsolationRule, base: &str, target: &str) -> bool {
    match rule.match_kind {
        IsolationMatch::Contains => rule.values.iter().any(|value| target.contains(value)),
        IsolationMatch::Target => rule.values.contains(&target),
        IsolationMatch::Base => rule.values.contains(&base),
    }
}

/// The isolation rule for a launch, or `None` when the runtime has no
/// documented home variable and so cannot be isolated. Same semantics as
/// `agentStateIsolationFor` in the TypeScript policy accessor.
pub fn isolation_rule_for(command: &str, args: &[String]) -> Option<ResolvedAgentStateIsolation> {
    let (base, target) = launch_target(command, args);
    let mut resolved: Option<ResolvedAgentStateIsolation> = None;
    for rule in AGENT_STATE_ISOLATION_RULES {
        if !rule_matches(rule, &base, &target) {
            continue;
        }
        let merged = resolved.get_or_insert_with(Default::default);
        for (key, relative) in rule.env {
            match merged.env.iter_mut().find(|(existing, _)| existing == key) {
                Some(entry) => entry.1 = (*relative).to_string(),
                None => merged
                    .env
                    .push(((*key).to_string(), (*relative).to_string())),
            }
        }
        for root in rule.shared_roots {
            if !merged.shared_roots.iter().any(|existing| existing == root) {
                merged.shared_roots.push((*root).to_string());
            }
        }
        for root in rule.deny_readable {
            if !merged.deny_readable.iter().any(|existing| existing == root) {
                merged.deny_readable.push((*root).to_string());
            }
        }
    }
    resolved
}

/// Does this launch already run under a private home of its own?
pub fn launch_owns_private_home(env: &HashMap<String, String>) -> bool {
    env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1")
        || env.contains_key(crate::gateway_task::PAYLOAD_ENV)
}

/// Drop the state key without applying it. For launches whose confinement
/// is not this host's process table (a runtime-environment container, a
/// container or Kubernetes exec backend): the child cannot see the host's
/// login roots there, and a host path in its env would name nothing.
/// Returns whether a key was present.
pub fn strip_state_key(config: &mut ExternalAgentSpawnConfig) -> bool {
    let present = config.env.remove(AGENT_STATE_KEY_ENV).is_some();
    if present {
        log::info!(
            "[state-isolation] {}: launch is confined outside this host's process table; \
             ignoring {AGENT_STATE_KEY_ENV}",
            config.id
        );
    }
    present
}

/// Create `path` (and missing ancestors) owner-only, refusing a symlink.
///
/// The root is writable by the agent it belongs to, so an entry under it can
/// have been swapped for a symlink by a previous run. Following one here would
/// point the next launch's home — and this `chmod` — outside the root.
fn ensure_private_dir(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!(
                "agent state directory {} is a symlink; refusing to use it",
                path.display()
            ));
        }
        Ok(meta) if !meta.is_dir() => {
            return Err(format!(
                "agent state path {} exists and is not a directory",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(path).map_err(|error| {
                format!(
                    "failed to create agent state directory {}: {error}",
                    path.display()
                )
            })?;
        }
        Err(error) => {
            return Err(format!(
                "failed to inspect agent state directory {}: {error}",
                path.display()
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "failed to restrict agent state directory {}: {error}",
                    path.display()
                )
            },
        )?;
    }
    Ok(())
}

/// Apply the configuration's state root to a spawn config.
///
/// - No key: `Ok(None)`, nothing changes.
/// - A launch that owns a private home ([`launch_owns_private_home`]): the
///   key is removed and ignored, `Ok(None)`.
/// - Otherwise the key is removed and must be valid, the runtime must have a
///   rule (`state isolation unsupported for <command>`), and `data_dir` must
///   be known. The root and every mapped subdirectory are created owner-only
///   and the mapping is inserted into the env, replacing any caller value.
///
/// `home` is the host home the plan's shared and denied roots are joined to.
pub fn apply_state_isolation(
    config: &mut ExternalAgentSpawnConfig,
    data_dir: Option<&Path>,
    home: &Path,
) -> Result<Option<IsolationPlan>, String> {
    let Some(key) = config.env.remove(AGENT_STATE_KEY_ENV) else {
        return Ok(None);
    };
    if launch_owns_private_home(&config.env) {
        log::info!(
            "[state-isolation] {}: launch already owns a private home; ignoring {AGENT_STATE_KEY_ENV}",
            config.id
        );
        return Ok(None);
    }
    if !state_key_valid(&key) {
        return Err(format!(
            "invalid {AGENT_STATE_KEY_ENV}: a state key is 1-128 characters of A-Z, a-z, 0-9, _ or -"
        ));
    }
    let rule = isolation_rule_for(&config.command, &config.args)
        .ok_or_else(|| format!("state isolation unsupported for {}", config.command))?;
    let data_dir = data_dir.filter(|dir| dir.is_absolute()).ok_or_else(|| {
        "state isolation needs this host's per-user data directory, which could not be determined"
            .to_string()
    })?;
    if !home.is_absolute() {
        return Err("state isolation needs an absolute home directory".into());
    }
    let root = agent_state_root(data_dir, &key);
    ensure_private_dir(&root)?;
    for (env_key, relative) in &rule.env {
        let mut path = root.clone();
        for component in relative.split('/').filter(|part| !part.is_empty()) {
            path.push(component);
            ensure_private_dir(&path)?;
        }
        config
            .env
            .insert(env_key.clone(), path.to_string_lossy().into_owned());
    }
    Ok(Some(IsolationPlan {
        shared_roots: rule
            .shared_roots
            .iter()
            .map(|relative| home.join(relative))
            .collect(),
        deny_readable: rule
            .deny_readable
            .iter()
            .map(|relative| home.join(relative))
            .collect(),
        root,
    }))
}

fn tree_bytes(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| tree_bytes(&entry.path()))
        .fold(0u64, u64::saturating_add)
}

/// Where a configuration's state root lives and how much it holds.
pub fn state_root_info(data_dir: &Path, key: &str) -> Result<AgentStateRootInfo, String> {
    if !state_key_valid(key) {
        return Err("invalid agent state key".into());
    }
    let root = agent_state_root(data_dir, key);
    let exists = std::fs::symlink_metadata(&root).is_ok();
    Ok(AgentStateRootInfo {
        bytes: if exists { tree_bytes(&root) } else { 0 },
        path: root.to_string_lossy().into_owned(),
        exists,
    })
}

/// Delete a configuration's state root. A missing root is not an error; a
/// root that is a symlink loses only the link, never its target.
pub fn remove_state_root(data_dir: &Path, key: &str) -> Result<(), String> {
    if !state_key_valid(key) {
        return Err("invalid agent state key".into());
    }
    let root = agent_state_root(data_dir, key);
    let result = match std::fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => Err(error),
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&root),
        Ok(_) => std::fs::remove_file(&root),
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove agent state root {}: {error}",
            root.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(command: &str, args: &[&str], env: &[(&str, &str)]) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: "agent-1".into(),
            command: command.into(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            env: env
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            cwd: Some("/work".into()),
            framing: Default::default(),
            sandbox: None,
        }
    }

    #[test]
    fn state_keys_are_config_ids_never_paths() {
        for key in ["cfg-1", "A_b-9", &"x".repeat(128)] {
            assert!(state_key_valid(key), "{key}");
        }
        for key in [
            "",
            &"x".repeat(129),
            "../escape",
            "a/b",
            "a\\b",
            ".",
            "..",
            "key with space",
            "ключ",
            "a\0b",
        ] {
            assert!(!state_key_valid(key), "{key:?}");
        }
    }

    #[test]
    fn data_dir_follows_each_platform_convention() {
        let home = Path::new("/home/dev");
        assert_eq!(
            agent_state_data_dir("macos", Some(Path::new("/Users/dev")), None, None),
            Some(PathBuf::from("/Users/dev/Library/Application Support"))
        );
        assert_eq!(
            agent_state_data_dir("linux", Some(home), None, None),
            Some(PathBuf::from("/home/dev/.local/share"))
        );
        assert_eq!(
            agent_state_data_dir("linux", Some(home), Some(Path::new("/data/xdg")), None),
            Some(PathBuf::from("/data/xdg"))
        );
        // A relative XDG_DATA_HOME is invalid per the spec and ignored.
        assert_eq!(
            agent_state_data_dir("linux", Some(home), Some(Path::new("rel")), None),
            Some(PathBuf::from("/home/dev/.local/share"))
        );
        // XDG_DATA_HOME is a Linux convention; macOS ignores it.
        assert_eq!(
            agent_state_data_dir(
                "macos",
                Some(Path::new("/Users/dev")),
                Some(Path::new("/x")),
                None
            ),
            Some(PathBuf::from("/Users/dev/Library/Application Support"))
        );
        #[cfg(windows)]
        let appdata = Path::new("C:\\Users\\dev\\AppData\\Roaming");
        #[cfg(not(windows))]
        let appdata = Path::new("/c/Users/dev/AppData/Roaming");
        assert_eq!(
            agent_state_data_dir("windows", Some(home), None, Some(appdata)),
            Some(appdata.to_path_buf())
        );
        assert_eq!(
            agent_state_data_dir("windows", Some(home), None, None),
            None
        );
        assert_eq!(agent_state_data_dir("macos", None, None, None), None);
        assert_eq!(
            agent_state_data_dir("freebsd", Some(home), None, None),
            None
        );
        assert_eq!(
            agent_state_root(Path::new("/data"), "cfg-1"),
            PathBuf::from("/data/cognia/external-agents/cfg-1")
        );
    }

    fn env_keys(command: &str, args: &[&str]) -> Option<Vec<String>> {
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        isolation_rule_for(command, &args)
            .map(|rule| rule.env.into_iter().map(|(key, _)| key).collect())
    }

    #[test]
    fn rules_resolve_like_the_typescript_accessor() {
        assert_eq!(
            env_keys("npx", &["-y", "@zed-industries/codex-acp"]),
            Some(vec!["CODEX_HOME".into()])
        );
        assert_eq!(env_keys("codex-acp", &[]), Some(vec!["CODEX_HOME".into()]));
        assert_eq!(
            env_keys("claude-agent-acp", &[]),
            Some(vec!["CLAUDE_CONFIG_DIR".into()])
        );
        assert_eq!(
            env_keys("Claude.EXE", &[]),
            Some(vec!["CLAUDE_CONFIG_DIR".into()])
        );
        assert_eq!(
            env_keys("pi", &[]),
            Some(vec!["PI_CODING_AGENT_DIR".into()])
        );
        // "copilot" contains "pi": the Pi row matches the bare command only.
        assert_eq!(env_keys("copilot", &[]), Some(vec!["COPILOT_HOME".into()]));
        // …and an npx package containing "pi" is not Pi either.
        assert_eq!(env_keys("npx", &["pi-something"]), None);
        assert_eq!(
            env_keys("opencode", &["acp"]),
            Some(vec![
                "OPENCODE_CONFIG_DIR".into(),
                "XDG_DATA_HOME".into(),
                "XDG_STATE_HOME".into(),
                "XDG_CACHE_HOME".into(),
            ])
        );
        let opencode = isolation_rule_for("opencode", &[]).unwrap();
        assert_eq!(
            opencode.shared_roots,
            vec![
                ".config/opencode".to_string(),
                ".local/share/opencode".into()
            ]
        );
        // No documented home variable, no isolation.
        for command in [
            "gemini",
            "goose",
            "devin",
            "kiro-cli",
            "droid",
            "cursor-agent",
            "aider",
        ] {
            assert_eq!(env_keys(command, &[]), None, "{command}");
        }
        let qoder = isolation_rule_for("qoder", &[]).unwrap();
        assert!(qoder.deny_readable.is_empty());
        let kimi = isolation_rule_for("kimi", &[]).unwrap();
        assert_eq!(
            kimi.deny_readable,
            vec![".kimi-code".to_string(), ".kimi".into()]
        );
    }

    /// The compiled-in table must be the policy file, row for row. The gate
    /// checks the same thing from the other side; this keeps `cargo test`
    /// honest on its own.
    #[test]
    fn compiled_table_matches_the_security_policy_file() {
        let policy: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol/external-agent-security-policy.json"
        ))
        .expect("policy parses");
        let rules = policy["agentStateIsolation"]["rules"]
            .as_array()
            .expect("rules array");
        assert_eq!(rules.len(), AGENT_STATE_ISOLATION_RULES.len());
        for (json, rust) in rules.iter().zip(AGENT_STATE_ISOLATION_RULES) {
            let kind = match rust.match_kind {
                IsolationMatch::Contains => "contains",
                IsolationMatch::Base => "base",
                IsolationMatch::Target => "target",
            };
            assert_eq!(json["match"], kind);
            let strings = |value: &serde_json::Value| -> Vec<String> {
                value
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| item.as_str().unwrap().to_string())
                    .collect()
            };
            assert_eq!(strings(&json["values"]), rust.values.to_vec());
            assert_eq!(strings(&json["sharedRoots"]), rust.shared_roots.to_vec());
            assert_eq!(strings(&json["denyReadable"]), rust.deny_readable.to_vec());
            let env: Vec<(String, String)> = json["env"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_string()))
                .collect();
            let mut expected: Vec<(String, String)> = rust
                .env
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect();
            let mut actual = env;
            expected.sort();
            actual.sort();
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn isolation_maps_env_creates_private_dirs_and_strips_the_key() {
        let data = tempfile::tempdir().unwrap();
        let mut input = config(
            "npx",
            &["-y", "@zed-industries/codex-acp"],
            &[
                (AGENT_STATE_KEY_ENV, "cfg-1"),
                ("CODEX_HOME", "/caller/value"),
                ("OPENAI_API_KEY", "sk"),
            ],
        );
        let plan = apply_state_isolation(&mut input, Some(data.path()), Path::new("/home/dev"))
            .unwrap()
            .expect("plan");
        let root = data.path().join("cognia/external-agents/cfg-1");
        assert_eq!(plan.root, root);
        assert_eq!(plan.shared_roots, vec![PathBuf::from("/home/dev/.codex")]);
        assert_eq!(plan.deny_readable, vec![PathBuf::from("/home/dev/.codex")]);
        assert!(!input.env.contains_key(AGENT_STATE_KEY_ENV));
        assert_eq!(
            input.env["CODEX_HOME"],
            root.join("codex").to_string_lossy()
        );
        assert_eq!(input.env["OPENAI_API_KEY"], "sk");
        assert!(root.join("codex").is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for dir in [root.clone(), root.join("codex")] {
                let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o700, "{}", dir.display());
            }
        }
    }

    #[test]
    fn nested_mappings_create_each_level() {
        let data = tempfile::tempdir().unwrap();
        let mut input = config("opencode", &["acp"], &[(AGENT_STATE_KEY_ENV, "oc")]);
        apply_state_isolation(&mut input, Some(data.path()), Path::new("/home/dev"))
            .unwrap()
            .expect("plan");
        let root = data.path().join("cognia/external-agents/oc");
        assert_eq!(
            input.env["OPENCODE_CONFIG_DIR"],
            root.join("config").join("opencode").to_string_lossy()
        );
        for relative in ["config/opencode", "data", "state", "cache"] {
            assert!(root.join(relative).is_dir(), "{relative}");
        }
    }

    #[test]
    fn no_key_changes_nothing() {
        let mut input = config("codex", &[], &[("CODEX_HOME", "/mine")]);
        let before = input.env.clone();
        assert_eq!(
            apply_state_isolation(&mut input, None, Path::new("/home/dev")).unwrap(),
            None
        );
        assert_eq!(input.env, before);
    }

    #[test]
    fn invalid_keys_unsupported_runtimes_and_unknown_data_dirs_refuse() {
        let data = tempfile::tempdir().unwrap();
        let home = Path::new("/home/dev");
        let mut bad = config("codex", &[], &[(AGENT_STATE_KEY_ENV, "../x")]);
        assert!(apply_state_isolation(&mut bad, Some(data.path()), home)
            .unwrap_err()
            .contains("invalid"));
        assert!(!bad.env.contains_key(AGENT_STATE_KEY_ENV));
        let mut gemini = config("gemini", &["--acp"], &[(AGENT_STATE_KEY_ENV, "g")]);
        assert_eq!(
            apply_state_isolation(&mut gemini, Some(data.path()), home).unwrap_err(),
            "state isolation unsupported for gemini"
        );
        let mut no_dir = config("codex", &[], &[(AGENT_STATE_KEY_ENV, "c")]);
        assert!(apply_state_isolation(&mut no_dir, None, home).is_err());
        let mut relative = config("codex", &[], &[(AGENT_STATE_KEY_ENV, "c")]);
        assert!(apply_state_isolation(&mut relative, Some(Path::new("rel")), home).is_err());
        // Nothing was created for any refused launch.
        assert!(!data.path().join("cognia").exists());
    }

    #[test]
    fn bot_and_gateway_launches_keep_their_own_home_and_drop_the_key() {
        let data = tempfile::tempdir().unwrap();
        for owner in [
            ("COGNIA_BOT_ISOLATION", "1"),
            (crate::gateway_task::PAYLOAD_ENV, "{}"),
        ] {
            let mut input = config("codex", &[], &[(AGENT_STATE_KEY_ENV, "cfg"), owner]);
            assert_eq!(
                apply_state_isolation(&mut input, Some(data.path()), Path::new("/home/dev"))
                    .unwrap(),
                None
            );
            assert!(!input.env.contains_key(AGENT_STATE_KEY_ENV));
            assert!(!input.env.contains_key("CODEX_HOME"));
        }
        assert!(!data.path().join("cognia").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_state_directory_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = data.path().join("cognia/external-agents/cfg");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("codex")).unwrap();
        let mut input = config("codex", &[], &[(AGENT_STATE_KEY_ENV, "cfg")]);
        let error = apply_state_isolation(&mut input, Some(data.path()), Path::new("/home/dev"))
            .unwrap_err();
        assert!(error.contains("symlink"), "{error}");
    }

    #[test]
    fn strip_removes_only_the_key() {
        let mut input = config("codex", &[], &[(AGENT_STATE_KEY_ENV, "c"), ("A", "b")]);
        assert!(strip_state_key(&mut input));
        assert!(!strip_state_key(&mut input));
        assert_eq!(input.env.len(), 1);
    }

    #[test]
    fn info_reports_size_and_remove_is_idempotent() {
        let data = tempfile::tempdir().unwrap();
        let info = state_root_info(data.path(), "cfg").unwrap();
        assert!(!info.exists);
        assert_eq!(info.bytes, 0);
        assert_eq!(
            PathBuf::from(&info.path),
            agent_state_root(data.path(), "cfg")
        );
        remove_state_root(data.path(), "cfg").expect("missing root is fine");

        let root = agent_state_root(data.path(), "cfg");
        std::fs::create_dir_all(root.join("codex/sessions")).unwrap();
        std::fs::write(root.join("codex/auth.json"), b"0123456789").unwrap();
        std::fs::write(root.join("codex/sessions/a.jsonl"), b"abc").unwrap();
        let info = state_root_info(data.path(), "cfg").unwrap();
        assert!(info.exists);
        assert_eq!(info.bytes, 13);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["exists"], true);
        assert_eq!(json["bytes"], 13);

        remove_state_root(data.path(), "cfg").unwrap();
        assert!(!root.exists());
        // A sibling configuration's root is untouched.
        let sibling = agent_state_root(data.path(), "other");
        std::fs::create_dir_all(&sibling).unwrap();
        remove_state_root(data.path(), "cfg").unwrap();
        assert!(sibling.exists());
    }

    #[cfg(unix)]
    #[test]
    fn removing_a_symlinked_root_never_touches_its_target() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), b"x").unwrap();
        let root = agent_state_root(data.path(), "cfg");
        std::fs::create_dir_all(root.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(outside.path(), &root).unwrap();
        // Info does not follow the link either.
        assert!(state_root_info(data.path(), "cfg").unwrap().exists);
        remove_state_root(data.path(), "cfg").unwrap();
        assert!(outside.path().join("keep").exists());
        assert!(std::fs::symlink_metadata(&root).is_err());
    }

    #[test]
    fn info_and_remove_refuse_invalid_keys() {
        let data = tempfile::tempdir().unwrap();
        assert!(state_root_info(data.path(), "../x").is_err());
        assert!(remove_state_root(data.path(), "").is_err());
        assert!(remove_state_root(data.path(), "a/b").is_err());
    }
}
