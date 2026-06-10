/**
 * Plugin Permission Guard
 *
 * Runtime permission enforcement for plugin API calls.
 * Validates permissions before allowing access to protected APIs.
 */

import type { PluginPermission } from "@/types/plugin"

import { getPluginConsentBroker } from "./consent-broker"

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
  network: ["network:fetch", "network:websocket"],
  clipboard: ["clipboard:read", "clipboard:write"],
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
  native: ["native:input", "native:screen"],
  dangerous: ["shell:execute", "process:spawn", "python:execute", "terminal:spawn"],
}

export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  "filesystem:read": "Read files from the file system",
  "filesystem:write": "Write files to the file system",
  "network:fetch": "Make HTTP/HTTPS requests",
  "network:websocket": "Establish WebSocket connections",
  "clipboard:read": "Read from the clipboard",
  "clipboard:write": "Write to the clipboard",
  notification: "Show system notifications",
  "shell:execute": "Execute shell commands",
  "process:spawn": "Spawn child processes",
  "database:read": "Read from the database",
  "database:write": "Write to the database",
  "settings:read": "Read application settings",
  "settings:write": "Modify application settings",
  "session:read": "Read chat sessions",
  "session:write": "Modify chat sessions",
  "media:image:read": "Read image media assets",
  "media:image:write": "Write image media assets",
  "media:video:read": "Read video media assets",
  "media:video:write": "Write video media assets",
  "media:video:export": "Export rendered video outputs",
  "agent:control": "Control agent execution",
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
  "subscription:read": "Read subscription plan and usage metrics",
  "perf:read": "Read performance dashboard snapshots and the live sample stream",
  "connectors:read": "List connector adapters and observe inbound platform events",
  "connectors:send": "Send outbound messages through a connected platform",
  "connectors:manage": "Create, reconfigure, enable, or delete your connected platform accounts",
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
}

export const DANGEROUS_PERMISSIONS: PluginPermission[] = [
  "shell:execute",
  "process:spawn",
  "python:execute",
  "filesystem:write",
  "secrets:write",
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
]

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

    for (const permission of permissions) {
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
      for (const permission of permissions) {
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
    const grant = this.grants.get(pluginId)?.get(permission)
    const allowed = this.isGrantValid(grant)

    this.audit(pluginId, permission, "check", allowed, context)

    return allowed
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
  } = {}
): T {
  const guard = getPermissionGuard()
  const consentExempt = new Set<keyof T>(options.consentExempt ?? [])

  return new Proxy(api, {
    get(target, prop: string | symbol) {
      const value = target[prop as keyof T]

      if (typeof value !== "function") {
        return value
      }

      const requiredPermissions = permissionMap[prop as keyof T]
      if (!requiredPermissions) {
        return value
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
          }
          return (value as (...args: unknown[]) => unknown).apply(target, args)
        })()
      }
    },
  })
}
