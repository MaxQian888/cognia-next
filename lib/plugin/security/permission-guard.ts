/**
 * Plugin Permission Guard
 *
 * Runtime permission enforcement for plugin API calls.
 * Validates permissions before allowing access to protected APIs.
 */

import type { PluginPermission } from "@/types/plugin"

import { getPluginConsentBroker } from "./consent-broker"
import { pluginRuntimeAccountAvailable } from "./account-runtime-gate"

// =============================================================================
// Types
// =============================================================================

/**
 * Per-(plugin, permission) enforcement tier. Adopted from ADR-0020's
 * Computer Use 3-tier model.
 *
 *   - `silent`  — allow as long as the manifest declared the permission.
 *                 Backward-compat default for every existing grant.
 *   - `confirm` — require an interactive consent overlay each call,
 *                 unless the user has chosen "Always allow this session"
 *                 in the ConsentBroker.
 *   - `forbid`  — always deny, regardless of manifest declaration. Lets
 *                 the user keep a plugin installed but lock out a single
 *                 risky scope (e.g. clipboard:read).
 */
export type PluginPermissionTier = "silent" | "confirm" | "forbid"

export interface PermissionRequest {
  pluginId: string
  permission: PluginPermission
  reason?: string
  timestamp: number
}

export interface PermissionGrant {
  pluginId: string
  permission: PluginPermission
  grantedAt: number
  expiresAt?: number
  grantedBy: "manifest" | "user" | "system"
}

export interface PermissionDenial {
  pluginId: string
  permission: PluginPermission
  reason: string
  timestamp: number
}

export interface PermissionAuditEntry {
  pluginId: string
  permission: PluginPermission
  action: "check" | "grant" | "deny" | "revoke" | "request"
  allowed: boolean
  timestamp: number
  context?: string
}

export interface PermissionGuardConfig {
  strictMode: boolean
  auditEnabled: boolean
  maxAuditEntries: number
  allowRuntimeGrants: boolean
  defaultDenyMessage: string
  /**
   * When true, any `DANGEROUS_PERMISSIONS` a plugin declares are stamped with
   * the "confirm" tier at registration time, so they prompt for consent
   * instead of being silently allowed. Default false to preserve the
   * historical silent-grant behavior — opt in for a hardened posture (C4).
   */
  confirmDangerousByDefault: boolean
}

type PermissionRequestHandler = (request: PermissionRequest) => Promise<boolean>

// =============================================================================
// Permission Definitions
// =============================================================================

export const PERMISSION_GROUPS: Record<string, PluginPermission[]> = {
  filesystem: ["filesystem:read", "filesystem:write"],
  network: ["network:fetch", "network:upload", "network:websocket"],
  clipboard: ["clipboard:read", "clipboard:write"],
  selection: ["selection:read"],
  media: [
    "media:image:read",
    "media:image:write",
    "media:video:read",
    "media:video:write",
    "media:video:export",
  ],
  database: ["database:read", "database:write"],
  settings: ["settings:read", "settings:write"],
  session: ["session:read", "session:write"],
  terminal: [
    "terminal:spawn",
    "terminal:write",
    "terminal:kill",
    "terminal:completion",
    "terminal:safety",
  ],
  git: ["git:read", "git:write"],
  goal: ["goal:read", "goal:write"],
  plan: ["plan:read", "plan:write"],
  memory: ["memory:read", "memory:write"],
  team: ["team:read", "team:write"],
  connectors: ["connectors:read", "connectors:send", "connectors:manage"],
  share: ["share:read", "share:create"],
  backup: ["backup:read", "backup:write"],
  automation: [
    "automation:screenshot",
    "automation:read",
    "automation:click",
    "automation:type",
    "automation:pointer",
    "automation:window",
  ],
  companion: ["companion:read", "companion:control", "companion:goal-control"],
  observability: ["perf:read", "logs:read", "trace:read"],
  templates: [
    "templates:read",
    "templates:contribute",
    "templates:instantiate",
    "templates:library:write",
  ],
  commands: ["commands:read", "commands:write"],
  native: ["native:input", "native:screen", "native:filesystem", "native:process"],
  dangerous: [
    "shell:execute",
    "process:spawn",
    "python:execute",
    "terminal:spawn",
    "debug:control",
    "tests:run",
    "notebook:execute",
  ],
}

