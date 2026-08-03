/**
 * Plugin tool manifest → realtime tool definitions.
 *
 * The realtime session advertises its tools once, inside `session-update`. That
 * makes this mapping load-bearing in a way the sidecar path is not: a single
 * malformed entry does not degrade one tool, it makes the provider reject the
 * whole `session.update` and the session comes up with **no** tools at all. So
 * every entry is validated and normalized here, and anything that cannot be
 * made safe is dropped with a reason rather than forwarded.
 *
 * Four things are enforced:
 *
 * 1. **Names.** Vendors accept `^[a-zA-Z0-9_-]{1,64}$`. Namespaced plugin tools
 *    can exceed that; they are dropped, not silently truncated (truncation
 *    would collide two tools onto one name).
 * 2. **Schemas.** A bare `{}` is a legal JSON Schema but vendors reject it.
 *    Typeless schemas are normalized to a real object schema.
 * 3. **Duplicates.** `resolveSendOptions` appends from roughly eight sources
 *    and only some of them de-duplicate. First occurrence wins, because the
 *    promoted built-ins are appended ahead of the plugin entries they supersede.
 * 4. **Budget.** Tool count and serialized size are capped so a user with many
 *    plugins enabled still gets a session rather than an oversized frame.
 */

import type { Experimental_RealtimeModelV4ToolDefinition as RealtimeToolDefinition } from "@ai-sdk/provider"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

/** The entry shape carried on `SendOptions.pluginTools`. */
export interface PluginToolEntry {
  name: string
  description: string
  jsonSchema: object
  pluginId: string
}

/** Vendor-accepted tool name. Anything else is refused by the provider. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * What a typeless schema becomes. `additionalProperties: false` matters: with a
 * permissive schema some models invent arguments the tool never declared, and
 * the plugin then receives keys it does not validate.
 */
const EMPTY_OBJECT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

/** Default ceiling on advertised tools. */
export const DEFAULT_MAX_REALTIME_TOOLS = 64

/**
 * Default ceiling on the serialized tool block, in bytes. `session.update` is a
 * single WebSocket frame; providers reject oversized ones outright.
 */
export const DEFAULT_MAX_REALTIME_TOOL_BYTES = 32_768

export type DroppedToolReason =
  "invalid-name" | "invalid-description" | "pii" | "duplicate" | "tool-budget" | "byte-budget"

export interface DroppedTool {
  name: string
  pluginId: string
  reason: DroppedToolReason
}

export interface RealtimeToolMapping {
  tools: RealtimeToolDefinition[]
  /** Everything that did not make it, so the UI and telemetry can say why. */
  dropped: DroppedTool[]
}

export interface MapRealtimeToolsOptions {
  maxTools?: number
  maxBytes?: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Coerce a plugin's JSON Schema into something a realtime provider accepts.
 *
 * A schema that already declares `type` is passed through untouched — plugins
 * own their contracts and rewriting them would change validation semantics.
 */
export function normalizeToolSchema(schema: object): JSONSchema7 {
  if (!isPlainObject(schema)) return EMPTY_OBJECT_SCHEMA
  if (typeof schema.type === "string") return schema as JSONSchema7
  // Properties without a `type` is the common hand-written case; it is an
  // object schema that forgot to say so.
  if (isPlainObject(schema.properties)) {
    return { type: "object", ...schema } as JSONSchema7
  }
  return EMPTY_OBJECT_SCHEMA
}

/**
 * Map plugin tool manifest entries onto realtime tool definitions.
 *
 * Input order is preserved rather than sorted: it encodes priority (promoted
 * built-ins first, then plugins in registry order), so truncating at the budget
 * drops the least important tools instead of the alphabetically last ones. The
 * result is still deterministic for a given manifest.
 */
export function mapRealtimeTools(
  entries: readonly PluginToolEntry[] | undefined,
  options: MapRealtimeToolsOptions = {}
): RealtimeToolMapping {
  const maxTools = options.maxTools ?? DEFAULT_MAX_REALTIME_TOOLS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_REALTIME_TOOL_BYTES

  const tools: RealtimeToolDefinition[] = []
  const dropped: DroppedTool[] = []
  const seen = new Set<string>()
  let bytes = 0

  for (const entry of entries ?? []) {
    const name = typeof entry?.name === "string" ? entry.name : ""
    const pluginId = typeof entry?.pluginId === "string" ? entry.pluginId : "unknown"

    if (!TOOL_NAME_PATTERN.test(name)) {
      dropped.push({ name, pluginId, reason: "invalid-name" })
      continue
    }
    if (seen.has(name)) {
      dropped.push({ name, pluginId, reason: "duplicate" })
      continue
    }
    // A non-string description would serialize as `null`/`{}` inside the tool
    // block; some providers reject the whole frame rather than that one field.
    if (entry.description !== undefined && typeof entry.description !== "string") {
      dropped.push({ name, pluginId, reason: "invalid-description" })
      continue
    }
    if (tools.length >= maxTools) {
      dropped.push({ name, pluginId, reason: "tool-budget" })
      continue
    }

    const tool: RealtimeToolDefinition = {
      type: "function",
      name,
      ...(entry.description ? { description: entry.description } : {}),
      parameters: normalizeToolSchema(entry.jsonSchema),
    }

    if (!hasNoLeakingPiiDeep(tool)) {
      dropped.push({ name, pluginId, reason: "pii" })
      continue
    }

    const size = JSON.stringify(tool).length
    if (bytes + size > maxBytes) {
      // Keep scanning rather than stopping: one tool with a huge schema should
      // not shut out every smaller tool behind it. Still deterministic.
      dropped.push({ name, pluginId, reason: "byte-budget" })
      continue
    }

    bytes += size
    seen.add(name)
    tools.push(tool)
  }

  return { tools, dropped }
}
