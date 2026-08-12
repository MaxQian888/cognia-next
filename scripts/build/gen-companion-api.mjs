#!/usr/bin/env node

import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { parseDocument, stringify } from "yaml"
import { z } from "zod"

import { buildCompanionRequestSchemaContracts } from "./companion-request-schema-contracts.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const PUBLIC_SPEC_PATH = "docs/api/mobile-companion-api.openapi.yaml"
const HEADLESS_SPEC_PATH = "docs/api/headless-service-api.openapi.yaml"
const HEADLESS_ASYNCAPI_SPEC_PATH = "docs/api/headless-service-api.asyncapi.yaml"
const HOST_COMMAND_CATALOG_PATH = "crates/cognia-cli/assets/host-command-catalog.json"
const HEADLESS_CONTRACT_IDENTITY_PATH = "cli/src/serve/headless-contract-identity.ts"
const BRIDGE_FIXTURE_PATH = "cli/src/serve/fixtures/bridge-frames.json"
const BRIDGE_PROTOCOL_VERSION = 3
const ROUTE_CONTRACT_PATH = "protocol/companion-api-routes.json"
const COMMAND_MANIFEST_PATH = "protocol/companion-commands.json"
const REQUEST_SCHEMA_CATALOG_PATH = "protocol/companion-request-schemas.json"
const RESPONSE_SCHEMA_CATALOG_PATH = "protocol/companion-response-schemas.json"
const HEADLESS_DISPOSITIONS_PATH = "protocol/headless-command-dispositions.json"
const ZOD_REQUEST_SCHEMA_PATH = "scripts/build/companion-request-schema-contracts.mjs"
const RPC_SOURCE_PATH = "src-tauri/src/companion_api/rpc.rs"
const RPC_DISPATCH_SOURCE_PATHS = [
  "src-tauri/src/companion_api/rpc/chat.rs",
  "src-tauri/src/companion_api/rpc/codex_app.rs",
  "src-tauri/src/companion_api/rpc/native_tools.rs",
  "src-tauri/src/companion_api/rpc/data_sync.rs",
  "src-tauri/src/companion_api/rpc/service_plane.rs",
  "src-tauri/src/companion_api/rpc/source_control.rs",
  "src-tauri/src/companion_api/rpc/filesystem.rs",
  "src-tauri/src/companion_api/rpc/terminal.rs",
  "src-tauri/src/companion_api/rpc/plugins.rs",
  "src-tauri/src/companion_api/rpc/diagnostics.rs",
]
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

const responseSchemaCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  $defs: z.record(z.string(), z.record(z.string(), z.unknown())),
  commands: z.record(z.string(), z.record(z.string(), z.unknown())),
})

const headlessDispositionsSchema = z.object({
  schemaVersion: z.literal(1),
  groups: z.array(
    z.object({
      disposition: z.enum([
        "local-only",
        "covered-by-headless",
        "runtime-internal",
        "separate-design-required",
        "in-progress",
      ]),
      reason: z.string().min(1),
      commands: z.array(z.string().min(1)),
    })
  ),
})

function flattenHeadlessDispositions(catalog, manifest) {
  const dispositions = new Map()
  const errors = []
  for (const group of catalog.groups) {
    for (const name of group.commands) {
      if (dispositions.has(name)) {
        errors.push(`duplicate Headless disposition: ${name}`)
        continue
      }
      dispositions.set(name, {
        disposition: group.disposition,
        reason: group.reason,
      })
    }
  }
  const byName = new Map(manifest.commands.map((command) => [command.name, command]))
  for (const command of manifest.commands) {
    if (command.target === "client" && !dispositions.has(command.name)) {
      errors.push(`client command has no Headless disposition: ${command.name}`)
    }
  }
  for (const name of dispositions.keys()) {
    const command = byName.get(name)
    if (!command) errors.push(`Headless disposition has no command descriptor: ${name}`)
    else if (command.target !== "client") {
      errors.push(`remote command must not have a Headless exclusion disposition: ${name}`)
    }
  }
  return { dispositions, errors }
}

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

export function validateCommandCoverage(manifest, dispatchNames) {
  const errors = []
  const descriptors = new Map()
  for (const command of manifest.commands) {
    if (descriptors.has(command.name)) {
      errors.push(`duplicate command descriptor: ${command.name}`)
      continue
    }
    descriptors.set(command.name, command)
    if (command.operation !== "read" && command.idempotency !== "required") {
      errors.push(`mutation must use durable idempotency: ${command.name}`)
    }
    if (
      command.target === "service" &&
      (command.transports.length !== 1 || command.transports[0] !== "internal")
    ) {
      errors.push(`service command must be internal-only: ${command.name}`)
    }
    if (command.target !== "client" && !dispatchNames.has(command.name)) {
      errors.push(`remote command has no canonical dispatch arm: ${command.name}`)
    }
  }
  for (const name of dispatchNames) {
    if (!descriptors.has(name)) errors.push(`dispatch arm has no command descriptor: ${name}`)
  }
  return errors
}

function clone(value) {
  return structuredClone(value)
}

function rewriteLegacyComponentReferences(value) {
  if (typeof value === "string") {
    return value.replace(
      "#/components/responses/JwtRejected",
      "#/components/responses/AuthenticationRejected",
    )
  }
  if (Array.isArray(value)) return value.map(rewriteLegacyComponentReferences)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, rewriteLegacyComponentReferences(child)])
  )
}

function mergeClosedObjectAllOf(schema) {
  if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) return schema
  const branches = schema.allOf
  const closedObjectBranches = branches.filter(
    (branch) =>
      branch?.type === "object" &&
      branch.additionalProperties === false &&
      branch.properties &&
      typeof branch.properties === "object" &&
      !Array.isArray(branch.properties),
  )
  if (closedObjectBranches.length === 0) return schema
  if (closedObjectBranches.length !== branches.length) {
    throw new Error("cannot safely merge mixed closed-object allOf request schema")
  }

  const properties = {}
  const required = []
  for (const branch of branches) {
    const unsupported = Object.keys(branch).filter(
      (key) => !["type", "required", "properties", "additionalProperties"].includes(key),
    )
    if (unsupported.length > 0) {
      throw new Error(
        `cannot safely merge closed-object allOf keywords: ${unsupported.sort().join(", ")}`,
      )
    }
    for (const [name, propertySchema] of Object.entries(branch.properties)) {
      if (
        Object.hasOwn(properties, name) &&
        JSON.stringify(properties[name]) !== JSON.stringify(propertySchema)
      ) {
        throw new Error(`conflicting closed-object allOf property: ${name}`)
      }
      properties[name] = propertySchema
    }
    for (const name of branch.required ?? []) {
      if (!required.includes(name)) required.push(name)
    }
  }
  const { allOf: _allOf, ...siblings } = schema
  return {
    ...siblings,
    type: "object",
    ...(required.length > 0 ? { required } : {}),
    properties,
    additionalProperties: false,
  }
}

function prepareRequestSchema(value) {
  if (Array.isArray(value)) return value.map(prepareRequestSchema)
  if (!value || typeof value !== "object") return value
  let next = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, prepareRequestSchema(child)])
  )
  next = mergeClosedObjectAllOf(next)
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

const HOST_CATEGORIES = [
  {
    id: "sessions",
    title: "Sessions and messages",
    description: "Chat sessions, messages, conversations, characters, and transcripts.",
    skill: "cognia-host-sessions",
    pattern: /^(session_|message_|conversation_|character_|transcript_)/,
  },
  {
    id: "agents",
    title: "Agents and teams",
    description: "Agent runtimes, Claude sessions, teams, fleet controls, and goals.",
    skill: "cognia-host-agents",
    pattern:
      /^(agent_|claude_|codex_app_|external_agent_|spawn_external_agent$|send_to_external_agent$|kill_external_agent$|get_external_agent_status$|fleet_|team_|goal_)/,
  },
  {
    id: "tasks",
    title: "Tasks and workspaces",
    description: "Task lifecycle, resources, patches, runs, and workspace settlement.",
    skill: "cognia-host-tasks",
    pattern: /^task_/,
  },
  {
    id: "automation",
    title: "Workflows and automation",
    description: "Workflows, schedules, background jobs, monitors, and consent decisions.",
    skill: "cognia-host-automation",
    pattern: /^(workflow_|scheduled_task_|automation_|background_)/,
  },
  {
    id: "connectors",
    title: "Connectors and integrations",
    description: "Connector transports, integration ingress, Lark, notifications, and adapters.",
    skill: "cognia-host-connectors",
    pattern:
      /^(adapter_|connector_|connectors_|integration_|lark_|remote_notification_publish$|register_push_token$|revoke_push_token$)/,
  },
  {
    id: "extensions",
    title: "Extensions and providers",
    description: "Plugins, skills, MCP servers, provider catalogs, and diagnostics.",
    skill: "cognia-host-extensions",
    pattern: /^(plugin_|skill_|skills_|mcp_|provider_)/,
  },
  {
    id: "knowledge",
    title: "Knowledge and intelligence",
    description: "Memory, digital twins, ingestion jobs, and OCR models.",
    skill: "cognia-host-knowledge",
    pattern: /^(memory_|twin_|ocr_)/,
  },
  {
    id: "development",
    title: "Development tools",
    description: "Git, files, terminals, browsers, code-server, and language servers.",
    skill: "cognia-host-development",
    pattern:
      /^(browser_|codeserver_|fs_|git_|github_workspace_|project_environment_|terminal_|lsp_|ensure_dir$|ensure_dir_confined$|ensure_system_lsp_host$|read_agent_config$|write_agent_config$|read_text_file$|write_text_file$|write_text_file_confined$|default_export_dir$)/,
  },
  {
    id: "system",
    title: "System and security",
    description: "Host capabilities, service secrets, backups, sync, logs, and bridge administration.",
    skill: "cognia-host-system",
    pattern: /^(app_|backup_|companion_|device_|external_bridge_|host_|keyring_|logs_|secret_|sync_)/,
  },
]

