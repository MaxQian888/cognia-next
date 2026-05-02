/**
 * Plugin Permission Guard
 *
 * Runtime permission enforcement for plugin API calls.
 * Validates permissions before allowing access to protected APIs.
 */

import type { PluginPermission } from "@/types/plugin"

// =============================================================================
// Types
// =============================================================================

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
  dangerous: ["shell:execute", "process:spawn", "python:execute"],
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
  "python:execute": "Execute Python code",
  "sandbox:web-execute": "Execute code inside the browser sandbox",
}

export const DANGEROUS_PERMISSIONS: PluginPermission[] = [
  "shell:execute",
  "process:spawn",
  "python:execute",
  "filesystem:write",
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

  constructor(config: Partial<PermissionGuardConfig> = {}) {
    this.config = {
      strictMode: true,
      auditEnabled: true,
      maxAuditEntries: 1000,
      allowRuntimeGrants: true,
      defaultDenyMessage: "Permission denied",
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
  }

  unregisterPlugin(pluginId: string): void {
    this.grants.delete(pluginId)
    this.denials.delete(pluginId)
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

export function resetPermissionGuard(): void {
  if (permissionGuardInstance) {
    permissionGuardInstance.clear()
    permissionGuardInstance = null
  }
}

// =============================================================================
// API Wrapper Factory
// =============================================================================

export function createGuardedAPI<T extends object>(
  pluginId: string,
  api: T,
  permissionMap: Partial<Record<keyof T, PluginPermission | PluginPermission[]>>
): T {
  const guard = getPermissionGuard()

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

        for (const permission of permissions) {
          guard.require(pluginId, permission, `API call: ${String(prop)}`)
        }

        return (value as (...args: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}
