import { parseDocument } from "yaml"

import type { ExternalServiceRisk, JsonSchema } from "@/types/external-service"
import type { OpenApiRiskOverride } from "@/types/plugin/plugin-service"

const MAX_SPEC_BYTES = 2 * 1024 * 1024
const MAX_VISITED_NODES = 100_000
const HTTP_METHODS = ["get", "head", "options", "post", "put", "patch", "delete", "trace"] as const

type HttpMethodLower = (typeof HTTP_METHODS)[number]
type UnknownRecord = Record<string, unknown>

export class OpenApiCompileError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string
  ) {
    super(code)
    this.name = "OpenApiCompileError"
  }
}

export interface CompiledOpenApiSecurityScheme {
  id: string
  type: "apiKey" | "http" | "oauth2" | "openIdConnect"
  scheme?: string
  location?: "query" | "header" | "cookie"
  name?: string
  openIdConnectUrl?: string
  flows?: UnknownRecord
}

export interface CompiledOpenApiOperation {
  operationId: string
  method: Uppercase<HttpMethodLower>
  path: string
  summary?: string
  description?: string
  risk: ExternalServiceRisk
  idempotency?: "required" | "supported" | "none"
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  requestContentType?: string
  security: Array<Record<string, string[]>>
  callbackIds: string[]
}

export interface CompiledOpenApiWebhook {
  id: string
  operationId: string
  method: Uppercase<HttpMethodLower>
  inputSchema: JsonSchema
  enabled: false
}

export interface CompiledOpenApiProvider {
  title: string
  version: string
  documentVersion: string
  allowedOrigins: string[]
  externalRefs: string[]
  securitySchemes: CompiledOpenApiSecurityScheme[]
  operations: CompiledOpenApiOperation[]
  webhooks: CompiledOpenApiWebhook[]
}

export interface CompileOpenApiOptions {
  sourceUrl?: string
  approvedExternalOrigins?: string[]
  /** Pre-fetched external documents keyed by absolute URL without a fragment. */
  externalDocuments?: Record<string, string | UnknownRecord>
  riskOverrides?: OpenApiRiskOverride[]
  maxBytes?: number
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseSource(source: string | UnknownRecord, maxBytes: number): UnknownRecord {
  if (typeof source !== "string") {
    if (!isRecord(source)) throw new OpenApiCompileError("invalid-document")
    return source
  }
  if (new TextEncoder().encode(source).byteLength > maxBytes) {
    throw new OpenApiCompileError("document-too-large")
  }
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new OpenApiCompileError("invalid-document", document.errors[0].message)
  }
  const parsed = document.toJS({ maxAliasCount: 100 })
  if (!isRecord(parsed)) throw new OpenApiCompileError("invalid-document")
  return parsed
}

function decodePointerSegment(segment: string): string {
  return decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~")
}

function readLocalRef(root: UnknownRecord, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new OpenApiCompileError("invalid-local-ref", ref)
  let current: unknown = root
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(current)) throw new OpenApiCompileError("unresolved-ref", ref)
    current = current[decodePointerSegment(segment)]
  }
  if (current === undefined) throw new OpenApiCompileError("unresolved-ref", ref)
  return current
}

function sourceOrigin(sourceUrl?: string): string | undefined {
  if (!sourceUrl) return undefined
  try {
    return new URL(sourceUrl).origin
  } catch {
    throw new OpenApiCompileError("invalid-source-url")
  }
}

function resolveRefs(
  value: unknown,
  root: UnknownRecord,
  options: CompileOpenApiOptions,
  externalRefs: Set<string>,
  stack: string[] = [],
  visited = { count: 0 }
): unknown {
  visited.count += 1
  if (visited.count > MAX_VISITED_NODES) throw new OpenApiCompileError("document-too-complex")
  if (Array.isArray(value)) {
    return value.map((entry) => resolveRefs(entry, root, options, externalRefs, stack, visited))
  }
  if (!isRecord(value)) return value
  const ref = typeof value.$ref === "string" ? value.$ref : undefined
  if (ref) {
    if (ref.startsWith("#")) {
      if (stack.includes(ref)) throw new OpenApiCompileError("cyclic-ref", ref)
      const resolved = resolveRefs(
        readLocalRef(root, ref),
        root,
        options,
        externalRefs,
        [...stack, ref],
        visited
      )
      if (!isRecord(resolved)) return resolved
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"))
      return { ...resolved, ...resolveRefs(siblings, root, options, externalRefs, stack, visited) }
    }
    const url = new URL(ref, options.sourceUrl)
    const approved = new Set(options.approvedExternalOrigins ?? [])
    const ownOrigin = sourceOrigin(options.sourceUrl)
    if (url.origin !== ownOrigin && !approved.has(url.origin)) {
      throw new OpenApiCompileError("external-ref-origin-not-approved", url.origin)
    }
    externalRefs.add(url.href)
    const documentUrl = new URL(url.href)
    const fragment = documentUrl.hash
    documentUrl.hash = ""
    const externalSource = options.externalDocuments?.[documentUrl.href]
    if (externalSource !== undefined) {
      if (stack.includes(url.href)) throw new OpenApiCompileError("cyclic-ref", url.href)
      const externalRoot = parseSource(externalSource, options.maxBytes ?? MAX_SPEC_BYTES)
      const target = fragment ? readLocalRef(externalRoot, fragment) : externalRoot
      return resolveRefs(
        target,
        externalRoot,
        { ...options, sourceUrl: documentUrl.href },
        externalRefs,
        [...stack, url.href],
        visited
      )
    }
    return { ...value, $ref: url.href }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveRefs(entry, root, options, externalRefs, stack, visited),
    ])
  )
}