export function classifyHostCommand(name) {
  const matches = HOST_CATEGORIES.filter((category) => category.pattern.test(name))
  if (matches.length !== 1) {
    throw new Error(
      `Headless command must match exactly one host category: ${name} (${matches
        .map((category) => category.id)
        .join(", ")})`,
    )
  }
  return matches[0].id
}

const HOST_RESOURCE_ALIASES = [
  [/^(?:agent_task_|team_task_)/, "agent-tasks"],
  [/^app_settings_/, "settings"],
  [/^automation_consent_/, "automation-consent"],
  [/^background_job_/, "background-jobs"],
  [/^background_monitor_/, "background-monitors"],
  [/^external_agent_|^(?:spawn|send_to|kill)_external_agent$|^get_external_agent_status$/, "external-agents"],
  [/^external_bridge_/, "external-bridge"],
  [/^host_admin_lease_/, "admin-leases"],
  [/^integration_ingress_/, "integration-ingress"],
  [/^github_workspace_/, "github-workspaces"],
  [/^(?:keyring_secret_|secret_store_)/, "secrets"],
  [/^plugin_python_/, "plugin-python"],
  [/^plugin_wasm_/, "plugin-wasm"],
  [/^plugin_.*vscode|^plugin_vscode_/, "plugin-vscode"],
  [/^plugin_(?:permission|set_(?:network|shell)_allowlist)/, "plugin-permissions"],
  [/^plugin_(?:backup|stage|commit_staged|discard_staged|finalize_staged)/, "plugin-updates"],
  [/^provider_catalog_/, "provider-catalog"],
  [/^provider_diagnostics_/, "provider-diagnostics"],
  [/^provider_profiles_/, "provider-profiles"],
  [/^project_environment_/, "project-environments"],
  [/^scheduled_task_/, "scheduled-tasks"],
  [/^(?:skill_|skills_)/, "skills"],
  [/^task_resource_/, "task-resources"],
  [/^task_workspace_/, "task-workspaces"],
  [/^(?:connector_|connectors_|adapter_)/, "connectors"],
  [/^(?:register_push_token|revoke_push_token|remote_notification_publish)$/, "notifications"],
  [/^(?:ensure_dir|ensure_dir_confined|default_export_dir|read_text_file|write_text_file|write_text_file_confined)$/, "files"],
  [/^fs_/, "workspace-files"],
  [/^(?:read_agent_config|write_agent_config)$/, "agent-config"],
  [/^(?:ensure_system_lsp_host|lsp_host_)/, "language-servers"],
]

const HOST_RESOURCE_TITLES = new Map([
  ["agent-config", "Agent Configuration"],
  ["codeserver", "Code Server"],
  ["mcp", "MCP"],
  ["ocr", "OCR"],
  ["plugin-vscode", "Plugin VS Code"],
])

export function hostResourceForCommand(name) {
  const aliases = HOST_RESOURCE_ALIASES.filter(([pattern]) => pattern.test(name))
  if (aliases.length > 1) {
    throw new Error(
      `Headless command matches multiple host resources: ${name} (${aliases
        .map(([, resource]) => resource)
        .join(", ")})`,
    )
  }
  return aliases[0]?.[1] ?? name.split("_", 1)[0]
}

function hostResourceTitle(resource) {
  const title = HOST_RESOURCE_TITLES.get(resource)
  if (title) return title
  return resource
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ")
}

export function buildHostCommandCatalog(manifest, remoteNames, headlessSpec) {
  const { byName, internalNames } = classifyCommands(manifest, remoteNames)
  const commands = internalNames.map((name) => {
    const descriptor = byName.get(name)
    const operation = headlessSpec.paths[`/internal/_rpc/${name}`]?.post
    if (!operation) throw new Error(`cannot catalog missing Headless command: ${name}`)
    return {
      name,
      category: classifyHostCommand(name),
      resource: hostResourceForCommand(name),
      target: descriptor.target,
      operation: descriptor.operation,
      capability: descriptor.capability,
      risk: descriptor.risk,
      approval: descriptor.approval,
      idempotency: descriptor.idempotency,
      summary: operation.summary ?? "",
      description: operation.description ?? "",
      inputSchemaSource: operation["x-cognia-request-schema-source"],
      inputSchema: operation.requestBody?.content?.["application/json"]?.schema,
      outputSchemaSource: operation["x-cognia-response-schema-source"] ?? null,
      outputSchema:
        operation["x-cognia-response-schema-source"] === "contract"
          ? operation.responses?.[200]?.content?.["application/json"]?.schema
          : null,
      outputTyped: operation["x-cognia-response-schema-source"] === "contract",
    }
  })
  const categories = HOST_CATEGORIES.map(({ pattern: _pattern, ...category }) => category)
  const resources = [...new Set(commands.map((command) => command.resource))]
    .sort()
    .map((id) => {
      const categories = [
        ...new Set(
          commands.filter((command) => command.resource === id).map((command) => command.category),
        ),
      ]
      if (categories.length !== 1) {
        throw new Error(`host resource spans multiple categories: ${id} (${categories.join(", ")})`)
      }
      return { id, title: hostResourceTitle(id), category: categories[0] }
    })
  const payload = { schemaVersion: 1, categories, resources, commands }
  return {
    ...payload,
    catalogHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  }
}

function renderHostCommandCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`
}

function renderHeadlessContractIdentity(catalog) {
  return `/** Generated by scripts/build/gen-companion-api.mjs. Do not edit. */\nexport const HEADLESS_CONTRACT_VERSION = ${catalog.schemaVersion} as const\nexport const HEADLESS_CATALOG_HASH = ${JSON.stringify(catalog.catalogHash)} as const\n`
}

function renderBridgeFixture(source, catalog) {
  const fixture = JSON.parse(source)
  fixture.protocol = BRIDGE_PROTOCOL_VERSION
  for (const frame of Object.values(fixture.frames ?? {})) frame.v = BRIDGE_PROTOCOL_VERSION
  for (const name of ["hello", "helloAck"]) {
    fixture.frames[name].protocol = BRIDGE_PROTOCOL_VERSION
    fixture.frames[name].catalogHash = catalog.catalogHash
    fixture.frames[name].contractVersion = catalog.schemaVersion
  }
  return `${JSON.stringify(fixture, null, 2)}\n`
}

function materializeResponseSchema(value, definitions, stack = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => materializeResponseSchema(entry, definitions, stack))
  }
  if (!value || typeof value !== "object") return value
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
    const name = value.$ref.slice("#/$defs/".length)
    const definition = definitions[name]
    if (!definition) throw new Error(`unknown response schema definition: ${name}`)
    if (stack.includes(name)) {
      throw new Error(`cyclic response schema definition: ${[...stack, name].join(" -> ")}`)
    }
    const { $ref: _ref, ...siblings } = value
    return {
      ...materializeResponseSchema(definition, definitions, [...stack, name]),
      ...materializeResponseSchema(siblings, definitions, stack),
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      materializeResponseSchema(child, definitions, stack),
    ])
  )
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

function completedRpcSchema(resultSchema = {}) {
  return {
    type: "object",
    required: ["requestId", "result"],
    additionalProperties: false,
    properties: {
      requestId: { type: "string", format: "uuid" },
      operationId: { type: "string", format: "uuid" },
      result: resultSchema,
    },
  }
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
            "application/json": {
              schema:
                audience === "public"
                  ? completedRpcSchema({ $ref: command.outputSchema })
                  : { $ref: command.outputSchema },
            },
          },
        },
        202: {
          description: "Command is still running under the durable operation ledger.",
          content: {
            "application/json": {
              schema: {
                $ref:
                  audience === "public"
                    ? "#/components/schemas/RpcRunningResponse"
                    : "#/components/schemas/InternalRpcRunningResponse",
              },
            },
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
        403: {
          description: "Capability, transport, or policy authorization failed.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
        404: {
          description: "The command is not registered.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
        409: {
          description: "The idempotency key conflicts with an existing operation.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
        415: {
          description: "The request body is not JSON.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
        422: {
          description: "The JSON request body does not match the endpoint shape.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
        428: {
          description: "A valid signed policy is required.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
        429: {
          description: "The principal exceeded its command rate limit.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
        500: {
          description: "The canonical dispatch failed.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
        503: {
          description: "The durable security store is unavailable.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
      },
    },
  }
}

export function reconcileRpcPaths({
  publicPaths,
  internalPaths,
  manifest,
  remoteNames,
  argumentSchemas = new Map(),
  preserveExisting = true,
}) {
  const versionedPaths = Object.keys(publicPaths).filter((path) =>
    /^\/(?:api|ws)\/v\d+\//.test(path)
  )
  if (versionedPaths.length > 0) {
    throw new Error(`versioned public paths are forbidden: ${versionedPaths.sort().join(", ")}`)
  }
  const { byName, publicNames, internalNames } = classifyCommands(manifest, remoteNames)
  const publicSet = new Set(publicNames)
  const internalSet = new Set(internalNames)
  const publicResult = {}
  const existingByName = new Map()

  for (const [path, item] of Object.entries(publicPaths)) {
    const match = path.match(/^\/api\/_rpc\/([a-z0-9_]+)$/)
    if (!match) {
      if (path !== "/api/_rpc/{name}") publicResult[path] = clone(item)
      continue
    }
    existingByName.set(match[1], clone(item))
    if (publicSet.has(match[1])) {
      publicResult[path] = preserveExisting
        ? clone(item)
        : genericRpcPath(byName.get(match[1]), "public", argumentSchemas)
    }
  }

  publicResult["/api/_rpc/{name}"] = preserveExisting
    ? clone(
        publicPaths["/api/_rpc/{name}"] ?? {
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
              description: "Command completed.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RpcCompletedResponse" },
                },
              },
            },
            202: {
              description: "Command is still running under the durable operation ledger.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RpcRunningResponse" },
                },
              },
            },
            400: { $ref: "#/components/responses/PublicApiError" },
            401: { $ref: "#/components/responses/AuthenticationRejected" },
            403: { $ref: "#/components/responses/AuthenticationRejected" },
            404: { $ref: "#/components/responses/PublicApiError" },
            409: { $ref: "#/components/responses/PublicApiError" },
            415: { $ref: "#/components/responses/PublicApiError" },
            422: { $ref: "#/components/responses/PublicApiError" },
            428: { $ref: "#/components/responses/PublicApiError" },
            429: { $ref: "#/components/responses/PublicApiError" },
            500: { $ref: "#/components/responses/PublicApiError" },
            503: { $ref: "#/components/responses/PublicApiError" },
          },
        },
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

const AXUM_ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "any"]
const AXUM_ROUTE_METHOD_PATTERN = new RegExp(`^\\s*(${AXUM_ROUTE_METHODS.join("|")})\\s*\\(`)

function readRouteExpression(source, start) {
  let depth = 1
  let quote = null
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === "(") {
      depth += 1
    } else if (character === ")") {
      depth -= 1
      if (depth === 0) return source.slice(start, index)
    }
  }
  return source.slice(start)
}

function extractRouteMethods(expression) {
  const initial = expression.match(AXUM_ROUTE_METHOD_PATTERN)
  if (!initial) return []
  const methods = [initial[1]]
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === "(") {
      depth += 1
      continue
    }
    if (character === ")") {
      depth -= 1
      continue
    }
    if (depth !== 0 || character !== ".") continue
    const chained = expression
      .slice(index + 1)
      .match(new RegExp(`^(${AXUM_ROUTE_METHODS.join("|")})\\s*\\(`))
    if (chained) methods.push(chained[1])
  }
  return methods
}

export function extractRuntimeRoutes(source) {
  const testModule = source.search(/^\s*#\[cfg\(test\)\]\s*\n\s*mod tests\s*\{/m)
  const runtimeSource = testModule === -1 ? source : source.slice(0, testModule)
  const routes = new Set()
  const routePattern = /\.route\(\s*"([^"]+)"\s*,/g
  for (const match of runtimeSource.matchAll(routePattern)) {
    const expression = readRouteExpression(runtimeSource, match.index + match[0].length)
    for (const method of extractRouteMethods(expression)) {
      routes.add(`${method === "any" ? "*" : method.toUpperCase()} ${match[1]}`)
    }
  }
  return routes
}

export function collectRuntimeRoutes(sources) {
  const routes = new Set()
  const errors = []
  for (const [sourcePath, source] of sources) {
    for (const route of extractRuntimeRoutes(source)) {
      if (routes.has(route)) errors.push(`duplicate runtime route registration: ${route} (${sourcePath})`)
      routes.add(route)
    }
  }
  return { routes, errors }
}

export function validateRouteContract({ contract, runtimeRoutes, publicPaths, internalPaths }) {
  const parsed = routeContractSchema.safeParse(contract)
  if (!parsed.success) return parsed.error.issues.map((issue) => `route contract: ${issue.message}`)
  const errors = []
  const seen = new Set()
  const declaredRuntimeRoutes = new Set()
  for (const route of parsed.data.routes) {
    const identity = `${route.method.toUpperCase()} ${route.path}`
    if (seen.has(identity)) errors.push(`duplicate route contract entry: ${identity}`)
    seen.add(identity)
    const runtimePath = route.runtimePath ?? route.path
    const runtimeIdentity = `${route.method.toUpperCase()} ${runtimePath}`
    declaredRuntimeRoutes.add(runtimeIdentity)
    if (!runtimeRoutes.has(runtimeIdentity) && !runtimeRoutes.has(`* ${runtimePath}`)) {
      errors.push(`not mounted: ${runtimeIdentity}`)
    }
    const paths = route.document === "public" ? publicPaths : internalPaths
    if (route.document !== "none" && !paths[route.path]?.[route.method]) {
      errors.push(`missing from ${route.document} spec: ${identity}`)
    }
  }
  const declaredRuntimePaths = new Set(
    parsed.data.routes.map((route) => route.runtimePath ?? route.path)
  )
  for (const runtimeIdentity of [...runtimeRoutes].sort()) {
    const separator = runtimeIdentity.indexOf(" ")
    const method = runtimeIdentity.slice(0, separator)
    const runtimePath = runtimeIdentity.slice(separator + 1)
    const declared =
      method === "*"
        ? declaredRuntimePaths.has(runtimePath)
        : declaredRuntimeRoutes.has(runtimeIdentity)
    if (!declared) errors.push(`not declared: ${runtimeIdentity}`)
    if (/^\/(?:api|ws)\/v\d+(?:\/|$)/.test(runtimePath)) {
      errors.push(`versioned runtime path is forbidden: ${runtimePath}`)
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
    path.startsWith("/api/auth/device/")
  ) {
    return []
  }
  if (
    path === "/ws/events" ||
    path === "/ws/acp" ||
    path.startsWith("/ws/terminal") ||
    path.startsWith("/ws/browser")
  ) {
    return []
  }
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
      tags: ["api"],
      summary: `${route.method.toUpperCase()} ${route.path}`,
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

function normalizePublicPaths(paths, contract) {
  const next = clone(paths)

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
      if (
        operation.security.some((requirement) => Object.hasOwn(requirement, "dpopAccess")) &&
        !operation.parameters?.some((parameter) => parameter?.$ref === "#/components/parameters/DpopProof")
      ) {
        operation.parameters = [
          ...(operation.parameters ?? []),
          { $ref: "#/components/parameters/DpopProof" },
        ]
      }
    }
  }

  const canonicalEvents = next["/ws/events"]?.get
  if (canonicalEvents) {
    canonicalEvents.summary = "Open the canonical event stream with a single-use socket ticket."
    canonicalEvents.description = [
      "Open a resumable Companion event stream with a 60-second, path-bound, single-use ticket.",
      "Obtain the ticket from `POST /api/auth/socket-ticket` with channel `events`; bearer tokens",
      "and arbitrary query-token credentials are not accepted on the WebSocket URL.",
      "Use the optional `since` cursor to replay retained events in sequence.",
    ].join(" ")
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
  const whoami = next["/api/whoami"]?.get
  if (whoami) {
    whoami.summary = "Return the authenticated Companion device identity."
    whoami.description =
      "Requires a five-minute device access token and a matching DPoP proof; returns the device, tenant, server version, and pinned TLS fingerprint."
  }
  const schemaResponse = (schema, description) => ({
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  })
  const publicApiError = { $ref: "#/components/responses/PublicApiError" }
  const authenticationRejected = { $ref: "#/components/responses/AuthenticationRejected" }
  const addPublicErrors = (operation, statuses) => {
    if (!operation) return
    for (const status of statuses) {
      operation.responses[status] =
        status === 401 || status === 403 ? authenticationRejected : publicApiError
    }
  }
  const agentCard = next["/.well-known/agent-card.json"]?.get
  if (agentCard) {
    agentCard.summary = "Discover the Cognia A2A agent and its supported capabilities."
    agentCard.responses = {
      200: schemaResponse("A2aAgentCard", "A2A Agent Card discovery document."),
      400: publicApiError,
    }
  }
  if (whoami) {
    whoami.responses[200] = schemaResponse(
      "WhoamiResponse",
      "Authenticated Companion device identity."
    )
    addPublicErrors(whoami, [400, 401, 409, 503])
  }
  const devices = next["/api/devices"]?.get
  if (devices) {
    devices.responses[200] = schemaResponse("DevicesResponse", "Registered devices.")
    addPublicErrors(devices, [400, 401, 403, 409, 503])
  }
  const revokeDevice = next["/api/devices/{device_id}"]?.delete
  if (revokeDevice) {
    revokeDevice.responses[200] = schemaResponse(
      "DeviceRevocationResponse",
      "Device revoked."
    )
    addPublicErrors(revokeDevice, [400, 401, 403, 409, 503])
  }
  const invitation = next["/api/invitations"]?.post
  if (invitation) {
    invitation.requestBody = {
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/InvitationRequest" } },
      },
    }
    invitation.responses[200] = schemaResponse("InvitationResponse", "Owner invitation created.")
    addPublicErrors(invitation, [400, 401, 403, 409, 415, 422, 503])
  }
  const listPolicies = next["/api/policies"]?.get
  if (listPolicies) {
    listPolicies.responses[200] = schemaResponse("PoliciesResponse", "Active host policies.")
    addPublicErrors(listPolicies, [400, 401, 403, 409, 503])
  }
  const createPolicy = next["/api/policies"]?.post
  if (createPolicy) {
    createPolicy.requestBody = {
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/CreatePolicyRequest" } },
      },
    }
    createPolicy.responses[200] = schemaResponse("HostPolicySummary", "Host policy created.")
    addPublicErrors(createPolicy, [400, 401, 403, 409, 415, 422, 503])
  }
  const operation = next["/api/operations/{operation_id}"]?.get
  if (operation) {
    operation.responses[200] = schemaResponse("OperationSummary", "Durable operation status.")
    addPublicErrors(operation, [400, 401, 404, 409, 503])
  }
  const sessionMedia = next["/api/sessions/{session_id}/media/{hash}"]?.get
  if (sessionMedia) {
    sessionMedia.summary = "Read immutable media bytes owned by an authenticated session."
    sessionMedia.parameters ??= []
    if (
      !sessionMedia.parameters.some(
        (parameter) => parameter?.in === "query" && parameter.name === "variant"
      )
    ) {
      sessionMedia.parameters.push({
        in: "query",
        name: "variant",
        required: false,
        schema: {
          type: "string",
          enum: ["thumbnail", "canonical", "original"],
          default: "canonical",
        },
      })
    }
    sessionMedia.responses = {
      200: {
        description: "Media bytes. The concrete Content-Type is supplied by the media record.",
        headers: {
          "Cache-Control": { schema: { type: "string" } },
          ETag: { schema: { type: "string" } },
        },
        content: {
          "application/octet-stream": { schema: { type: "string", format: "binary" } },
        },
      },
      400: publicApiError,
      401: { $ref: "#/components/responses/AuthenticationRejected" },
      404: publicApiError,
      413: publicApiError,
      503: publicApiError,
    }
  }
  const terminal = next["/ws/terminal"]?.get
  if (terminal) {
    terminal.description = [
      "Open the canonical binary terminal protocol after obtaining a 60-second, path-bound,",
      "single-use ticket from `POST /api/auth/socket-ticket` with channel `terminal`.",
      "Remote terminal access and the device terminal capability are revalidated before upgrade.",
      "Bearer tokens are never accepted in the WebSocket URL.",
    ].join(" ")
    terminal.responses[403] = publicApiError
    terminal.responses[503] = publicApiError
  }
  const browser = next["/ws/browser/{session_id}"]?.get
  if (browser) {
    browser.summary = "Open a browser-session stream with a one-time ticket."
    browser.description =
      "Redeem a 60-second browser ticket bound to this session. Text frames use the versioned browser envelope; binary frames carry screencast media."
    browser.parameters ??= []
    if (!browser.parameters.some((parameter) => parameter?.in === "query" && parameter.name === "ticket")) {
      browser.parameters.push({
        in: "query",
        name: "ticket",
        required: true,
        schema: { type: "string" },
        description: "Single-use stream ticket bound to this browser session.",
      })
    }
    browser.responses = {
      101: { description: "WebSocket upgrade accepted." },
      200: schemaResponse(
        "BrowserSocketTextFrame",
        "Synthetic success response documenting browser WebSocket text frames."
      ),
      401: { $ref: "#/components/responses/AuthenticationRejected" },
      426: { description: "A WebSocket upgrade is required." },
      503: publicApiError,
    }
    browser["x-websocket"] = {
      outboundFrames: [
        { name: "BrowserSocketTextFrame", schema: { $ref: "#/components/schemas/BrowserSocketTextFrame" } },
        { name: "BrowserScreencastFrame", schema: { type: "string", format: "binary" } },
      ],
      inboundFrames: [
        {
          name: "BrowserSocketCommand",
          schema: {
            type: "object",
            required: ["version", "type", "payload"],
            additionalProperties: false,
            properties: {
              version: { type: "integer", const: 1 },
              type: { type: "string", enum: ["control.takeover", "input", "frame.ack"] },
              payload: { type: "object", additionalProperties: true },
            },
          },
        },
      ],
    }
  }
  const acp = next["/ws/acp"]?.get
  if (acp) {
    acp.summary = "Open the ACP stream with a one-time socket ticket."
    acp.description = [
      "Obtain a 60-second, path-bound, single-use ticket from `POST /api/auth/socket-ticket`",
      "with channel `acp`. The redeemed principal and canonical capability snapshot govern every",
      "mapped command; bearer tokens are never accepted in the WebSocket URL.",
    ].join(" ")
    acp.parameters = [
      {
        in: "query",
        name: "ticket",
        required: true,
        schema: { type: "string" },
        description: "Single-use ticket bound to /ws/acp and the authenticated device principal.",
      },
    ]
    acp.responses = {
      101: { description: "WebSocket upgrade accepted." },
      200: { description: "WebSocket handshake accepted by tooling that models upgrades as success." },
      401: { $ref: "#/components/responses/AuthenticationRejected" },
      503: publicApiError,
    }
  }
  const a2a = next["/a2a"]?.post
  if (a2a) {
    a2a.operationId = "dispatchA2aJsonRpc"
    a2a.tags = ["a2a"]
    a2a.summary = "Dispatch an A2A JSON-RPC request through the canonical execution authority."
    a2a.requestBody = {
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/A2aJsonRpcRequest" } },
      },
    }
    a2a.responses = {
      200: schemaResponse(
        "A2aJsonRpcResponse",
        "A2A JSON-RPC success or protocol error envelope."
      ),
      400: publicApiError,
      401: { $ref: "#/components/responses/AuthenticationRejected" },
      415: publicApiError,
      422: publicApiError,
      503: publicApiError,
    }
  }
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
  const authenticationRejected = { $ref: "#/components/responses/AuthenticationRejected" }
  const publicApiError = { $ref: "#/components/responses/PublicApiError" }
  return {
    "/api/auth/device/challenge": {
      post: {
        operationId: "issueDeviceChallenge",
        tags: ["device-auth"],
        summary: "Issue a one-minute device proof challenge.",
        security: [],
        requestBody: jsonBody("DeviceChallengeRequest"),
        responses: {
          200: jsonResponse("DeviceChallengeResponse", "Challenge issued."),
          400: publicApiError,
          415: publicApiError,
          422: publicApiError,
          429: publicApiError,
          503: publicApiError,
        },
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
          400: publicApiError,
          401: authenticationRejected,
          403: authenticationRejected,
          409: publicApiError,
          415: publicApiError,
          422: publicApiError,
          429: publicApiError,
          503: publicApiError,
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
          400: publicApiError,
          401: authenticationRejected,
          409: publicApiError,
          415: publicApiError,
          422: publicApiError,
          429: publicApiError,
          500: publicApiError,
          503: publicApiError,
        },
      },
    },
    "/api/auth/socket-ticket": {
      post: {
        operationId: "issueSocketTicket",
        tags: ["device-auth"],
        summary: "Mint a 60-second single-use, endpoint-bound WebSocket ticket.",
        description:
          "The server derives the exact path, audience, and required capability from the typed channel (`host.observe` for events, `terminal.open` for terminal, and `agent.run` for browser/ACP). Browser requests must also name an active session owned by the authenticated device.",
        security: [{ dpopAccess: [] }],
        parameters: [{ $ref: "#/components/parameters/DpopProof" }],
        requestBody: jsonBody("SocketTicketRequest"),
        responses: {
          200: jsonResponse("SocketTicketResponse", "Socket ticket issued."),
          400: publicApiError,
          401: authenticationRejected,
          403: authenticationRejected,
          409: publicApiError,
          415: publicApiError,
          422: publicApiError,
          429: publicApiError,
          503: publicApiError,
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
      description:
        "Five-minute access token bound to the active device key and signed by a process-ephemeral authority; a server restart invalidates outstanding tokens. Send a matching DPoP header.",
    },
  }
  delete next.securitySchemes.legacyBearer
  delete next.securitySchemes.legacyQueryToken
  delete next.securitySchemes.bearerAuth
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
    RpcCompletedResponse: completedRpcSchema(),
    RpcRunningResponse: {
      type: "object",
      required: ["requestId", "operationId", "status"],
      additionalProperties: false,
      properties: {
        requestId: { type: "string", format: "uuid" },
        operationId: { type: "string", format: "uuid" },
        status: { type: "string", const: "running" },
      },
    },
    WhoamiResponse: {
      type: "object",
      required: ["deviceId", "accountId", "serverVersion", "tlsFingerprint"],
      additionalProperties: false,
      properties: {
        deviceId: { type: "string" },
        accountId: { type: "string" },
        serverVersion: { type: "string" },
        tlsFingerprint: { type: "string" },
      },
    },
    DeviceSummary: {
      type: "object",
      required: ["deviceId", "displayName", "role", "status", "createdAt", "updatedAt"],
      additionalProperties: false,
      properties: {
        deviceId: { type: "string" },
        displayName: { type: "string" },
        role: { type: "string" },
        status: { type: "string" },
        createdAt: { type: "integer", format: "int64" },
        updatedAt: { type: "integer", format: "int64" },
      },
    },
    DevicesResponse: {
      type: "object",
      required: ["devices"],
      additionalProperties: false,
      properties: {
        devices: { type: "array", items: { $ref: "#/components/schemas/DeviceSummary" } },
      },
    },
    DeviceRevocationResponse: {
      type: "object",
      required: ["revokedDeviceId"],
      additionalProperties: false,
      properties: { revokedDeviceId: { type: "string" } },
    },
    InvitationRequest: {
      type: "object",
      additionalProperties: false,
      properties: {
        ttlSeconds: { type: "integer", minimum: 1, maximum: 3600, default: 600 },
      },
    },
    InvitationResponse: {
      type: "object",
      required: ["invitation", "expiresIn"],
      additionalProperties: false,
      properties: {
        invitation: { type: "string" },
        expiresIn: { type: "integer", format: "int64" },
      },
    },
    HostPolicySummary: {
      type: "object",
      required: ["policyId", "capability", "policy", "createdAt"],
      additionalProperties: false,
      properties: {
        policyId: { type: "string" },
        capability: { type: "string" },
        policy: { type: "object", additionalProperties: true },
        expiresAt: { type: ["integer", "null"], format: "int64" },
        createdAt: { type: "integer", format: "int64" },
      },
    },
    PoliciesResponse: {
      type: "object",
      required: ["policies"],
      additionalProperties: false,
      properties: {
        policies: { type: "array", items: { $ref: "#/components/schemas/HostPolicySummary" } },
      },
    },
    CreatePolicyRequest: {
      type: "object",
      required: ["capability", "commands", "expiresAt"],
      additionalProperties: false,
      properties: {
        capability: { type: "string" },
        commands: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
        constraints: { type: "object", additionalProperties: true, default: {} },
        expiresAt: { type: "integer", format: "int64" },
      },
    },
    OperationSummary: {
      type: "object",
      required: ["operationId", "status", "createdAt", "updatedAt"],
      additionalProperties: false,
      properties: {
        operationId: { type: "string", format: "uuid" },
        status: { type: "string" },
        receipt: {},
        createdAt: { type: "integer", format: "int64" },
        updatedAt: { type: "integer", format: "int64" },
      },
    },
    A2aAgentCard: {
      type: "object",
      required: [
        "protocolVersion",
        "name",
        "url",
        "preferredTransport",
        "version",
        "capabilities",
        "defaultInputModes",
        "defaultOutputModes",
        "securitySchemes",
        "security",
        "skills",
      ],
      additionalProperties: false,
      properties: {
        protocolVersion: { type: "string", const: "0.3.0" },
        name: { type: "string" },
        description: { type: "string" },
        url: { type: "string", format: "uri" },
        preferredTransport: { type: "string", const: "JSONRPC" },
        version: { type: "string" },
        provider: {
          type: "object",
          required: ["organization", "url"],
          additionalProperties: false,
          properties: {
            organization: { type: "string" },
            url: { type: "string", format: "uri" },
          },
        },
        capabilities: {
          type: "object",
          required: ["streaming", "pushNotifications", "stateTransitionHistory"],
          additionalProperties: false,
          properties: {
            streaming: { type: "boolean", const: false },
            pushNotifications: { type: "boolean", const: false },
            stateTransitionHistory: { type: "boolean", const: false },
          },
        },
        defaultInputModes: { type: "array", items: { type: "string" } },
        defaultOutputModes: { type: "array", items: { type: "string" } },
        securitySchemes: {
          type: "object",
          required: ["bearer", "dpop"],
          additionalProperties: false,
          properties: {
            bearer: { type: "object", additionalProperties: true },
            dpop: { type: "object", additionalProperties: true },
          },
        },
        security: {
          type: "array",
          items: { type: "object", additionalProperties: { type: "array", items: {} } },
        },
        skills: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name", "description", "tags", "inputModes", "outputModes"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              inputModes: { type: "array", items: { type: "string" } },
              outputModes: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    A2aPart: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "text"],
          additionalProperties: false,
          properties: { kind: { type: "string", const: "text" }, text: { type: "string" } },
        },
        {
          type: "object",
          required: ["kind", "data"],
          additionalProperties: false,
          properties: { kind: { type: "string", const: "data" }, data: {} },
        },
        {
          type: "object",
          required: ["kind", "file"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", const: "file" },
            file: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                mimeType: { type: "string" },
                bytes: { type: "string", format: "byte" },
                uri: { type: "string", format: "uri" },
              },
              anyOf: [{ required: ["bytes"] }, { required: ["uri"] }],
            },
          },
        },
      ],
    },
    A2aMessage: {
      type: "object",
      required: ["kind", "role", "messageId", "parts"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "message" },
        role: { type: "string", enum: ["user", "agent"] },
        messageId: { type: "string", minLength: 1 },
        contextId: { type: "string" },
        taskId: { type: "string" },
        parts: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/components/schemas/A2aPart" },
        },
      },
    },
    A2aTask: {
      type: "object",
      required: ["kind", "id", "contextId", "status", "artifacts"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "task" },
        id: { type: "string" },
        contextId: { type: "string" },
        status: {
          type: "object",
          required: ["state"],
          additionalProperties: false,
          properties: {
            state: {
              type: "string",
              enum: ["submitted", "working", "input-required", "completed", "failed", "canceled"],
            },
            message: { $ref: "#/components/schemas/A2aMessage" },
          },
        },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            required: ["artifactId", "name", "parts"],
            additionalProperties: false,
            properties: {
              artifactId: { type: "string" },
              name: { type: "string" },
              parts: { type: "array", items: { $ref: "#/components/schemas/A2aPart" } },
            },
          },
        },
      },
    },
    A2aJsonRpcRequest: {
      type: "object",
      required: ["jsonrpc", "id", "method", "params"],
      additionalProperties: false,
      properties: {
        jsonrpc: { type: "string", const: "2.0" },
        id: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
        method: { type: "string", enum: ["message/send", "tasks/get", "tasks/cancel"] },
        params: {
          oneOf: [
            {
              type: "object",
              required: ["message"],
              additionalProperties: false,
              properties: { message: { $ref: "#/components/schemas/A2aMessage" } },
            },
            {
              type: "object",
              required: ["id"],
              additionalProperties: false,
              properties: { id: { type: "string" } },
            },
          ],
        },
      },
    },
    A2aJsonRpcResponse: {
      oneOf: [
        {
          type: "object",
          required: ["jsonrpc", "id", "result"],
          additionalProperties: false,
          properties: {
            jsonrpc: { type: "string", const: "2.0" },
            id: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
            result: { $ref: "#/components/schemas/A2aTask" },
          },
        },
        {
          type: "object",
          required: ["jsonrpc", "id", "error"],
          additionalProperties: false,
          properties: {
            jsonrpc: { type: "string", const: "2.0" },
            id: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
            error: {
              type: "object",
              required: ["code", "message"],
              additionalProperties: false,
              properties: { code: { type: "integer" }, message: { type: "string" }, data: {} },
            },
          },
        },
      ],
    },
    BrowserSocketTextFrame: {
      oneOf: [
        {
          type: "object",
          required: ["version", "type", "payload"],
          additionalProperties: false,
          properties: {
            version: { type: "integer", const: 1 },
            type: { type: "string", const: "connected" },
            payload: {
              type: "object",
              required: ["sessionId"],
              additionalProperties: false,
              properties: { sessionId: { type: "string" } },
            },
          },
        },
        {
          type: "object",
          required: ["version", "type", "payload"],
          additionalProperties: false,
          properties: {
            version: { type: "integer", const: 1 },
            type: { type: "string", enum: ["event", "result"] },
            payload: {},
          },
        },
        {
          type: "object",
          required: ["version", "type", "payload"],
          additionalProperties: false,
          properties: {
            version: { type: "integer", const: 1 },
            type: { type: "string", const: "error" },
            payload: {
              type: "object",
              required: ["code"],
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
          },
        },
      ],
    },
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
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["channel", "sessionId"],
          properties: {
            channel: { type: "string", const: "browser" },
            sessionId: {
              type: "string",
              minLength: 1,
              description: "Binds the ticket to one active browser session owned by the device.",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["channel"],
          properties: {
            channel: { type: "string", enum: ["events", "terminal", "acp"] },
          },
        },
      ],
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
  next.schemas.RpcError = { $ref: "#/components/schemas/CanonicalApiError" }
  delete next.schemas.BrowserSocketCommand
  for (const legacySchema of ["IssueResponse", "PairRequest", "PairResponse"]) {
    delete next.schemas[legacySchema]
  }
  next.responses = {
    ...(next.responses ?? {}),
    PublicApiError: {
      description: "The request was rejected by the public Companion API.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/CanonicalApiError" } } },
    },
    AuthenticationRejected: {
      description: "Authentication or authorization rejected.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/CanonicalApiError" } } },
    },
  }
  for (const legacyResponse of [
    "PayloadTooLarge",
    "RemoteControlForbidden",
    "ServiceTokenRequired",
  ]) {
    delete next.responses[legacyResponse]
  }
  delete next.responses.JwtRejected
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
  return rewriteLegacyComponentReferences(normalizeOpenApi31({
    ...base,
    info: {
      ...base.info,
      title: "Cognia Companion Device API",
      summary: "Canonical unversioned DPoP device API.",
      description:
        "The device surface uses unversioned /api and /ws routes, five-minute DPoP-bound access tokens, and 60-second single-use WebSocket tickets. Versioned compatibility aliases are intentionally not exposed; service-token Headless routes are documented separately.",
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
      legacyCompatibility: false,
    },
  }))
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
      license: { name: "Proprietary", identifier: "LicenseRef-Proprietary" },
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
            202: { description: "Command is still running.", content: { "application/json": { schema: { $ref: "#/components/schemas/InternalRpcRunningResponse" } } } },
            401: { $ref: "#/components/responses/ServiceTokenRejected" },
            403: { $ref: "#/components/responses/ServiceTokenRejected" },
            404: { $ref: "#/components/responses/HeadlessRpcError" },
            409: { $ref: "#/components/responses/HeadlessRpcError" },
            415: { $ref: "#/components/responses/HeadlessRpcError" },
            422: { $ref: "#/components/responses/HeadlessRpcError" },
            428: { $ref: "#/components/responses/HeadlessRpcError" },
            429: { $ref: "#/components/responses/HeadlessRpcError" },
            500: { $ref: "#/components/responses/HeadlessRpcError" },
            503: { $ref: "#/components/responses/HeadlessRpcError" },
          },
        },
      },
      "/internal/operations/{operation_id}": {
        get: {
          operationId: "headlessOperationGet",
          tags: ["headless-rpc"],
          summary: "Read a durable Headless operation without replaying the command.",
          parameters: [
            {
              in: "path",
              name: "operation_id",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            200: {
              description: "Durable operation status.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/InternalOperationSummary" },
                },
              },
            },
            401: { $ref: "#/components/responses/ServiceTokenRejected" },
            403: { $ref: "#/components/responses/ServiceTokenRejected" },
            404: { $ref: "#/components/responses/HeadlessRpcError" },
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
          responses: {
            101: { description: "WebSocket upgrade accepted." },
            200: { description: "Handshake accepted by tooling that models upgrades as success." },
            401: { $ref: "#/components/responses/ServiceTokenRejected" },
          },
        },
      },
      "/internal/bridge": {
        get: {
          operationId: "headlessBridge",
          tags: ["headless-bridge"],
          summary: "Open the bidirectional Rust-to-Brain data-plane bridge.",
          security: [{ serviceQueryToken: [] }],
          responses: {
            101: { description: "WebSocket upgrade accepted." },
            200: { description: "Handshake accepted by tooling that models upgrades as success." },
            401: { $ref: "#/components/responses/ServiceTokenRejected" },
          },
        },
      },
      "/integrations/mcp/oauth/callback": {
        get: {
          operationId: "mcpOAuthCallback",
          tags: ["headless-rpc"],
          summary: "Complete a pending MCP OAuth authorization-code flow.",
          security: [],
          parameters: [
            { in: "query", name: "code", required: false, schema: { type: "string", maxLength: 8192 } },
            { in: "query", name: "state", required: true, schema: { type: "string", minLength: 64, maxLength: 64 } },
            { in: "query", name: "error", required: false, schema: { type: "string" } },
            { in: "query", name: "error_description", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Authorization completed. Returns a small HTML completion page." },
            400: { description: "State, authorization code, or provider response was invalid." },
            404: { description: "The Headless OAuth callback is disabled." },
            409: { description: "The authorization attempt was cleared while exchanging the code." },
            500: { description: "The helper or secure token storage failed." },
          },
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
        InternalRpcRunningResponse: {
          type: "object",
          required: ["operationId", "status"],
          additionalProperties: false,
          properties: {
            operationId: { type: "string", format: "uuid" },
            status: { type: "string", const: "running" },
          },
        },
        InternalOperationSummary: {
          type: "object",
          required: ["operationId", "status", "createdAt", "updatedAt"],
          additionalProperties: false,
          properties: {
            operationId: { type: "string", format: "uuid" },
            status: {
              type: "string",
              enum: ["queued", "running", "waiting_input", "cancelling", "recovering", "succeeded", "failed", "cancelled"],
            },
            receipt: {},
            createdAt: { type: "integer", format: "int64" },
            updatedAt: { type: "integer", format: "int64" },
          },
        },
        RpcError: {
          type: "object",
          required: ["code", "message", "requestId", "retryable", "details"],
          additionalProperties: false,
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            requestId: { type: "string", format: "uuid" },
            retryable: { type: "boolean" },
            details: { type: "object", additionalProperties: true },
            operationId: { type: "string", format: "uuid" },
          },
        },
        ServiceTokenError: {
          type: "object",
          required: ["error", "message"],
          additionalProperties: false,
          properties: {
            error: { type: "string" },
            message: { type: "string" },
          },
        },
      },
      responses: {
        ServiceTokenRejected: {
          description: "The token is missing, invalid, not service-scoped, or presented by a non-loopback peer.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ServiceTokenError" } } },
        },
        HeadlessRpcError: {
          description: "The Headless request failed before producing a valid command result.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/RpcError" } } },
        },
      },
    },
  }
}

function buildHeadlessSpec(
  base,
  contract,
  manifest,
  remoteNames,
  argumentSchemas,
  responseSchemaCatalog,
) {
  const classified = classifyCommands(manifest, remoteNames)
  const reconciled = reconcileRpcPaths({
    publicPaths: {},
    internalPaths: base.paths ?? {},
    manifest,
    remoteNames,
    argumentSchemas,
  })
  const paths = reconciled.internalPaths
  for (const [name, schema] of Object.entries(responseSchemaCatalog.commands)) {
    const operation = paths[`/internal/_rpc/${name}`]?.post
    if (!operation) throw new Error(`response schema has no Headless command: ${name}`)
    operation["x-cognia-response-schema-source"] = "contract"
    const materialized = materializeResponseSchema(
      schema,
      responseSchemaCatalog.$defs,
    )
    if (JSON.stringify(materialized).includes("x-cognia-opaque-reason")) {
      materialized["x-cognia-schema-owner"] = hostResourceForCommand(name)
    }
    operation.responses[200].content["application/json"].schema = materialized
  }
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
        RESPONSE_SCHEMA_CATALOG_PATH,
        HEADLESS_DISPOSITIONS_PATH,
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
      generatedResponseSchemaCount: classified.internalNames.filter(
        (name) => responseSchemaCatalog.commands[name] !== undefined
      ).length,
      loopbackOnly: true,
    },
  })
}

function renderSpec(spec) {
  return stringify(spec, { indent: 2, lineWidth: 120, sortMapEntries: false })
}

function buildHeadlessAsyncApi(contract, catalog) {
  const routePaths = new Set(
    contract.routes.filter((route) => route.document === "headless").map((route) => route.path),
  )
  for (const path of ["/internal/events", "/internal/bridge"]) {
    if (!routePaths.has(path)) throw new Error(`AsyncAPI channel has no Headless route: ${path}`)
  }
  const frameBase = {
    type: "object",
    required: ["v", "type"],
    properties: {
      v: { type: "integer", const: BRIDGE_PROTOCOL_VERSION },
      type: { type: "string" },
    },
  }
  const message = (name, payload) => ({ name, payload })
  return {
    asyncapi: "3.0.0",
    info: {
      title: "Cognia Headless Service Event and Bridge API",
      version: String(catalog.schemaVersion),
      description:
        "Generated WebSocket contract for the existing Headless event stream and Brain data-plane bridge.",
      "x-cognia-catalog-hash": catalog.catalogHash,
    },
    servers: {
      loopback: {
        host: "127.0.0.1:{port}",
        protocol: "wss",
        pathname: "/",
        variables: { port: { default: "3000" } },
        security: [{ $ref: "#/components/securitySchemes/serviceQueryToken" }],
      },
    },
    channels: {
      headlessEvents: {
        address: "/internal/events",
        messages: {
          event: { $ref: "#/components/messages/EventFrame" },
          streamReady: { $ref: "#/components/messages/StreamReadyFrame" },
          resyncRequired: { $ref: "#/components/messages/ResyncRequiredFrame" },
          ping: { $ref: "#/components/messages/EventPingFrame" },
        },
      },
      headlessBridge: {
        address: "/internal/bridge",
        messages: {
          hello: { $ref: "#/components/messages/BridgeHelloFrame" },
          helloAck: { $ref: "#/components/messages/BridgeHelloAckFrame" },
          event: { $ref: "#/components/messages/BridgeEventFrame" },
          respond: { $ref: "#/components/messages/BridgeRespondFrame" },
          ping: { $ref: "#/components/messages/BridgePingFrame" },
          pong: { $ref: "#/components/messages/BridgePongFrame" },
          tokenRefresh: { $ref: "#/components/messages/BridgeTokenRefreshFrame" },
        },
      },
    },
    operations: {
      receiveHeadlessEvents: {
        action: "receive",
        channel: { $ref: "#/channels/headlessEvents" },
        messages: [
          { $ref: "#/channels/headlessEvents/messages/event" },
          { $ref: "#/channels/headlessEvents/messages/streamReady" },
          { $ref: "#/channels/headlessEvents/messages/resyncRequired" },
          { $ref: "#/channels/headlessEvents/messages/ping" },
        ],
      },
      sendBridgeFrames: {
        action: "send",
        channel: { $ref: "#/channels/headlessBridge" },
        messages: [
          { $ref: "#/channels/headlessBridge/messages/hello" },
          { $ref: "#/channels/headlessBridge/messages/respond" },
          { $ref: "#/channels/headlessBridge/messages/pong" },
        ],
      },
      receiveBridgeFrames: {
        action: "receive",
        channel: { $ref: "#/channels/headlessBridge" },
        messages: [
          { $ref: "#/channels/headlessBridge/messages/helloAck" },
          { $ref: "#/channels/headlessBridge/messages/event" },
          { $ref: "#/channels/headlessBridge/messages/ping" },
          { $ref: "#/channels/headlessBridge/messages/pong" },
          { $ref: "#/channels/headlessBridge/messages/tokenRefresh" },
        ],
      },
    },
    components: {
      securitySchemes: {
        serviceQueryToken: { type: "apiKey", in: "query", name: "token" },
      },
      messages: {
        EventFrame: message("EventFrame", {
          type: "object",
          required: ["type", "seq", "payload", "ts_ms"],
          additionalProperties: false,
          properties: {
            type: { type: "string", description: "Tauri-compatible event topic." },
            seq: { type: "integer", minimum: 1 },
            payload: {},
            ts_ms: { type: "integer", format: "int64" },
          },
        }),
        StreamReadyFrame: message("StreamReadyFrame", {
          type: "object",
          required: ["type", "cursor"],
          additionalProperties: false,
          properties: {
            type: { type: "string", const: "stream_ready" },
            cursor: { type: "integer", minimum: 0 },
          },
        }),
        ResyncRequiredFrame: message("ResyncRequiredFrame", {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", const: "resync_required" },
            cursor: { type: "integer", minimum: 0 },
            domains: { type: "array", items: { type: "string" } },
          },
        }),
        EventPingFrame: message("EventPingFrame", {
          type: "object",
          required: ["type", "ts"],
          additionalProperties: false,
          properties: {
            type: { type: "string", const: "ping" },
            ts: { type: "integer", format: "int64" },
          },
        }),
        BridgeHelloFrame: message("BridgeHelloFrame", {
          ...frameBase,
          required: [...frameBase.required, "role", "brainVersion", "protocol", "accountId", "capabilities", "catalogHash", "contractVersion"],
          additionalProperties: false,
          properties: {
            ...frameBase.properties,
            type: { type: "string", const: "hello" },
            role: { type: "string", const: "brain" },
            brainVersion: { type: "string" },
            protocol: { type: "integer", const: BRIDGE_PROTOCOL_VERSION },
            accountId: { type: "string" },
            capabilities: { type: "array", items: { type: "string" } },
            catalogHash: { type: "string", const: catalog.catalogHash },
            contractVersion: { type: "integer", const: catalog.schemaVersion },
          },
        }),
        BridgeHelloAckFrame: message("BridgeHelloAckFrame", {
          ...frameBase,
          required: [...frameBase.required, "serverVersion", "protocol", "accountId", "catalogHash", "contractVersion"],
          additionalProperties: false,
          properties: {
            ...frameBase.properties,
            type: { type: "string", const: "hello_ack" },
            serverVersion: { type: "string" },
            protocol: { type: "integer", const: BRIDGE_PROTOCOL_VERSION },
            accountId: { type: "string" },
            catalogHash: { type: "string", const: catalog.catalogHash },
            contractVersion: { type: "integer", const: catalog.schemaVersion },
          },
        }),
        BridgeEventFrame: message("BridgeEventFrame", {
          ...frameBase,
          required: [...frameBase.required, "event", "payload"],
          additionalProperties: false,
          properties: { ...frameBase.properties, type: { type: "string", const: "event" }, event: { type: "string" }, payload: {} },
        }),
        BridgeRespondFrame: message("BridgeRespondFrame", {
          ...frameBase,
          required: [...frameBase.required, "command", "payload"],
          additionalProperties: false,
          properties: { ...frameBase.properties, type: { type: "string", const: "respond" }, command: { type: "string" }, payload: { type: "object" } },
        }),
        BridgePingFrame: message("BridgePingFrame", {
          ...frameBase,
          required: [...frameBase.required, "ts"],
          additionalProperties: false,
          properties: { ...frameBase.properties, type: { type: "string", const: "ping" }, ts: { type: "integer", format: "int64" } },
        }),
        BridgePongFrame: message("BridgePongFrame", {
          ...frameBase,
          required: [...frameBase.required, "ts", "rssBytes", "lastFlushAt"],
          additionalProperties: false,
          properties: {
            ...frameBase.properties,
            type: { type: "string", const: "pong" },
            ts: { type: "integer", format: "int64" },
            rssBytes: { type: "integer", minimum: 0 },
            lastFlushAt: { type: "integer", format: "int64" },
          },
        }),
        BridgeTokenRefreshFrame: message("BridgeTokenRefreshFrame", {
          ...frameBase,
          required: [...frameBase.required, "token"],
          additionalProperties: false,
          properties: { ...frameBase.properties, type: { type: "string", const: "token_refresh" }, token: { type: "string", writeOnly: true } },
        }),
      },
    },
  }
}

export function extractKnownCommands(source) {
  const match = source.match(/const KNOWN_COMMANDS[^=]*=\s*&\[([\s\S]*?)\n\];/)
  if (!match) throw new Error("Could not locate KNOWN_COMMANDS in rpc.rs")
  const names = [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1])
  const unique = new Set(names)
  if (unique.size !== names.length) {
    const duplicates = [...unique].filter(
      (name) => names.indexOf(name) !== names.lastIndexOf(name),
    )
    throw new Error(`duplicate KNOWN_COMMANDS entries: ${duplicates.sort().join(", ")}`)
  }
  return unique
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
  const requestSchemaCatalogSource = readRepo(REQUEST_SCHEMA_CATALOG_PATH)
  const requestSchemaCatalog = requestSchemaCatalogSchema.parse(
    JSON.parse(requestSchemaCatalogSource)
  )
  const responseSchemaCatalog = responseSchemaCatalogSchema.parse(
    JSON.parse(readRepo(RESPONSE_SCHEMA_CATALOG_PATH))
  )
  const headlessDispositionsCatalog = headlessDispositionsSchema.parse(
    JSON.parse(readRepo(HEADLESS_DISPOSITIONS_PATH))
  )
  const headlessDispositionResult = flattenHeadlessDispositions(
    headlessDispositionsCatalog,
    manifest,
  )
  const publicSource = readRepo(PUBLIC_SPEC_PATH)
  let headlessSource = ""
  try {
    headlessSource = readRepo(HEADLESS_SPEC_PATH)
  } catch {
    // The first generator run creates the dedicated Headless contract.
  }
  let headlessAsyncApiSource = ""
  try {
    headlessAsyncApiSource = readRepo(HEADLESS_ASYNCAPI_SPEC_PATH)
  } catch {
    // The first generator run creates the Headless WebSocket contract.
  }
  let hostCommandCatalogSource = ""
  try {
    hostCommandCatalogSource = readRepo(HOST_COMMAND_CATALOG_PATH)
  } catch {
    // The first generator run creates the embedded CLI catalog.
  }
  let headlessContractIdentitySource = ""
  try {
    headlessContractIdentitySource = readRepo(HEADLESS_CONTRACT_IDENTITY_PATH)
  } catch {
    // The first generator run creates the compact Brain bridge identity module.
  }
  const bridgeFixtureSource = readRepo(BRIDGE_FIXTURE_PATH)
  const publicSpec = parseYaml(publicSource, PUBLIC_SPEC_PATH)
  const runtime = collectRuntimeRoutes(
    RUNTIME_ROUTE_SOURCES.map((sourcePath) => [sourcePath, readRepo(sourcePath)])
  )
  const runtimeRoutes = runtime.routes
  const remoteNames = extractKnownCommands(readRepo(RPC_SOURCE_PATH))
  const commandCoverageErrors = validateCommandCoverage(manifest, remoteNames)
  const inferredArgumentSchemas = new Map(
    RPC_DISPATCH_SOURCE_PATHS.flatMap((sourcePath) => [
      ...extractCommandArgumentSchemas(readRepo(sourcePath)),
    ])
  )
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
  const promotedRequestSchemas = { ...requestSchemaCatalog.commands }
  for (const [name, schema] of inferredArgumentSchemas) {
    if (
      remoteNames.has(name) &&
      promotedRequestSchemas[name] === undefined &&
      !zodRequestSchemas.has(name)
    ) {
      promotedRequestSchemas[name] = schema
    }
  }
  const desiredRequestSchemaCatalogSource = `${JSON.stringify(
    {
      schemaVersion: 1,
      commands: Object.fromEntries(
        Object.entries(promotedRequestSchemas).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
    null,
    2,
  )}\n`
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
    argumentSchemas,
    responseSchemaCatalog,
  )
  const desiredPublicSource = renderSpec(desiredPublicSpec)
  const desiredHeadlessSource = renderSpec(desiredHeadlessSpec)
  const desiredHostCommandCatalog = buildHostCommandCatalog(
    manifest,
    remoteNames,
    desiredHeadlessSpec,
  )
  const desiredHostCommandCatalogSource = renderHostCommandCatalog(desiredHostCommandCatalog)
  const desiredHeadlessAsyncApiSource = renderSpec(
    buildHeadlessAsyncApi(contract, desiredHostCommandCatalog),
  )
  const desiredHeadlessContractIdentitySource = renderHeadlessContractIdentity(
    desiredHostCommandCatalog,
  )
  const desiredBridgeFixtureSource = renderBridgeFixture(
    bridgeFixtureSource,
    desiredHostCommandCatalog,
  )
  const errors = validateRouteContract({
    contract,
    runtimeRoutes,
    publicPaths: desiredPublicSpec.paths ?? {},
    internalPaths: desiredHeadlessSpec.paths ?? {},
  })
  errors.push(...runtime.errors)
  errors.push(...commandCoverageErrors)
  errors.push(...headlessDispositionResult.errors)
  const versionedReference = JSON.stringify(desiredPublicSpec).match(/\/(?:api|ws)\/v\d+\//)
  if (versionedReference) {
    errors.push(`versioned public path reference is forbidden: ${versionedReference[0]}`)
  }
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
    if (operation["x-cognia-response-schema-source"] !== "contract") {
      errors.push(`internal command has no concrete response schema: ${name}`)
    }
    const responseSchema = operation.responses?.[200]?.content?.["application/json"]?.schema
    if (
      JSON.stringify(responseSchema).includes("x-cognia-opaque-reason") &&
      typeof responseSchema?.["x-cognia-schema-owner"] !== "string"
    ) {
      errors.push(`opaque response schema has no domain owner: ${name}`)
    }
  }
  for (const name of Object.keys(requestSchemaCatalog.commands)) {
    if (!classified.byName.has(name)) errors.push(`request schema has no command descriptor: ${name}`)
  }
  for (const name of zodRequestSchemas.keys()) {
    if (!classified.byName.has(name)) errors.push(`Zod request schema has no command descriptor: ${name}`)
  }
  for (const name of Object.keys(responseSchemaCatalog.commands)) {
    if (!classified.internalNames.includes(name)) {
      errors.push(`response schema has no Headless command: ${name}`)
    }
  }
  return {
    contract,
    manifest,
    publicSpec,
    runtimeRoutes,
    remoteNames,
    desiredPublicSpec,
    desiredHeadlessSpec,
    desiredPublicSource,
    desiredHeadlessSource,
    desiredHeadlessAsyncApiSource,
    desiredHostCommandCatalog,
    desiredHostCommandCatalogSource,
    desiredHeadlessContractIdentitySource,
    desiredRequestSchemaCatalogSource,
    desiredBridgeFixtureSource,
    headlessDispositions: headlessDispositionResult.dispositions,
    publicDrift: publicSource !== desiredPublicSource,
    headlessDrift: headlessSource !== desiredHeadlessSource,
    headlessAsyncApiDrift: headlessAsyncApiSource !== desiredHeadlessAsyncApiSource,
    hostCommandCatalogDrift: hostCommandCatalogSource !== desiredHostCommandCatalogSource,
    headlessContractIdentityDrift:
      headlessContractIdentitySource !== desiredHeadlessContractIdentitySource,
    requestSchemaCatalogDrift:
      requestSchemaCatalogSource !== desiredRequestSchemaCatalogSource,
    bridgeFixtureDrift: bridgeFixtureSource !== desiredBridgeFixtureSource,
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
  if (
    check &&
    (inspected.publicDrift ||
      inspected.headlessDrift ||
      inspected.headlessAsyncApiDrift ||
      inspected.hostCommandCatalogDrift ||
      inspected.headlessContractIdentityDrift ||
      inspected.requestSchemaCatalogDrift ||
      inspected.bridgeFixtureDrift)
  ) {
    const drift = [
      inspected.publicDrift ? PUBLIC_SPEC_PATH : null,
      inspected.headlessDrift ? HEADLESS_SPEC_PATH : null,
      inspected.headlessAsyncApiDrift ? HEADLESS_ASYNCAPI_SPEC_PATH : null,
      inspected.hostCommandCatalogDrift ? HOST_COMMAND_CATALOG_PATH : null,
      inspected.headlessContractIdentityDrift ? HEADLESS_CONTRACT_IDENTITY_PATH : null,
      inspected.requestSchemaCatalogDrift ? REQUEST_SCHEMA_CATALOG_PATH : null,
      inspected.bridgeFixtureDrift ? BRIDGE_FIXTURE_PATH : null,
    ].filter(Boolean)
    throw new Error(`generated artifacts drifted: ${drift.join(", ")}; run pnpm companion-api:gen`)
  }
  if (!check) {
    writeFileSync(resolve(repoRoot, PUBLIC_SPEC_PATH), inspected.desiredPublicSource)
    writeFileSync(resolve(repoRoot, HEADLESS_SPEC_PATH), inspected.desiredHeadlessSource)
    writeFileSync(
      resolve(repoRoot, HEADLESS_ASYNCAPI_SPEC_PATH),
      inspected.desiredHeadlessAsyncApiSource,
    )
    writeFileSync(
      resolve(repoRoot, HOST_COMMAND_CATALOG_PATH),
      inspected.desiredHostCommandCatalogSource,
    )
    writeFileSync(
      resolve(repoRoot, HEADLESS_CONTRACT_IDENTITY_PATH),
      inspected.desiredHeadlessContractIdentitySource,
    )
    writeFileSync(
      resolve(repoRoot, REQUEST_SCHEMA_CATALOG_PATH),
      inspected.desiredRequestSchemaCatalogSource,
    )
    writeFileSync(
      resolve(repoRoot, BRIDGE_FIXTURE_PATH),
      inspected.desiredBridgeFixtureSource,
    )
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
