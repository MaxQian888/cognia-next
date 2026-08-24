import {
  PLUGIN_API_NAMESPACE_CONTRACTS,
  type PluginApiMethodContract,
  type PluginApiNamespaceContract,
} from "@cognia/plugin-sdk/contracts"
import type { PluginPermission } from "@/types/plugin"

export type PluginApiRuntime = "frontend" | "hybrid" | "python" | "wasm" | "vscode"

/**
 * Classify a plugin's manifest type as the runtime the API catalog reasons in.
 *
 * These are two vocabularies for the same thing and they agree everywhere but
 * one spelling, so the mapping lives here — beside the union — rather than at
 * the call site, where a new plugin type could be added without anyone
 * noticing the catalog still classifies it as `frontend`.
 */
export function pluginApiRuntimeForType(type: string | undefined): PluginApiRuntime {
  switch (type) {
    case "python":
      return "python"
    case "hybrid":
      return "hybrid"
    case "wasm":
      return "wasm"
    case "vscode-extension":
      return "vscode"
    default:
      return "frontend"
  }
}
export type PluginApiPlatform = "desktop" | "web" | "mobile" | "headless"

export interface EffectivePluginApiMethodContract extends PluginApiMethodContract {
  namespace: PluginApiNamespaceContract
}

interface PluginApiPolicyDecisionBase {
  mode: "shadow" | "active"
  missingPermissions: PluginPermission[]
  descriptor?: EffectivePluginApiMethodContract
}

export type PluginApiPolicyDecision =
  | (PluginApiPolicyDecisionBase & { allowed: true; reason: "allowed" })
  | (PluginApiPolicyDecisionBase & {
      allowed: false
      reason: "unmapped" | "runtime" | "platform" | "permission"
    })

export interface PluginApiAuditEvent {
  pluginId: string
  methodId: string
  /**
   * Runtime the call came from. Load-bearing rather than decorative: it is one
   * of the axes `evaluatePluginApiCall` gates on, so an audit record without it
   * cannot explain its own `denied` verdict — and consumers cannot tell an
   * in-renderer call apart from one that crossed a process boundary.
   */
  runtime: PluginApiRuntime
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
  if (missingPermissions.length === 0) {
    return { allowed: true, mode, reason: "allowed", missingPermissions, descriptor }
  }
  return { allowed: false, mode, reason: "permission", missingPermissions, descriptor }
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
