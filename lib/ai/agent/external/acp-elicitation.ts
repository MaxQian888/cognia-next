import type {
  AcpElicitationPropertySchema,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpElicitationSchema,
  AcpElicitationValue,
} from "@/types/agent/external-agent"

const MAX_FIELDS = 64
const SECRET_FIELD =
  /(?:password|passphrase|secret|api[_-]?key|api[_-]?token|access[_-]?token|credential)/i
const ALLOWED_PROPERTY_TYPES = new Set(["string", "integer", "number", "boolean", "array"])

type NormalizeResult =
  | { ok: true; request: AcpElicitationRequest }
  | {
      ok: false
      reason:
        "invalid_request" | "invalid_schema" | "unsafe_secret" | "unsafe_url" | "unsupported_mode"
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateProperty(name: string, value: unknown): AcpElicitationPropertySchema | undefined {
  if (!isRecord(value)) return undefined
  // `type` is required by every schema variant, but real agents omit it on
  // enum/oneOf properties — JSON Schema permits the omission and the choice
  // list unambiguously means a string select (or a multi-select via `items`).
  const type =
    typeof value.type === "string"
      ? value.type
      : value.enum !== undefined || value.oneOf !== undefined
        ? "string"
        : value.items !== undefined
          ? "array"
          : undefined
  if (type === undefined || !ALLOWED_PROPERTY_TYPES.has(type)) return undefined
  const property = { ...value, type }
  if (SECRET_FIELD.test(name) || property.format === "password" || property.writeOnly === true) {
    throw new Error("unsafe_secret")
  }
  if (type === "array") {
    if (!isRecord(property.items) || property.items.type !== "string") return undefined
  }
  if (
    property.enum !== undefined &&
    (!Array.isArray(property.enum) || !property.enum.every((item) => typeof item === "string"))
  ) {
    return undefined
  }
  if (
    property.oneOf !== undefined &&
    (!Array.isArray(property.oneOf) ||
      !property.oneOf.every(
        (item) =>
          isRecord(item) &&
          typeof item.const === "string" &&
          (item.title === undefined || typeof item.title === "string") &&
          (item.group === undefined || typeof item.group === "string")
      ))
  ) {
    return undefined
  }
  return property as AcpElicitationPropertySchema
}

function validateSchema(value: unknown): AcpElicitationSchema | undefined {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "object")) {
    return undefined
  }
  // `properties` is optional on the wire: a schema-less form is a
  // message-only confirmation, which the overlay can already ask.
  if (value.properties !== undefined && value.properties !== null && !isRecord(value.properties)) {
    return undefined
  }
  const entries = isRecord(value.properties) ? Object.entries(value.properties) : []
  if (entries.length > MAX_FIELDS) return undefined
  const properties: Record<string, AcpElicitationPropertySchema> = {}
  for (const [name, property] of entries) {
    if (!name || name.length > 128) return undefined
    const validated = validateProperty(name, property)
    if (!validated) return undefined
    properties[name] = validated
  }
  if (
    value.required !== undefined &&
    value.required !== null &&
    (!Array.isArray(value.required) || !value.required.every((name) => typeof name === "string"))
  ) {
    return undefined
  }
  // A required name the schema never declares is unanswerable — holding it
  // would guarantee a "missing required field" failure on the response path.
  const required = Array.isArray(value.required)
    ? value.required.filter((name): name is string => name in properties)
    : (value.required as string[] | null | undefined)
  return { ...(value as unknown as AcpElicitationSchema), properties, required }
}

