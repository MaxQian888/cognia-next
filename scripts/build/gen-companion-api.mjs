#!/usr/bin/env node

import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { parseDocument, stringify } from "yaml"
import { z } from "zod"

import { buildCompanionRequestSchemaContracts } from "./companion-request-schema-contracts.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const PUBLIC_SPEC_PATH = "docs/api/mobile-companion-api.openapi.yaml"
const HEADLESS_SPEC_PATH = "docs/api/headless-service-api.openapi.yaml"
const ROUTE_CONTRACT_PATH = "protocol/companion-api-routes.json"
const COMMAND_MANIFEST_PATH = "protocol/companion-commands.json"
const REQUEST_SCHEMA_CATALOG_PATH = "protocol/companion-request-schemas.json"
const ZOD_REQUEST_SCHEMA_PATH = "scripts/build/companion-request-schema-contracts.mjs"
const RPC_SOURCE_PATH = "src-tauri/src/companion_api/rpc.rs"
const RUNTIME_ROUTE_SOURCES = [
  "src-tauri/src/companion_api/server.rs",
  "src-tauri/src/companion_api/api.rs",
]

const routeSchema = z.object({
  path: z.string().startsWith("/"),
  runtimePath: z.string().startsWith("/").optional(),
  method: z.enum(["get", "post", "put", "patch", "delete"]),
  document: z.enum(["public", "headless", "none"]),
})

const routeContractSchema = z.object({
  schemaVersion: z.literal(1),
  routes: z.array(routeSchema),
})

const requestSchemaCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  commands: z.record(z.string(), z.record(z.string(), z.unknown())),
})

function isPublicHttpCommand(command) {
  return (
    (command.target === "execution" || command.target === "host-admin") &&
    command.transports.includes("http")
  )
}

export function classifyCommands(manifest, remoteNames) {
  const byName = new Map(manifest.commands.map((command) => [command.name, command]))
  const internalNames = [...remoteNames].filter((name) => byName.has(name)).sort()
  const publicNames = internalNames.filter((name) => isPublicHttpCommand(byName.get(name)))
  return { byName, publicNames, internalNames }
}

function clone(value) {
  return structuredClone(value)
}

function prepareRequestSchema(value) {
  if (Array.isArray(value)) return value.map(prepareRequestSchema)
  if (!value || typeof value !== "object") return value
  const next = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, prepareRequestSchema(child)])
  )
  if (next.type !== "object" && !(Array.isArray(next.type) && next.type.includes("object"))) {
    return next
  }
  if (
    Object.keys(next.properties ?? {}).length === 0 &&
    Array.isArray(next.propertyNames?.enum)
  ) {
    next.properties = Object.fromEntries(next.propertyNames.enum.map((name) => [name, {}]))
    delete next.propertyNames
  }
  const hasNamedProperties = Object.keys(next.properties ?? {}).length > 0
  if (next.additionalProperties === true && hasNamedProperties) {
    next.additionalProperties = false
  } else if (!hasNamedProperties && next.additionalProperties === true) {
    next.additionalProperties = {}
    next.example ??= {}
  } else if (
    !hasNamedProperties &&
    next.additionalProperties &&
    typeof next.additionalProperties === "object"
  ) {
    next.example ??= {}
  }
  return next
}

function unwrapRustType(type, wrapper) {
  const normalized = type.trim()
  const prefix = `${wrapper}<`
  if (!normalized.startsWith(prefix) || !normalized.endsWith(">")) return null
  return normalized.slice(prefix.length, -1).trim()
}

function rustTypeSchema(type) {
  let normalized = type.replace(/\s+/g, " ").trim()
  normalized = unwrapRustType(normalized, "Option") ?? normalized
  const vectorItem = unwrapRustType(normalized, "Vec")
  if (vectorItem) return { type: "array", items: rustTypeSchema(vectorItem) }
  if (/^(?:HashMap|BTreeMap)</.test(normalized)) {
    return { type: "object", additionalProperties: true }
  }
  if (
    /^(?:String|&str|Cow<|Uuid)/.test(normalized) ||
    /(?:^|::)PathBuf$/.test(normalized)
  ) {
    return { type: "string" }
  }
  if (normalized === "bool") return { type: "boolean" }
  if (/^(?:u8|u16|u32)$/.test(normalized)) {
    return { type: "integer", format: "int32", minimum: 0 }
  }
  if (/^(?:u64|usize)$/.test(normalized)) {
    return { type: "integer", format: "int64", minimum: 0 }
  }
  if (/^(?:i8|i16|i32)$/.test(normalized)) return { type: "integer", format: "int32" }
  if (normalized === "i64" || normalized === "isize") {
    return { type: "integer", format: "int64" }
  }
  if (/^(?:f32|f64)$/.test(normalized)) return { type: "number" }
  if (/(?:^|::)Value$/.test(normalized)) return {}
  return { type: "object", additionalProperties: true }
}

function inferredExample(schema, field) {
  if (schema.type === "integer" || schema.type === "number") return field === "limit" ? 20 : 0
  if (schema.type === "string") return ""
  if (schema.type === "boolean") return false
  if (schema.type === "array") return []
  if (schema.type === "object") return {}
  return undefined
}