export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  "filesystem:read": "Read files from the file system",
  "filesystem:write": "Write files to the file system",
  "network:fetch": "Make HTTP/HTTPS requests",
  "network:upload": "Upload local file contents over HTTP/HTTPS",
  "network:websocket": "Establish WebSocket connections",
  "clipboard:read": "Read from the clipboard",
  "clipboard:write": "Write to the clipboard",
  "selection:read": "Read text you selected in another desktop application",
  notification: "Show system notifications",
  "shell:execute": "Execute shell commands",
  "process:spawn": "Spawn child processes",
  "database:read": "Read from the database",
  "database:write": "Write to the database",
  "settings:read": "Read application settings",
  "settings:write": "Modify application settings",
  "session:read": "Read chat sessions",
  "session:write": "Modify chat sessions",
  "session:delete": "Delete chat sessions",
  "project:read": "Read project metadata and files through scoped APIs",
  "project:write": "Create and modify projects, their knowledge files, tags, and linked sessions",
  "project:delete": "Delete projects",
  "canvas:read": "Read Canvas document metadata and selection",
  "canvas:write": "Create, modify, and delete Canvas documents",
  "canvas:run": "Run code blocks and actions inside Canvas documents",
  "canvas:collaborate": "Join and act in Canvas collaboration sessions",
  "artifact:read": "Read artifact metadata",
  "artifact:write": "Create and modify artifacts",
  "workflow:read": "Read workflow metadata and selection",
  "editor:read":
    "See what you are looking at in the project editor — the focused file, your selection, and its diagnostics",
  "editor:write": "Open files and reveal edits in the project editor",
  "debug:control": "Start, inspect, and control debug sessions",
  "tests:run": "Discover and run tests through the IDE",
  "notebook:execute": "Execute notebook cells and notebook kernels",
  "vector:read": "Search the vector store",
  "vector:write": "Add to and delete from the vector store",
  "ai:chat": "Send prompts to a language model on your account (consumes your quota)",
  "ai:embed": "Generate embeddings on your account (consumes your quota)",
  "export:session": "Export chat sessions out of the app",
  "export:project": "Export whole projects out of the app",
  "theme:read": "Read the active theme",
  "theme:write": "Change the active theme",
  "extension:ui": "Contribute trusted UI to host extension surfaces",
  "extension:workflow": "Contribute workflow nodes, triggers, tasks, and templates",
  "media:image:read": "Read image media assets",
  "media:image:write": "Write image media assets",
  "media:video:read": "Read video media assets",
  "media:video:write": "Write video media assets",
  "media:video:export": "Export rendered video outputs",
  "agent:control": "Control agent execution",
  "builtin-skills:invoke":
    "Invoke manifest-allowlisted built-in skills through the host policy gate",
  "agent:dispatch-external": "Dispatch external coding agents (Claude Code / Codex / …)",
  "agent:dispatch": "Dispatch built-in subagents and agent teams",
  "agent:shared-memory:read": "Read team shared-memory entries",
  "twin:read": "Query the employee twin's memory",
  "python:execute": "Execute Python code",
  "sandbox:web-execute": "Execute code inside the browser sandbox",
  "secrets:read": "Read secrets from the OS keyring",
  "secrets:write": "Store secrets in the OS keyring",
  "terminal:spawn": "Open a new terminal session in the integrated dock",
  "terminal:write": "Pipe input into an existing terminal session",
  "terminal:kill": "Terminate an existing terminal session",
  "terminal:completion": "Suggest terminal commands and read the line you are typing",
  "terminal:safety": "Add command-safety rules and check whether a command is safe to run",
  "git:read": "Read the active source-control repository (status, log, diff, branches)",
  "git:write": "Stage, commit, branch, push, stash, or discard changes in the active repository",
  "goal:read": "Read your goals and their progress",
  "goal:write": "Create, update, complete, and decompose your goals",
  "plan:read": "Read your agent plans, their steps, and their progress",
  "plan:write":
    "Create, edit, approve, run, pause, and replan agent plans (a plan can dispatch teammates, tools, and sub-workflows)",
  "memory:read": "Search and list what the assistant remembers about you",
  "memory:write":
    "Store, update, and forget long-term memories (PII-screened; can never change working instructions)",
  "team:read": "Read your agent teams, task boards, run events, and execution reports",
  "team:write":
    "Create/edit/assign tasks, comment, move cards, and manage non-lead teammates and team config on your agent-team boards",
  "subscription:read": "Read subscription plan and usage metrics",
  "perf:read": "Read performance dashboard snapshots and the live sample stream",
  "logs:read": "Read this app's local logs, their statistics, and transport health",
  "trace:read":
    "Read agent-trace spans — models, tokens, cost, timing, and (when you have content capture on) redacted prompt and response previews",
  "connectors:read":
    "List connector adapters, bots, and conversation bindings; observe inbound platform events",
  "connectors:send": "Send outbound messages through a connected platform (direct or queued)",
  "connectors:manage":
    "Create, reconfigure, enable, or delete your connected platform accounts; manage dispatch rules, chats, and contact lookups",
  "share:read": "Read your created public share links and their view stats",
  "share:create": "Create and revoke public share links (publishes data online)",
  "backup:read": "Build and read encrypted backups and the backup history",
  "backup:write": "Restore a backup, overwriting your local data",
  "automation:screenshot": "Capture screenshots of your desktop",
  "automation:read": "Read the on-screen UI tree, cursor position, and focused element",
  "automation:click": "Click and press mouse buttons on your desktop",
  "automation:type": "Type text and send keyboard input to your desktop",
  "automation:pointer": "Move, drag, and scroll the mouse on your desktop",
  "automation:window": "Focus, close, minimize, maximize, or resize desktop windows",
  "companion:read": "List paired devices and their remote-control grants",
  "companion:control": "Grant or revoke a paired device's remote-control capability",
  "companion:goal-control": "Pause, resume, or stop your running goal loops",
  "cli:execute": "Run an external command-line tool this plugin declares (e.g. ripgrep, ffmpeg)",
  "native:input": "Send native keyboard and mouse input through a native Anthropic tool",
  "native:screen": "Capture your screen through a native Anthropic tool",
  "native:filesystem": "Read and write files on this device through the sandboxed tools backend",
  "native:process": "Run programs on this device through the sandboxed tools backend",
  "ipc:call": "Call or send messages to another plugin over inter-plugin IPC (incl. RPC)",
  "ipc:expose": "Expose RPC methods that other plugins can invoke over IPC",
  "events:publish": "Emit events other plugins can listen for",
  "events:subscribe": "Listen for events other plugins emit",
  "auth:provide": "Register a native auth/OAuth provider other plugins can use",
  "auth:consume": "Consume sessions from a registered auth provider",
  "integrations:read": "Read Integration definitions, accounts, subscriptions, and job status",
  "integrations:events": "Publish normalized Integration events to workflows and Inbox",
  "integrations:execute": "Run Integration actions and authenticated platform requests",
  "integrations:manage": "Manage Integration accounts, subscriptions, ingress, and migrations",
  "pet:read": "Read the desktop pet's public state and subscribe to its events",
  "pet:interact": "Care for the desktop pet and grant budget-capped rewards",
  "hooks:chat-intercept":
    "Intercept every chat prompt, tool call, and tool result — can rewrite or block them",
  "templates:read": "Read the unified template catalog and validation results",
  "templates:contribute": "Register lifecycle-scoped template packages",
  "templates:instantiate": "Preflight and instantiate templates after confirmation",
  "templates:library:write": "Create user-owned template drafts after confirmation",
  "commands:read": "List the slash commands this app offers and read your custom command files",
  "commands:write":
    "Register slash commands, and create, overwrite or delete the markdown command files in .claude/commands and .cognia/commands",
}

