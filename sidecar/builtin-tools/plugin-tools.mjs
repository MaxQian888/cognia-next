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
import { toolError, toolText } from "./safety.mjs"

export const SERVER_NAME = "cognia-plugin-tools"
export const SERVER_VERSION = "0.1.0"

const DEFAULT_PLUGIN_TOOL_TIMEOUT_MS = 120_000

/**
 * True when a plugin tool returned a ready MCP `CallToolResult` rather than a
 * plain value. Plugin results otherwise get `JSON.stringify`-ed into a single
 * text block, which makes it *structurally impossible* for a plugin tool to
 * return an image / audio / embedded resource — the model would only ever see
 * base64 text, and the chat would only ever render a wall of it. Built-in tools
 * already return this shape (see `safety.mjs:toolImage`), so the check is the
 * same one the built-in path relies on.
 *
 * @param {unknown} result
 * @returns {boolean}
 */
export function isCallToolResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false
  const content = /** @type {{ content?: unknown }} */ (result).content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => !!b && typeof b === "object" && typeof b.type === "string")
  )
}

/**
 * Register a resolver for `toolUseId` in `pending` and return a promise that
 * settles when the renderer writes the matching `plugin_tool_response` (resolved
 * by `claude-host.mjs:handlePluginToolResponse` via the registered `{ resolve }`),
 * OR after `timeoutMs` with an error envelope. The timeout is the agent-loop
 * safety net: a stalled / closed renderer must surface a clean tool error rather
 * than hang the SDK turn forever. The resolver is registered SYNCHRONOUSLY so the
 * caller can `emit` the request immediately after calling this.
 *
 * A `timeoutMs <= 0` (or non-finite) disables the timer entirely — for tools
 * that legitimately block on a human (`ask_user`) or run their own bounded long
 * task (`dispatch_agent`), where a fixed safety-net timeout would sever a call
 * that is still perfectly valid.
 *
 * @param {Map<string, { resolve: (r: any) => void }>} pending
 * @param {string} toolUseId
 * @param {string} name  bare tool name, for the timeout message
 * @param {number} [timeoutMs]
 * @returns {Promise<{ result?: unknown, error?: string }>}
 */