function schemaFromArm(arm) {
  const properties = {}
  const requiredFields = new Set()
  const assignment =
    /let\s+(?:mut\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?::\s*([^=;]+?))?\s*=\s*(?:\r?\n\s*)?(required_aliased|optional_aliased|required|optional)(?:\s*::<\s*([^>]+)\s*>)?\s*\(\s*&args\s*,\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?/g
  for (const match of arm.matchAll(assignment)) {
    const [, annotatedType, helper, explicitType, field, alias] = match
    const isRequired = helper.startsWith("required")
    const schema = rustTypeSchema(annotatedType || explicitType || "serde_json::Value")
    if (isRequired) {
      requiredFields.add(field)
      const example = inferredExample(schema, field)
      if (example !== undefined) schema.example = example
    }
    if (alias) schema.description = `Also accepted as \`${alias}\`.`
    properties[field] = schema
  }
  const propertyRead = /args\s*\.get\(\s*"([^"]+)"\s*\)([\s\S]{0,120})/g
  for (const match of arm.matchAll(propertyRead)) {
    const [, field, chain] = match
    if (properties[field]) continue
    const schema = chain.includes(".as_bool()")
      ? { type: "boolean" }
      : chain.includes(".as_u64()")
        ? { type: "integer", format: "int64", minimum: 0 }
        : chain.includes(".as_i64()")
          ? { type: "integer", format: "int64" }
          : chain.includes(".as_f64()")
            ? { type: "number" }
            : chain.includes(".as_array()")
              ? { type: "array", items: {} }
              : chain.includes(".as_object()")
                ? { type: "object", additionalProperties: true }
                : chain.includes(".as_str()")
                  ? { type: "string" }
                  : {}
    if (/\.ok_or(?:_else)?\s*\(/.test(chain)) requiredFields.add(field)
    properties[field] = schema
  }
  if (Object.keys(properties).length === 0) {
    if (/\bargs\b/.test(arm)) return null
    return { type: "object", properties: {}, additionalProperties: false }
  }
  return {
    type: "object",
    ...(requiredFields.size > 0 ? { required: [...requiredFields] } : {}),
    properties,
    additionalProperties: false,
  }
}

/**
 * Infer JSON request fields from the real Rust dispatch boundary. Rustfmt
 * keeps top-level match patterns at eight spaces, which gives us a stable
 * seam without trying to parse the rest of Rust. Explicit manifest schemas
 * still win; this only replaces the otherwise-empty RpcArgs fallback.
 */
export function extractCommandArgumentSchemas(source) {
  const dispatchStart = source.indexOf("pub(super) async fn dispatch(")
  if (dispatchStart < 0) throw new Error("Could not locate companion RPC dispatch function")
  const matchStart = source.indexOf("match name {", dispatchStart)
  if (matchStart < 0) throw new Error("Could not locate companion RPC dispatch match")
  const lines = source.slice(matchStart).split(/\r?\n/)
  const schemas = new Map()
  let current = null

  const finish = () => {
    if (!current) return
    const schema = schemaFromArm(current.body.join("\n"))
    if (schema) for (const name of current.names) schemas.set(name, clone(schema))
    current = null
  }

  for (const line of lines.slice(1)) {
    const direct = line.match(/^        "([a-z][a-z0-9_]*)"/)
    const continuation = line.match(/^        \| "([a-z][a-z0-9_]*)"/)
    if (line.match(/^        _\s*=>/)) {
      finish()
      break
    }
    if (direct && (!current || current.hasArrow)) {
      finish()
      current = { names: [direct[1]], hasArrow: line.includes("=>"), body: [line] }
      continue
    }
    if (current && !current.hasArrow) {
      if (direct) current.names.push(direct[1])
      if (continuation) current.names.push(continuation[1])
      current.hasArrow ||= line.includes("=>")
      current.body.push(line)
      continue
    }
    if (current) current.body.push(line)
  }
  finish()
  return schemas
}

function genericRpcPath(command, audience, argumentSchemas = new Map()) {
  const requiresIdempotency = command.idempotency === "required"
  const usesGenericFallback = command.inputSchema === "#/components/schemas/RpcArgs"
  const generatedSchema = usesGenericFallback ? argumentSchemas.get(command.name) : undefined
  const requestSchemaSource = generatedSchema
    ? generatedSchema.source
    : usesGenericFallback
      ? "generic-fallback"
      : "manifest"
  const operationId = `${audience}Rpc${command.name
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("")}`
  return {
    post: {
      operationId,
      tags: [audience === "public" ? "rpc-dispatch" : "headless-rpc"],
      summary: `${command.name} (${command.capability})`,
      description:
        audience === "public"
          ? `Device-reachable ${command.operation} command. Risk: ${command.risk}; approval: ${command.approval}.`
          : `Loopback service-token command. Target: ${command.target}; risk: ${command.risk}.`,
      "x-cognia-request-schema-source": requestSchemaSource,
      ...(requiresIdempotency
        ? { parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }] }
        : {}),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema:
              generatedSchema !== undefined
                ? prepareRequestSchema(generatedSchema.schema)
                : { $ref: command.inputSchema },
          },
        },
      },
      responses: {
        200: {
          description: "Command completed.",
          content: {
            "application/json": { schema: { $ref: command.outputSchema } },
          },
        },
        400: {
          description: "The request or command arguments are invalid.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/RpcError" } },
          },
        },
        401: {
          description: "Authentication failed.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/RpcError" } },
          },
        },
      },
    },
  }
}