/**
 * Back-compat aliases for permissions that were SPLIT out of a broader one.
 *
 * `session:delete` was carved out of `session:write`: before it existed,
 * `session:write` was what `ctx.session.deleteSession` / `deleteMessage`
 * required. Installed manifests cannot be rewritten on upgrade, so a plugin
 * that declared only `session:write` would start throwing at the first delete
 * — a silent break the user cannot diagnose or fix. Expanding the older, wider
 * declaration keeps those installs working exactly as they did, while new
 * plugins can declare `session:delete` alone to grant delete without write.
 *
 * Only add an entry here when a permission is genuinely narrowed out of an
 * existing one; this is a compatibility shim, not a convenience table.
 */
const LEGACY_PERMISSION_IMPLICATIONS: Partial<Record<PluginPermission, PluginPermission[]>> = {
  "session:write": ["session:delete"],
}

/** Declared permissions plus anything an older, wider declaration implies. */
export function expandLegacyPermissions(
  permissions: readonly PluginPermission[]
): PluginPermission[] {
  const expanded = new Set<PluginPermission>(permissions)
  for (const permission of permissions) {
    for (const implied of LEGACY_PERMISSION_IMPLICATIONS[permission] ?? []) {
      expanded.add(implied)
    }
  }
  return [...expanded]
}