export function awaitPluginToolResponse(
  pending,
  toolUseId,
  name,
  timeoutMs = DEFAULT_PLUGIN_TOOL_TIMEOUT_MS
) {
  return new Promise((resolve) => {
    const noTimeout = !Number.isFinite(timeoutMs) || timeoutMs <= 0
    const timer = noTimeout
      ? null
      : setTimeout(() => {
          pending.delete(toolUseId)
          resolve({ error: `plugin tool '${name}' timed out after ${timeoutMs}ms` })
        }, timeoutMs)
    if (timer && typeof timer.unref === "function") timer.unref()
    pending.set(toolUseId, {
      resolve: (r) => {
        if (timer) clearTimeout(timer)
        pending.delete(toolUseId)
        resolve(r)
      },
    })
  })
}

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
  sandboxRuntimeRef,
  pendingPluginToolCalls,
  alwaysLoad,
  alwaysLoadToolNames,
  remoteExecutionContext,
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
        // Honor a per-tool timeout override from the manifest (`t.timeoutMs`);
        // `0` means "no timeout" for human-blocking / long-running tools.
        const pending = awaitPluginToolResponse(
          pendingPluginToolCalls,
          toolUseId,
          t.name,
          typeof t.timeoutMs === "number" ? t.timeoutMs : undefined
        )
        emit({
          type: "plugin_tool_exec",
          sessionId,
          toolUseId,
          name: t.name,
          args,
          ...(sandboxRuntimeRef ? { sandboxRuntimeRef } : {}),
          ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
        })
        const response = await pending
        if (response && response.error) {
          return toolError(response.error, "plugin tool")
        }
        const result = response?.result ?? null
        // A plugin that already speaks MCP (image / audio / resource blocks)
        // passes through untouched; everything else keeps the JSON-text shape.
        return isCallToolResult(result) ? result : toolText(result)
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
    // `enum` / `const` are checked BEFORE `type`: the enum IS the contract, and
    // for several tools it is also the discovery mechanism (dispatch_agent's
    // `subagentId` enumerates the available subagents). Dropping it left the
    // model a bare string on this rail while the ai-sdk rail saw the real
    // constraint — the same tool validated differently per provider.
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      // `null` is a legal enum member and a common one: `enum: ["a","b",null]`
      // is how a schema says "one of these, or explicitly cleared". Filtering it
      // out (rather than mapping it to `z.null()`) made this rail reject a value
      // the schema declares, and left `enum: [null]` with no members at all.
      const literals = p.enum.filter((v) => v !== null && v !== undefined)
      const hasNull = p.enum.includes(null)
      if (!hasNull && literals.length > 0 && literals.every((v) => typeof v === "string")) {
        zodType = z.enum(/** @type {[string, ...string[]]} */ (literals))
      } else {
        const branches = [
          ...literals.map((v) => z.literal(/** @type {any} */ (v))),
          ...(hasNull ? [z.null()] : []),
        ]
        // A single member is a literal, not a union: `z.union` needs two, and
        // duplicating the member to satisfy it only obscured the empty case.
        zodType =
          branches.length === 1
            ? branches[0]
            : branches.length > 1
              ? z.union(/** @type {any} */ (branches))
              : z.unknown()
      }
    } else if (p.const !== undefined) {
      zodType = z.literal(/** @type {any} */ (p.const))
    } else {
      switch (p.type) {
        case "string": {
          let s = z.string()
          if (typeof p.minLength === "number") s = s.min(p.minLength)
          if (typeof p.maxLength === "number") s = s.max(p.maxLength)
          if (typeof p.pattern === "string") {
            try {
              s = s.regex(new RegExp(p.pattern))
            } catch {
              /* an unsupported pattern must not brick the tool */
            }
          }
          zodType = s
          break
        }
        case "number":
        case "integer": {
          let n = p.type === "integer" ? z.number().int() : z.number()
          if (typeof p.minimum === "number") n = n.min(p.minimum)
          if (typeof p.maximum === "number") n = n.max(p.maximum)
          if (typeof p.exclusiveMinimum === "number") n = n.gt(p.exclusiveMinimum)
          if (typeof p.exclusiveMaximum === "number") n = n.lt(p.exclusiveMaximum)
          zodType = n
          break
        }
        case "boolean":
          zodType = z.boolean()
          break
        case "array": {
          const itemSchema =
            p.items && typeof p.items === "object"
              ? jsonSchemaPropToZod(p.items, true)
              : z.unknown()
          let a = z.array(itemSchema)
          if (typeof p.minItems === "number") a = a.min(p.minItems)
          if (typeof p.maxItems === "number") a = a.max(p.maxItems)
          zodType = a
          break
        }
        case "object": {
          // Recurse into nested `properties`/`required` instead of collapsing
          // the whole object to an opaque record. `working_set.entry` carries
          // three enums, a `required` list and `refs.maxItems` that all
          // vanished under the old `z.record(z.string(), z.unknown())`.
          if (p.properties && typeof p.properties === "object") {
            const nestedRequired = Array.isArray(p.required) ? p.required : []
            /** @type {Record<string, z.ZodType>} */
            const nestedShape = {}
            for (const [k, v] of Object.entries(p.properties)) {
              nestedShape[k] = jsonSchemaPropToZod(v, nestedRequired.includes(k))
            }
            const obj = z.object(nestedShape)
            // Only close the object when the schema says so; JSON Schema's
            // default is open, and tightening it would reject valid calls.
            zodType = p.additionalProperties === false ? obj.strict() : obj.passthrough()
          } else {
            zodType = z.record(z.string(), z.unknown())
          }
          break
        }
        case "null":
          zodType = z.null()
          break
        default:
          zodType = z.unknown()
      }
    }
    if (typeof p.description === "string" && p.description.length > 0) {
      zodType = zodType.describe(p.description)
    }
    // `default` implies the field is optional to the caller; apply it last so
    // it wraps whatever constraint was built above.
    if (p.default !== undefined && !required) {
      return zodType.optional().default(/** @type {any} */ (p.default))
    }
  }
  return required ? zodType : zodType.optional()
}