function normalizeRpcPath(path) {
  return path.replace(/^\/api\/v1\/_rpc\//, "/api/_rpc/")
}

export function reconcileRpcPaths({
  publicPaths,
  internalPaths,
  manifest,
  remoteNames,
  argumentSchemas = new Map(),
  preserveExisting = true,
}) {
  const { byName, publicNames, internalNames } = classifyCommands(manifest, remoteNames)
  const publicSet = new Set(publicNames)
  const internalSet = new Set(internalNames)
  const publicResult = {}
  const existingByName = new Map()

  for (const [path, item] of Object.entries(publicPaths)) {
    const normalized = normalizeRpcPath(path)
    const match = normalized.match(/^\/api\/_rpc\/([a-z0-9_]+)$/)
    if (!match) {
      if (normalized !== "/api/_rpc/{name}") publicResult[normalized] = clone(item)
      continue
    }
    existingByName.set(match[1], clone(item))
    if (publicSet.has(match[1])) {
      publicResult[normalized] = preserveExisting
        ? clone(item)
        : genericRpcPath(byName.get(match[1]), "public", argumentSchemas)
    }
  }

  publicResult["/api/_rpc/{name}"] = preserveExisting
    ? clone(
        publicPaths["/api/_rpc/{name}"] ??
          publicPaths["/api/v1/_rpc/{name}"] ?? {
            post: {
              operationId: "rpcDispatch",
              responses: { 200: { description: "Command result." } },
            },
          }
      )
    : {
        post: {
          operationId: "rpcDispatch",
          tags: ["rpc-dispatch"],
          summary: "Dispatch a device-reachable command.",
          parameters: [{ $ref: "#/components/parameters/RpcName" }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RpcArgs" } },
            },
          },
          responses: {
            200: {
              description: "Command completed or was durably accepted.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/RpcResult" } },
              },
            },
            400: { $ref: "#/components/responses/AuthenticationRejected" },
            401: { $ref: "#/components/responses/AuthenticationRejected" },
          },
        },
      }
  publicResult["/api/v1/_rpc/{name}"] = clone(publicResult["/api/_rpc/{name}"])
  publicResult["/api/v1/_rpc/{name}"].post = {
    ...publicResult["/api/v1/_rpc/{name}"].post,
    operationId: "legacyRpcDispatch",
    deprecated: true,
    summary: "Deprecated device-JWT compatibility RPC dispatcher.",
  }
  for (const name of publicNames) {
    publicResult[`/api/_rpc/${name}`] ??= genericRpcPath(
      byName.get(name),
      "public",
      argumentSchemas
    )
  }

  const internalResult = {}
  for (const [path, item] of Object.entries(internalPaths)) {
    if (!path.startsWith("/internal/_rpc/")) internalResult[path] = clone(item)
  }
  internalResult["/internal/_rpc/{name}"] =
    clone(internalPaths["/internal/_rpc/{name}"]) ?? {
      post: {
        operationId: "headlessRpcDispatch",
        tags: ["headless-rpc"],
        summary: "Dispatch a command through the loopback Headless service plane.",
        responses: { 200: { description: "Command result." } },
      },
    }
  for (const name of internalNames) {
    if (!internalSet.has(name)) continue
    internalResult[`/internal/_rpc/${name}`] =
      clone(internalPaths[`/internal/_rpc/${name}`] ?? existingByName.get(name)) ??
      genericRpcPath(byName.get(name), "internal", argumentSchemas)
  }

  return { publicPaths: publicResult, internalPaths: internalResult }
}

