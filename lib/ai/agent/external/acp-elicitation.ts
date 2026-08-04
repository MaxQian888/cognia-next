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
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !ALLOWED_PROPERTY_TYPES.has(value.type)
  ) {
    return undefined
  }
  if (SECRET_FIELD.test(name) || value.format === "password" || value.writeOnly === true) {
    throw new Error("unsafe_secret")
  }
  if (value.type === "array") {
    if (!isRecord(value.items) || value.items.type !== "string") return undefined
  }
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || !value.enum.every((item) => typeof item === "string"))
  ) {
    return undefined
  }
  if (
    value.oneOf !== undefined &&
    (!Array.isArray(value.oneOf) ||
      !value.oneOf.every(
        (item) =>
          isRecord(item) &&
          typeof item.const === "string" &&
          (item.title === undefined || typeof item.title === "string") &&
          (item.group === undefined || typeof item.group === "string")
      ))
  ) {
    return undefined
  }
  return value as AcpElicitationPropertySchema
}

function validateSchema(value: unknown): AcpElicitationSchema | undefined {
  if (
    !isRecord(value) ||
    (value.type !== undefined && value.type !== "object") ||
    !isRecord(value.properties)
  ) {
    return undefined
  }
  const entries = Object.entries(value.properties)
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
    (!Array.isArray(value.required) ||
      !value.required.every((name) => typeof name === "string" && name in properties))
  ) {
    return undefined
  }
  return { ...(value as unknown as AcpElicitationSchema), properties }
}

export function normalizeAcpElicitationRequest(
  rpcRequestId: number | string,
  value: unknown
): NormalizeResult {
  if (!isRecord(value) || typeof value.message !== "string" || typeof value.mode !== "string") {
    return { ok: false, reason: "invalid_request" }
  }
  const hasSessionScope = typeof value.sessionId === "string"
  const hasRequestScope = typeof value.requestId === "number" || typeof value.requestId === "string"
  if (hasSessionScope === hasRequestScope) return { ok: false, reason: "invalid_request" }

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

  if (value.mode === "form") {
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

  if (value.mode === "url") {
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
