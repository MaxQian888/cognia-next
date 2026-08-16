// The typed SDK declaration handed to the model in Code presentation
// (ADR-0117, Phase 4).
//
// Rendered from the tools' REAL JSON Schemas, which is why it lives here and
// not in `lib/`: the renderer only ever has tool *names*, while the assembled
// sidecar defs carry `inputSchema`. A renderer-side generator would have had to
// invent signatures, and generated code that type-checks against an invented
// signature is worse than no declaration at all.
//
// The declaration is embedded in `run_code`'s own description rather than
// appended to the system prompt: it is the API for that one tool, and keeping
// them together means a session that does not offer `run_code` cannot end up
// advertising an SDK for it.

import limits from "../../../lib/ai/code-mode/limits.json" with { type: "json" }

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Render one JSON Schema as a TypeScript type.
 *
 * @param {object | undefined} schema
 * @param {number} depth
 * @returns {string}
 */
export function renderSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object") return "unknown"

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  }

  const union = schema.anyOf ?? schema.oneOf
  if (Array.isArray(union) && union.length > 0) {
    return union.map((member) => renderSchema(member, depth)).join(" | ")
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  switch (type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array":
      return `Array<${schema.items ? renderSchema(schema.items, depth) : "unknown"}>`
    case "object":
      return renderObject(schema, depth)
    default:
      // `unknown`, never `any`: `any` would let generated code type-check
      // against a shape the tool will reject at validation time.
      return "unknown"
  }
}

function renderObject(schema, depth) {
  const properties = schema.properties ?? {}
  const names = Object.keys(properties)
  if (names.length === 0) {
    return schema.additionalProperties === false
      ? "Record<string, never>"
      : "Record<string, unknown>"
  }

  const pad = "  ".repeat(depth + 2)
  const closePad = "  ".repeat(depth + 1)
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const body = names.map((name) => {
    const property = properties[name] ?? {}
    const optional = required.has(name) ? "" : "?"
    const doc = typeof property.description === "string" ? property.description.trim() : ""
    const comment = doc ? `${pad}/** ${escapeComment(doc)} */\n` : ""
    return `${comment}${pad}${propertyKey(name)}${optional}: ${renderSchema(property, depth + 1)}`
  })
  return `{\n${body.join("\n")}\n${closePad}}`
}

function propertyKey(name) {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

function escapeComment(text) {
  return text.replace(/\*\//g, "*\\/")
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MiB`
  return `${bytes / 1024} KiB`
}

/**
 * Render the full declaration.
 *
 * @param {Array<{ name: string, description?: string, inputSchema?: object }>} tools
 *        The eligible tools, already filtered by the allowlist and by what this
 *        session actually enabled.
 * @param {object} [config] limit overrides, for tests
 */
export function generateSdkDeclaration(tools, config = limits) {
  const lines = [
    "Read-only tool SDK available inside `run_code` as `cognia`.",
    "",
    "Every function re-enters the host's tool registry: the same argument",
    "validation, permissions, confinement and audit log as a direct tool call.",
    "None of them can write.",
    "",
    "Limits for one run:",
    `  source ${formatBytes(config.maxSourceBytes)} · wall time ${config.wallTimeMs / 1000}s · ` +
      `${config.maxToolCalls} tool calls · concurrency ${config.maxConcurrency} · ` +
      `result ${formatBytes(config.maxResultBytes)}`,
    "",
    "```ts",
    "declare const cognia: {",
  ]

  for (const tool of tools) {
    const doc = typeof tool.description === "string" ? tool.description.trim() : ""
    if (doc) lines.push(`  /** ${escapeComment(doc)} */`)
    // A tool with no declared schema takes an open bag rather than nothing:
    // claiming `()` for a tool that does accept arguments would make the model
    // write calls the validator then rejects.
    const argType = tool.inputSchema ? renderSchema(tool.inputSchema, 0) : "Record<string, unknown>"
    lines.push(`  ${propertyKey(tool.name)}(input: ${argType}): Promise<unknown>`)
  }

  lines.push("}", "```")
  return lines.join("\n")
}