export function extractRuntimeRoutePaths(source) {
  return new Set([...source.matchAll(/\.route\(\s*"([^"]+)"\s*,/g)].map((match) => match[1]))
}

export function validateRouteContract({ contract, runtimePaths, publicPaths, internalPaths }) {
  const parsed = routeContractSchema.safeParse(contract)
  if (!parsed.success) return parsed.error.issues.map((issue) => `route contract: ${issue.message}`)
  const errors = []
  const seen = new Set()
  for (const route of parsed.data.routes) {
    const identity = `${route.method.toUpperCase()} ${route.path}`
    if (seen.has(identity)) errors.push(`duplicate route contract entry: ${identity}`)
    seen.add(identity)
    const runtimePath = route.runtimePath ?? route.path
    if (!runtimePaths.has(runtimePath)) errors.push(`not mounted: ${runtimePath}`)
    const paths = route.document === "public" ? publicPaths : internalPaths
    if (route.document !== "none" && !paths[route.path]?.[route.method]) {
      errors.push(`missing from ${route.document} spec: ${identity}`)
    }
  }
  return errors
}

function parseYaml(source, path) {
  const document = parseDocument(source)
  if (document.errors.length > 0) {
    throw new Error(`${path}: ${document.errors.map((error) => error.message).join("; ")}`)
  }
  return document.toJS()
}

function validateGeneratedRequestSchema(schema, location, errors) {
  if (Array.isArray(schema)) {
    schema.forEach((value, index) =>
      validateGeneratedRequestSchema(value, `${location}/${index}`, errors)
    )
    return
  }
  if (!schema || typeof schema !== "object") return
  if (schema.type === "array" && (!schema.items || Object.keys(schema.items).length === 0)) {
    errors.push(`${location}: array request field has no item schema`)
  }
  if (schema.additionalProperties === true) {
    errors.push(`${location}: unconstrained object can generate property1/property2 placeholders`)
  }
  for (const [key, value] of Object.entries(schema)) {
    validateGeneratedRequestSchema(value, `${location}/${key}`, errors)
  }
}

function operationIdFor(method, path) {
  const suffix = path
    .replace(/[{}*]/g, "")
    .split(/[\/_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("")
  return `${method}${suffix}`
}

function authForPath(path) {
  if (
    ["/healthz", "/livez", "/readyz", "/.well-known/agent-card.json"].includes(path) ||
    path.startsWith("/api/auth/device/") ||
    path.startsWith("/api/v1/auth/pair")
  ) {
    return []
  }
  if (path === "/ws/events" || path.startsWith("/ws/terminal") || path.startsWith("/ws/browser")) {
    return []
  }
  if (path.startsWith("/ws/v1/")) return [{ legacyQueryToken: [] }]
  if (path.startsWith("/api/v1/")) return [{ legacyBearer: [] }]
  if (path.startsWith("/internal/") || path.startsWith("/ide/content")) {
    return [{ serviceBearer: [] }]
  }
  return [{ dpopAccess: [] }]
}

export function ensureOperationPathParameters(operation, path) {
  const existingParameters = Array.isArray(operation.parameters) ? operation.parameters : []
  const referencedPathParameters = new Map([
    ["#/components/parameters/RpcName", "name"],
    ["#/components/parameters/WorkflowRunId", "run_id"],
  ])
  const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
  const parameterName = (parameter) => {
    if (parameter?.in === "path" && typeof parameter.name === "string") return parameter.name
    return referencedPathParameters.get(parameter?.$ref)
  }
  const nonPathParameters = existingParameters.filter((parameter) => !parameterName(parameter))
  const pathParameters = pathNames.map((name) => {
    const matching = existingParameters.filter((parameter) => parameterName(parameter) === name)
    return (
      matching.find((parameter) => typeof parameter?.$ref === "string") ??
      matching[0] ?? {
        in: "path",
        name,
        required: true,
        schema: { type: "string" },
      }
    )
  })
  operation.parameters = [...nonPathParameters, ...pathParameters]
  if (operation.parameters.length === 0) delete operation.parameters
}

function genericRoutePath(route) {
  const pathParameters = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    in: "path",
    name: match[1],
    required: true,
    schema: { type: "string" },
  }))
  return {
    [route.method]: {
      operationId: operationIdFor(route.method, route.path),
      tags: [route.path.startsWith("/api/v1/") || route.path.startsWith("/ws/v1/") ? "legacy" : "api"],
      summary: `${route.method.toUpperCase()} ${route.path}`,
      ...(route.path.startsWith("/api/v1/") || route.path.startsWith("/ws/v1/")
        ? { deprecated: true }
        : {}),
      security: authForPath(route.path),
      ...(pathParameters.length > 0 ? { parameters: pathParameters } : {}),
      responses: {
        200: { description: "Successful response." },
        401: {
          $ref:
            route.path.startsWith("/internal/") || route.path.startsWith("/ide/content")
              ? "#/components/responses/ServiceTokenRejected"
              : "#/components/responses/AuthenticationRejected",
        },
      },
    },
  }
}

function mergePathOperation(paths, route, pathItem = genericRoutePath(route)) {
  paths[route.path] = { ...(paths[route.path] ?? {}), ...pathItem }
}

function renamePath(paths, from, to, { retain = false } = {}) {
  if (!paths[from]) return
  paths[to] ??= clone(paths[from])
  if (!retain) delete paths[from]
}

function normalizePublicPaths(paths, contract) {
  const next = clone(paths)
  for (const [from, to] of [
    [
      "/api/v1/workflow-deployments/{deploymentId}/runs",
      "/api/workflow-deployments/{deployment_id}/runs",
    ],
    ["/api/v1/workflow-runs/{runId}", "/api/workflow-runs/{run_id}"],
    ["/api/v1/workflow-runs/{runId}/events", "/api/workflow-runs/{run_id}/events"],
    ["/api/v1/workflow-runs/{runId}/cancel", "/api/workflow-runs/{run_id}/cancel"],
    ["/api/v1/whoami", "/api/whoami"],
  ]) {
    renamePath(next, from, to)
  }
  renamePath(next, "/ws/v1/events", "/ws/events", { retain: true })

  for (const route of contract.routes.filter((entry) => entry.document === "none")) {
    if (!next[route.path]?.[route.method]) continue
    delete next[route.path][route.method]
    if (Object.keys(next[route.path]).length === 0) delete next[route.path]
  }

  for (const route of contract.routes.filter((entry) => entry.document === "public")) {
    if (!next[route.path]?.[route.method]) mergePathOperation(next, route)
    ensureOperationPathParameters(next[route.path][route.method], route.path)
  }

  for (const [path, item] of Object.entries(next)) {
    for (const operation of Object.values(item)) {
      if (!operation || typeof operation !== "object" || !operation.responses) continue
      operation.security = authForPath(path)
      if (path.startsWith("/api/v1/") || path.startsWith("/ws/v1/")) operation.deprecated = true
    }
  }

  const canonicalEvents = next["/ws/events"]?.get
  if (canonicalEvents) {
    canonicalEvents.summary = "Open the canonical event stream with a single-use socket ticket."
    canonicalEvents.parameters = [
      {
        in: "query",
        name: "ticket",
        required: true,
        schema: { type: "string" },
        description: "60-second, path-bound, single-use ticket from POST /api/auth/socket-ticket.",
      },
      {
        in: "query",
        name: "since",
        required: false,
        schema: { type: "integer", minimum: 0 },
      },
    ]
  }
  const legacyEvents = next["/ws/v1/events"]?.get
  if (legacyEvents) legacyEvents.operationId = "legacyWsEvents"

  const workflowDeployment = next["/api/workflow-deployments/{deployment_id}/runs"]?.post
  const deploymentParameter = workflowDeployment?.parameters?.find(
    (parameter) => parameter?.in === "path"
  )
  if (deploymentParameter) deploymentParameter.name = "deployment_id"

  return next
}

function canonicalAuthPaths() {
  const jsonBody = (schema) => ({
    required: true,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  })
  const jsonResponse = (schema, description) => ({
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  })
  return {
    "/api/auth/device/challenge": {
      post: {
        operationId: "issueDeviceChallenge",
        tags: ["device-auth"],
        summary: "Issue a one-minute device proof challenge.",
        security: [],
        requestBody: jsonBody("DeviceChallengeRequest"),
        responses: { 200: jsonResponse("DeviceChallengeResponse", "Challenge issued.") },
      },
    },
    "/api/auth/device/register": {
      post: {
        operationId: "registerDeviceKey",
        tags: ["device-auth"],
        summary: "Register a device public key after invitation or OIDC authorization.",
        security: [],
        requestBody: jsonBody("DeviceRegisterRequest"),
        responses: {
          200: jsonResponse("DeviceRegisterResponse", "Device key registered."),
          401: { $ref: "#/components/responses/AuthenticationRejected" },
          403: { $ref: "#/components/responses/AuthenticationRejected" },
        },
      },
    },
    "/api/auth/token": {
      post: {
        operationId: "issueDeviceAccessToken",
        tags: ["device-auth"],
        summary: "Exchange a signed challenge for a five-minute DPoP-bound access token.",
        security: [],
        requestBody: jsonBody("DeviceTokenRequest"),
        responses: {
          200: jsonResponse("DeviceTokenResponse", "DPoP access token issued."),
          401: { $ref: "#/components/responses/AuthenticationRejected" },
        },
      },
    },
    "/api/auth/socket-ticket": {
      post: {
        operationId: "issueSocketTicket",
        tags: ["device-auth"],
        summary: "Mint a 60-second single-use WebSocket ticket.",
        security: [{ dpopAccess: [] }],
        parameters: [{ $ref: "#/components/parameters/DpopProof" }],
        requestBody: jsonBody("SocketTicketRequest"),
        responses: {
          200: jsonResponse("SocketTicketResponse", "Socket ticket issued."),
          401: { $ref: "#/components/responses/AuthenticationRejected" },
        },
      },
    },
  }
}

function ensurePublicComponents(components, publicNames) {
  const next = clone(components ?? {})
  next.securitySchemes = {
    ...(next.securitySchemes ?? {}),
    dpopAccess: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description: "Five-minute access token bound to the active device key; send a matching DPoP header.",
    },
    legacyBearer: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description: "Deprecated 90-day device JWT accepted only on explicit /api/v1 compatibility routes.",
    },
    legacyQueryToken: {
      type: "apiKey",
      in: "query",
      name: "token",
      description: "Deprecated long-lived device JWT query parameter for released v1 WebSocket clients.",
    },
  }
  next.parameters = {
    ...(next.parameters ?? {}),
    DpopProof: {
      in: "header",
      name: "DPoP",
      required: true,
      schema: { type: "string" },
      description: "Signed proof bound to the access-token jti, HTTP method, and request path.",
    },
    RpcName: {
      in: "path",
      name: "name",
      required: true,
      description: "Device-reachable HTTP command from protocol/companion-commands.json.",
      schema: { type: "string", enum: publicNames },
    },
    IdempotencyKey: {
      in: "header",
      name: "Idempotency-Key",
      required: true,
      schema: { type: "string", format: "uuid" },
      description: "Required for command descriptors whose idempotency field is required.",
    },
  }
  if (next.parameters.WorkflowRunId) next.parameters.WorkflowRunId.name = "run_id"
  next.schemas = {
    ...(next.schemas ?? {}),
    RpcArgs: { type: "object", additionalProperties: true },
    RpcResult: {},
    DeviceChallengeRequest: {
      type: "object",
      additionalProperties: false,
      properties: { tenantId: { type: "string" } },
    },
    DeviceChallengeResponse: {
      type: "object",
      required: ["challengeId", "nonce", "expiresAt"],
      properties: {
        challengeId: { type: "string" },
        nonce: { type: "string" },
        expiresAt: { type: "integer", format: "int64" },
      },
    },
    DeviceRegisterRequest: {
      type: "object",
      additionalProperties: false,
      required: ["challengeId", "challengeNonce", "deviceId", "displayName", "publicKeyPem", "proof"],
      properties: {
        tenantId: { type: "string" },
        invitation: { type: "string" },
        challengeId: { type: "string" },
        challengeNonce: { type: "string" },
        deviceId: { type: "string" },
        displayName: { type: "string" },
        publicKeyPem: { type: "string" },
        proof: { type: "string" },
      },
    },
    DeviceRegisterResponse: {
      type: "object",
      required: ["deviceId", "role"],
      properties: { deviceId: { type: "string" }, role: { type: "string", enum: ["owner", "member"] } },
    },
    DeviceTokenRequest: {
      type: "object",
      additionalProperties: false,
      required: ["deviceId", "challengeId", "challengeNonce", "proof"],
      properties: {
        tenantId: { type: "string" },
        deviceId: { type: "string" },
        challengeId: { type: "string" },
        challengeNonce: { type: "string" },
        proof: { type: "string" },
      },
    },
    DeviceTokenResponse: {
      type: "object",
      required: ["accessToken", "tokenType", "expiresIn"],
      properties: {
        accessToken: { type: "string" },
        tokenType: { type: "string", const: "DPoP" },
        expiresIn: { type: "integer", const: 300 },
      },
    },
    SocketTicketRequest: {
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: { channel: { type: "string", enum: ["events", "terminal", "browser", "acp"] } },
    },
    SocketTicketResponse: {
      type: "object",
      required: ["ticket", "expiresIn"],
      properties: { ticket: { type: "string" }, expiresIn: { type: "integer", const: 60 } },
    },
    CanonicalApiError: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message", "requestId", "retryable", "details"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            requestId: { type: "string", format: "uuid" },
            retryable: { type: "boolean" },
            details: {},
            operationId: { type: "string" },
          },
        },
      },
    },
  }
  next.responses = {
    ...(next.responses ?? {}),
    AuthenticationRejected: {
      description: "Authentication or authorization rejected.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/CanonicalApiError" } } },
    },
  }
  const sidecarPath = next.schemas.McpServerLifecycleRequest?.properties?.sidecarPath
  if (sidecarPath) {
    sidecarPath.description =
      "Legacy local-Tauri hint; ignored by the headless Companion facade, which resolves the packaged host sidecar."
    delete sidecarPath["which resolves the packaged host sidecar."]
  }
  return next
}

