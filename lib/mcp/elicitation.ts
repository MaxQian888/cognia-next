import type { JsonSchema } from "@/types/external-service"

const SENSITIVE_FIELD_PATTERN =
  /(?:password|passcode|secret|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|payment|card[\s_-]*(?:number|code)|cvv|cvc|pin)/i

export type McpElicitationValue = string | number | boolean | string[]

export interface McpElicitationProvenance {
  serverId: string
  serverName: string
  endpoint?: string
}

export interface McpFormElicitation {
  mode: "form"
  message: string
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
    elicitationId?: string
    url?: string
  }
}

function assertSafeFormSchema(schema: JsonSchema | undefined): asserts schema is JsonSchema & {
  type: "object"
  properties: Record<string, JsonSchema>
  required?: string[]
} {
  if (!schema || schema.type !== "object" || !schema.properties) {
    throw new Error("MCP elicitation form requires an object schema")
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    const signals = [name, property.title, property.description, property.format]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
    if (SENSITIVE_FIELD_PATTERN.test(signals)) {
      throw new Error(`MCP elicitation form cannot request sensitive field: ${name}`)
    }
  }
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
    provenance,
  }
}
