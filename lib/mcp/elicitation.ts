import type { JsonSchema } from "@/types/external-service"
import type { AcpElicitationRequest } from "@cognia/agent-contracts/external-agent"
import { elicitationFormSchemaSafetyError } from "@cognia/agent-contracts/external-agent"

/** Adapt runtime interaction approvals, including older persisted SDK requests. */
export function approvalElicitationRequest(approval: {
  toolName: string
  requestId: string
  input: Record<string, unknown>
}): AcpElicitationRequest | undefined {
  if (!["Runtime:Elicitation", "SDK:Elicitation"].includes(approval.toolName)) return undefined
  const raw = approval.input.elicitation ?? approval.input.request
  if (!raw || typeof raw !== "object") return undefined
  const request = raw as Partial<AcpElicitationRequest>
  if (typeof request.message !== "string") return undefined
  if (
    request.mode !== "url" &&
    request.requestedSchema !== undefined &&
    elicitationFormSchemaSafetyError(request.requestedSchema)
  )
    return undefined
  if (request.mode === "url") {
    try {
      const target = parseUrlElicitation(request.url)
      return {
        ...request,
        id: approval.requestId,
        mode: "url",
        message: request.message,
        url: target.href,
        origin: target.origin,
        raw: {},
      }
    } catch {
      return undefined
    }
  }
  return { ...request, id: approval.requestId, mode: "form", message: request.message, raw: {} }
}

export type McpElicitationValue = string | number | boolean | string[]

export interface McpElicitationProvenance {
  serverId: string
  serverName: string
  endpoint?: string
}

export interface McpFormElicitation {
  mode: "form"
  message: string
  propertyOrder?: string[]
  requestedSchema: JsonSchema & {
    type: "object"
    properties: Record<string, JsonSchema>
    required?: string[]
  }
  provenance: McpElicitationProvenance
}

export interface McpUrlElicitation {
  mode: "url"
  message: string
  elicitationId: string
  url: string
  targetOrigin: string
  targetHostname: string
  provenance: McpElicitationProvenance
}

export type McpElicitation = McpFormElicitation | McpUrlElicitation

export type McpElicitationResult =
  | { action: "accept"; content?: Record<string, McpElicitationValue> }
  | { action: "decline" | "cancel" }

export type McpElicitationHandler = (
  request: McpElicitation
) => McpElicitationResult | Promise<McpElicitationResult>

interface RawElicitationRequest {
  params?: {
    mode?: "form" | "url"
    message?: string
    requestedSchema?: JsonSchema
    propertyOrder?: string[]
    elicitationId?: string
    url?: string
  }
}

function assertSafeFormSchema(schema: JsonSchema | undefined): asserts schema is JsonSchema & {
  type: "object"
  properties: Record<string, JsonSchema>
  required?: string[]
} {
  const error = elicitationFormSchemaSafetyError(schema)
  if (error) throw new Error(error)
}

function parseUrlElicitation(url: string | undefined): URL {
  if (!url) throw new Error("MCP URL elicitation requires a target URL")
  const parsed = new URL(url)
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error("MCP URL elicitation only permits HTTPS or loopback HTTP")
  }
  if (parsed.username || parsed.password) {
    throw new Error("MCP URL elicitation cannot contain embedded credentials")
  }
  return parsed
}

export function createMcpElicitationRequest(
  request: RawElicitationRequest,
  provenance: McpElicitationProvenance
): McpElicitation {
  const params = request.params
  if (!params || typeof params.message !== "string") {
    throw new Error("Invalid MCP elicitation request")
  }
  if (params.mode === "url") {
    const parsed = parseUrlElicitation(params.url)
    if (!params.elicitationId) throw new Error("MCP URL elicitation requires an id")
    return {
      mode: "url",
      message: params.message,
      elicitationId: params.elicitationId,
      url: parsed.href,
      targetOrigin: parsed.origin,
      targetHostname: parsed.hostname,
      provenance,
    }
  }
  assertSafeFormSchema(params.requestedSchema)
  return {
    mode: "form",
    message: params.message,
    requestedSchema: params.requestedSchema,
    ...(Array.isArray(params.propertyOrder)
      ? { propertyOrder: params.propertyOrder.filter((key) => typeof key === "string") }
      : {}),
    provenance,
  }
}
