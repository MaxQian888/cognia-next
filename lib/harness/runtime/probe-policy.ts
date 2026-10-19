/**
 * What a probe may do (ADR-0237).
 *
 * A probe runs a candidate harness on a real task, unattended, many times.
 * It must not touch the user's workspace, the user's app data, other people
 * or the network beyond what the task needs. Three layers decide that, from
 * outside in:
 *
 * 1. The per-run capability grant ({@link probeCapabilityGrant}). Folded into
 *    resolution like every other grant, so the resolver's filter, ceiling and
 *    finalizer govern it. It caps the permission mode at `default` (so every
 *    mutating call reaches a decision instead of a mode shortcut), carries an
 *    unattended permission profile that denies outbound messages, secret use
 *    and host configuration in the sidecar itself (ADR-0224 A7), keeps only the
 *    MCP servers the user declared safe to probe, and denies every tool that
 *    writes app state or acts outside the machine.
 * 2. The plugin-tool surface. First-party plugin tools are many and their rule
 *    tier can auto-allow them, so a probe keeps only a short allowlist and
 *    denies the rest by name ({@link probePluginToolDenials}), discovered from
 *    the resolved manifest once per run.
 * 3. The permission responder ({@link decideProbeToolCall}) for every call
 *    that still asks: file tools must stay inside the probe directory and
 *    shell commands pass a policy built on the shared command classifier.
 *
 * A git worktree or a scratch directory is not a sandbox. Shell commands that
 * pass run on this machine; the policy refuses the recognisable ways out
 * (remotes, global installs, privileged and system commands, paths outside
 * the directory), and the rollout's evidence says so in a caveat unless the
 * agent runs in a sandbox runtime.
 */

import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import { splitCommandSegments } from "@/lib/claude/permissions/command-parse"
import { classifyCommand, normalizePosixPath } from "@/lib/claude/permissions/command-safety"
import type {
  HarnessIsolationKind,
  HarnessProbePolicy,
  HarnessRoleModel,
} from "@/types/harness/evolution"

const BUILTIN_SERVER = "cognia-tools"
const PLUGIN_SERVER = "cognia-plugin-tools"
const A2UI_SERVER = "a2ui-bridge"

/** `mcp__<server>__<tool>` → its parts; a bare name has no server. */
export function splitProbeToolName(toolName: string): { server?: string; bare: string } {
  if (!toolName.startsWith("mcp__")) return { bare: toolName }
  const rest = toolName.slice(5)
  const i = rest.indexOf("__")
  if (i <= 0) return { bare: toolName }
  return { server: rest.slice(0, i), bare: rest.slice(i + 2) }
}

function aliases(server: string, names: readonly string[]): string[] {
  return names.flatMap((name) => [name, `mcp__${server}__${name}`])
}

/** File tools that write: native SDK editors and the built-in catalog's writers. */
export const PROBE_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "str_replace_based_edit_tool",
  "text_editor",
  "write",
  "edit",
  "multi_edit",
  "file_append",
  "file_binary_write",
  "file_copy",
  "file_rename",
  "file_move",
  "directory_create",
  "directory_delete",
  "apply_patch",
  "ast_grep_replace",
])

/** File and code tools that only read. */
export const PROBE_FILE_READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "read",
  "grep",
  "glob",
  "ls",
  "file_hash",
  "file_diff",
  "file_info",
  "file_search",
  "content_search",
  "file_exists",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_remote",
  "git_tag",
  "git_repo_inspect",
  "git_changes",
  "git_history",
  "ast_grep_search",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_diagnostics",
])

/** Shell tools whose command the shell policy judges. */
export const PROBE_SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "bash"])

/** Local git writes: allowed only inside a probe's own worktree. */
export const PROBE_GIT_WRITE_TOOLS: ReadonlySet<string> = new Set(["git_stage", "git_commit"])

/** Tools whose effect stays inside the run: task bookkeeping, its own shells, delegation, skills. */
export const PROBE_SESSION_TOOLS: ReadonlySet<string> = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "BashOutput",
  "bash_output",
  "KillShell",
  "KillBash",
  "kill_shell",
  "list_shells",
  "monitor_cancel",
  "monitor_list",
  "ExitPlanMode",
  "EnterPlanMode",
  "exit_plan_mode",
  "Task",
  "Agent",
  "Skill",
  "load_skill",
  "load_skill_resource",
  "current_time",
  "system_info",
  "a2ui_create_surface",
  "a2ui_update_components",
  "a2ui_data_model_update",
  "a2ui_delete_surface",
])