function inferRisk(method: HttpMethodLower): ExternalServiceRisk {
  if (method === "get" || method === "head" || method === "options") return "read"
  if (method === "delete") return "destructive"
  return "write"
}

function mediaSchema(content: unknown): { contentType?: string; schema?: JsonSchema } {
  if (!isRecord(content)) return {}
  const contentType = content["application/json"]
    ? "application/json"
    : content["application/problem+json"]
      ? "application/problem+json"
      : Object.keys(content)[0]
  if (!contentType || !isRecord(content[contentType])) return {}
  const schema = (content[contentType] as UnknownRecord).schema
  return { contentType, schema: isRecord(schema) ? schema : undefined }
}

function responseSchema(responses: unknown): JsonSchema | undefined {
  if (!isRecord(responses)) return undefined
  const key = Object.keys(responses).find((entry) => /^2\d\d$/.test(entry)) ?? "default"
  const response = responses[key]
  if (!isRecord(response)) return undefined
  return mediaSchema(response.content).schema
}

function parametersSchema(pathItem: UnknownRecord, operation: UnknownRecord): JsonSchema {
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ].filter(isRecord)
  const grouped: Record<string, Record<string, JsonSchema>> = {
    path: {},
    query: {},
    header: {},
    cookie: {},
  }
  const requiredByGroup: Record<string, string[]> = { path: [], query: [], header: [], cookie: [] }
  for (const parameter of parameters) {
    const location = parameter.in
    const name = parameter.name
    if (
      typeof location !== "string" ||
      !(location in grouped) ||
      typeof name !== "string" ||
      !isRecord(parameter.schema)
    ) {
      continue
    }
    grouped[location][name] = parameter.schema
    if (parameter.required === true) requiredByGroup[location].push(name)
  }

  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [location, entries] of Object.entries(grouped)) {
    if (Object.keys(entries).length === 0) continue
    properties[location] = {
      type: "object",
      properties: entries,
      ...(requiredByGroup[location].length > 0 ? { required: requiredByGroup[location] } : {}),
      additionalProperties: false,
    }
    if (requiredByGroup[location].length > 0) required.push(location)
  }

  const requestBody = isRecord(operation.requestBody) ? operation.requestBody : undefined
  const body = mediaSchema(requestBody?.content)
  if (body.schema) {
    properties.body = body.schema
    if (requestBody?.required === true) required.push("body")
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function compileSecuritySchemes(document: UnknownRecord): CompiledOpenApiSecurityScheme[] {
  const components = isRecord(document.components) ? document.components : {}
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {}
  const result: CompiledOpenApiSecurityScheme[] = []
  for (const [id, value] of Object.entries(schemes)) {
    if (!isRecord(value)) continue
    if (value.type === "apiKey") {
      result.push({
        id,
        type: "apiKey",
        location:
          value.in === "query" || value.in === "cookie" || value.in === "header"
            ? value.in
            : undefined,
        name: typeof value.name === "string" ? value.name : undefined,
      })
    } else if (value.type === "http") {
      result.push({
        id,
        type: "http",
        scheme: typeof value.scheme === "string" ? value.scheme : undefined,
      })
    } else if (value.type === "oauth2") {
      result.push({ id, type: "oauth2", flows: isRecord(value.flows) ? value.flows : undefined })
    } else if (value.type === "openIdConnect") {
      result.push({
        id,
        type: "openIdConnect",
        openIdConnectUrl:
          typeof value.openIdConnectUrl === "string" ? value.openIdConnectUrl : undefined,
      })
    }
  }
  return result
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

function compileOrigins(document: UnknownRecord, sourceUrl?: string): string[] {
  const servers = Array.isArray(document.servers) ? document.servers : []
  const origins = new Set<string>()
  for (const server of servers) {
    if (!isRecord(server) || typeof server.url !== "string") continue
    let url: URL
    try {
      url = new URL(server.url, sourceUrl)
    } catch {
      throw new OpenApiCompileError("invalid-server-url", server.url)
    }
    if (url.username || url.password) {
      throw new OpenApiCompileError("credentials-in-server-url", url.origin)
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new OpenApiCompileError("insecure-server-origin", url.origin)
    }
    origins.add(url.origin)
  }
  return [...origins]
}

function compileOperation(
  path: string,
  method: HttpMethodLower,
  pathItem: UnknownRecord,
  operation: UnknownRecord,
  override?: OpenApiRiskOverride
): CompiledOpenApiOperation {
  const operationId =
    typeof operation.operationId === "string" && operation.operationId.length > 0
      ? operation.operationId
      : `${method}:${path}`
  const body = mediaSchema(
    isRecord(operation.requestBody) ? operation.requestBody.content : undefined
  )
  return {
    operationId,
    method: method.toUpperCase() as Uppercase<HttpMethodLower>,
    path,
    summary: typeof operation.summary === "string" ? operation.summary : undefined,
    description: typeof operation.description === "string" ? operation.description : undefined,
    risk: override?.risk ?? inferRisk(method),
    idempotency: override?.idempotency,
    inputSchema: parametersSchema(pathItem, operation),
    outputSchema: responseSchema(operation.responses),
    requestContentType: body.contentType,
    security: Array.isArray(operation.security)
      ? operation.security
          .filter(isRecord)
          .map((entry) =>
            Object.fromEntries(
              Object.entries(entry).map(([key, value]) => [
                key,
                Array.isArray(value)
                  ? value.filter((scope): scope is string => typeof scope === "string")
                  : [],
              ])
            )
          )
      : [],
    callbackIds: isRecord(operation.callbacks) ? Object.keys(operation.callbacks) : [],
  }
}

export function compileOpenApiDocument(
  source: string | UnknownRecord,
  options: CompileOpenApiOptions = {}
): CompiledOpenApiProvider {
  const raw = parseSource(source, options.maxBytes ?? MAX_SPEC_BYTES)
  const version = typeof raw.openapi === "string" ? raw.openapi : ""
  if (!/^3\.(0|1|2)\.\d+(?:[-+].*)?$/.test(version)) {
    throw new OpenApiCompileError("unsupported-version", version)
  }
  const externalRefs = new Set<string>()
  const document = resolveRefs(raw, raw, options, externalRefs)
  if (!isRecord(document)) throw new OpenApiCompileError("invalid-document")
  const info = isRecord(document.info) ? document.info : {}
  const paths = isRecord(document.paths) ? document.paths : {}
  const overrides = new Map(
    (options.riskOverrides ?? []).map((entry) => [entry.operationId, entry])
  )
  const operations: CompiledOpenApiOperation[] = []
  const seenOperationIds = new Set<string>()
  for (const [path, value] of Object.entries(paths)) {
    if (!isRecord(value)) continue
    for (const method of HTTP_METHODS) {
      const operation = value[method]
      if (!isRecord(operation)) continue
      const operationId =
        typeof operation.operationId === "string" && operation.operationId.length > 0
          ? operation.operationId
          : `${method}:${path}`
      if (seenOperationIds.has(operationId)) {
        throw new OpenApiCompileError("duplicate-operation-id", operationId)
      }
      seenOperationIds.add(operationId)
      operations.push(compileOperation(path, method, value, operation, overrides.get(operationId)))
    }
  }

  const webhooks: CompiledOpenApiWebhook[] = []
  const webhookEntries = isRecord(document.webhooks) ? document.webhooks : {}
  for (const [name, value] of Object.entries(webhookEntries)) {
    if (!isRecord(value)) continue
    for (const method of HTTP_METHODS) {
      const operation = value[method]
      if (!isRecord(operation)) continue
      const operationId =
        typeof operation.operationId === "string" ? operation.operationId : `${method}:${name}`
      webhooks.push({
        id: operationId || name,
        operationId,
        method: method.toUpperCase() as Uppercase<HttpMethodLower>,
        inputSchema: parametersSchema(value, operation),
        enabled: false,
      })
    }
  }

  return {
    title: typeof info.title === "string" ? info.title : "Imported API",
    version,
    documentVersion: typeof info.version === "string" ? info.version : "unknown",
    allowedOrigins: compileOrigins(document, options.sourceUrl),
    externalRefs: [...externalRefs],
    securitySchemes: compileSecuritySchemes(document),
    operations,
    webhooks,
  }
}