function orderPaths(paths, contract, prefix) {
  const ordered = {}
  for (const route of contract.routes.filter((entry) => entry.document === prefix)) {
    if (paths[route.path]) ordered[route.path] = paths[route.path]
  }
  for (const path of Object.keys(paths).sort()) {
    if (!ordered[path]) ordered[path] = paths[path]
  }
  return ordered
}

function buildPublicSpec(base, contract, manifest, remoteNames, argumentSchemas) {
  const classified = classifyCommands(manifest, remoteNames)
  const reconciled = reconcileRpcPaths({
    publicPaths: base.paths ?? {},
    internalPaths: {},
    manifest,
    remoteNames,
    argumentSchemas,
    preserveExisting: false,
  })
  let paths = normalizePublicPaths(reconciled.publicPaths, contract)
  paths = { ...paths, ...canonicalAuthPaths() }
  for (const name of classified.publicNames) {
    const operation = paths[`/api/_rpc/${name}`]?.post
    if (operation) operation.security = [{ dpopAccess: [] }]
  }
  paths["/api/v1/_rpc/{name}"].post.security = [{ legacyBearer: [] }]
  return normalizeOpenApi31({
    ...base,
    info: {
      ...base.info,
      title: "Cognia Companion Device API",
      summary: "Canonical DPoP device API plus explicitly deprecated v1 compatibility routes.",
      description:
        "The canonical device surface uses unversioned /api and /ws routes, five-minute DPoP-bound access tokens, and 60-second single-use WebSocket tickets. Explicit /api/v1 and /ws/v1 entries are deprecated compatibility routes for released mobile clients; service-token Headless routes are documented separately.",
    },
    servers: [
      { url: "https://127.0.0.1:27890", description: "Default TLS loopback listener." },
      { url: "https://{companionHost}", description: "LAN or managed deployment front door.", variables: { companionHost: { default: "cognia.example.com" } } },
    ],
    security: [],
    paths: orderPaths(paths, contract, "public"),
    components: ensurePublicComponents(base.components, classified.publicNames),
    "x-cognia-generated": {
      sources: [
        COMMAND_MANIFEST_PATH,
        ROUTE_CONTRACT_PATH,
        REQUEST_SCHEMA_CATALOG_PATH,
        RPC_SOURCE_PATH,
        ZOD_REQUEST_SCHEMA_PATH,
      ],
      publicCommandCount: classified.publicNames.length,
      generatedRequestSchemaCount: classified.publicNames.filter((name) =>
        argumentSchemas.has(name)
      ).length,
      runtimeInferredRequestSchemaCount: classified.publicNames.filter(
        (name) => argumentSchemas.get(name)?.source === "runtime-inferred"
      ).length,
      contractRequestSchemaCount: classified.publicNames.filter((name) =>
        ["contract", "zod-contract"].includes(argumentSchemas.get(name)?.source)
      ).length,
      genericRequestSchemaCount: classified.publicNames.filter(
        (name) =>
          !argumentSchemas.has(name) &&
          classified.byName.get(name).inputSchema === "#/components/schemas/RpcArgs"
      ).length,
      legacyCompatibility: true,
    },
  })
}