/** Tools that reach the network for reading. Denied when the probe policy cuts the network. */
export const PROBE_WEB_TOOLS: readonly string[] = [
  "WebFetch",
  "WebSearch",
  "web_search",
  "web_fetch",
]

/**
 * First-party plugin tools a probe keeps. Everything else on the plugin
 * server is denied by name: skills must load, and the agent's own knowledge
 * and the web are read-only inputs a real run would use.
 */
export const PROBE_ALLOWED_PLUGIN_TOOLS: ReadonlySet<string> = new Set([
  "Skill",
  "load_skill",
  "load_skill_resource",
  "web_search",
  "web_fetch",
  "knowledge_list_documents",
  "knowledge_read_outline",
  "knowledge_read_original",
  "knowledge_locate",
  "vector_search",
])

/**
 * Built-in catalog tools a probe never gets: secrets in the environment,
 * host processes, outbound clones, long-lived terminals, plan rows in the
 * app database, and the advanced shell whose input the shell policy does not
 * model.
 */
const DENIED_BUILTIN_TOOLS = [
  "list_env",
  "get_env",
  "start_process",
  "terminate_process",
  "clone_dep_source",
  "web_clone",
  "web_clone_convert",
  "terminal_repl_spawn",
  "terminal_repl_write",
  "terminal_repl_kill",
  "Monitor",
  "shell_execute_advanced",
  "create_plan",
  "update_plan",
]

/**
 * First-party plugin tools that write app state or act outside the machine,
 * denied by name even before the manifest is known (defence in depth for the
 * discovery pass; the discovered denial covers every other plugin tool).
 */
const DENIED_PLUGIN_TOOLS = [
  "ask_user",
  "artifact_create",
  "artifact_update",
  "artifact_delete",
  "canvas_create",
  "canvas_update",
  "canvas_open",
  "filespace_share",
  "filespace_revoke_share",
  "filespace_enable_webdav",
  "filespace_disable_webdav",
  "propose_threads",
  "resolve_thread",
  "remember_project_note",
  "set_project_preference",
  "spawn_thread",
  "start_thread",
  "message_thread",
  "stop_thread",
  "report_to_coordinator",
  "agent_builder_update_draft",
  "agent_builder_create_agent",
  "open_in_editor",
  "reveal_in_editor",
  "show_editor_diff",
  "apply_editor_edit",
  "save_editor_buffers",
  "build_site",
  "deploy_site",
  "pet_care",
  "pet_say",
  "pet_reward",
  "pet_show",
  "template_instantiate",
  "squad_apply_template",
  "squad_save_as_template",
  "vector_add_document",
  "vector_delete_document",
  "working_set",
  "team_publish_memory",
  "team_request_consensus",
  "team_vote",
  "task_add_comment",
  "team_propose_decision",
  "team_send_message",
  "team_post_to_chat",
  "team_delegate",
  "dispatch_agent",
  "spawn_task",
  "send_session_message",
  "scheduler_create_task",
  "scheduler_update_task",
  "scheduler_set_task_status",
  "scheduler_delete_task",
  "scheduler_run_task_now",
  "scheduler_cancel_task_run",
  "scheduler_stop_task_process",
  "issue_create",
  "issue_update",
  "issue_comment",
  "issue_create_project",
  "issue_update_project",
  "issue_link_artifact",
  "issue_wakeup_create",
  "issue_wakeup_set_enabled",
  "issue_wakeup_checkin",
  "issue_delete",
  "issue_delete_project",
  "issue_wakeup_delete",
  "issue_run",
  "issue_cancel_run",
  "im_create_chat",
  "im_update_chat",
  "im_invite_members",
  "im_remove_members",
  "im_broadcast",
  "im_dispatch_task",
  "video_generate",
  "plugin_conversion_apply",
  "terminal_dock_spawn",
  "terminal_dock_write",
  "expand_element",
  "perform_action",
  "click_text",
  "SlashCommand",
]

/** The A2UI bridge call that injects inbound IM input. */
const DENIED_A2UI_TOOLS = ["a2ui_handle_connector_action"]

/** Every tool a probe is denied regardless of its directory or network setting. */
export const PROBE_DENIED_TOOLS: readonly string[] = [
  ...aliases(BUILTIN_SERVER, DENIED_BUILTIN_TOOLS),
  ...aliases(PLUGIN_SERVER, DENIED_PLUGIN_TOOLS),
  ...aliases(A2UI_SERVER, DENIED_A2UI_TOOLS),
]

