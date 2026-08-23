import type {
  CapabilityGrant,
  ExternalCapability,
  ExternalServiceSurface,
  ServiceConnection,
} from "@/types/external-service"

export interface CapabilityAuthorizationContext {
  interactive: boolean
  surface?: ExternalServiceSurface
  accountId?: string
  workflowId?: string
  sessionId?: string
  resourceScopes?: Array<{ kind: string; value: string }>
  now?: string
}

export type CapabilityAuthorizationDecision =
  | { decision: "allow"; reason: "read-default" | "scoped-grant"; grantId?: string }
  | {
      decision: "ask"
      reason: "unknown-capability" | "write-confirmation" | "destructive-confirmation"
    }
  | {
      decision: "deny"
      reason:
        | "unknown-capability"
        | "connection-unavailable"
        | "surface-disabled"
        | "connection-mismatch"
        | "grant-required"
    }

function operationMatches(pattern: string, operationId: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith("*") && pattern.indexOf("*") === pattern.length - 1) {
    return operationId.startsWith(pattern.slice(0, -1))
  }
  return pattern === operationId
}

function grantMatches(
  grant: CapabilityGrant,
  capability: ExternalCapability,
  connection: ServiceConnection,
  context: CapabilityAuthorizationContext
): boolean {
  if (grant.connectionId !== connection.id) return false
  if (grant.providerFingerprint !== connection.providerFingerprint) return false
  const now = Date.parse(context.now ?? new Date().toISOString())
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) return false
  const operationId = capability.operationId ?? capability.capabilityId
  if (!grant.operationPatterns.some((pattern) => operationMatches(pattern, operationId))) {
    return false
  }
  if (grant.accountId && grant.accountId !== context.accountId) return false
  if (grant.workflowId && grant.workflowId !== context.workflowId) return false
  if (grant.sessionId && grant.sessionId !== context.sessionId) return false
  if (capability.risk === "destructive" && grant.allowDestructive !== true) return false

  const requestedScopes = context.resourceScopes ?? []
  if ((grant.resourceScopes?.length ?? 0) > 0 && requestedScopes.length === 0) return false
  for (const requested of requestedScopes) {
    const allowed = grant.resourceScopes?.find((scope) => scope.kind === requested.kind)
    if (!allowed?.values.includes(requested.value)) return false
  }
  return true
}

export function authorizeExternalCapability(input: {
  capability?: ExternalCapability
  connection: ServiceConnection
  grants: CapabilityGrant[]
  context: CapabilityAuthorizationContext
}): CapabilityAuthorizationDecision {
  const { capability, connection, grants, context } = input
  if (!capability) {
    return context.interactive
      ? { decision: "ask", reason: "unknown-capability" }
      : { decision: "deny", reason: "unknown-capability" }
  }
  if (connection.status !== "connected") {
    return { decision: "deny", reason: "connection-unavailable" }
  }
  if (
    capability.serviceId !== connection.serviceId ||
    capability.providerId !== connection.providerId
  ) {
    return { decision: "deny", reason: "connection-mismatch" }
  }
  if (context.surface && !connection.enabledSurfaces.includes(context.surface)) {
    return { decision: "deny", reason: "surface-disabled" }
  }
  if (capability.risk === "read") return { decision: "allow", reason: "read-default" }

  const matchingGrant = grants.find((grant) => grantMatches(grant, capability, connection, context))
  if (matchingGrant) {
    return { decision: "allow", reason: "scoped-grant", grantId: matchingGrant.id }
  }
  if (!context.interactive) return { decision: "deny", reason: "grant-required" }
  return capability.risk === "destructive"
    ? { decision: "ask", reason: "destructive-confirmation" }
    : { decision: "ask", reason: "write-confirmation" }
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value
  if (!pointer.startsWith("/")) return undefined
  let current = value
  for (const encoded of pointer.slice(1).split("/")) {
    if (!current || typeof current !== "object") return undefined
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~")
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function extractCapabilityResourceScopes(
  capability: ExternalCapability,
  args: unknown
): { ok: true; scopes: Array<{ kind: string; value: string }> } | { ok: false; reason: string } {
  const scopes: Array<{ kind: string; value: string }> = []
  for (const selector of capability.scopeSelectors ?? []) {
    const value = readJsonPointer(args, selector.jsonPointer)
    if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
      return { ok: false, reason: `Missing required resource scope "${selector.kind}"` }
    }
    scopes.push({ kind: selector.kind, value: String(value) })
  }
  return { ok: true, scopes }
}