function normalizeOpenApi31(value) {
  if (Array.isArray(value)) return value.map(normalizeOpenApi31)
  if (!value || typeof value !== "object") return value
  const next = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "nullable") continue
    next[key] = normalizeOpenApi31(child)
  }
  if (value.nullable === true && typeof next.type === "string") next.type = [next.type, "null"]
  return next
}

function headlessBaseSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Cognia Headless Service API",
      version: "0.1.0",
      license: { name: "Proprietary" },
      summary: "Loopback-only authenticated RPC and WebSocket plane for the renderer-free Brain.",
      description: [
        "This is an internal development and deployment contract, not a paired-device API.",
        "For local debugging, `pnpm dev:headless --local-debug` creates a process-scoped opaque token and an importable Apifox/Postman environment.",
        "The 24-hour service JWT from `pnpm --silent dev:headless token` remains available for persistent clients. Both credentials are rejected from non-loopback peers.",
      ].join("\n"),
    },
    servers: [{ url: "https://127.0.0.1:27890", description: "Default renderer-free development listener." }],
    security: [{ serviceBearer: [] }],
    tags: [
      { name: "headless-rpc", description: "Commands shared with the Headless Brain." },
      { name: "headless-events", description: "Server-to-Brain event stream." },
      { name: "headless-bridge", description: "Bidirectional data-plane bridge." },
      { name: "ide-content", description: "Loopback content broker for managed IDEs." },
    ],
    paths: {
      "/internal/_rpc/{name}": {
        post: {
          operationId: "headlessRpcDispatch",
          tags: ["headless-rpc"],
          summary: "Dispatch a command with a loopback service token.",
          parameters: [{ $ref: "#/components/parameters/InternalRpcName" }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RpcArgs" } } },
          },
          responses: {
            200: { description: "Command result.", content: { "application/json": { schema: { $ref: "#/components/schemas/RpcResult" } } } },
            401: { $ref: "#/components/responses/ServiceTokenRejected" },
            403: { $ref: "#/components/responses/ServiceTokenRejected" },
          },
        },
      },
      "/internal/events": {
        get: {
          operationId: "headlessEvents",
          tags: ["headless-events"],
          summary: "Open the Brain event stream.",
          security: [{ serviceQueryToken: [] }],
          parameters: [
            { in: "query", name: "since", required: false, schema: { type: "integer", minimum: 0 } },
          ],
          responses: { 101: { description: "WebSocket upgrade accepted." } },
        },
      },
      "/internal/bridge": {
        get: {
          operationId: "headlessBridge",
          tags: ["headless-bridge"],
          summary: "Open the bidirectional Rust-to-Brain data-plane bridge.",
          security: [{ serviceQueryToken: [] }],
          responses: { 101: { description: "WebSocket upgrade accepted." } },
        },
      },
      "/ide/content": genericRoutePath({ path: "/ide/content", method: "post" }),
      "/ide/content/{handle_id}": genericRoutePath({ path: "/ide/content/{handle_id}", method: "get" }),
    },
    components: {
      securitySchemes: {
        serviceBearer: {
          type: "http",
          scheme: "bearer",
          description: "Process-scoped local-debug opaque token or a 24-hour service JWT.",
        },
        serviceQueryToken: { type: "apiKey", in: "query", name: "token" },
      },
      parameters: {
        InternalRpcName: { in: "path", name: "name", required: true, schema: { type: "string", enum: [] } },
        IdempotencyKey: { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", format: "uuid" } },
      },
      schemas: {
        RpcArgs: { type: "object", additionalProperties: true },
        RpcResult: {},
        RpcError: {
          type: "object",
          required: ["code", "message"],
          properties: { code: { type: "string" }, message: { type: "string" } },
        },
      },
      responses: {
        ServiceTokenRejected: {
          description: "The token is missing, invalid, not service-scoped, or presented by a non-loopback peer.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
      },
    },
  }
}