/** Plugin tools in a resolved manifest that a probe must not have. */
export function probePluginToolDenials(
  pluginTools: readonly { name: string }[] | undefined
): string[] {
  const names = [...new Set((pluginTools ?? []).map((t) => t.name))]
    .filter((name) => !PROBE_ALLOWED_PLUGIN_TOOLS.has(name))
    .sort()
  return aliases(PLUGIN_SERVER, names)
}

/** The unattended permission profile every probe carries. */
export const PROBE_PERMISSION_PROFILE = {
  workspace: "sandbox",
  outbound: "deny",
  secrets: "deny",
  hostConfig: "deny",
} as const

export interface ProbeGrantInput {
  runId: string
  label: string
  isolation: HarnessIsolationKind
  policy: HarnessProbePolicy
  maxTurns: number
  /** Per-rollout dollar ceiling where the runtime enforces one. */
  maxBudgetUsd?: number
  /** Plugin tools discovered in the resolved manifest that the probe must not have. */
  pluginToolDenials?: readonly string[]
  /** The executor model chosen for the run; absent keeps the agent's own. */
  executor?: HarnessRoleModel
}

/** The capability grant a probe runs under. */
export function probeCapabilityGrant(input: ProbeGrantInput): AgentCapabilityGrantV1 {
  const deny = new Set<string>(PROBE_DENIED_TOOLS)
  if (input.policy.networkOff) {
    for (const name of [
      ...aliases(BUILTIN_SERVER, PROBE_WEB_TOOLS),
      ...aliases(PLUGIN_SERVER, PROBE_WEB_TOOLS),
    ]) {
      deny.add(name)
    }
  }
  if (input.isolation === "none") {
    // No working directory: the run is text-only, so nothing writes or runs.
    const writers = [...PROBE_FILE_WRITE_TOOLS, ...PROBE_SHELL_TOOLS, ...PROBE_GIT_WRITE_TOOLS]
    for (const name of aliases(BUILTIN_SERVER, writers)) deny.add(name)
  }
  for (const name of input.pluginToolDenials ?? []) deny.add(name)
  const maxTurns = Math.max(1, Math.min(100, Math.floor(input.maxTurns)))
  return {
    schemaVersion: 1,
    source: { kind: "harness-evolution", id: `${input.runId}:${input.label}` },
    ...(input.executor?.model ? { model: input.executor.model } : {}),
    ...(input.executor?.providerId ? { provider: input.executor.providerId } : {}),
    maxTurns,
    ...(typeof input.maxBudgetUsd === "number" &&
    Number.isFinite(input.maxBudgetUsd) &&
    input.maxBudgetUsd > 0
      ? { maxBudgetUsd: input.maxBudgetUsd }
      : {}),
    permissionMode: "default",
    permissionProfile: { ...PROBE_PERMISSION_PROFILE },
    mcpServers: { only: [...input.policy.allowedMcpServerIds].sort() },
    tools: { deny: [...deny].sort() },
  }
}

export interface ProbePolicyContext {
  isolation: HarnessIsolationKind
  /** The probe's working directory; absent for `none`. */
  root?: string
  /** The host user's home directory, to resolve `~`. */
  home?: string
  networkOff: boolean
  /** Names (as they appear in tool names) of the MCP servers declared safe to probe. */
  allowedMcpServerNames: ReadonlySet<string>
}

export type ProbeToolDecision = { allow: true } | { allow: false; reason: string }

const ALLOW: ProbeToolDecision = { allow: true }
const refuse = (reason: string): ProbeToolDecision => ({ allow: false, reason })

/** Forward slashes, collapsed dots; drive letters lower-cased for comparison. */
function normalizeHostPath(path: string): string | undefined {
  const forward = path.replace(/\\/g, "/")
  const drive = /^[A-Za-z]:\//.test(forward)
  const body = drive ? forward.slice(2) : forward
  const normalized = normalizePosixPath(body)
  if (!normalized) return undefined
  return drive ? `${forward.slice(0, 2).toLowerCase()}${normalized}` : normalized
}

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
}

/**
 * Where `target` lands, resolved against `root`; `undefined` when it cannot be
 * proven (a `~` path without a home, an empty string).
 */