export const DANGEROUS_PERMISSIONS: PluginPermission[] = [
  // Desktop selections can contain passwords, private messages, or document
  // fragments. A plugin must receive per-call consent before reading them.
  "selection:read",
  // Chat interception sees (and can rewrite) everything the user and the
  // model exchange, including tool inputs/outputs — surveillance-grade.
  "hooks:chat-intercept",
  "shell:execute",
  "process:spawn",
  "python:execute",
  "debug:control",
  "tests:run",
  "notebook:execute",
  "filesystem:write",
  "secrets:write",
  // Network egress reaches any host and can carry whatever the plugin can read
  // (secrets, clipboard, fs) off-device — an unrecallable exfiltration channel.
  // Gate it behind consent instead of granting it silently on enable.
  "network:fetch",
  "network:upload",
  "network:websocket",
  // Dispatching an external coding agent spawns an outside process that can
  // read/edit files and run commands — same risk tier as `process:spawn`.
  "agent:dispatch-external",
  "terminal:spawn",
  // Wave 3 — writing to an existing terminal session is equivalent to
  // executing arbitrary shell commands in that shell, so it sits in
  // the same risk tier as `shell:execute` and `terminal:spawn`.
  "terminal:write",
  // Mutating the repository can rewrite history, force-push, or discard
  // working-tree changes — destructive and hard to undo. Reads stay safe.
  "git:write",
  // Sending outbound messages reaches real people on real platforms (IM,
  // email, …) — outward-facing and unrecallable. Same tier as shell exec.
  "connectors:send",
  // Managing adapter instances can re-point, disable, or delete the user's
  // live IM/email connections (e.g. silently swap a bot's routing or drop a
  // configured channel) — config-destructive and affects real delivery.
  "connectors:manage",
  // Creating a public share link publishes (encrypted) data to an external
  // worker — outward-facing data egress; the user should consent.
  "share:create",
  // Restoring a backup overwrites the local database — destructive and not
  // reversible from inside the app.
  "backup:write",
  // Driving the real desktop — reading the screen (a11y tree / screenshots)
  // exposes everything on screen, and click/type/pointer/window can take any
  // action the user could. The whole automation surface is consent-worthy.
  "automation:screenshot",
  "automation:read",
  "automation:click",
  "automation:type",
  "automation:pointer",
  "automation:window",
  // Granting a paired device remote-control capability lets that device drive
  // the host — same outward-facing risk tier as enabling remote access.
  // (`companion:goal-control` is NOT dangerous: it is a strict subset of the
  // non-dangerous `goal:write` — pause/resume/stop only.)
  "companion:control",
  // Running a declared external CLI executes a real process with the user's
  // privileges — argv templating prevents injection but the binary itself can
  // do anything (`shell:execute` risk tier).
  "cli:execute",
  // A custom command file is a prompt the user runs by name, and its
  // front matter carries `allowed-tools` — so writing one both puts text in
  // front of the model and can widen the tool surface of every later run of
  // that command. It also writes to `~/.claude/commands`, outside any
  // workspace root. Same tier as `filesystem:write`.
  //
  // The two in-memory methods (`registerSlashCommand` / `unregisterSlashCommand`)
  // are `consentExempt` in `commands-api.ts`: they touch no disk, are undone on
  // unload, and run during `activate()` where a modal would deadlock the
  // enable. The disk writes are the consent-worthy half, and they prompt.
  "commands:write",
]

/**
 * WASM host capabilities declared in the WIT contract but with no real backend
 * in the current api-version. The install-time grant sheet renders these
 * disabled with a hint and never adds them to the granted set, so a user is not
 * misled into believing a stubbed capability works.
 *
 * **Empty as of api-version 0.2.** Every capability the v0.2 contract declares
 * now has a backend: clipboard and notifications are served in-process by the
 * Tauri plugins, and `ai.generate-text` / `workflow.emit-event` go through the
 * renderer bridge (`lib/plugin/wasm-bridge/`). Leaving `clipboard:read` /
 * `clipboard:write` listed here would be worse than cosmetic — the grant sheet
 * would render the now-working clipboard permissions permanently disabled and
 * never grant them, so the host capability would be implemented in Rust and
 * unreachable in practice.
 *
 * Note also that `ai.generate-text` no longer rides `network:fetch`: v0.2 gates
 * it on the canonical `ai:chat` capability, because spending the user's model
 * quota is a separate consent decision from raw outbound HTTP. `workflow`
 * likewise moved from ungated to `extension:workflow`.
 *
 * Keep the constant rather than deleting it: a future api-version that adds a
 * declared-but-unbacked capability needs this list again, and the grant-sheet
 * wiring is the awkward part to reconstruct.
 */
export const WASM_UNIMPLEMENTED_PERMISSIONS: PluginPermission[] = []

// =============================================================================
// Permission Guard
// =============================================================================

export class PermissionGuard {
  private config: PermissionGuardConfig
  private grants: Map<string, Map<PluginPermission, PermissionGrant>> = new Map()
  private denials: Map<string, PermissionDenial[]> = new Map()
  private auditLog: PermissionAuditEntry[] = []
  private requestHandler: PermissionRequestHandler | null = null
  private pendingRequests: Map<string, Promise<boolean>> = new Map()
  /**
   * Tier overlay (ADR-0020 model). Missing rows default to "silent"
   * (the historic behavior). Keyed by `pluginId → permission → tier`.
   */
  private tiers: Map<string, Map<PluginPermission, PluginPermissionTier>> = new Map()
  private tierListeners: Set<
    (pluginId: string, permission: PluginPermission, tier: PluginPermissionTier) => void
  > = new Set()

