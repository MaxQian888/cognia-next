// Round-trip of plugin tool names across the Claude Agent SDK boundary.
//
// The bundled Claude Code normalises every MCP tool name it advertises to the
// API (`ocr.extract` becomes `mcp__cognia-plugin-tools__ocr_extract`), and the
// Anthropic API itself only accepts `[a-zA-Z0-9_-]`. Everything on our side of
// the sidecar keys on the ORIGINAL manifest name: the renderer's tool cards,
// the IM permission ceiling, `alwaysAllowTools`, `suppressApprovalForTools`,
// the permission ruleset, the plugin round-trip. Registering the sanitized
// name ourselves (with the same replacement Claude Code applies) makes the
// alias table exact, and these helpers translate at the three places the two
// vocabularies meet: the option lists we hand the SDK, the tool name the SDK
// hands `canUseTool`, and the messages the SDK streams back.

import { sanitizeToolMap } from "./model-names.ts"
import { qualifiedToolName } from "./names.ts"

/** A content block as the SDK streams it; only tool_use blocks carry a name. */
interface ToolUseBlockLike {
  type?: unknown
  name?: unknown
}

/** The fields of an SDK message that can carry a tool name. */
interface SdkMessageLike {
  type?: unknown
  subtype?: unknown
  message?: { content?: ToolUseBlockLike[] }
  event?: { type?: unknown; content_block?: ToolUseBlockLike }
  tools?: unknown[]
  tool_name?: unknown
}

/** Bare `model → original` names for one MCP server's renamed tools. */
type Aliases = ReadonlyMap<string, string> | undefined | null

/**
 * The bare tool name behind a qualified one on `serverName`, or `null` when
 * the name belongs to another server or is not qualified at all.
 */
export function bareNameOnServer(serverName: string, name: unknown): string | null {
  if (typeof name !== "string") return null
  const prefix = `mcp__${serverName}__`
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null
}

/**
 * Model-facing names for a manifest, plus the alias table `model → original`
 * holding only the names that changed.
 */
export function planPluginToolNames(tools: unknown): {
  modelNameOf: Map<string, string>
  aliases: Map<string, string>
} {
  const byName: Record<string, true> = {}
  for (const t of Array.isArray(tools) ? (tools as unknown[]) : []) {
    const name = (t as { name?: unknown } | null)?.name
    if (t && typeof name === "string") byName[name] = true
  }
  const { aliases } = sanitizeToolMap(byName)
  const modelNameOf = new Map<string, string>()
  for (const [model, original] of aliases) modelNameOf.set(original, model)
  return { modelNameOf, aliases }
}

/**
 * The original qualified name for a qualified model-facing one. Identity for
 * names that were never renamed or that belong to another server.
 */
export function restorePluginToolName(aliases: Aliases, serverName: string, name: string): string {
  if (!aliases || aliases.size === 0) return name
  const bare = bareNameOnServer(serverName, name)
  if (bare === null) return name
  const original = aliases.get(bare)
  return original === undefined ? name : qualifiedToolName(serverName, original)
}

/**
 * The model-facing qualified name for an original qualified one. Identity for
 * names that need no rename.
 */
export function modelPluginToolName(aliases: Aliases, serverName: string, name: string): string {
  if (!aliases || aliases.size === 0) return name
  const bare = bareNameOnServer(serverName, name)
  if (bare === null) return name
  for (const [model, original] of aliases) {
    if (original === bare) return qualifiedToolName(serverName, model)
  }
  return name
}

/**
 * Translate a tool-name list (allowedTools, disallowedTools) to the names the
 * SDK will compare against. Non-string entries and other servers pass through,
 * and the list keeps its order and identity when nothing changes.
 */
export function modelPluginToolNameList<L>(aliases: Aliases, serverName: string, list: L): L {
  if (!Array.isArray(list) || !aliases || aliases.size === 0) return list
  let changed = false
  const out = (list as unknown[]).map((entry) => {
    if (typeof entry !== "string") return entry
    const mapped = modelPluginToolName(aliases, serverName, entry)
    if (mapped !== entry) changed = true
    return mapped
  })
  // Same length and element kinds as `list`, so the list's own type still holds.
  return changed ? (out as L) : list
}

/**
 * Rewrite the tool names inside one streamed SDK message back to the original
 * vocabulary: `tool_use` blocks of an assistant message, the `tool_use` block
 * that opens a streamed content block, and the tool inventory of the init
 * message. Returns the same object when nothing needed to change, so the
 * common case allocates nothing. The copy keeps every other field, so it
 * stays the caller's message type.
 */
export function restorePluginToolNamesInSdkMessage<T>(
  aliases: Aliases,
  serverName: string,
  evt: T
): T {
  if (!aliases || aliases.size === 0 || !evt || typeof evt !== "object") return evt
  const restore = (name: string): string => restorePluginToolName(aliases, serverName, name)
  const message = evt as SdkMessageLike

  if (message.type === "assistant" && Array.isArray(message.message?.content)) {
    let changed = false
    const content = message.message.content.map((block: ToolUseBlockLike) => {
      if (block?.type !== "tool_use" || typeof block.name !== "string") return block
      const name = restore(block.name)
      if (name === block.name) return block
      changed = true
      return { ...block, name }
    })
    return changed ? ({ ...message, message: { ...message.message, content } } as T) : evt
  }

  if (message.type === "stream_event") {
    const block = message.event?.content_block
    if (
      message.event?.type === "content_block_start" &&
      block?.type === "tool_use" &&
      typeof block.name === "string"
    ) {
      const name = restore(block.name)
      if (name === block.name) return evt
      return { ...message, event: { ...message.event, content_block: { ...block, name } } } as T
    }
    return evt
  }

  if (message.type === "system" && message.subtype === "init" && Array.isArray(message.tools)) {
    let changed = false
    const tools = message.tools.map((name: unknown) => {
      if (typeof name !== "string") return name
      const restored = restore(name)
      if (restored !== name) changed = true
      return restored
    })
    return changed ? ({ ...message, tools } as T) : evt
  }

  if (message.type === "tool_progress" && typeof message.tool_name === "string") {
    const name = restore(message.tool_name)
    return name === message.tool_name ? evt : ({ ...message, tool_name: name } as T)
  }

  return evt
}