export function resolveProbePath(target: string, root: string, home?: string): string | undefined {
  const trimmed = target.trim()
  if (!trimmed) return undefined
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return home ? normalizeHostPath(`${home}/${trimmed.slice(1)}`) : undefined
  }
  if (trimmed.startsWith("file://")) return resolveProbePath(trimmed.slice(7), root, home)
  if (isAbsoluteHostPath(trimmed)) return normalizeHostPath(trimmed)
  return normalizeHostPath(`${root.replace(/[\\/]+$/, "")}/${trimmed}`)
}

/** Whether `path` (already resolved) is `root` or inside it. */
export function isInsideRoot(path: string, root: string): boolean {
  const r = normalizeHostPath(root)
  if (!r) return false
  const p = path
  const caseFold = /^[a-z]:\//.test(r)
  const a = caseFold ? p.toLowerCase() : p
  const b = caseFold ? r.toLowerCase() : r
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`)
}

const PATH_KEY =
  /^(file_?path|path|paths|notebook_?path|source|destination|old_?path|new_?path|target|target_?path|directory|dir|cwd|output_?path|dest(ination)?_?path|repo(_?path)?|root)$/i

/** Every path-like string a tool input names, top level and one level into arrays/objects. */
export function pathsInToolInput(input: unknown): string[] {
  const out: string[] = []
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 2) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (PATH_KEY.test(key)) {
        if (typeof v === "string") out.push(v)
        else if (Array.isArray(v)) for (const s of v) if (typeof s === "string") out.push(s)
      } else if (typeof v === "object") {
        visit(v, depth + 1)
      }
    }
  }
  visit(input, 0)
  return out
}

/** File paths a patch body touches (unified diff and the apply_patch envelope). */
export function pathsInPatch(patch: string): string[] {
  const out = new Set<string>()
  for (const line of patch.split(/\r?\n/)) {
    const envelope =
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line)
    if (envelope) {
      out.add(envelope[1].trim())
      continue
    }
    const unified = /^(?:\+\+\+|---) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line)
    if (unified && unified[1].trim() !== "/dev/null") out.add(unified[1].trim())
  }
  return [...out]
}

function patchText(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  for (const key of ["patch", "input", "diff"]) {
    if (typeof record[key] === "string") return record[key] as string
  }
  return null
}

function checkPathsInRoot(paths: readonly string[], ctx: ProbePolicyContext): ProbeToolDecision {
  if (!ctx.root) return refuse("This probe has no working directory; file access is not available.")
  for (const raw of paths) {
    const resolved = resolveProbePath(raw, ctx.root, ctx.home)
    if (!resolved || !isInsideRoot(resolved, ctx.root)) {
      return refuse(`"${raw}" is outside this probe's working directory.`)
    }
  }
  return ALLOW
}

/** Heads a probe never runs: remote access, privilege, system services, other apps, cloud and infra. */
const SHELL_DENIED_HEADS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "su",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "telnet",
  "nc",
  "ncat",
  "socat",
  "rsync",
  "open",
  "xdg-open",
  "osascript",
  "launchctl",
  "systemctl",
  "service",
  "crontab",
  "at",
  "schtasks",
  "kill",
  "killall",
  "pkill",
  "taskkill",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "docker",
  "docker-compose",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "ansible",
  "vagrant",
  "aws",
  "az",
  "gcloud",
  "heroku",
  "vercel",
  "netlify",
  "gh",
  "glab",
  "brew",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "apk",
  "snap",
  "choco",
  "winget",
  "scoop",
  "pipx",
  "gem",
  "printenv",
  "security",
  "defaults",
  "reg",
  "regedit",
  "setx",
  "mount",
  "umount",
  "ifconfig",
  "route",
  "iptables",
  "ufw",
  "netsh",
])

/** Heads that reach the network; refused when the probe policy cuts it. */
const SHELL_NETWORK_HEADS: ReadonlySet<string> = new Set(["curl", "wget", "http", "https", "xh"])

/** Package-manager subcommands that download. */
const INSTALL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "install",
  "i",
  "add",
  "ci",
  "update",
  "upgrade",
  "fetch",
  "dlx",
  "exec",
  "x",
  "create",
  "init",
])

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "cargo",
  "go",
  "composer",
  "bundle",
])

/** Package-manager subcommands that publish or change registry state. */
const PUBLISH_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "publish",
  "unpublish",
  "login",
  "logout",
  "adduser",
  "token",
  "owner",
  "access",
  "deprecate",
  "yank",
  "link",
])

