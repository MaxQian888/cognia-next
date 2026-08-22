//! `SpawnPolicy` — the preset allowlist gating the RCE-grade headless
//! external-agent RPC arms (ADR-0059 D6 / R11).
//!
//! `spawn_external_agent` over the companion RPC surface is remote code
//! execution by construction: headless it is reachable with the brain's
//! service token, so every spawn request is validated against a **preset-only**
//! policy before it touches the exec backend:
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
//!
//! The desktop calls the Tauri command locally, which for a long time was read
//! as "so no policy is needed there". That conflates who *asks* for the spawn
//! with what the spawned agent then does — the agent is the untrusted party and
//! it has `bash`. The desktop therefore runs [`SpawnPolicy::validate_desktop`]
//! (same command allowlist, same default-deny env filter) and then wraps the
//! result in [`crate::sandbox`]. Only the workspaces-root cwd confinement stays
//! headless-only; see that method for why.

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
///
/// Mirrors `binaryAllowlist.commands` in
/// `protocol/external-agent-security-policy.json`, which the TypeScript
/// launcher consumes directly. The two are kept in step by
/// `pnpm audit:agent-capabilities` rather than by a comment: a security
/// allowlist must stay compiled in, so it cannot read the JSON at runtime, and
/// the last time the two were only linked by a comment they drifted in both
/// directions at once.
const BINARY_ALLOWLIST: &[&str] = &[
    "claude",
    // The `claude-code` preset spawns THIS bare binary
    // (`ecosystem-adapters.ts`), not the npx package. Its absence meant every
    // headless spawn of a shipped preset was refused by policy.
    "claude-agent-acp",
    "claude-code-acp",
    "codex",
    "codex-acp",
    "opencode",
    "cursor-agent",
    "gemini",
    "copilot",
    "kiro-cli",
    "droid",
    // Pi's own binary, driven natively over `pi --mode rpc` (ADR-0119). The
    // `pi-acp` npx bridge stays in NPX_PACKAGE_ALLOWLIST for the legacy preset.
    "pi",
];