  constructor(config: Partial<PermissionGuardConfig> = {}) {
    this.config = {
      strictMode: true,
      auditEnabled: true,
      maxAuditEntries: 1000,
      allowRuntimeGrants: true,
      defaultDenyMessage: "Permission denied",
      // Secure by default: declared dangerous permissions register at the
      // "confirm" tier so they prompt for per-call consent (with a session
      // grant cache) instead of being silently granted. Hosts/tests can pass
      // `false` to restore the historic silent-grant posture.
      confirmDangerousByDefault: true,
      ...config,
    }
  }

  // ===========================================================================
  // Plugin Registration
  // ===========================================================================

  registerPlugin(pluginId: string, permissions: PluginPermission[]): void {
    const grantMap = new Map<PluginPermission, PermissionGrant>()
    const effective = expandLegacyPermissions(permissions)

    for (const permission of effective) {
      grantMap.set(permission, {
        pluginId,
        permission,
        grantedAt: Date.now(),
        grantedBy: "manifest",
      })
    }

    this.grants.set(pluginId, grantMap)
    this.denials.set(pluginId, [])

    // Hardened posture (opt-in): force declared dangerous permissions to the
    // "confirm" tier so they prompt rather than being implicitly silent.
    if (this.config.confirmDangerousByDefault) {
      const tierRow = new Map<PluginPermission, PluginPermissionTier>()
      for (const permission of effective) {
        if (DANGEROUS_PERMISSIONS.includes(permission)) {
          tierRow.set(permission, "confirm")
        }
      }
      if (tierRow.size > 0) this.tiers.set(pluginId, tierRow)
    }
  }

  unregisterPlugin(pluginId: string): void {
    this.grants.delete(pluginId)
    this.denials.delete(pluginId)
    this.tiers.delete(pluginId)
  }

  // ===========================================================================
  // Permission Tier (ADR-0020 3-tier model)
  // ===========================================================================

  /**
   * Read the tier configured for (pluginId, permission). Returns "silent"
   * for any (plugin, permission) that has not been explicitly tiered —
   * the historical implicit-grant behavior.
   */
  getTier(pluginId: string, permission: PluginPermission): PluginPermissionTier {
    return this.tiers.get(pluginId)?.get(permission) ?? "silent"
  }

  /**
   * Set the tier for one (pluginId, permission). Notifies subscribers so
   * the permission-review UI can react.
   */
  setTier(pluginId: string, permission: PluginPermission, tier: PluginPermissionTier): void {
    let row = this.tiers.get(pluginId)
    if (!row) {
      row = new Map()
      this.tiers.set(pluginId, row)
    }
    row.set(permission, tier)
    for (const listener of this.tierListeners) {
      try {
        listener(pluginId, permission, tier)
      } catch {
        // Never let a listener crash the guard.
      }
    }
  }

  /**
   * Return every non-default tier row for `pluginId`. Empty array if the
   * plugin has no overrides (everything defaults to "silent").
   */
  getTiersForPlugin(pluginId: string): Array<{
    permission: PluginPermission
    tier: PluginPermissionTier
  }> {
    const row = this.tiers.get(pluginId)
    if (!row) return []
    return Array.from(row.entries()).map(([permission, tier]) => ({ permission, tier }))
  }

  /**
   * Subscribe to tier changes — returns a disposer.
   */
  subscribeTierChanges(
    listener: (pluginId: string, permission: PluginPermission, tier: PluginPermissionTier) => void
  ): () => void {
    this.tierListeners.add(listener)
    return () => {
      this.tierListeners.delete(listener)
    }
  }

  /**
   * Tier-aware async permission check. Use this from API call sites
   * that should respect the user's per-permission tier override.
   *
   *   - `forbid`  → resolves `false` immediately, audits as deny.
   *   - `silent`  → resolves the existing sync `check()` result.
   *   - `confirm` → goes through the per-call consent overlay via the
   *                 supplied broker. The user's response is honored
   *                 once; a "Always allow this session" response is
   *                 cached by the broker so repeated calls skip the UI.
   *
   * The broker is injected so tests can stub it. Production callers
   * pass `getPluginConsentBroker()` from
   * `lib/plugin/security/consent-broker.ts`.
   */
  async checkWithConsent(
    pluginId: string,
    permission: PluginPermission,
    broker: {
      request: (req: {
        pluginId: string
        permission: PluginPermission
        reason?: string
      }) => Promise<boolean>
    },
    options: { reason?: string; context?: string } = {}
  ): Promise<boolean> {
    const tier = this.getTier(pluginId, permission)
    if (tier === "forbid") {
      this.audit(pluginId, permission, "deny", false, options.context)
      return false
    }
    if (tier === "silent") {
      return this.check(pluginId, permission, options.context)
    }
    // tier === "confirm" — defer to the broker. Audit the request so
    // the plugin author + user can see what's being asked.
    this.audit(pluginId, permission, "request", false, options.context)
    const allowed = await broker.request({ pluginId, permission, reason: options.reason })
    this.audit(pluginId, permission, allowed ? "grant" : "deny", allowed, options.context)
    return allowed
  }

