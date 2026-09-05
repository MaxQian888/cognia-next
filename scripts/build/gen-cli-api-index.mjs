// Generate the CLI's API command index from the frozen protocol contracts.
//
// The index is what turns `cognia-agent api …` and the derived `<group>
// <action>` commands into a complete, typed surface over the host command
// plane. It joins three generated sources, none of which is edited by hand:
//
//   - protocol/companion-commands.json ...... target/capability/risk/approval
//   - docs/api/headless-service-api.openapi.yaml ... /internal/_rpc request schemas
//   - docs/api/mobile-companion-api.openapi.yaml ... /api/_rpc request schemas
//
// Both specs are themselves produced by `pnpm companion-api:gen`, which fails
// if any RPC would fall back to a generic request shape. That is what lets the
// CLI validate a call locally instead of discovering a 422 on the wire.
//
// Usage:
//   node scripts/build/gen-cli-api-index.mjs           # write
//   node scripts/build/gen-cli-api-index.mjs --check   # fail on drift

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import YAML from "yaml"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const OUT = path.join(root, "cli/src/api/generated/command-index.ts")
const SCHEMA_VERSION = 1

const HEADLESS_SPEC = "docs/api/headless-service-api.openapi.yaml"
const DEVICE_SPEC = "docs/api/mobile-companion-api.openapi.yaml"
const HEADLESS_PREFIX = "/internal/_rpc/"
const DEVICE_PREFIX = "/api/_rpc/"

/** Flags the global parser owns. A field with one of these names keeps its
 *  schema name but is only reachable through `--data`, never as a bare flag,
 *  so `api call x --format y` can never be ambiguous. */
const RESERVED_FLAGS = new Set([
  "help",
  "version",
  "format",
  "output",
  "endpoint",
  "profile",
  "host",
  "timeout",
  "debug",
  "json",
  "data",
  "wait",
  "template",
  "yes",
])

/** `sessionId` -> `session-id`, `session_id` -> `session-id`, `a2uiEnabled` -> `a2ui-enabled`. */
export function toFlagName(property) {
  return property
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
}

/** `plugin_backup_create` -> { group: "plugin", action: "backup-create" }. */
export function splitCommandName(name) {
  const cut = name.indexOf("_")
  if (cut < 0) return { group: name, action: "" }
  return { group: name.slice(0, cut), action: name.slice(cut + 1).replace(/_/g, "-") }
}

function firstLine(text) {
  if (typeof text !== "string") return undefined
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 0 ? line.slice(0, 160) : undefined
}

/** JSON Schema `type` may be a union with "null" (the "explicit null clears it"
 *  pattern the manifest leans on). Reduce it to one CLI-facing kind. */
function flagType(schema) {
  const raw = Array.isArray(schema.type)
    ? schema.type.filter((entry) => entry !== "null")
    : schema.type
      ? [schema.type]
      : []
  const type = raw[0]
  if (type === "object" || type === "array") return "json"
  if (type === "boolean" || type === "integer" || type === "number" || type === "string") return type
  // Untyped, $ref, or a per-property oneOf/anyOf: the value is passed through
  // as JSON so an author is never blocked by a shape we did not model.
  return "json"
}

function isNullable(schema) {
  return Array.isArray(schema.type) && schema.type.includes("null")
}

function enumValues(schema) {
  if (!Array.isArray(schema.enum)) return undefined
  const values = schema.enum.filter((entry) => entry !== null).map((entry) => String(entry))
  return values.length > 0 ? values : undefined
}

/** `allOf: [{ anyOf: [{required:[a]},{required:[b]}] }]` is how the specs say
 *  "one of these alias spellings is required" (151 commands). It is a
 *  requirement group, not an alternative body, so it becomes a local
 *  validation rule rather than a reason to give up on flags. */
function requireOneOfGroups(schema) {
  if (!Array.isArray(schema.allOf)) return undefined
  const groups = []
  for (const branch of schema.allOf) {
    if (!Array.isArray(branch.anyOf)) continue
    const names = []
    for (const option of branch.anyOf) {
      if (Array.isArray(option.required) && option.required.length === 1) {
        names.push(option.required[0])
      }
    }
    if (names.length > 1) groups.push(names)
  }
  return groups.length > 0 ? groups : undefined
}

function readRpcSchemas(relativeSpec, prefix) {
  const spec = YAML.parse(fs.readFileSync(path.join(root, relativeSpec), "utf8"))
  const byCommand = new Map()
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    if (!route.startsWith(prefix) || route.includes("{")) continue
    const operation = item.post
    if (!operation) continue
    // `operation.summary` is always "<name> (<capability>)", which the manifest
    // already carries, so it is dropped. The request schema's own description
    // is the only prose worth keeping (7 commands have one).
    byCommand.set(route.slice(prefix.length), {
      schema: operation.requestBody?.content?.["application/json"]?.schema ?? null,
    })
  }
  return byCommand
}