/// Packages `npx` may execute (`npx [-y|--yes] <package> …`).
///
/// Mirrors `npxPackageAllowlist.packages` in
/// `protocol/external-agent-security-policy.json`; see [`BINARY_ALLOWLIST`].
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
    // Pins the DeepSeek Harness user-data root into Cognia-owned space. Without
    // it DSH falls back to ~/.dsh, where a user-writable cordis.patch.yml can
    // inject plugins and arbitrary JS into a certified composition.
    "DSH_HOME",
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
    // DeepSeek Harness: the provider credential plus the composition's own
    // COGNIA_DSH_* inputs (workspace, session root, model, persona). DSH_HOME is
    // an exact key below — it is a path, not a prefix family.
    "DEEPSEEK_",
    "COGNIA_DSH_",
    // Tool-host handshake for the bundled Cognia Pi extension. Pi has no
    // per-session mcpServers parameter, so the socket path and per-attempt
    // token reach the extension through its process env rather than through an
    // MCP server spec. The broker's authorize() remains the permission
    // authority; see ADR-0119.
    "COGNIA_TOOLHOST_",
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

    /// Resolve a client-supplied workspace root against the server-owned
    /// workspaces directory. This is the filesystem RPC trust boundary: a
    /// caller may choose a workspace below the root, never redefine the root.
    pub fn validate_workspace_root(&self, requested: &str) -> Result<String, PolicyViolation> {
        self.validate_cwd(Some(requested))
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

    /// Validate a **desktop** spawn request: same command allowlist and the
    /// same default-deny env filter, but no workspaces-root confinement.
    ///
    /// The confinement in [`Self::validate`] exists because a remote client
    /// chooses the headless cwd. On the desktop the cwd comes from
    /// `agent.config.process.cwd` — a path the local user typed into settings —
    /// and forcing it under `<data_dir>/workspaces` would break running an
    /// agent in your own project. Write confinement is instead enforced by the
    /// launcher scope built in [`crate::sandbox`], which is exactly what the
    /// CLI host relies on.
    ///
    /// The cwd is still canonicalized when present: it defeats `..` traversal
    /// and symlink games before the path becomes a sandbox scope, and it makes
    /// a non-existent directory fail here rather than inside the launcher.
    ///
    /// An absent cwd falls back to the workspaces root rather than failing,
    /// matching `validateCwd` in `cli/src/runtime/external/node-backend.ts`.
    /// Agents configured before the sandbox existed have no cwd, and the
    /// sandbox needs a concrete directory to scope to; refusing them would turn
    /// this hardening into an outage for configs that used to work (they ran in
    /// the app process's cwd, which for a bundled app is `/`).
    pub fn validate_desktop(
        &self,
        mut config: ExternalAgentSpawnConfig,
    ) -> Result<ValidatedSpawn, PolicyViolation> {
        self.validate_command(&config.command, &config.args)?;
        config.cwd = match config.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            None => Some(self.validate_cwd(None)?),
            Some(requested) => Some(
                Path::new(requested)
                    .canonicalize()
                    .map_err(|e| {
                        PolicyViolation(format!("cwd {requested:?} does not resolve: {e}"))
                    })?
                    .display()
                    .to_string(),
            ),
        };
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
            // The DeepSeek Harness runtime has no binary of its own: Cognia
            // supplies the entry point, so the spawn is `node <launcher> <yml>`.
            // Admitting bare `node` would defeat the allowlist entirely, so the
            // exception is pinned to a launcher inside Cognia's own runtime
            // home. The launcher then refuses to boot unless DSH_HOME is pinned
            // there too, which is what keeps user-writable patch layers out.
            if is_dsh_launcher_invocation(args, &self.workspaces_dir) {
                return Ok(());
            }
            return Err(PolicyViolation(
                "node is only admitted for the smoke stub (COGNIA_SMOKE_AGENT=1 + \
                 stub-acp-agent.mjs) or the managed DeepSeek Harness launcher"
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

/// The managed DeepSeek Harness launcher, spawned as `node <launcher> <composition>`.
///
/// Both paths must be absolute and canonicalize under the DSH runtime home, so
/// a caller cannot point `node` at a script of its own choosing. Rooting the
/// check at the enclosing data root would not do: that root also contains
/// `workspaces/`, where every agent cwd is confined and therefore where an
/// agent can write — it could plant its own `launcher.mjs` + `.yml` and turn
/// the one `node` exception into arbitrary code execution. Canonicalization is
/// what defeats `..` traversal and a symlink planted inside the runtime home.
fn is_dsh_launcher_invocation(args: &[String], workspaces_dir: &Path) -> bool {
    let (launcher, composition) = match (args.first(), args.get(1)) {
        (Some(launcher), Some(composition)) if args.len() == 2 => (launcher, composition),
        _ => return false,
    };
    if Path::new(launcher).file_name().map(|f| f != "launcher.mjs").unwrap_or(true) {
        return false;
    }
    if Path::new(composition)
        .extension()
        .map(|e| e != "yml")
        .unwrap_or(true)
    {
        return false;
    }
    // The runtime home is a sibling of the workspaces dir under the Cognia data
    // root; both paths must resolve inside the runtime home itself.
    let Some(data_root) = workspaces_dir.parent() else {
        return false;
    };
    let Ok(root) = crate::dsh_runtime::runtime_home(data_root).canonicalize() else {
        return false;
    };
    [launcher, composition].iter().all(|candidate| {
        Path::new(candidate)
            .canonicalize()
            .map(|resolved| resolved.starts_with(&root))
            .unwrap_or(false)
    })
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
            framing: Default::default(),
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
            "gemini",
            "claude-agent-acp",
            "claude-code-acp",
            "copilot",
            "kiro-cli",
            "droid",
            "pi",
        ] {
            assert!(p.validate(config(bin, &[])).is_ok(), "{bin} must pass");
        }
        // Windows shims normalize.
        assert!(p.validate(config("claude.CMD", &[])).is_ok());
        assert!(p.validate(config("codex.exe", &[])).is_ok());
    }

    #[test]
    fn the_shipped_claude_code_preset_binary_is_allowed() {
        // `ecosystem-adapters.ts` spawns the bare `claude-agent-acp` binary for
        // the `claude-code` preset. Only the npx PACKAGE of the same name was
        // allowlisted, so every headless spawn of a shipped preset was refused.
        let (_tmp, p) = policy(false);
        assert!(p.validate(config("claude-agent-acp", &[])).is_ok());
    }

    #[test]
    fn binaries_no_preset_can_reach_are_denied() {
        // `cline` sat in the allowlist with no preset, no adapter and no
        // ecosystem surface — an executable the headless spawn RPC would run
        // that no Cognia code path could ever ask for.
        let (_tmp, p) = policy(false);
        assert!(p.validate(config("cline", &[])).is_err());
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

    #[test]
    fn dsh_launcher_is_admitted_only_inside_the_cognia_data_root() {
        let (tmp, p) = policy(false);
        // The runtime home is a sibling of the workspaces dir under the data root.
        let runtime_home = tmp.path().join("deepseek-harness");
        std::fs::create_dir_all(&runtime_home).expect("runtime home");
        let launcher = runtime_home.join("launcher.mjs");
        let composition = runtime_home.join("host.sdk-readonly.yml");
        std::fs::write(&launcher, "").expect("launcher");
        std::fs::write(&composition, "").expect("composition");
        // The workspaces dir must exist for the data root to canonicalize.
        std::fs::create_dir_all(tmp.path().join("workspaces")).expect("workspaces");

        let ok = config(
            "node",
            &[
                launcher.to_str().expect("launcher path"),
                composition.to_str().expect("composition path"),
            ],
        );
        assert!(p.validate(ok).is_ok());

        // A script outside the data root would make `node` a universal escape
        // from the allowlist.
        let outside = tempfile::tempdir().expect("outside");
        let evil = outside.path().join("launcher.mjs");
        std::fs::write(&evil, "").expect("evil");
        assert!(p
            .validate(config(
                "node",
                &[
                    evil.to_str().expect("evil path"),
                    composition.to_str().expect("composition path"),
                ],
            ))
            .is_err());

        // A launcher the agent planted in its own workspace. The workspaces dir
        // lives under the same data root, so rooting the check there would
        // admit this and hand the agent arbitrary code execution.
        let workspace = tmp.path().join("workspaces").join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let planted = workspace.join("launcher.mjs");
        let planted_yml = workspace.join("host.acp.yml");
        std::fs::write(&planted, "").expect("planted launcher");
        std::fs::write(&planted_yml, "").expect("planted composition");
        assert!(p
            .validate(config(
                "node",
                &[
                    planted.to_str().expect("planted path"),
                    planted_yml.to_str().expect("planted yml path"),
                ],
            ))
            .is_err());

        // Right location, wrong name.
        let other = runtime_home.join("evil.mjs");
        std::fs::write(&other, "").expect("other");
        assert!(p
            .validate(config(
                "node",
                &[
                    other.to_str().expect("other path"),
                    composition.to_str().expect("composition path"),
                ],
            ))
            .is_err());

        // Exactly two arguments: an extra flag could carry something the
        // launcher never vets, such as --inspect.
        assert!(p
            .validate(config(
                "node",
                &[
                    launcher.to_str().expect("launcher path"),
                    composition.to_str().expect("composition path"),
                    "--inspect",
                ],
            ))
            .is_err());
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

    #[test]
    fn workspace_root_validation_rejects_client_selected_host_directories() {
        let (tmp, policy) = policy(false);
        let workspace = tmp.path().join("workspaces/project");
        std::fs::create_dir_all(&workspace).unwrap();
        assert_eq!(
            PathBuf::from(
                policy
                    .validate_workspace_root(workspace.to_str().unwrap())
                    .unwrap()
            )
            .canonicalize()
            .unwrap(),
            workspace.canonicalize().unwrap()
        );
        assert!(policy
            .validate_workspace_root(tmp.path().to_str().unwrap())
            .is_err());
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

    /// Pi runs as a bare allowlisted binary, unlike the `pi-acp` bridge which
    /// goes through npx. Both must keep working: the native preset spawns
    /// `pi`, the legacy compatibility preset still spawns `npx -y pi-acp`.
    #[test]
    fn pi_runs_as_an_allowlisted_binary_alongside_the_legacy_bridge() {
        let (_tmp, p) = policy(false);
        assert!(p.validate(config("pi", &["--mode", "rpc"])).is_ok());
        assert!(p.validate(config("npx", &["-y", "pi-acp"])).is_ok());
        // Still a bare name only — a path must never be admitted.
        assert!(p
            .validate(config("/usr/local/bin/pi", &["--mode", "rpc"]))
            .is_err());
    }

    /// The bundled Cognia Pi extension reads the tool-host handshake from its
    /// own process env, so these keys have to survive `filter_env`. Without
    /// them the extension cannot reach the broker and fails closed, which
    /// looks like an unexplained handshake timeout.
    #[test]
    fn tool_host_handshake_env_reaches_the_agent() {
        let (_tmp, p) = policy(false);
        let mut cfg = config("pi", &["--mode", "rpc"]);
        cfg.env = HashMap::from([
            (
                "COGNIA_TOOLHOST_SOCKET".to_string(),
                "/tmp/cognia-toolhost-501/s.sock".to_string(),
            ),
            ("COGNIA_TOOLHOST_TOKEN".to_string(), "tok".to_string()),
            (
                "COGNIA_TOOLHOST_SERVER".to_string(),
                "cognia-tools".to_string(),
            ),
            ("COGNIA_UNRELATED".to_string(), "nope".to_string()),
        ]);
        let validated = p.validate(cfg).expect("valid command");
        assert!(validated.config.env.contains_key("COGNIA_TOOLHOST_SOCKET"));
        assert!(validated.config.env.contains_key("COGNIA_TOOLHOST_TOKEN"));
        assert!(validated.config.env.contains_key("COGNIA_TOOLHOST_SERVER"));
        // The prefix must not have widened into a general COGNIA_ passthrough.
        assert_eq!(validated.dropped_env_keys, vec!["COGNIA_UNRELATED"]);
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

    // ── Desktop policy: same command + env gates, no workspaces confinement ──

    #[test]
    fn desktop_keeps_the_command_allowlist() {
        let (_tmp, p) = policy(false);
        assert!(p.validate_desktop(config("pi", &[])).is_ok());
        assert!(p.validate_desktop(config("bash", &[])).is_err());
        assert!(p.validate_desktop(config("/usr/bin/pi", &[])).is_err());
        // `node` stays gated on the smoke switch here exactly as it is headless.
        assert!(p
            .validate_desktop(config("node", &["stub-acp-agent.mjs"]))
            .is_err());
    }

    #[test]
    fn desktop_keeps_the_default_deny_env_filter() {
        let (_tmp, p) = policy(false);
        let mut cfg = config("pi", &[]);
        cfg.env.insert("ANTHROPIC_API_KEY".into(), "keep".into());
        cfg.env
            .insert("COGNIA_TOOLHOST_TOKEN".into(), "keep".into());
        cfg.env.insert("LD_PRELOAD".into(), "/evil.so".into());
        cfg.env.insert("NODE_OPTIONS".into(), "--require=x".into());

        let validated = p.validate_desktop(cfg).expect("desktop validate");

        assert!(validated.config.env.contains_key("ANTHROPIC_API_KEY"));
        assert!(validated.config.env.contains_key("COGNIA_TOOLHOST_TOKEN"));
        assert!(!validated.config.env.contains_key("LD_PRELOAD"));
        assert!(!validated.config.env.contains_key("NODE_OPTIONS"));
        assert!(validated.dropped_env_keys.contains(&"LD_PRELOAD".to_string()));
    }

    /// The whole point of the desktop variant: a real project directory outside
    /// `<data_dir>/workspaces` is allowed, where `validate` would refuse it.
    #[test]
    fn desktop_allows_a_cwd_outside_the_workspaces_root() {
        let (tmp, p) = policy(false);
        let project = tmp.path().join("some-project");
        std::fs::create_dir_all(&project).expect("project dir");

        let mut cfg = config("pi", &[]);
        cfg.cwd = Some(project.display().to_string());

        let headless = p.validate(cfg.clone());
        assert!(
            headless.is_err(),
            "headless must still confine cwd to the workspaces root"
        );

        let desktop = p.validate_desktop(cfg).expect("desktop validate");
        let resolved = PathBuf::from(desktop.config.cwd.expect("cwd"));
        assert_eq!(resolved, project.canonicalize().expect("canonicalize"));
    }

    #[test]
    fn desktop_canonicalizes_cwd_and_rejects_one_that_does_not_resolve() {
        let (tmp, p) = policy(false);
        let nested = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&nested).expect("nested");

        let mut cfg = config("pi", &[]);
        cfg.cwd = Some(tmp.path().join("a").join("..").join("a").join("b").display().to_string());
        let validated = p.validate_desktop(cfg).expect("desktop validate");
        assert_eq!(
            PathBuf::from(validated.config.cwd.expect("cwd")),
            nested.canonicalize().expect("canonicalize")
        );

        let mut missing = config("pi", &[]);
        missing.cwd = Some(tmp.path().join("nope").display().to_string());
        assert!(p.validate_desktop(missing).is_err());
    }

    /// An agent configured before the sandbox existed has no cwd. It must keep
    /// working, so it lands on the workspaces root exactly as it does on the
    /// CLI host — not refused, and not left to run in `/`.
    #[test]
    fn desktop_defaults_an_absent_cwd_to_the_workspaces_root() {
        let (tmp, p) = policy(false);
        let validated = p.validate_desktop(config("pi", &[])).expect("validate");
        let resolved = PathBuf::from(validated.config.cwd.expect("cwd"));
        assert_eq!(
            resolved,
            tmp.path()
                .join("workspaces")
                .canonicalize()
                .expect("workspaces root is created on demand")
        );
    }
}
