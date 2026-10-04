//! `SpawnPolicy` — the preset allowlist gating the RCE-grade headless
//! external-agent RPC arms (ADR-0059 D6 / R11).
//!
//! `spawn_external_agent` over the companion RPC surface is remote code
//! execution by construction: headless it is reachable with the brain's
//! service token, so every spawn request is validated against the Host-owned
//! policy before it touches the exec backend:
//!
//! - the command must be a bare binary name (no path separators) from the
//!   agent-CLI allowlist, or `npx` with an allowlisted package, or the smoke
//!   stub (only when `COGNIA_SMOKE_AGENT=1`), or an operator-admitted custom CLI;
//! - the working directory must canonicalize under the workspaces root
//!   (`COGNIA_WORKSPACES_DIR`, default `<data_dir>/workspaces`);
//! - env keys are allowlisted (provider credentials + proxy), with the
//!   `LD_PRELOAD` class default-denied. Dropped keys are reported so the
//!   audit log records them.
//!
//! Operators may extend bare commands and exact env keys with JSON arrays in
//! `COGNIA_AGENT_COMMAND_ALLOWLIST` / `COGNIA_AGENT_ENV_ALLOWLIST`. These are read
//! only from the Host process environment; invalid configuration denies spawns.
//! Admission does not install a binary or bypass a pinned sandbox bundle manifest.
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

const COMMAND_ALLOWLIST_ENV: &str = "COGNIA_AGENT_COMMAND_ALLOWLIST";
const ENV_ALLOWLIST_ENV: &str = "COGNIA_AGENT_ENV_ALLOWLIST";
const MAX_OPERATOR_CONFIG_BYTES: usize = 8192;
const MAX_OPERATOR_ENTRIES: usize = 64;
const MAX_OPERATOR_NAME_BYTES: usize = 128;

/// Bare binary names an external-agent spawn may execute (ADR-0048/0049
/// ecosystem; resolution itself goes through `command_resolver`).
///
/// Mirrors `binaryAllowlist.commands` in
/// `protocol/external-agent-security-policy.json`, which the TypeScript
/// launcher consumes directly. The two are kept in step by
/// `pnpm audit:agent-capabilities` rather than by a comment: a security
/// default allowlist stays compiled in; operator additions are a separate gate, and
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
    "devin",
    "cline",
    "qoder",
    "kimi",
    "goose",
    "aider",
    // Pi's own binary, driven natively over `pi --mode rpc` (ADR-0119).
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
    "@agentclientprotocol/codex-acp",
    "@anthropic-ai/claude-code",
    "@google/gemini-cli",
    "@qwen-code/qwen-code",
    "opencode-ai",
];

/// Exact env keys always allowed through.
const ENV_KEY_ALLOWLIST: &[&str] = &[
    "KIMI_CODE_HOME",
    "KIMI_CODE_NO_AUTO_UPDATE",
    "KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT",
    "KIMI_DISABLE_TELEMETRY",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_CAPABILITIES",
    "KIMI_MODEL_DISPLAY_NAME",
    "KIMI_MODEL_MAX_CONTEXT_SIZE",
    "KIMI_MODEL_MAX_OUTPUT_SIZE",
    "KIMI_MODEL_MAX_COMPLETION_TOKENS",
    "KIMI_MODEL_REASONING_KEY",
    "KIMI_MODEL_ADAPTIVE_THINKING",
    "KIMI_MODEL_TEMPERATURE",
    "KIMI_MODEL_TOP_P",
    "KIMI_MODEL_THINKING_EFFORT",
    "KIMI_MODEL_THINKING_KEEP",
    "KIMI_MCP_STARTUP_TIMEOUT_MS",
    "KIMI_MCP_TOOL_TIMEOUT_MS",
    "KIMI_LOOP_MAX_STEPS_PER_TURN",
    "KIMI_LOOP_MAX_ATTEMPTS_PER_STEP",
    "CLINE_API_KEY",
    "CLINE_PROVIDER",
    "CLINE_MODEL",
    "CLINE_DIR",
    "CLINE_NO_AUTO_UPDATE",
    "QODER_PERSONAL_ACCESS_TOKEN",
    "QODER_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "NO_COLOR",
    "FORCE_COLOR",
    // Reviewed Codex ACP controls. INITIAL_AGENT_MODE governs its inner tool
    // mode; APP_SERVER_LOGS names a directory, still confined by Cognia's sandbox.
    "NO_BROWSER",
    "INITIAL_AGENT_MODE",
    "APP_SERVER_LOGS",
    // Pins the DeepSeek Harness user-data root into Cognia-owned space. Without
    // it DSH falls back to ~/.dsh, where a user-writable cordis.patch.yml can
    // inject plugins and arbitrary JS into a certified composition.
    "DSH_HOME",
    "MODEL_PROVIDER",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    // Host-consumed task configuration and its one-time gateway lease.
    "COGNIA_GATEWAY_TASK_CONFIG",
    "COGNIA_GATEWAY_TOKEN",
    "COGNIA_DEVIN_MCP_SERVERS",
    "COGNIA_BOT_ISOLATION",
    "COGNIA_BOT_STATE_DIR",
    "DISABLE_AUTO_UPDATE",
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
    "DEVIN_",
    "WINDSURF_",
    "ACP_",
    "COGNIA_AGENT_",
    // DeepSeek Harness: the provider credential plus the composition's own
    // COGNIA_DSH_* inputs (workspace, session root, model, persona). DSH_HOME is
    // an exact key below — it is a path, not a prefix family.
    "DEEPSEEK_",
    "GOOSE_",
    "COGNIA_DSH_",
    // Tool-host handshake for the bundled Cognia Pi extension. Pi has no
    // per-session mcpServers parameter, so the socket path and per-attempt
    // token reach the extension through its process env rather than through an
    // MCP server spec. The broker's authorize() remains the permission
    // authority; see ADR-0119.
    "COGNIA_TOOLHOST_",
    // Plugin Pi package values (ADR-0210). Only a cooperating extension that a
    // plugin ships and the user opted an agent into reads these; no program,
    // loader or runtime interprets a `COGNIA_PIPKG_*` key. The values come from
    // the plugin's manifest literals, its own configuration or the session
    // workspace path — never from the model — and the dedicated prefix is what
    // keeps a plugin from reaching `NODE_OPTIONS`, `LD_PRELOAD` or a provider
    // credential through this channel.
    "COGNIA_PIPKG_",
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
    /// Where THIS host materializes managed working copies, when it does.
    ///
    /// A managed run does not execute in the workspaces root. Task Workspace
    /// creates an isolated working copy under
    /// `<data_dir>/task-workspaces/executions/...` and hands the agent that
    /// path, so confining spawns to `workspaces_dir` alone meant the host
    /// provisioned a working copy and then refused to run anything in it:
    /// "managed execution" and "external agents" could not be used together at
    /// all on a headless deployment.
    ///
    /// This is not a widening. The directory is created BY the host, for one
    /// run, from a source root the policy already admitted. A remote client
    /// cannot name a path here that the host did not just make for it, and
    /// nothing outside the executions tree becomes reachable.
    managed_execution_dir: Option<PathBuf>,
    smoke_agent_enabled: bool,
    operator_commands: Vec<String>,
    operator_env: Vec<String>,
    operator_config_error: Option<PolicyViolation>,
}