  // ===========================================================================
  // Permission Checking
  // ===========================================================================

  check(pluginId: string, permission: PluginPermission, context?: string): boolean {
    if (!pluginRuntimeAccountAvailable()) {
      this.audit(pluginId, permission, "check", false, context)
      return false
    }
    const grant = this.grants.get(pluginId)?.get(permission)
    const allowed = this.isGrantValid(grant)

    this.audit(pluginId, permission, "check", allowed, context)

    return allowed
  }

  /** Append an already-authorized, non-decision usage event to the audit log. */
  recordUsage(pluginId: string, permission: PluginPermission, context?: string): void {
    this.audit(pluginId, permission, "check", true, context)
  }

  checkMultiple(pluginId: string, permissions: PluginPermission[]): boolean {
    return permissions.every((p) => this.check(pluginId, p))
  }

  checkAny(pluginId: string, permissions: PluginPermission[]): boolean {
    return permissions.some((p) => this.check(pluginId, p))
  }

  require(pluginId: string, permission: PluginPermission, context?: string): void {
    if (!this.check(pluginId, permission, context)) {
      const message = this.getDenialMessage(pluginId, permission)
      throw new PermissionError(message, pluginId, permission)
    }
  }

  requireMultiple(pluginId: string, permissions: PluginPermission[]): void {
    for (const permission of permissions) {
      this.require(pluginId, permission)
    }
  }

  private isGrantValid(grant?: PermissionGrant): boolean {
    if (!grant) return false
    if (grant.expiresAt && Date.now() > grant.expiresAt) return false
    return true
  }

  // ===========================================================================
  // Permission Granting
  // ===========================================================================

  grant(
    pluginId: string,
    permission: PluginPermission,
    options: {
      grantedBy?: "manifest" | "user" | "system"
      expiresIn?: number
    } = {}
  ): void {
    if (!this.config.allowRuntimeGrants && options.grantedBy !== "manifest") {
      throw new Error("Runtime permission grants are disabled")
    }

    let grantMap = this.grants.get(pluginId)
    if (!grantMap) {
      grantMap = new Map()
      this.grants.set(pluginId, grantMap)
    }

    grantMap.set(permission, {
      pluginId,
      permission,
      grantedAt: Date.now(),
      expiresAt: options.expiresIn ? Date.now() + options.expiresIn : undefined,
      grantedBy: options.grantedBy || "system",
    })

    this.audit(pluginId, permission, "grant", true)
  }

  grantMultiple(pluginId: string, permissions: PluginPermission[]): void {
    for (const permission of permissions) {
      this.grant(pluginId, permission)
    }
  }

  // ===========================================================================
  // Permission Revocation
  // ===========================================================================

  revoke(pluginId: string, permission: PluginPermission): void {
    this.grants.get(pluginId)?.delete(permission)
    this.audit(pluginId, permission, "revoke", false)
  }

  revokeMultiple(pluginId: string, permissions: PluginPermission[]): void {
    for (const permission of permissions) {
      this.revoke(pluginId, permission)
    }
  }

  revokeAll(pluginId: string): void {
    const grantMap = this.grants.get(pluginId)
    if (grantMap) {
      for (const permission of grantMap.keys()) {
        this.audit(pluginId, permission, "revoke", false)
      }
      grantMap.clear()
    }
  }

  // ===========================================================================
  // Permission Requests
  // ===========================================================================

  setRequestHandler(handler: PermissionRequestHandler): void {
    this.requestHandler = handler
  }

  async request(pluginId: string, permission: PluginPermission, reason?: string): Promise<boolean> {
    // Check if already granted
    if (this.check(pluginId, permission)) {
      return true
    }

    // Check for pending request
    const pendingKey = `${pluginId}:${permission}`
    const pending = this.pendingRequests.get(pendingKey)
    if (pending) {
      return pending
    }

    // No handler means automatic denial
    if (!this.requestHandler) {
      this.deny(pluginId, permission, "No permission handler configured")
      return false
    }

    // Create request
    const request: PermissionRequest = {
      pluginId,
      permission,
      reason,
      timestamp: Date.now(),
    }

    this.audit(pluginId, permission, "request", false)

    // Execute request handler
    const requestPromise = this.requestHandler(request).then((granted) => {
      this.pendingRequests.delete(pendingKey)

      if (granted) {
        this.grant(pluginId, permission, { grantedBy: "user" })
      } else {
        this.deny(pluginId, permission, "User denied permission request")
      }

      return granted
    })

    this.pendingRequests.set(pendingKey, requestPromise)
    return requestPromise
  }