/** Git subcommands that talk to a remote. */
const GIT_REMOTE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "push",
  "fetch",
  "pull",
  "clone",
  "ls-remote",
  "submodule",
  "send-email",
  "request-pull",
])

/** Heads whose `ask` verdict is local file work, acceptable inside the probe directory. */
const LOCAL_MUTATION_HEADS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "rename",
  "tee",
  "make",
  "chmod",
  "mkdir",
  "touch",
  "cp",
  "ln",
  "git",
])

/** Paths outside the probe directory a command may read: tools and the null devices. */
const READABLE_SYSTEM_PREFIXES = [
  "/usr/",
  "/bin/",
  "/sbin/",
  "/opt/homebrew/",
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/stdin",
]

const SECRET_VARIABLE =
  /\$\{?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\}?/i

/** A segment as a command line without its redirects, arguments re-quoted. */
function withoutRedirects(segment: { head: string; args: readonly string[] }): string {
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)
  return [segment.head, ...segment.args].map(quote).join(" ")
}

function firstSub(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"))
}

function pathLikeTokens(args: readonly string[]): string[] {
  const out: string[] = []
  for (const arg of args) {
    const value = arg.includes("=") && arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg
    if (
      value.startsWith("/") ||
      value.startsWith("~") ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.split(/[\\/]/).includes("..")
    ) {
      out.push(value)
    }
  }
  return out
}

/** The shell policy for one command line in a probe with a working directory. */
export function decideProbeShellCommand(
  command: string,
  ctx: ProbePolicyContext
): ProbeToolDecision {
  if (!ctx.root)
    return refuse("This probe has no working directory; shell commands are not available.")
  if (SECRET_VARIABLE.test(command)) {
    return refuse("The command reads a credential from the environment.")
  }
  const whole = classifyCommand(command, { cwd: ctx.root, ...(ctx.home ? { home: ctx.home } : {}) })
  if (whole.verdict === "deny") return refuse(`Refused by the command classifier: ${whole.reason}.`)
  const segments = splitCommandSegments(command)
  for (const segment of segments) {
    const head = segment.head
    if (!head) continue
    if (SHELL_DENIED_HEADS.has(head)) {
      return refuse(
        `"${head}" acts outside this probe (remote access, privilege, services or other apps).`
      )
    }
    if (head === "env" && segment.args.length === 0) {
      return refuse("Listing the environment would expose credentials.")
    }
    if (ctx.networkOff && SHELL_NETWORK_HEADS.has(head)) {
      return refuse(`"${head}" reaches the network, which this probe policy cuts.`)
    }
    const sub = firstSub(segment.args)
    if (head === "git" && sub) {
      if (GIT_REMOTE_SUBCOMMANDS.has(sub)) {
        return refuse(`"git ${sub}" talks to a remote.`)
      }
      if (sub === "config" && segment.args.some((a) => a === "--global" || a === "--system")) {
        return refuse("Changing global git configuration acts outside this probe.")
      }
    }
    if (PACKAGE_MANAGERS.has(head) && sub) {
      if (PUBLISH_SUBCOMMANDS.has(sub)) return refuse(`"${head} ${sub}" changes registry state.`)
      if (segment.args.some((a) => a === "-g" || a === "--global" || a === "--user")) {
        return refuse(`"${head}" with a global flag installs outside this probe.`)
      }
      if ((head === "pip" || head === "pip3") && sub === "install") {
        return refuse("pip install writes outside this probe's directory.")
      }
      if (ctx.networkOff && (INSTALL_SUBCOMMANDS.has(sub) || head === "npx")) {
        return refuse(
          `"${head} ${sub}" downloads packages, and this probe policy cuts the network.`
        )
      }
    }
    const segmentVerdict = classifyCommand(segment.raw, {
      cwd: ctx.root,
      ...(ctx.home ? { home: ctx.home } : {}),
    })
    if (segmentVerdict.verdict === "deny") {
      return refuse(`Refused by the command classifier: ${segmentVerdict.reason}.`)
    }
    if (
      segmentVerdict.verdict === "ask" &&
      !LOCAL_MUTATION_HEADS.has(head) &&
      // An `ask` that only comes from a redirect is judged by the redirect check below.
      classifyCommand(withoutRedirects(segment), {
        cwd: ctx.root,
        ...(ctx.home ? { home: ctx.home } : {}),
      }).verdict !== "allow"
    ) {
      return refuse(
        `"${head}" has effects beyond this probe's directory (${segmentVerdict.reason}).`
      )
    }
    if ((head === "cd" || head === "pushd") && segment.args[0]) {
      const target = resolveProbePath(segment.args[0], ctx.root, ctx.home)
      if (!target || !isInsideRoot(target, ctx.root)) {
        return refuse(`"cd ${segment.args[0]}" leaves this probe's working directory.`)
      }
    }
    const writes = segmentVerdict.verdict === "ask"
    for (const token of pathLikeTokens(segment.args)) {
      const resolved = resolveProbePath(token, ctx.root, ctx.home)
      if (resolved && isInsideRoot(resolved, ctx.root)) continue
      const readable =
        !writes &&
        resolved !== undefined &&
        READABLE_SYSTEM_PREFIXES.some((p) => resolved.startsWith(p))
      if (!readable) return refuse(`"${token}" is outside this probe's working directory.`)
    }
    for (const redirect of segment.redirects) {
      if (redirect.duplicatesDescriptor || redirect.target === undefined) continue
      const resolved = resolveProbePath(redirect.target, ctx.root, ctx.home)
      if (resolved && isInsideRoot(resolved, ctx.root)) continue
      if (
        resolved &&
        READABLE_SYSTEM_PREFIXES.some((p) => p.startsWith("/dev/") && resolved === p)
      ) {
        continue
      }
      return refuse(`Redirect to "${redirect.target}" is outside this probe's working directory.`)
    }
  }
  return ALLOW
}

function shellCommandOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  return typeof record.command === "string" ? record.command : null
}

/**
 * Decide a call that reached the probe's permission responder. Fails closed:
 * a tool the policy does not know is refused, and the refusal is recorded as a
 * blocked action on the rollout's evidence.
 */
export function decideProbeToolCall(
  toolName: string,
  input: unknown,
  ctx: ProbePolicyContext
): ProbeToolDecision {
  const { server, bare } = splitProbeToolName(toolName)
  if (server && server !== BUILTIN_SERVER && server !== PLUGIN_SERVER && server !== A2UI_SERVER) {
    return ctx.allowedMcpServerNames.has(server)
      ? ALLOW
      : refuse(`MCP server "${server}" is not declared safe to probe.`)
  }
  if (server === A2UI_SERVER) {
    return PROBE_SESSION_TOOLS.has(bare) ? ALLOW : refuse(`"${bare}" acts outside this probe.`)
  }
  if (server === PLUGIN_SERVER) {
    if (!PROBE_ALLOWED_PLUGIN_TOOLS.has(bare)) {
      return refuse(
        `"${bare}" writes app state or acts outside this machine; probes do not run it.`
      )
    }
    if (ctx.networkOff && PROBE_WEB_TOOLS.includes(bare)) {
      return refuse(`"${bare}" reaches the network, which this probe policy cuts.`)
    }
    return ALLOW
  }
  if (PROBE_SESSION_TOOLS.has(bare)) return ALLOW
  if (PROBE_WEB_TOOLS.includes(bare)) {
    return ctx.networkOff
      ? refuse(`"${bare}" reaches the network, which this probe policy cuts.`)
      : ALLOW
  }
  if (PROBE_SHELL_TOOLS.has(bare)) {
    const command = shellCommandOf(input)
    if (command === null) return refuse("The shell call carries no command.")
    return decideProbeShellCommand(command, ctx)
  }
  if (PROBE_FILE_WRITE_TOOLS.has(bare)) {
    if (!ctx.root) {
      return refuse("This probe has no working directory; file writes are not available.")
    }
    const paths = pathsInToolInput(input)
    const patch = bare === "apply_patch" ? patchText(input) : null
    if (patch !== null) paths.push(...pathsInPatch(patch))
    if (paths.length === 0) return refuse(`"${bare}" names no path the probe policy can check.`)
    return checkPathsInRoot(paths, ctx)
  }
  if (PROBE_GIT_WRITE_TOOLS.has(bare)) {
    if (ctx.isolation !== "git" || !ctx.root) {
      return refuse("Git writes are only available in a probe's own worktree.")
    }
    return checkPathsInRoot(pathsInToolInput(input), ctx)
  }
  if (PROBE_FILE_READ_TOOLS.has(bare)) {
    if (!ctx.root)
      return refuse("This probe has no working directory; file access is not available.")
    return checkPathsInRoot(pathsInToolInput(input), ctx)
  }
  return refuse(`"${bare}" is not on the probe allowlist.`)
}