function buildFlags(schema) {
  // A top-level oneOf/anyOf is a genuinely alternative body (8 commands).
  // Deriving flags from one arbitrary branch would be a lie, so those commands
  // take `--data` only and say so.
  if (schema && (schema.oneOf || schema.anyOf)) return { bodyKind: "composed", flags: [] }
  const properties = schema?.properties ?? {}
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  const flags = []
  const seen = new Set()
  for (const [property, propertySchema] of Object.entries(properties)) {
    const value = propertySchema && typeof propertySchema === "object" ? propertySchema : {}
    let flag = toFlagName(property)
    // Two schema properties can kebab-case to the same flag, and a property can
    // collide with a global flag. Both keep the property reachable via --data
    // and drop only the shorthand, so no field becomes unreachable.
    const reserved = RESERVED_FLAGS.has(flag) || seen.has(flag)
    if (reserved) flag = ""
    else seen.add(flag)
    flags.push({
      name: property,
      flag,
      type: flagType(value),
      ...(required.has(property) ? { required: true } : {}),
      ...(isNullable(value) ? { nullable: true } : {}),
      ...(enumValues(value) ? { enum: enumValues(value) } : {}),
      ...(firstLine(value.description) ? { description: firstLine(value.description) } : {}),
    })
  }
  return { bodyKind: "fields", flags }
}

function build() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "protocol/companion-commands.json"), "utf8")
  )
  const headless = readRpcSchemas(HEADLESS_SPEC, HEADLESS_PREFIX)
  const device = readRpcSchemas(DEVICE_SPEC, DEVICE_PREFIX)

  const entries = []
  for (const descriptor of manifest.commands) {
    const onHeadless = headless.get(descriptor.name)
    const onDevice = device.get(descriptor.name)
    if (!onHeadless && !onDevice) continue // internal-only, never reachable over a wire
    const wires = []
    if (onHeadless) wires.push("internal")
    if (onDevice) wires.push("http")
    // The two specs are generated from one dispatcher, so the request shape is
    // the same. Prefer headless because it is the superset.
    const source = onHeadless ?? onDevice
    const { bodyKind, flags } = buildFlags(source.schema)
    const { group, action } = splitCommandName(descriptor.name)
    entries.push({
      name: descriptor.name,
      group,
      action,
      ...(firstLine(source.schema?.description)
        ? { description: firstLine(source.schema.description) }
        : {}),
      target: descriptor.target,
      capability: descriptor.capability,
      risk: descriptor.risk,
      approval: descriptor.approval,
      idempotency: descriptor.idempotency,
      wires,
      bodyKind,
      flags,
      ...(requireOneOfGroups(source.schema) ? { requireOneOf: requireOneOfGroups(source.schema) } : {}),
    })
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return entries
}

function render(entries) {
  const lines = entries.map((entry) => `  ${JSON.stringify(entry)},`)
  return `// @generated by scripts/build/gen-cli-api-index.mjs. Do not edit.
//
// Run \`pnpm cli:api:gen\` after changing protocol/companion-commands.json or
// regenerating the Companion OpenAPI specs. \`pnpm cli:api:check\` fails on drift.

import type { ApiCommandEntry } from "../types"

export const API_INDEX_SCHEMA_VERSION = ${SCHEMA_VERSION}

export const API_COMMANDS: readonly ApiCommandEntry[] = [
${lines.join("\n")}
]
`
}

const entries = build()
const rendered = render(entries)

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : ""
  if (current !== rendered) {
    console.error(
      "gen-cli-api-index: cli/src/api/generated/command-index.ts is out of date.\n" +
        "  Fix: pnpm cli:api:gen"
    )
    process.exit(1)
  }
  const internal = entries.filter((entry) => entry.wires.includes("internal")).length
  const http = entries.filter((entry) => entry.wires.includes("http")).length
  console.log(`gen-cli-api-index: up to date (${entries.length} commands, ${internal} internal, ${http} http)`)
  process.exit(0)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, rendered)
const internal = entries.filter((entry) => entry.wires.includes("internal")).length
const http = entries.filter((entry) => entry.wires.includes("http")).length
console.log(
  `gen-cli-api-index: wrote ${path.relative(root, OUT)} (${entries.length} commands, ${internal} internal, ${http} http, ${(rendered.length / 1024).toFixed(0)} KB)`
)