  private deny(pluginId: string, permission: PluginPermission, reason: string): void {
    let denialList = this.denials.get(pluginId)
    if (!denialList) {
      denialList = []
      this.denials.set(pluginId, denialList)
    }

    denialList.push({
      pluginId,
      permission,
      reason,
      timestamp: Date.now(),
    })

    // Keep only last 50 denials per plugin
    if (denialList.length > 50) {
      this.denials.set(pluginId, denialList.slice(-50))
    }

    this.audit(pluginId, permission, "deny", false)
  }

  private getDenialMessage(pluginId: string, permission: PluginPermission): string {
    const denials = this.denials.get(pluginId) || []
    const lastDenial = denials.find((d) => d.permission === permission)

    if (lastDenial) {
      return lastDenial.reason
    }

    return `${this.config.defaultDenyMessage}: ${permission}`
  }

  // ===========================================================================
  // Audit Logging
  // ===========================================================================

  private audit(
    pluginId: string,
    permission: PluginPermission,
    action: PermissionAuditEntry["action"],
    allowed: boolean,
    context?: string
  ): void {
    if (!this.config.auditEnabled) return

    this.auditLog.push({
      pluginId,
      permission,
      action,
      allowed,
      timestamp: Date.now(),
      context,
    })

    if (this.auditLog.length > this.config.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this.config.maxAuditEntries)
    }
  }

  getAuditLog(options?: {
    pluginId?: string
    permission?: PluginPermission
    action?: PermissionAuditEntry["action"]
    since?: number
    limit?: number
  }): PermissionAuditEntry[] {
    let entries = [...this.auditLog]

    if (options?.pluginId) {
      entries = entries.filter((e) => e.pluginId === options.pluginId)
    }

    if (options?.permission) {
      entries = entries.filter((e) => e.permission === options.permission)
    }

    if (options?.action) {
      entries = entries.filter((e) => e.action === options.action)
    }

    if (options?.since !== undefined) {
      const since = options.since
      entries = entries.filter((e) => e.timestamp >= since)
    }

    if (options?.limit) {
      entries = entries.slice(-options.limit)
    }

    return entries
  }

  clearAuditLog(): void {
    this.auditLog = []
  }

  // ===========================================================================
  // Introspection
  // ===========================================================================

  getPluginPermissions(pluginId: string): PluginPermission[] {
    const grantMap = this.grants.get(pluginId)
    if (!grantMap) return []

    return Array.from(grantMap.entries())
      .filter(([_, grant]) => this.isGrantValid(grant))
      .map(([permission]) => permission)
  }

  getPluginGrants(pluginId: string): PermissionGrant[] {
    const grantMap = this.grants.get(pluginId)
    if (!grantMap) return []

    return Array.from(grantMap.values()).filter((grant) => this.isGrantValid(grant))
  }

  getPluginDenials(pluginId: string): PermissionDenial[] {
    return this.denials.get(pluginId) || []
  }

  getAllPluginsWithPermission(permission: PluginPermission): string[] {
    const plugins: string[] = []

    for (const [pluginId, grantMap] of this.grants.entries()) {
      const grant = grantMap.get(permission)
      if (this.isGrantValid(grant)) {
        plugins.push(pluginId)
      }
    }

    return plugins
  }

  isDangerousPermission(permission: PluginPermission): boolean {
    return DANGEROUS_PERMISSIONS.includes(permission)
  }

  getPermissionDescription(permission: PluginPermission): string {
    return PERMISSION_DESCRIPTIONS[permission] || permission
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  clear(): void {
    this.grants.clear()
    this.denials.clear()
    this.auditLog = []
    this.pendingRequests.clear()
    this.tiers.clear()
    this.tierListeners.clear()
  }
}

// =============================================================================
// Permission Error
// =============================================================================

export class PermissionError extends Error {
  public readonly pluginId: string
  public readonly permission: PluginPermission

  constructor(message: string, pluginId: string, permission: PluginPermission) {
    super(message)
    this.name = "PermissionError"
    this.pluginId = pluginId
    this.permission = permission
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let permissionGuardInstance: PermissionGuard | null = null

export function getPermissionGuard(config?: Partial<PermissionGuardConfig>): PermissionGuard {
  if (!permissionGuardInstance) {
    permissionGuardInstance = new PermissionGuard(config)
  }
  return permissionGuardInstance
}

/**
 * Build a fresh `PermissionGuard` without touching the module-level
 * default instance. PR-E added this so tests / dev-mode can compare
 * grant decisions across isolated guards (e.g. preview a different
 * tier overlay before applying it). The class constructor already
 * accepts the full config — this wrapper exists so callers reading
 * the code see "factory" instead of `new`.
 */
export function createPermissionGuard(config?: Partial<PermissionGuardConfig>): PermissionGuard {
  return new PermissionGuard(config)
}

export function resetPermissionGuard(): void {
  if (permissionGuardInstance) {
    permissionGuardInstance.clear()
    permissionGuardInstance = null
  }
}

/**
 * Test-only alias for `resetPermissionGuard` that throws outside the
 * test runner. Mirrors the `__resetForTesting` convention from
 * `lib/plugin/registries/createOverlayRegistry.ts:74` so suites can
 * grep for one name across all the singletons.
 */
export function __resetPermissionGuardForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetPermissionGuardForTesting is only callable in NODE_ENV=test")
  }
  resetPermissionGuard()
}