impl SpawnPolicy {
    pub fn new(workspaces_dir: PathBuf, smoke_agent_enabled: bool) -> Self {
        Self {
            workspaces_dir,
            managed_execution_dir: None,
            smoke_agent_enabled,
            operator_commands: Vec::new(),
            operator_env: Vec::new(),
            operator_config_error: None,
        }
    }

    /// Also admit this host's own managed execution roots. See
    /// [`Self::managed_execution_dir`].
    pub fn with_managed_execution_dir(mut self, dir: PathBuf) -> Self {
        self.managed_execution_dir = Some(dir);
        self
    }

    /// Standard construction: workspaces root from `COGNIA_WORKSPACES_DIR`
    /// (default `<data_dir>/workspaces`), smoke stub gated on
    /// `COGNIA_SMOKE_AGENT=1`, and the managed execution root this same
    /// `data_dir` gives `TaskWorkspaceService::open`.
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
            .with_managed_execution_dir(data_dir.join("task-workspaces").join("executions"))
            .with_operator_allowlists(
                std::env::var(COMMAND_ALLOWLIST_ENV),
                std::env::var(ENV_ALLOWLIST_ENV),
            )
    }

    // Private: renderer spawn configuration must never supply policy additions.
    // Capture both lists atomically; a malformed list must not enable a partial policy.
    fn with_operator_allowlists(
        mut self,
        commands: Result<String, std::env::VarError>,
        keys: Result<String, std::env::VarError>,
    ) -> Self {
        let parsed = parse_operator_list(COMMAND_ALLOWLIST_ENV, commands, valid_operator_command)
            .and_then(|commands| {
                parse_operator_list(ENV_ALLOWLIST_ENV, keys, valid_operator_env)
                    .map(|keys| (commands, keys))
            });
        match parsed {
            Ok((commands, keys)) => {
                self.operator_commands = commands;
                self.operator_env = keys;
            }
            Err(error) => self.operator_config_error = Some(error),
        }
        self
    }

    /// The server-owned workspaces directory every confined path resolves
    /// under. Exposed so the Host can *report* the root it enforces: a remote
    /// client has no other way to learn where it is allowed to browse, and
    /// guessing costs it a refusal it cannot interpret.
    pub fn workspaces_dir(&self) -> &Path {
        &self.workspaces_dir
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
        crate::devin_mcp_config::validate_target(&config.command, &config.args, &config.env)
            .map_err(PolicyViolation)?;
        config.cwd = Some(self.validate_cwd(config.cwd.as_deref())?);
        validate_bot_runtime_state(&config)?;
        let (env, dropped) =
            filter_env_with_additions(std::mem::take(&mut config.env), &self.operator_env);
        config.env = env;
        // A remote caller never names sandbox roots: the plugin store whose
        // packages the key points at lives on the desktop, and the key is a
        // host-to-wrapper request, not client input.
        let dropped = scope_pi_package_env(&config.command, &mut config.env, dropped, true);
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
        crate::devin_mcp_config::validate_target(&config.command, &config.args, &config.env)
            .map_err(PolicyViolation)?;
        config.cwd = match config
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
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
        validate_bot_runtime_state(&config)?;
        let (env, dropped) =
            filter_env_with_additions(std::mem::take(&mut config.env), &self.operator_env);
        config.env = env;
        let dropped = scope_pi_package_env(&config.command, &mut config.env, dropped, false);
        Ok(ValidatedSpawn {
            config,
            dropped_env_keys: dropped,
        })
    }

    fn validate_command(&self, command: &str, args: &[String]) -> Result<(), PolicyViolation> {
        if let Some(error) = &self.operator_config_error {
            return Err(error.clone());
        }
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return Err(PolicyViolation("empty command".into()));
        }
        if trimmed.contains('/') || trimmed.contains('\\') {
            let configured_node = crate::command_resolver::resolve_command_path("node")
                .and_then(|path| path.canonicalize().ok());
            let requested_node = Path::new(trimmed).canonicalize().ok();
            if requested_node.is_some()
                && requested_node == configured_node
                && is_dsh_launcher_invocation(args, &self.workspaces_dir)
            {
                return Ok(());
            }
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

        if self.operator_commands.iter().any(|name| name == trimmed) {
            return Ok(());
        }
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
        if canonical.starts_with(&root) {
            return Ok(canonical.display().to_string());
        }
        // The host's own managed working copies. Canonicalized the same way, so
        // a symlink cannot point at this root from outside it.
        if let Some(managed) = self.managed_execution_dir.as_ref() {
            if let Ok(managed_root) = managed.canonicalize() {
                if canonical.starts_with(&managed_root) {
                    return Ok(canonical.display().to_string());
                }
            }
        }
        Err(PolicyViolation(format!(
            "cwd {:?} escapes the workspaces root {:?}",
            canonical.display(),
            root.display()
        )))
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
    if Path::new(launcher)
        .file_name()
        .map(|f| f != "launcher.mjs")
        .unwrap_or(true)
    {
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
/// Preserve the isolation request through native env filtering only when the
/// runtime state is the checkout's dedicated sibling, never an arbitrary root.
fn validate_bot_runtime_state(config: &ExternalAgentSpawnConfig) -> Result<(), PolicyViolation> {
    let isolation = config.env.get("COGNIA_BOT_ISOLATION");
    let state = config.env.get("COGNIA_BOT_STATE_DIR");
    if isolation.is_none() && state.is_none() {
        return Ok(());
    }
    if isolation.map(String::as_str) != Some("1") {
        return Err(PolicyViolation(
            "Bot isolation must be explicitly enabled".into(),
        ));
    }
    let cwd = Path::new(
        config
            .cwd
            .as_deref()
            .ok_or_else(|| PolicyViolation("Bot isolation requires a checkout".into()))?,
    );
    let name = cwd
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PolicyViolation("Bot checkout has no directory name".into()))?;
    let parent = cwd
        .parent()
        .ok_or_else(|| PolicyViolation("Bot checkout has no parent".into()))?;
    let expected = parent.join(format!("{name}-state"));
    let state = Path::new(
        state.ok_or_else(|| PolicyViolation("Bot isolation requires runtime state".into()))?,
    );
    if state != expected
        || state.is_symlink()
        || (state.exists() && state.canonicalize().ok().as_ref() != Some(&expected))
    {
        return Err(PolicyViolation(
            "Bot runtime state must be the checkout's dedicated sibling".into(),
        ));
    }
    Ok(())
}

fn parse_operator_list(
    variable: &str,
    raw: Result<String, std::env::VarError>,
    valid: fn(&str) -> bool,
) -> Result<Vec<String>, PolicyViolation> {
    let invalid = |reason: &str| PolicyViolation(format!("Invalid Host {variable}: {reason}"));
    let raw = match raw {
        Ok(raw) => raw,
        Err(std::env::VarError::NotPresent) => return Ok(Vec::new()),
        Err(_) => return Err(invalid("must contain Unicode JSON")),
    };
    if raw.len() > MAX_OPERATOR_CONFIG_BYTES {
        return Err(invalid("exceeds 8192 bytes"));
    }
    let entries: Vec<String> =
        serde_json::from_str(&raw).map_err(|_| invalid("expected a JSON array of names"))?;
    if entries.len() > MAX_OPERATOR_ENTRIES {
        return Err(invalid("exceeds 64 names"));
    }
    let mut seen = std::collections::HashSet::new();
    for name in &entries {
        if name.is_empty() || name.len() > MAX_OPERATOR_NAME_BYTES || !valid(name) {
            return Err(invalid(
                "contains an invalid or reserved name (maximum 128 ASCII characters)",
            ));
        }
        if !seen.insert(name) {
            return Err(invalid("contains duplicate names"));
        }
    }
    Ok(entries)
}

fn valid_operator_command(name: &str) -> bool {
    if !name.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    // Scripts must be packaged behind an operator-installed bare executable;
    // do not turn an interpreter/package runner into an unrestricted RPC shell.
    let base = lower.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    !lower.ends_with(".cmd")
        && !lower.ends_with(".bat")
        && !lower.ends_with(".exe")
        && ![
            "sh",
            "bash",
            "zsh",
            "dash",
            "fish",
            "ksh",
            "csh",
            "tcsh",
            "cmd",
            "powershell",
            "pwsh",
            "env",
            "sudo",
            "su",
            "doas",
            "busybox",
            "xargs",
            "node",
            "nodejs",
            "python",
            "perl",
            "ruby",
            "php",
            "lua",
            "luajit",
            "deno",
            "bun",
            "npm",
            "npx",
            "pnpm",
            "yarn",
            "uv",
            "uvx",
            "pip",
            "cargo",
            "rustc",
            "go",
            "java",
            "js",
            "qjs",
            "awk",
            "gawk",
        ]
        .contains(&base)
}

fn valid_operator_env(key: &str) -> bool {
    if !key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        || cognia_exec_sandbox::env::is_dangerous_env_key(key)
    {
        return false;
    }
    let upper = key.to_ascii_uppercase();
    // Host control, executable resolution, interpreter loading and identity roots
    // cannot be widened by an env addition. Existing preset env contracts remain.
    !["COGNIA_", "BASH_FUNC_", "XDG_", "NPM_CONFIG_", "SSH_"]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
        && ![
            "PATH",
            "PATHEXT",
            "HOME",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
            "USER",
            "LOGNAME",
            "SHELL",
            "COMSPEC",
            "SYSTEMROOT",
            "WINDIR",
            "TMP",
            "TEMP",
            "TMPDIR",
            "NODE_PATH",
            "PYTHONPATH",
            "PYTHONHOME",
            "PERL5LIB",
            "RUBYLIB",
            "CDPATH",
            "SHELLOPTS",
            "BASHOPTS",
            "GLOBIGNORE",
            "PSMODULEANALYSISCACHEPATH",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "DSH_HOME",
            "CLINE_DIR",
            "QODER_CONFIG_DIR",
            "KIMI_CODE_HOME",
            "PI_CODING_AGENT_DIR",
            "PI_CODING_AGENT_SESSION_DIR",
            "GOOSE_PATH_ROOT",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AWS_SHARED_CREDENTIALS_FILE",
            "AWS_CONFIG_FILE",
        ]
        .contains(&upper.as_str())
}

pub(crate) fn kimi_env_key(key: &str) -> bool {
    key.starts_with("KIMI_") && ENV_KEY_ALLOWLIST.contains(&key)
}

/// Plugin Pi package env (ADR-0210) only belongs to a Pi process: the
/// `COGNIA_PIPKG_*` values and the package-roots request are dropped from any
/// other command, and the roots request is dropped from every REMOTE spawn.
/// Applied after the allowlist so an operator addition cannot re-admit them.
fn scope_pi_package_env(
    command: &str,
    env: &mut HashMap<String, String>,
    mut dropped: Vec<String>,
    remote: bool,
) -> Vec<String> {
    let lower = command.trim().to_ascii_lowercase();
    let base = [".exe", ".cmd", ".bat"]
        .iter()
        .find_map(|suffix| lower.strip_suffix(suffix))
        .unwrap_or(&lower);
    let is_pi = base == "pi";
    let keys: Vec<String> = env
        .keys()
        .filter(|key| {
            let pipkg = key.starts_with("COGNIA_PIPKG_");
            let roots = key.as_str() == crate::sandbox::PI_PACKAGE_ROOTS_ENV;
            ((pipkg || roots) && !is_pi) || (roots && remote)
        })
        .cloned()
        .collect();
    for key in keys {
        env.remove(&key);
        dropped.push(key);
    }
    dropped.sort();
    dropped
}

#[cfg(test)]
fn filter_env(env: HashMap<String, String>) -> (HashMap<String, String>, Vec<String>) {
    filter_env_with_additions(env, &[])
}

fn filter_env_with_additions(
    env: HashMap<String, String>,
    additions: &[String],
) -> (HashMap<String, String>, Vec<String>) {
    let mut kept = HashMap::new();
    let mut dropped = Vec::new();
    for (key, value) in env {
        let allowed = ENV_KEY_ALLOWLIST.contains(&key.as_str())
            || ENV_PREFIX_ALLOWLIST
                .iter()
                .any(|prefix| key.starts_with(prefix));
        let host_policy_key = key.eq_ignore_ascii_case(COMMAND_ALLOWLIST_ENV)
            || key.eq_ignore_ascii_case(ENV_ALLOWLIST_ENV);
        if !host_policy_key && (allowed || additions.contains(&key)) {
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

    static HOST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn config(command: &str, args: &[&str]) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: "a1".into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: HashMap::new(),
            cwd: None,
            framing: Default::default(),
            sandbox: None,
        }
    }

    fn policy(smoke: bool) -> (tempfile::TempDir, SpawnPolicy) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let policy = SpawnPolicy::new(tmp.path().join("workspaces"), smoke);
        (tmp, policy)
    }

    fn custom_policy(commands: &str, keys: &str) -> (tempfile::TempDir, SpawnPolicy) {
        let (tmp, policy) = policy(false);
        (
            tmp,
            policy.with_operator_allowlists(Ok(commands.into()), Ok(keys.into())),
        )
    }

    #[test]
    fn reviewed_runtime_options_survive_host_and_bundle_environment_filters() {
        let (_tmp, policy) = policy(false);
        let reviewed = HashMap::from([
            ("LANG".into(), "en_US.UTF-8".into()),
            ("LC_ALL".into(), "C".into()),
            ("LC_CTYPE".into(), "UTF-8".into()),
            ("TZ".into(), "Asia/Shanghai".into()),
            ("TERM".into(), "xterm-256color".into()),
            ("NO_COLOR".into(), "1".into()),
            ("FORCE_COLOR".into(), "0".into()),
            ("NO_BROWSER".into(), "1".into()),
            ("INITIAL_AGENT_MODE".into(), "workspace-write".into()),
            ("APP_SERVER_LOGS".into(), "./agent logs".into()),
        ]);
        let mut request = config("codex-acp", &[]);
        request.env = reviewed.clone();
        request
            .env
            .insert("NODE_OPTIONS".into(), "--require=injected.js".into());
        request
            .env
            .insert("UNREVIEWED_RUNTIME_OPTION".into(), "blocked".into());
        for result in [
            policy.validate(request.clone()),
            policy.validate_desktop(request),
        ] {
            let validated = result.unwrap();
            assert_eq!(validated.config.env, reviewed);
            assert_eq!(
                validated.dropped_env_keys,
                ["NODE_OPTIONS", "UNREVIEWED_RUNTIME_OPTION"]
            );
            let mut env = validated.config.env.into_iter().collect();
            assert!(cognia_exec_sandbox::env::filter_env(&mut env).is_empty());
            let child =
                cognia_sandboxd::env::build_child_env(&cognia_sandboxd::env::ChildEnvInput {
                    parent: &env,
                    layout: &Default::default(),
                    libc: None,
                    user: None,
                    image_ca_bundle: None,
                });
            for (key, value) in &reviewed {
                assert_eq!(child.get(key), Some(value), "bundle dropped {key}");
            }
        }
    }

    #[test]
    fn operator_customization_is_opt_in_on_both_hosts() {
        let (_tmp, default) = policy(false);
        assert!(default.validate(config("review-agent", &[])).is_err());
        let mut request = config("pi", &[]);
        request
            .env
            .insert("AGENT_PERSONA".into(), "reviewer".into());
        assert_eq!(
            default.validate(request).unwrap().dropped_env_keys,
            ["AGENT_PERSONA"]
        );

        let (_tmp, policy) = custom_policy(r#"["review-agent"]"#, r#"["AGENT_PERSONA"]"#);
        let mut request = config("review-agent", &["--stdio", "two words", ""]);
        request
            .env
            .insert("AGENT_PERSONA".into(), "reviewer".into());
        request.env.insert("UNLISTED".into(), "dropped".into());
        for validated in [
            policy.validate(request.clone()),
            policy.validate_desktop(request),
        ] {
            let validated = validated.unwrap();
            assert_eq!(validated.config.command, "review-agent");
            assert_eq!(validated.config.args, ["--stdio", "two words", ""]);
            assert_eq!(validated.config.env["AGENT_PERSONA"], "reviewer");
            assert_eq!(validated.dropped_env_keys, ["UNLISTED"]);
        }
        assert!(policy
            .validate(config("/usr/bin/review-agent", &[]))
            .is_err());
        assert!(policy.validate(config("./review-agent", &[])).is_err());
        assert!(policy.validate(config("review-agent.cmd", &[])).is_err());
    }

    #[test]
    fn malformed_operator_configuration_denies_even_preset_spawns() {
        for raw in [
            "",
            "null",
            "{}",
            "[1]",
            r#"["valid", "valid"]"#,
            r#"["bad key"]"#,
        ] {
            for (commands, keys, expected) in [
                (raw, "[]", COMMAND_ALLOWLIST_ENV),
                ("[]", raw, ENV_ALLOWLIST_ENV),
            ] {
                let (_tmp, policy) = custom_policy(commands, keys);
                for result in [
                    policy.validate(config("pi", &[])),
                    policy.validate_desktop(config("pi", &[])),
                ] {
                    assert!(result.unwrap_err().0.contains(expected), "{raw}");
                }
            }
        }
        for raw in [
            serde_json::to_string(&vec!["x"; 65]).unwrap(),
            serde_json::to_string(&vec!["x".repeat(129)]).unwrap(),
            " ".repeat(8193),
        ] {
            let (_tmp, policy) = custom_policy(&raw, "[]");
            assert!(policy.validate(config("pi", &[])).is_err());
        }
    }

    #[test]
    fn operator_lists_support_unset_empty_and_exact_names() {
        let (_tmp, policy) = policy(false);
        let policy = policy.with_operator_allowlists(
            Err(std::env::VarError::NotPresent),
            Err(std::env::VarError::NotPresent),
        );
        assert!(policy.validate(config("pi", &[])).is_ok());
        let (_tmp, policy) = custom_policy("[]", r#"["agent_persona"]"#);
        let mut request = config("pi", &[]);
        request
            .env
            .insert("agent_persona".into(), "reviewer".into());
        request.env.insert("AGENT_PERSONA".into(), "blocked".into());
        let validated = policy.validate(request).unwrap();
        assert_eq!(validated.config.env["agent_persona"], "reviewer");
        assert_eq!(validated.dropped_env_keys, ["AGENT_PERSONA"]);
        assert!(parse_operator_list(
            ENV_ALLOWLIST_ENV,
            Err(std::env::VarError::NotUnicode(std::ffi::OsString::from(
                "invalid"
            ))),
            valid_operator_env
        )
        .is_err());
    }

    #[test]
    fn operator_cannot_admit_paths_shells_or_interpreters() {
        for name in [
            "/opt/review-agent",
            "./review-agent",
            r"C:\review-agent",
            "..",
            "bash",
            "sh",
            "pwsh",
            "cmd",
            "node",
            "python3.13",
            "npx",
            "uv",
            "env",
            "review-agent.cmd",
        ] {
            let raw = serde_json::to_string(&[name]).unwrap();
            let (_tmp, policy) = custom_policy(&raw, "[]");
            assert!(policy.validate(config("pi", &[])).is_err(), "{name}");
        }
    }

    #[test]
    fn operator_cannot_admit_loader_auth_scope_or_host_controls() {
        for key in [
            "LD_PRELOAD",
            "Dyld_Insert_Libraries",
            "NODE_OPTIONS",
            "PYTHONPATH",
            "BASH_FUNC_x",
            "HOME",
            "PATH",
            "XDG_CONFIG_HOME",
            "SSH_AUTH_SOCK",
            "NPM_CONFIG_USERCONFIG",
            "COGNIA_AGENT_ENV_ALLOWLIST",
            "COGNIA_GATEWAY_TOKEN",
        ] {
            let raw = serde_json::to_string(&[key]).unwrap();
            let (_tmp, policy) = custom_policy("[]", &raw);
            assert!(policy.validate(config("pi", &[])).is_err(), "{key}");
        }
    }

    #[test]
    fn request_environment_cannot_change_or_forward_operator_authority() {
        let (_tmp, policy) = custom_policy("[]", "[]");
        let mut request = config("review-agent", &[]);
        request
            .env
            .insert(COMMAND_ALLOWLIST_ENV.into(), r#"["review-agent"]"#.into());
        request
            .env
            .insert(ENV_ALLOWLIST_ENV.into(), r#"["AGENT_PERSONA"]"#.into());
        request
            .env
            .insert("AGENT_PERSONA".into(), "reviewer".into());
        assert!(policy.validate(request.clone()).is_err());
        request.command = "pi".into();
        let validated = policy.validate(request).unwrap();
        assert!(validated.config.env.is_empty());
        assert_eq!(
            validated.dropped_env_keys,
            ["AGENT_PERSONA", COMMAND_ALLOWLIST_ENV, ENV_ALLOWLIST_ENV]
        );
    }

    #[test]
    fn bot_runtime_isolation_survives_native_policy_filtering() {
        let (tmp, policy) = policy(false);
        let checkout = tmp.path().join("workspaces/run");
        std::fs::create_dir_all(&checkout).unwrap();
        let checkout = checkout.canonicalize().unwrap();
        let mut request = config("devin", &["acp"]);
        request.cwd = Some(checkout.to_string_lossy().into_owned());
        request
            .env
            .insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        request.env.insert(
            "COGNIA_BOT_STATE_DIR".into(),
            format!("{}-state", checkout.display()),
        );
        for validated in [
            policy.validate(request.clone()).unwrap(),
            policy.validate_desktop(request.clone()).unwrap(),
        ] {
            assert_eq!(
                validated
                    .config
                    .env
                    .get("COGNIA_BOT_ISOLATION")
                    .map(String::as_str),
                Some("1")
            );
            assert_eq!(
                validated.config.env.get("COGNIA_BOT_STATE_DIR"),
                request.env.get("COGNIA_BOT_STATE_DIR")
            );
        }
        request.env.insert(
            "COGNIA_BOT_STATE_DIR".into(),
            tmp.path().to_string_lossy().into_owned(),
        );
        assert!(policy.validate(request.clone()).is_err());
        assert!(policy.validate_desktop(request.clone()).is_err());
        request.env.remove("COGNIA_BOT_ISOLATION");
        assert!(policy.validate(request).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn bot_runtime_state_rejects_a_symlink_to_another_run() {
        let (tmp, policy) = policy(false);
        let checkout = tmp.path().join("workspaces/run");
        std::fs::create_dir_all(&checkout).unwrap();
        let checkout = checkout.canonicalize().unwrap();
        std::os::unix::fs::symlink(tmp.path(), format!("{}-state", checkout.display())).unwrap();
        let mut request = config("devin", &["acp"]);
        request.cwd = Some(checkout.to_string_lossy().into_owned());
        request
            .env
            .insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        request.env.insert(
            "COGNIA_BOT_STATE_DIR".into(),
            format!("{}-state", checkout.display()),
        );
        assert!(policy.validate(request).is_err());
    }

    // ── Policy matrix: command ───────────────────────────────────────────────

    #[test]
    fn kimi_launch_preserves_model_env_without_identity_or_script_injection() {
        let (_tmp, policy) = policy(false);
        let mut input = config("kimi", &["acp"]);
        input.env.extend([
            ("KIMI_CODE_HOME".into(), "/owned/kimi".into()),
            ("KIMI_MODEL_API_KEY".into(), "synthetic".into()),
            ("KIMI_MODEL_PROVIDER_TYPE".into(), "anthropic".into()),
            ("KIMI_MODEL_TEMPERATURE".into(), "0.5".into()),
            ("KIMI_CODE_USER_AGENT".into(), "spoofed".into()),
            ("KIMI_OAUTH_HOST".into(), "https://untrusted".into()),
            ("KIMI_PLUGIN_ROOT".into(), "/scripts".into()),
            ("KIMI_BIN_PATH".into(), "/injected".into()),
        ]);
        for validated in [
            policy.validate(input.clone()).unwrap(),
            policy.validate_desktop(input).unwrap(),
        ] {
            assert_eq!(validated.config.env["KIMI_CODE_HOME"], "/owned/kimi");
            assert_eq!(validated.config.env["KIMI_MODEL_API_KEY"], "synthetic");
            assert_eq!(
                validated.config.env["KIMI_MODEL_PROVIDER_TYPE"],
                "anthropic"
            );
            for key in [
                "KIMI_CODE_USER_AGENT",
                "KIMI_OAUTH_HOST",
                "KIMI_PLUGIN_ROOT",
                "KIMI_BIN_PATH",
            ] {
                assert!(!validated.config.env.contains_key(key));
            }
        }
        assert!(!valid_operator_env("KIMI_CODE_HOME"));
    }

    #[test]
    fn cline_launch_filters_exact_environment_keys_on_both_hosts() {
        let (_tmp, policy) = policy(false);
        let mut input = config("cline", &["--acp"]);
        input.env.extend([
            ("CLINE_API_KEY".into(), "synthetic".into()),
            ("CLINE_PROVIDER".into(), "deepseek".into()),
            ("CLINE_MODEL".into(), "deepseek-flash".into()),
            ("CLINE_DIR".into(), "/owned/cline".into()),
            ("CLINE_BIN_PATH".into(), "/injected".into()),
            ("CLINE_DATA_DIR".into(), "/unscoped".into()),
        ]);
        for validated in [
            policy.validate(input.clone()).unwrap(),
            policy.validate_desktop(input).unwrap(),
        ] {
            assert_eq!(validated.config.env["CLINE_API_KEY"], "synthetic");
            assert_eq!(validated.config.env["CLINE_DIR"], "/owned/cline");
            assert!(!validated.config.env.contains_key("CLINE_BIN_PATH"));
            assert!(!validated.config.env.contains_key("CLINE_DATA_DIR"));
        }
    }

    #[test]
    fn qoder_launch_filters_environment_on_both_hosts() {
        let (_tmp, policy) = policy(false);
        let mut input = config("qoder", &["--acp"]);
        input.env = HashMap::from([
            ("QODER_PERSONAL_ACCESS_TOKEN".into(), "synthetic".into()),
            ("QODER_CONFIG_DIR".into(), "/owned/qoder".into()),
            ("QODER_UNRELATED".into(), "blocked".into()),
            ("NODE_OPTIONS".into(), "--inspect".into()),
        ]);
        for validated in [
            policy.validate(input.clone()).unwrap(),
            policy.validate_desktop(input).unwrap(),
        ] {
            assert_eq!(
                validated.config.env["QODER_PERSONAL_ACCESS_TOKEN"],
                "synthetic"
            );
            assert_eq!(validated.config.env["QODER_CONFIG_DIR"], "/owned/qoder");
            assert!(!validated.config.env.contains_key("QODER_UNRELATED"));
            assert!(!validated.config.env.contains_key("NODE_OPTIONS"));
        }
    }

    #[test]
    fn goose_launch_keeps_provider_settings_and_filters_injection() {
        let (_tmp, policy) = policy(false);
        let mut input = config("goose", &["acp", "--with-builtin", "developer"]);
        input.env = HashMap::from([
            ("GOOSE_PROVIDER".into(), "openai".into()),
            ("GOOSE_MODEL".into(), "deepseek-flash".into()),
            ("GOOSE_MODE".into(), "approve".into()),
            ("OPENAI_API_KEY".into(), "synthetic".into()),
            ("LD_PRELOAD".into(), "/injected.so".into()),
        ]);
        for validated in [
            policy.validate(input.clone()).unwrap(),
            policy.validate_desktop(input).unwrap(),
        ] {
            assert_eq!(validated.config.env["GOOSE_MODEL"], "deepseek-flash");
            assert_eq!(validated.config.env["GOOSE_MODE"], "approve");
            assert!(validated.config.env.contains_key("OPENAI_API_KEY"));
            assert_eq!(validated.dropped_env_keys, vec!["LD_PRELOAD"]);
        }
    }

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
            "devin",
            "pi",
        ] {
            assert!(p.validate(config(bin, &[])).is_ok(), "{bin} must pass");
        }
        // Windows shims normalize.
        assert!(p.validate(config("claude.CMD", &[])).is_ok());
        assert!(p.validate(config("codex.exe", &[])).is_ok());
    }

    #[test]
    fn devin_mcp_payload_reaches_only_the_native_devin_acp_launch() {
        let (_tmp, p) = policy(false);
        let mut input = config("devin", &["acp"]);
        input
            .env
            .insert(crate::devin_mcp_config::PAYLOAD_ENV.into(), "[]".into());
        input
            .env
            .insert(crate::devin_mcp_config::WRAPPED_ENV.into(), "1".into());
        assert!(!p
            .validate(input.clone())
            .unwrap()
            .config
            .env
            .contains_key(crate::devin_mcp_config::WRAPPED_ENV));
        assert!(p
            .validate(input.clone())
            .unwrap()
            .config
            .env
            .contains_key(crate::devin_mcp_config::PAYLOAD_ENV));
        assert!(p
            .validate_desktop(input.clone())
            .unwrap()
            .config
            .env
            .contains_key(crate::devin_mcp_config::PAYLOAD_ENV));
        input.command = "codex".into();
        assert!(p.validate(input.clone()).is_err());
        assert!(p.validate_desktop(input).is_err());
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
    fn cline_binary_is_reachable_from_its_native_acp_preset() {
        let (_tmp, p) = policy(false);
        assert!(p
            .validate(config("cline", &["--acp", "--auto-approve", "false"]))
            .is_ok());
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
        if let Some(node) = crate::command_resolver::resolve_command_path("node") {
            assert!(p
                .validate(config(
                    node.to_str().expect("node path"),
                    &[
                        launcher.to_str().expect("launcher"),
                        composition.to_str().expect("composition"),
                    ]
                ))
                .is_ok());
            assert!(p
                .validate(config(
                    node.to_str().expect("node path"),
                    &["-e", "process.exit(0)"]
                ))
                .is_err());
        }

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

    #[test]
    fn workspaces_dir_reports_the_root_validation_enforces() {
        let (tmp, policy) = policy(false);
        let reported = policy.workspaces_dir().to_path_buf();
        assert_eq!(reported, tmp.path().join("workspaces"));
        // The reported root has to be one the client can actually browse, so
        // it must survive the same validation every other path goes through.
        std::fs::create_dir_all(&reported).unwrap();
        assert_eq!(
            PathBuf::from(
                policy
                    .validate_workspace_root(reported.to_str().unwrap())
                    .unwrap()
            )
            .canonicalize()
            .unwrap(),
            reported.canonicalize().unwrap()
        );
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
            ("DEVIN_API_KEY".to_string(), "devin".to_string()),
            ("WINDSURF_API_KEY".to_string(), "windsurf".to_string()),
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
        assert!(validated.config.env.contains_key("DEVIN_API_KEY"));
        assert!(validated.config.env.contains_key("WINDSURF_API_KEY"));
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
        assert_eq!(validated.config.env.len(), 8);
    }

    /// Pi runs as a bare allowlisted binary, never through npx (ADR-0119).
    ///
    /// The `pi-acp` community bridge used to be allowlisted alongside it. It
    /// was removed once the native adapter shipped, and this asserts the
    /// removal rather than just omitting it: re-adding the package to the
    /// allowlist would silently restore an unpinned `npx` launch that the
    /// runtime catalog no longer waives.
    #[test]
    fn pi_runs_as_an_allowlisted_binary_and_the_acp_bridge_is_refused() {
        let (_tmp, p) = policy(false);
        assert!(p.validate(config("pi", &["--mode", "rpc"])).is_ok());
        assert!(p.validate(config("npx", &["-y", "pi-acp"])).is_err());
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

    /// Plugin Pi package values reach the cooperating extension (ADR-0210),
    /// while the prefix stays exactly that prefix: a near-miss key, an
    /// injection vector and an unrelated `COGNIA_` key are all still dropped.
    #[test]
    fn plugin_pi_package_env_reaches_the_agent_without_widening_the_policy() {
        let (_tmp, p) = policy(false);
        let mut cfg = config("pi", &["--mode", "rpc"]);
        cfg.env = HashMap::from([
            (
                "COGNIA_PIPKG_TEX_ENGINE".to_string(),
                "lualatex".to_string(),
            ),
            ("COGNIA_PIPKG_WORKSPACE".to_string(), "/work".to_string()),
            ("COGNIA_PIPKGX".to_string(), "near-miss".to_string()),
            ("COGNIA_PLUGIN_SECRET".to_string(), "nope".to_string()),
            ("NODE_OPTIONS".to_string(), "--require evil".to_string()),
        ]);
        let validated = p.validate(cfg).expect("valid command");
        assert_eq!(
            validated
                .config
                .env
                .get("COGNIA_PIPKG_TEX_ENGINE")
                .map(String::as_str),
            Some("lualatex")
        );
        assert!(validated.config.env.contains_key("COGNIA_PIPKG_WORKSPACE"));
        assert_eq!(
            validated.dropped_env_keys,
            vec!["COGNIA_PIPKGX", "COGNIA_PLUGIN_SECRET", "NODE_OPTIONS"]
        );
    }

    /// The package-roots request is host-to-wrapper only: a remote spawn
    /// never carries it, and no plugin package env reaches a non-Pi agent.
    #[test]
    fn plugin_pi_package_env_is_scoped_to_local_pi_spawns() {
        let (_tmp, p) = policy(false);
        let env = || {
            HashMap::from([
                (
                    crate::sandbox::PI_PACKAGE_ROOTS_ENV.to_string(),
                    "[\"/anything\"]".to_string(),
                ),
                ("COGNIA_PIPKG_MODE".to_string(), "hosted".to_string()),
            ])
        };
        let mut remote = config("pi", &["--mode", "rpc"]);
        remote.env = env();
        let validated = p.validate(remote).expect("valid command");
        assert!(!validated
            .config
            .env
            .contains_key(crate::sandbox::PI_PACKAGE_ROOTS_ENV));
        assert!(validated.config.env.contains_key("COGNIA_PIPKG_MODE"));
        assert!(validated
            .dropped_env_keys
            .contains(&crate::sandbox::PI_PACKAGE_ROOTS_ENV.to_string()));

        let mut other = config("claude", &[]);
        other.env = env();
        let validated = p.validate(other).expect("valid command");
        assert!(validated.config.env.is_empty());
        assert_eq!(
            validated.dropped_env_keys,
            vec![
                "COGNIA_PIPKG_MODE".to_string(),
                crate::sandbox::PI_PACKAGE_ROOTS_ENV.to_string()
            ]
        );

        let (accepted, dropped) = filter_env(env());
        let mut local = accepted;
        let dropped = scope_pi_package_env("pi", &mut local, dropped, false);
        assert!(dropped.is_empty());
        assert!(local.contains_key(crate::sandbox::PI_PACKAGE_ROOTS_ENV));
        let mut local_exe = env();
        assert!(scope_pi_package_env("PI.EXE", &mut local_exe, vec![], false).is_empty());
    }

    #[test]
    fn pi_task_directories_survive_without_allowing_arbitrary_pi_options() {
        let (accepted, dropped) = filter_env(HashMap::from([
            ("PI_CODING_AGENT_DIR".into(), "/task/pi".into()),
            (
                "PI_CODING_AGENT_SESSION_DIR".into(),
                "/task/pi/sessions".into(),
            ),
            ("PI_UNTRUSTED_OPTION".into(), "blocked".into()),
        ]));
        assert_eq!(accepted["PI_CODING_AGENT_DIR"], "/task/pi");
        assert_eq!(accepted["PI_CODING_AGENT_SESSION_DIR"], "/task/pi/sessions");
        assert_eq!(dropped, vec!["PI_UNTRUSTED_OPTION"]);
    }

    #[test]
    fn from_env_reads_smoke_gate_and_workspaces_dir() {
        let _lock = HOST_ENV_LOCK.lock().unwrap();
        let prev_commands = std::env::var_os(COMMAND_ALLOWLIST_ENV);
        let prev_keys = std::env::var_os(ENV_ALLOWLIST_ENV);
        std::env::set_var(COMMAND_ALLOWLIST_ENV, r#"["review-agent"]"#);
        std::env::set_var(ENV_ALLOWLIST_ENV, r#"["AGENT_PERSONA"]"#);
        let prev_ws = std::env::var(WORKSPACES_DIR_ENV).ok();
        let prev_smoke = std::env::var(SMOKE_AGENT_ENV).ok();

        std::env::set_var(WORKSPACES_DIR_ENV, "X:/ws");
        std::env::set_var(SMOKE_AGENT_ENV, "1");
        let p = SpawnPolicy::from_env(Path::new("/data"));
        assert_eq!(p.workspaces_dir, PathBuf::from("X:/ws"));
        assert!(p.smoke_agent_enabled);
        assert!(p.validate_command("review-agent", &[]).is_ok());
        assert_eq!(p.operator_env, ["AGENT_PERSONA"]);
        std::env::set_var(COMMAND_ALLOWLIST_ENV, "[]");
        // Policy snapshots cannot be widened by subsequent request/child env changes.
        assert!(p.validate_command("review-agent", &[]).is_ok());

        std::env::remove_var(WORKSPACES_DIR_ENV);
        std::env::set_var(SMOKE_AGENT_ENV, "0");
        let p = SpawnPolicy::from_env(Path::new("/data"));
        assert_eq!(p.workspaces_dir, PathBuf::from("/data").join("workspaces"));
        assert!(!p.smoke_agent_enabled);
        assert!(p.validate_command("review-agent", &[]).is_err());
        std::env::set_var(ENV_ALLOWLIST_ENV, "invalid");
        let invalid = SpawnPolicy::from_env(Path::new("/data"));
        assert!(invalid
            .validate_command("pi", &[])
            .unwrap_err()
            .0
            .contains(ENV_ALLOWLIST_ENV));
        for (key, previous) in [
            (COMMAND_ALLOWLIST_ENV, prev_commands),
            (ENV_ALLOWLIST_ENV, prev_keys),
        ] {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }

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
        assert!(validated
            .dropped_env_keys
            .contains(&"LD_PRELOAD".to_string()));
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
        cfg.cwd = Some(
            tmp.path()
                .join("a")
                .join("..")
                .join("a")
                .join("b")
                .display()
                .to_string(),
        );
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

    /// The contradiction this closes: Task Workspace materializes a managed
    /// working copy under `<data_dir>/task-workspaces/executions/...` and hands
    /// the agent that path, while the policy admitted only the workspaces root.
    /// The host provisioned a working copy and then refused to run in it.
    #[test]
    fn a_managed_execution_root_is_admitted_and_nothing_beside_it_is() {
        let data = tempfile::tempdir().expect("tempdir");
        let workspaces = data.path().join("workspaces");
        let executions = data.path().join("task-workspaces").join("executions");
        let run_root = executions.join("bundle-a").join("workspace-a");
        std::fs::create_dir_all(&run_root).expect("mkdir run root");
        let sibling = data.path().join("task-workspaces").join("blobs");
        std::fs::create_dir_all(&sibling).expect("mkdir sibling");

        let policy = SpawnPolicy::new(workspaces, false).with_managed_execution_dir(executions);

        assert!(policy
            .validate_cwd(Some(run_root.to_str().expect("utf8")))
            .is_ok());
        // Only the executions tree. A neighbouring directory under the same
        // service dir is still outside the policy.
        assert!(policy
            .validate_cwd(Some(sibling.to_str().expect("utf8")))
            .is_err());
    }

    #[test]
    fn a_policy_with_no_managed_root_still_refuses_everything_outside_workspaces() {
        let data = tempfile::tempdir().expect("tempdir");
        let outside = data.path().join("elsewhere");
        std::fs::create_dir_all(&outside).expect("mkdir");

        let policy = SpawnPolicy::new(data.path().join("workspaces"), false);

        assert!(policy
            .validate_cwd(Some(outside.to_str().expect("utf8")))
            .is_err());
    }

    /// `from_env` is the production constructor, and it is the only place that
    /// knows the data dir both features are derived from. If it stopped wiring
    /// the managed root, every managed run on a headless Host would be denied
    /// again with nothing else changing.
    #[test]
    fn from_env_wires_the_managed_execution_root_beside_the_workspaces_root() {
        let _lock = HOST_ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os(WORKSPACES_DIR_ENV);
        let data = tempfile::tempdir().expect("tempdir");
        let run_root = data
            .path()
            .join("task-workspaces")
            .join("executions")
            .join("bundle-b")
            .join("workspace-b");
        std::fs::create_dir_all(&run_root).expect("mkdir run root");
        std::env::remove_var(WORKSPACES_DIR_ENV);

        let policy = SpawnPolicy::from_env(data.path());

        assert!(policy
            .validate_cwd(Some(run_root.to_str().expect("utf8")))
            .is_ok());
        match previous {
            Some(value) => std::env::set_var(WORKSPACES_DIR_ENV, value),
            None => std::env::remove_var(WORKSPACES_DIR_ENV),
        }
    }
}
