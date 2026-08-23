import type {
  ExternalServiceRisk,
  ExternalServiceSurface,
  JsonSchema,
} from "@/types/external-service"

export type ServiceProviderKind = "mcp" | "integration" | "openapi" | "browser"
export type ServiceProviderAvailability = "supported" | "preview" | "vendor-pending"

export interface ServiceProviderRef {
  id: string
  kind: ServiceProviderKind
  contributionId: string
  priority: number
  surfaces: ExternalServiceSurface[]
  availability?: ServiceProviderAvailability
}

export interface PluginServiceDef {
  id: string
  label: string
  description?: string
  icon?: string
  skillIds?: string[]
  providers: ServiceProviderRef[]
  fallbackPolicy: "never" | "confirm"
}

export interface OpenApiRiskOverride {
  operationId: string
  risk: ExternalServiceRisk
  idempotency?: "required" | "supported" | "none"
}

export interface PluginOpenApiProviderDef {
  id: string
  label: string
  description?: string
  source: { type: "bundled"; path: string } | { type: "url"; url: string }
  allowedOrigins?: string[]
  riskOverrides?: OpenApiRiskOverride[]
  /** Webhook exposure remains disabled unless the provider declares a host-verifiable scheme. */
  webhookVerification?:
    { type: "hmac-sha256"; signatureHeader: string } | { type: "static-token"; tokenHeader: string }
}

export interface BrowserSiteProviderDef {
  id: string
  label: string
  description?: string
  allowedDomains: string[]
  loginStartUrl?: string
  persistentProfile?: boolean
  allowUploads?: boolean
  allowDownloads?: boolean
  skillIds?: string[]
  operations?: Array<{
    id: string
    operationId: string
    label: string
    risk: ExternalServiceRisk
    inputSchema?: JsonSchema
  }>
}
