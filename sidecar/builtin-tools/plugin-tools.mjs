// Synthetic `cognia-plugin-tools` in-process MCP server (M2).
//
// Mirrors the shape of `./index.mjs` (the cognia-tools builtin server) but
// instead of running tools locally, every call here proxies back to the
// renderer process over the parent stdio protocol. The dispatcher builds
// one of these servers per session when the renderer has surfaced a
// non-empty `pluginTools` manifest in SendOptions.
//
// Wire protocol — sidecar → parent:
//   { type: "plugin_tool_exec", sessionId, toolUseId, name, args }
// Wire protocol — parent → sidecar (via claude-host.mjs):
//   { type: "plugin_tool_response", sessionId, toolUseId, result?, error? }
//
// The pending-promise map lives on the session object so concurrent tool
// calls don't trample each other and the parent can resolve them via the
// `toolUseId` key.

import { randomUUID } from "node:crypto"
import { z } from "zod"
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"

export const SERVER_NAME = "cognia-plugin-tools"
export const SERVER_VERSION = "0.1.0"

/**
 * Build an in-process MCP server that proxies tool calls back to the
 * renderer process via the existing claude-host stdio protocol.
 *
 * @param {object} options
 * @param {Array<{name: string, description: string, jsonSchema: object, pluginId: string}>} options.tools
 *        Plugin tool manifest forwarded from the renderer. The `execute`
 *        function is intentionally absent — functions don't cross the stdio
 *        boundary, so we synthesize one here that proxies back over IPC.
 * @param {(msg: any) => void} options.emit  sidecar → parent stdout writer.
 * @param {string} options.sessionId  Session id, used to scope responses.
 * @param {Map<string, { resolve: (r: any) => void }>} options.pendingPluginToolCalls
 *        Pending-promise map keyed by toolUseId. The parent resolves
 *        entries here when it receives the matching plugin_tool_response.
 * @param {boolean} [options.alwaysLoad]
 *        Server-level always-load — when true every plugin tool stays
 *        resident (never deferred behind tool search). Mirrors
 *        `createSdkMcpServer({ alwaysLoad })`.
 * @param {Set<string>} [options.alwaysLoadToolNames]
 *        Per-tool always-load allowlist (bare names). Tools whose name is in
 *        this set are pinned resident even when the server defers the rest —
 *        applied via `tool({ alwaysLoad })`, which the SDK OR's with the
 *        server-level flag.
 * @returns {ReturnType<typeof createSdkMcpServer> | null}
 */
export function buildPluginToolsServer({
  tools,
  emit,
  sessionId,
  pendingPluginToolCalls,
  alwaysLoad,
  alwaysLoadToolNames,
}) {
  if (!Array.isArray(tools) || tools.length === 0) return null

  const perToolAlways =
    alwaysLoadToolNames instanceof Set ? alwaysLoadToolNames : new Set(alwaysLoadToolNames ?? [])

  const wrappedTools = tools.map((t) => {
    const zodShape = jsonSchemaToZodShape(t.jsonSchema)
    const toolExtras = perToolAlways.has(t.name) ? { alwaysLoad: true } : undefined
    return tool(
      t.name,
      t.description ?? "",
      zodShape,
      async (args) => {
        const toolUseId = randomUUID()
        const response = await new Promise((resolve) => {
          pendingPluginToolCalls.set(toolUseId, { resolve })
          emit({
            type: "plugin_tool_exec",
            sessionId,
            toolUseId,
            name: t.name,
            args,
          })
        })
        if (response && response.error) {
          return {
            content: [{ type: "text", text: `Error: ${response.error}` }],
            isError: true,
          }
        }
        const payload =
          typeof response?.result === "string"
            ? response.result
            : JSON.stringify(response?.result ?? null)
        return {
          content: [{ type: "text", text: payload }],
        }
      },
      toolExtras
    )
  })

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: wrappedTools,
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  })
}

/**
 * Lightweight JSON Schema → zod shape conversion. The shape object is
 * exactly what `tool()` expects — keys map to zod schemas, NOT a wrapping
 * `z.object(...)`. For anything that isn't a JSON object schema we return
 * an empty shape; the underlying execute call still receives the raw args
 * unchanged because the SDK only uses the shape for validation /
 * autocompletion.
 *
 * @param {unknown} schema
 * @returns {Record<string, z.ZodType>}
 */
export function jsonSchemaToZodShape(schema) {
  if (!schema || typeof schema !== "object") return {}
  /** @type {Record<string, unknown>} */
  const s = schema
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
    return {}
  }
  const required = Array.isArray(s.required) ? s.required : []
  /** @type {Record<string, z.ZodType>} */
  const shape = {}
  for (const [key, prop] of Object.entries(s.properties)) {
    shape[key] = jsonSchemaPropToZod(prop, required.includes(key))
  }
  return shape
}

/**
 * Map a single JSON-Schema property to a zod type. Unknown types fall
 * back to `z.unknown()`. Optional fields (those not in `required`) are
 * wrapped with `.optional()`.
 *
 * @param {unknown} prop
 * @param {boolean} required
 * @returns {z.ZodType}
 */
export function jsonSchemaPropToZod(prop, required) {
  /** @type {z.ZodType} */
  let zodType
  if (!prop || typeof prop !== "object") {
    zodType = z.unknown()
  } else {
    /** @type {Record<string, unknown>} */
    const p = prop
    switch (p.type) {
      case "string":
        zodType = z.string()
        break
      case "number":
        zodType = z.number()
        break
      case "integer":
        zodType = z.number().int()
        break
      case "boolean":
        zodType = z.boolean()
        break
      case "array": {
        const itemSchema =
          p.items && typeof p.items === "object" ? jsonSchemaPropToZod(p.items, true) : z.unknown()
        zodType = z.array(itemSchema)
        break
      }
      case "object":
        zodType = z.record(z.string(), z.unknown())
        break
      case "null":
        zodType = z.null()
        break
      default:
        zodType = z.unknown()
    }
    if (typeof p.description === "string" && p.description.length > 0) {
      zodType = zodType.describe(p.description)
    }
  }
  return required ? zodType : zodType.optional()
}
