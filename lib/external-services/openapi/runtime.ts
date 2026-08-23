import { hasNoLeakingPiiDeep } from "@cognia/redact"

import type { ExternalServiceSurface } from "@/types/external-service"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import { registerExternalCapabilities } from "../catalog"
import type { CompiledOpenApiOperation, CompiledOpenApiProvider } from "./compiler"

export type OpenApiRequestBody = string | URLSearchParams | FormData | undefined

export type AuthenticatedOpenApiRequest = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: OpenApiRequestBody
    redirect: "manual"
  }
) => Promise<{ status: number; headers: Record<string, string>; data: unknown }>

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function scalar(value: unknown, label: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  throw new Error(`OpenAPI parameter "${label}" must be a scalar value`)
}

function appendQuery(url: URL, name: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const entry of value) url.searchParams.append(name, scalar(entry, name))
    return
  }
  url.searchParams.append(name, scalar(value, name))
}

function appendFormData(form: FormData, name: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const entry of value) appendFormData(form, name, entry)
    return
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    form.append(name, value)
    return
  }
  form.append(name, typeof value === "object" ? JSON.stringify(value) : scalar(value, name))
}

function serializeBody(
  contentType: string | undefined,
  value: unknown,
  headers: Record<string, string>
): OpenApiRequestBody {
  if (value === undefined) return undefined
  if (contentType === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams()
    for (const [key, entry] of Object.entries(record(value)))
      appendQueryToParams(params, key, entry)
    headers["content-type"] = contentType
    return params
  }
  if (contentType?.startsWith("multipart/form-data")) {
    const form = new FormData()
    for (const [key, entry] of Object.entries(record(value))) appendFormData(form, key, entry)
    // The runtime supplies the multipart boundary; setting content-type here
    // would omit it and produce an invalid request.
    return form
  }
  headers["content-type"] = contentType ?? "application/json"
  return JSON.stringify(value)
}

function appendQueryToParams(params: URLSearchParams, name: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const entry of value) params.append(name, scalar(entry, name))
    return
  }
  params.append(name, scalar(value, name))
}

function buildRequest(
  operation: CompiledOpenApiOperation,
  baseUrl: string,
  args: Record<string, unknown>
): {
  url: string
  init: Parameters<AuthenticatedOpenApiRequest>[1]
} {
  const base = new URL(baseUrl)
  const pathArgs = record(args.path)
  const resolvedPath = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathArgs[name]
    if (value === undefined || value === null) {
      throw new Error(`OpenAPI path parameter "${name}" is required`)
    }
    return encodeURIComponent(scalar(value, name))
  })
  const url = new URL(base.href)
  url.pathname = `${base.pathname.replace(/\/$/, "")}/${resolvedPath.replace(/^\//, "")}`
  for (const [name, value] of Object.entries(record(args.query))) appendQuery(url, name, value)

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(record(args.header))) {
    const normalized = name.toLowerCase()
    if (normalized === "authorization" || normalized === "proxy-authorization") {
      throw new Error(`OpenAPI credential header "${name}" must be injected by the host`)
    }
    headers[normalized] = scalar(value, name)
  }
  const cookieValues = Object.entries(record(args.cookie)).map(
    ([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(scalar(value, name))}`
  )
  if (cookieValues.length > 0) headers.cookie = cookieValues.join("; ")
  const body = serializeBody(operation.requestContentType, args.body, headers)
  return {
    url: url.href,
    init: {
      method: operation.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
    },
  }
}

export async function executeOpenApiOperation(input: {
  provider: CompiledOpenApiProvider
  operationId: string
  baseUrl: string
  approvedOrigins: string[]
  args: Record<string, unknown>
  request: AuthenticatedOpenApiRequest
}): Promise<{ status: number; headers: Record<string, string>; data: unknown }> {
  const operation = input.provider.operations.find(
    (candidate) => candidate.operationId === input.operationId
  )
  if (!operation) throw new Error(`Unknown OpenAPI operation "${input.operationId}"`)
  const validation = validateAgainstJsonSchema(operation.inputSchema, input.args)
  if (!validation.ok) {
    throw new Error(`OpenAPI operation input is invalid: ${validation.errors.join("; ")}`)
  }
  if (!hasNoLeakingPiiDeep(input.args)) {
    throw new Error("OpenAPI outbound request was blocked by the PII redaction gate")
  }
  const base = new URL(input.baseUrl)
  if (
    !input.approvedOrigins.includes(base.origin) ||
    !input.provider.allowedOrigins.includes(base.origin)
  ) {
    throw new Error(`OpenAPI request origin is not approved: ${base.origin}`)
  }
  const request = buildRequest(operation, input.baseUrl, input.args)
  const result = await input.request(request.url, request.init)
  if (result.status >= 300 && result.status < 400) {
    throw new Error("OpenAPI redirects require a new origin review")
  }
  if (operation.outputSchema) {
    const outputValidation = validateAgainstJsonSchema(operation.outputSchema, result.data)
    if (!outputValidation.ok) {
      throw new Error(`OpenAPI operation output is invalid: ${outputValidation.errors.join("; ")}`)
    }
  }
  return result
}

export function projectOpenApiCapabilities(input: {
  pluginId: string
  serviceId: string
  providerId: string
  surfaces: ExternalServiceSurface[]
  provider: CompiledOpenApiProvider
}): void {
  registerExternalCapabilities(
    input.pluginId,
    input.serviceId,
    input.providerId,
    input.provider.operations.map((operation) => ({
      pluginId: input.pluginId,
      serviceId: input.serviceId,
      providerId: input.providerId,
      capabilityId: operation.operationId,
      operationId: operation.operationId,
      kind: "action",
      risk: operation.risk,
      inputSchema: operation.inputSchema,
      outputSchema: operation.outputSchema,
      surfaces: input.surfaces,
    }))
  )
}