function buildHeadlessSpec(base, contract, manifest, remoteNames, argumentSchemas) {
  const classified = classifyCommands(manifest, remoteNames)
  const reconciled = reconcileRpcPaths({
    publicPaths: {},
    internalPaths: base.paths ?? {},
    manifest,
    remoteNames,
    argumentSchemas,
  })
  const paths = reconciled.internalPaths
  for (const route of contract.routes.filter((entry) => entry.document === "headless")) {
    if (!paths[route.path]?.[route.method]) mergePathOperation(paths, route)
  }
  const components = clone(base.components)
  components.parameters.InternalRpcName.schema.enum = classified.internalNames
  return normalizeOpenApi31({
    ...base,
    paths: orderPaths(paths, contract, "headless"),
    components,
    "x-cognia-generated": {
      sources: [
        COMMAND_MANIFEST_PATH,
        ROUTE_CONTRACT_PATH,
        REQUEST_SCHEMA_CATALOG_PATH,
        RPC_SOURCE_PATH,
        ZOD_REQUEST_SCHEMA_PATH,
      ],
      internalCommandCount: classified.internalNames.length,
      generatedRequestSchemaCount: classified.internalNames.filter((name) =>
        argumentSchemas.has(name)
      ).length,
      runtimeInferredRequestSchemaCount: classified.internalNames.filter(
        (name) => argumentSchemas.get(name)?.source === "runtime-inferred"
      ).length,
      contractRequestSchemaCount: classified.internalNames.filter((name) =>
        ["contract", "zod-contract"].includes(argumentSchemas.get(name)?.source)
      ).length,
      genericRequestSchemaCount: classified.internalNames.filter(
        (name) =>
          !argumentSchemas.has(name) &&
          classified.byName.get(name).inputSchema === "#/components/schemas/RpcArgs"
      ).length,
      loopbackOnly: true,
    },
  })
}

function renderSpec(spec) {
  return stringify(spec, { indent: 2, lineWidth: 120, sortMapEntries: false })
}

function extractKnownCommands(source) {
  const match = source.match(/const KNOWN_COMMANDS[^=]*=\s*&\[([\s\S]*?)\n\];/)
  if (!match) throw new Error("Could not locate KNOWN_COMMANDS in rpc.rs")
  return new Set([...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]))
}

