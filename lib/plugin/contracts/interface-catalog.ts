import {
  PLUGIN_API_NAMESPACE_CONTRACTS,
  type PluginApiMethodContract,
  type PluginApiNamespaceContract,
} from "@cognia/plugin-sdk/contracts"
import type { PluginPermission } from "@/types/plugin"

export type PluginApiRuntime = "frontend" | "hybrid" | "python" | "wasm" | "vscode"
export type PluginApiPlatform = "desktop" | "web" | "mobile" | "headless"

export interface EffectivePluginApiMethodContract extends PluginApiMethodContract {
  namespace: PluginApiNamespaceContract
}

export interface PluginApiPolicyDecision {
  allowed: boolean
  mode: "shadow" | "active"
  reason: "allowed" | "unmapped" | "runtime" | "platform" | "permission"
  missingPermissions: PluginPermission[]
  descriptor?: EffectivePluginApiMethodContract
}

export interface PluginApiAuditEvent {
  pluginId: string
  methodId: string
  outcome: "allowed" | "denied" | "error"
  durationMs: number
  dataClassification: PluginApiNamespaceContract["dataClassification"] | "unknown"
  errorCode?: string
}

const methods = new Map<string, EffectivePluginApiMethodContract>()
for (const namespace of PLUGIN_API_NAMESPACE_CONTRACTS) {
  for (const method of namespace.methods) {
    methods.set(method.id, { ...method, namespace })
  }
}

const auditListeners = new Set<(event: PluginApiAuditEvent) => void>()
const recentAuditEvents: PluginApiAuditEvent[] = []
const MAX_RECENT_AUDIT_EVENTS = 500

export function getPluginApiMethodContract(
  methodId: string
): EffectivePluginApiMethodContract | undefined {
  return methods.get(methodId)
}

export function listPluginApiMethodContracts(): readonly EffectivePluginApiMethodContract[] {
  return [...methods.values()]
}

export function evaluatePluginApiCall(input: {
  methodId: string
  runtime: PluginApiRuntime
  platform: PluginApiPlatform
  hasPermission: (permission: PluginPermission) => boolean
}): PluginApiPolicyDecision {
  const descriptor = methods.get(input.methodId)
  if (!descriptor) {
    return {
      allowed: false,
      mode: "active",
      reason: "unmapped",
      missingPermissions: [],
    }
  }
  const mode = descriptor.namespace.enforcement
  if (!descriptor.namespace.runtimes.includes(input.runtime)) {
    return { allowed: false, mode, reason: "runtime", missingPermissions: [], descriptor }
  }
  if (!descriptor.namespace.platforms.includes(input.platform)) {
    return { allowed: false, mode, reason: "platform", missingPermissions: [], descriptor }
  }
  const missingPermissions = descriptor.requiredPermissions.filter(
    (permission) => !input.hasPermission(permission as PluginPermission)
  ) as PluginPermission[]
  return {
    allowed: missingPermissions.length === 0,
    mode,
    reason: missingPermissions.length === 0 ? "allowed" : "permission",
    missingPermissions,
    descriptor,
  }
}

export function subscribePluginApiAudit(
  listener: (event: PluginApiAuditEvent) => void
): () => void {
  auditListeners.add(listener)
  return () => auditListeners.delete(listener)
}

export function getRecentPluginApiAuditEvents(): readonly PluginApiAuditEvent[] {
  return recentAuditEvents.map((event) => ({ ...event }))
}

export function clearPluginApiAuditEvents(): void {
  recentAuditEvents.length = 0
}

/** Records metadata only. Call arguments and return values are never accepted. */
export function recordPluginApiAudit(event: PluginApiAuditEvent): void {
  recentAuditEvents.push({ ...event })
  if (recentAuditEvents.length > MAX_RECENT_AUDIT_EVENTS) recentAuditEvents.shift()
  for (const listener of auditListeners) {
    try {
      listener(event)
    } catch {
      // Telemetry consumers must never change the result or error semantics of a plugin API call.
    }
  }
}