export function normalizeAcpElicitationRequest(
  rpcRequestId: number | string,
  value: unknown
): NormalizeResult {
  if (!isRecord(value) || typeof value.message !== "string") {
    return { ok: false, reason: "invalid_request" }
  }
  // `mode` is required on the wire, but MCP-dialect elicitations carry only
  // {message, requestedSchema}. Infer the mode from the fields that exist
  // rather than hard-failing a request we could answer.
  const mode =
    typeof value.mode === "string"
      ? value.mode
      : isRecord(value.requestedSchema)
        ? "form"
        : typeof value.elicitationId === "string" && typeof value.url === "string"
          ? "url"
          : undefined
  if (mode === undefined) return { ok: false, reason: "invalid_request" }
  const hasSessionScope = typeof value.sessionId === "string"
  const hasRequestScope = typeof value.requestId === "number" || typeof value.requestId === "string"
  // The wire requires exactly one scope; when an agent sends both, the
  // session scope is the useful one — requestId only stands in for
  // pre-session phases.
  if (!hasSessionScope && !hasRequestScope) return { ok: false, reason: "invalid_request" }

  const base = {
    id: String(rpcRequestId),
    message: value.message,
    ...(hasSessionScope ? { sessionId: value.sessionId as string } : {}),
    ...(hasRequestScope ? { requestId: value.requestId as number | string } : {}),
    ...(typeof value.toolCallId === "string" || value.toolCallId === null
      ? { toolCallId: value.toolCallId as string | null }
      : {}),
    ...(isRecord(value._meta) || value._meta === null
      ? { _meta: value._meta as Record<string, unknown> | null }
      : {}),
    raw: { ...value },
  }

  if (mode === "form") {
    let schema: AcpElicitationSchema | undefined
    try {
      schema = validateSchema(value.requestedSchema)
    } catch (error) {
      if (error instanceof Error && error.message === "unsafe_secret") {
        return { ok: false, reason: "unsafe_secret" }
      }
      return { ok: false, reason: "invalid_schema" }
    }
    if (!schema) return { ok: false, reason: "invalid_schema" }
    return { ok: true, request: { ...base, mode: "form", requestedSchema: schema } }
  }

  if (mode === "url") {
    if (typeof value.elicitationId !== "string" || typeof value.url !== "string") {
      return { ok: false, reason: "invalid_request" }
    }
    let url: URL
    try {
      url = new URL(value.url)
    } catch {
      return { ok: false, reason: "unsafe_url" }
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      return { ok: false, reason: "unsafe_url" }
    }
    return {
      ok: true,
      request: {
        ...base,
        mode: "url",
        elicitationId: value.elicitationId,
        url: url.href,
        origin: url.origin,
        hasPunycodeWarning: url.hostname.split(".").some((label) => label.startsWith("xn--")),
      },
    }
  }

  return { ok: false, reason: "unsupported_mode" }
}

function matchesType(value: AcpElicitationValue, schema: AcpElicitationPropertySchema): boolean {
  if (schema.type === "string") return typeof value === "string"
  if (schema.type === "integer") return typeof value === "number" && Number.isInteger(value)
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value)
  if (schema.type === "boolean") return typeof value === "boolean"
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

export function validateAcpElicitationResponse(
  request: AcpElicitationRequest,
  response: AcpElicitationResponse
): Omit<AcpElicitationResponse, "requestId"> {
  if (response.action === "decline" || response.action === "cancel") {
    return {
      action: response.action,
      ...(response._meta !== undefined ? { _meta: response._meta } : {}),
    }
  }
  if (response.action !== "accept") throw new Error("Unknown elicitation action")

  const content = response.content ?? {}
  if (request.mode === "form") {
    const schema = request.requestedSchema!
    for (const required of schema.required ?? []) {
      if (!(required in content)) throw new Error(`Missing required elicitation field: ${required}`)
    }
    for (const [name, value] of Object.entries(content)) {
      const property = schema.properties[name]
      if (!property || !matchesType(value, property)) {
        throw new Error(`Invalid elicitation field: ${name}`)
      }
      const allowed = property.enum ?? property.oneOf?.map((option) => option.const)
      if (
        allowed &&
        (Array.isArray(value)
          ? value.some((item) => !allowed.includes(item))
          : !allowed.includes(String(value)))
      ) {
        throw new Error(`Invalid elicitation option: ${name}`)
      }
    }
  }
  return {
    action: "accept",
    content,
    ...(response._meta !== undefined ? { _meta: response._meta } : {}),
  }
}