function createProgram() {
  return new Command()
    .name("pnpm companion-api:gen")
    .description("Generate and verify the Cognia public and Headless API contracts.")
    .option("--check", "Fail instead of writing when generated API artifacts drift.")
    .showHelpAfterError()
    .exitOverride()
}

function readRepo(path) {
  return readFileSync(resolve(repoRoot, path), "utf8")
}

export function inspectCommittedContract() {
  const manifest = JSON.parse(readRepo(COMMAND_MANIFEST_PATH))
  const contract = JSON.parse(readRepo(ROUTE_CONTRACT_PATH))
  const requestSchemaCatalog = requestSchemaCatalogSchema.parse(
    JSON.parse(readRepo(REQUEST_SCHEMA_CATALOG_PATH))
  )
  const publicSource = readRepo(PUBLIC_SPEC_PATH)
  let headlessSource = ""
  try {
    headlessSource = readRepo(HEADLESS_SPEC_PATH)
  } catch {
    // The first generator run creates the dedicated Headless contract.
  }
  const publicSpec = parseYaml(publicSource, PUBLIC_SPEC_PATH)
  const runtimePaths = new Set()
  for (const sourcePath of RUNTIME_ROUTE_SOURCES) {
    for (const route of extractRuntimeRoutePaths(readRepo(sourcePath))) runtimePaths.add(route)
  }
  const remoteNames = extractKnownCommands(readRepo(RPC_SOURCE_PATH))
  const inferredArgumentSchemas = extractCommandArgumentSchemas(readRepo(RPC_SOURCE_PATH))
  const argumentSchemas = new Map(
    [...inferredArgumentSchemas].map(([name, schema]) => [
      name,
      { source: "runtime-inferred", schema },
    ])
  )
  for (const [name, schema] of Object.entries(requestSchemaCatalog.commands)) {
    argumentSchemas.set(name, { source: "contract", schema })
  }
  const zodRequestSchemas = buildCompanionRequestSchemaContracts()
  for (const [name, schema] of zodRequestSchemas) {
    argumentSchemas.set(name, { source: "zod-contract", schema })
  }
  const desiredPublicSpec = buildPublicSpec(
    publicSpec,
    contract,
    manifest,
    remoteNames,
    argumentSchemas
  )
  const desiredHeadlessSpec = buildHeadlessSpec(
    headlessBaseSpec(),
    contract,
    manifest,
    remoteNames,
    argumentSchemas
  )
  const desiredPublicSource = renderSpec(desiredPublicSpec)
  const desiredHeadlessSource = renderSpec(desiredHeadlessSpec)
  const errors = validateRouteContract({
    contract,
    runtimePaths,
    publicPaths: desiredPublicSpec.paths ?? {},
    internalPaths: desiredHeadlessSpec.paths ?? {},
  })
  const classified = classifyCommands(manifest, remoteNames)
  for (const name of classified.publicNames) {
    if (!desiredPublicSpec.paths[`/api/_rpc/${name}`]) {
      errors.push(`public command missing from generated spec: ${name}`)
    }
  }
  for (const name of classified.internalNames) {
    const path = `/internal/_rpc/${name}`
    const operation = desiredHeadlessSpec.paths[path]?.post
    if (!operation) {
      errors.push(`internal command missing from generated spec: ${name}`)
      continue
    }
    if (operation["x-cognia-request-schema-source"] === "generic-fallback") {
      errors.push(`internal command has no concrete request schema: ${name}`)
    }
    validateGeneratedRequestSchema(
      operation.requestBody?.content?.["application/json"]?.schema,
      path,
      errors
    )
  }
  for (const name of Object.keys(requestSchemaCatalog.commands)) {
    if (!classified.byName.has(name)) errors.push(`request schema has no command descriptor: ${name}`)
  }
  for (const name of zodRequestSchemas.keys()) {
    if (!classified.byName.has(name)) errors.push(`Zod request schema has no command descriptor: ${name}`)
  }
  return {
    contract,
    manifest,
    publicSpec,
    runtimePaths,
    remoteNames,
    desiredPublicSpec,
    desiredHeadlessSpec,
    desiredPublicSource,
    desiredHeadlessSource,
    publicDrift: publicSource !== desiredPublicSource,
    headlessDrift: headlessSource !== desiredHeadlessSource,
    errors,
  }
}

async function main(argv = process.argv.slice(2)) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return
    throw error
  }
  const { check } = program.opts()
  const inspected = inspectCommittedContract()
  if (inspected.errors.length > 0) {
    throw new Error(inspected.errors.join("\n"))
  }
  if (check && (inspected.publicDrift || inspected.headlessDrift)) {
    const drift = [
      inspected.publicDrift ? PUBLIC_SPEC_PATH : null,
      inspected.headlessDrift ? HEADLESS_SPEC_PATH : null,
    ].filter(Boolean)
    throw new Error(`generated artifacts drifted: ${drift.join(", ")}; run pnpm companion-api:gen`)
  }
  if (!check) {
    writeFileSync(resolve(repoRoot, PUBLIC_SPEC_PATH), inspected.desiredPublicSource)
    writeFileSync(resolve(repoRoot, HEADLESS_SPEC_PATH), inspected.desiredHeadlessSource)
  }
  process.stdout.write(
    `[companion-api] OK: ${inspected.remoteNames.size} remote commands, ` +
      `${inspected.contract.routes.length} classified routes\n`
  )
}

const isEntry = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntry) {
  main().catch((error) => {
    process.stderr.write(`[companion-api] ${error.message}\n`)
    process.exitCode = 1
  })
}