// =============================================================================
// API Wrapper Factory
// =============================================================================

export function createGuardedAPI<T extends object>(
  pluginId: string,
  api: T,
  permissionMap: Partial<Record<keyof T, PluginPermission | PluginPermission[]>>,
  options: {
    /**
     * Method names that must NOT route through the async per-call consent
     * overlay even when their permission sits at the "confirm" tier. Use for
     * *synchronous* query / subscribe / pure-helper methods that happen to
     * share a dangerous permission with an async action (e.g. the terminal
     * API gates `list` / `onData` / `detectScriptType` with `terminal:spawn`,
     * but only the actual `spawn` is a consent-worthy action). Exempt methods
     * still require the granted permission — they just skip the prompt.
     */
    consentExempt?: ReadonlyArray<keyof T>
    /**
     * Method names intentionally NOT permission-gated — pure helpers or
     * non-security methods. Listing them is REQUIRED: a function property that
     * is neither in `permissionMap` nor here fails closed (throws on call)
     * rather than silently passing through ungated, so a method added to the
     * API without updating the map can't drift into being unprotected.
     * Non-function properties always pass through unchanged.
     */
    unguarded?: ReadonlyArray<keyof T>
    /**
     * Invoked once per permission immediately after a "confirm"-tier consent
     * resolves *allowed*, before the underlying method runs. Host-gated
     * namespaces (the native fs/secrets/clipboard/network gateway) use this to
     * persist a ledger grant so the follow-up `plugin_api_invoke` — and future
     * calls — pass the independent Rust permission gate. Silent-tier methods
     * never reach the consent path, so the hook never fires for them. Errors
     * thrown by the hook are swallowed (it must never break the guarded call).
     */
    onConsentGranted?: (permission: PluginPermission) => void
  } = {}
): T {
  const guard = getPermissionGuard()
  const consentExempt = new Set<keyof T>(options.consentExempt ?? [])
  const unguarded = new Set<keyof T>(options.unguarded ?? [])

  return new Proxy(api, {
    get(target, prop: string | symbol) {
      const value = target[prop as keyof T]

      if (typeof value !== "function") {
        return value
      }

      const requiredPermissions = permissionMap[prop as keyof T]
      if (!requiredPermissions) {
        // Explicitly unguarded helper → pass through. Otherwise fail closed.
        if (unguarded.has(prop as keyof T)) {
          return value
        }
        return () => {
          throw new PermissionError(
            `Method "${String(prop)}" on plugin "${pluginId}" is neither permission-mapped nor declared unguarded; refusing to call it.`,
            pluginId,
            "" as PluginPermission
          )
        }
      }

      return (...args: unknown[]) => {
        const permissions = Array.isArray(requiredPermissions)
          ? requiredPermissions
          : [requiredPermissions]
        const context = `API call: ${String(prop)}`

        // Fast path — keep the historic synchronous gate when (a) this method
        // is consent-exempt (a sync query/helper), or (b) no required
        // permission sits at the "confirm" tier. This preserves sync-returning
        // guarded methods; the async consent path below is only taken by
        // async action methods.
        const needsConsent =
          !consentExempt.has(prop as keyof T) &&
          permissions.some((permission) => guard.getTier(pluginId, permission) === "confirm")
        if (!needsConsent) {
          for (const permission of permissions) {
            guard.require(pluginId, permission, context)
          }
          return (value as (...args: unknown[]) => unknown).apply(target, args)
        }

        // Consent path — at least one permission needs the per-call overlay.
        // Hard-require the grant first (throws if missing/revoked), then defer
        // each "confirm"-tier permission to the consent broker; a denied or
        // timed-out prompt rejects the call.
        return (async () => {
          const broker = getPluginConsentBroker()
          for (const permission of permissions) {
            guard.require(pluginId, permission, context)
            if (guard.getTier(pluginId, permission) !== "confirm") continue
            const allowed = await guard.checkWithConsent(pluginId, permission, broker, {
              reason: context,
              context,
            })
            if (!allowed) {
              throw new PermissionError(
                `Consent denied for permission "${permission}"`,
                pluginId,
                permission
              )
            }
            if (options.onConsentGranted) {
              try {
                options.onConsentGranted(permission)
              } catch {
                // The hook is best-effort (e.g. persisting a host ledger grant);
                // never let it break the guarded call after consent succeeded.
              }
            }
          }
          return (value as (...args: unknown[]) => unknown).apply(target, args)
        })()
      }
    },
  })
}
