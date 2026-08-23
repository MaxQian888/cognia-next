export type ExternalServiceSurface = "chat" | "workflow" | "inbox"
export type ExternalServiceRisk = "read" | "write" | "destructive"
export type ExternalCapabilityKind =
  "tool" | "action" | "resource" | "prompt" | "event" | "task" | "ui"

export type JsonSchema = Record<string, unknown>

export interface ExternalCapability {
  pluginId: string
  serviceId: string
  providerId: string
  capabilityId: string
  /** Stable semantic identity required before two providers may substitute for one another. */
  operationId?: string
  kind: ExternalCapabilityKind
  risk: ExternalServiceRisk
  /** False means the host assigned fail-closed defaults to an undisclosed capability. */
  policyKnown?: boolean
  inputSchema?: JsonSchema
  outputSchema?: JsonSchema
  /** Host-extracted resource identifiers used to constrain durable grants. */
  scopeSelectors?: Array<{ kind: string; jsonPointer: string }>
  surfaces: ExternalServiceSurface[]
}

export type ServiceConnectionStatus =
  "pending" | "connected" | "needs-auth" | "degraded" | "suspended" | "blocked"

export type ServiceConnectionProviderRef =
  | { kind: "mcp"; serverId: string }
  | { kind: "integration"; accountId: string }
  | { kind: "openapi"; accountId: string; importId: string }
  | { kind: "browser"; profileId: string }

export interface ServiceConnection {
  id: string
  pluginId?: string
  serviceId: string
  providerId: string
  runtimeTargetId: string
  accountLabel?: string
  status: ServiceConnectionStatus
  providerFingerprint: string
  providerRef: ServiceConnectionProviderRef
  enabledSurfaces: ExternalServiceSurface[]
  suspendedFromStatus?: Exclude<ServiceConnectionStatus, "suspended">
  createdAt: string
  updatedAt: string
}

export interface CapabilityGrantResourceScope {
  kind: string
  values: string[]
}

export interface CapabilityGrant {
  id: string
  connectionId: string
  providerFingerprint: string
  operationPatterns: string[]
  accountId?: string
  resourceScopes?: CapabilityGrantResourceScope[]
  workflowId?: string
  sessionId?: string
  /** Destructive operations never inherit an ordinary write grant. */
  allowDestructive?: boolean
  expiresAt?: string
  createdAt: string
  updatedAt: string
}

export interface OpenApiImportRow {
  id: string
  pluginId?: string
  serviceId: string
  providerId: string
  label: string
  sourceKind: "url" | "file" | "plugin"
  sourceUrl?: string
  /** Original JSON/YAML. Credentials are never accepted in this document. */
  document: string
  documentFingerprint: string
  approvedOrigins: string[]
  approvedExternalRefOrigins: string[]
  trust: "trusted" | "untrusted" | "blocked"
  createdAt: string
  updatedAt: string
}
