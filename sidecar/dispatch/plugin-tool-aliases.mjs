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

import { sanitizeToolMap } from "./ai-sdk-tool-names.mjs"

/** `mcp__<server>__<tool>` for one bare tool name. */
export function qualifiedPluginToolName(serverName, bareName) {
  return `mcp__${serverName}__${bareName}`
}

/**
 * The bare tool name behind a qualified one on `serverName`, or `null` when
 * the name belongs to another server or is not qualified at all.
 *
 * @param {string} serverName
 * @param {unknown} name
 * @returns {string | null}
 */
export function bareNameOnServer(serverName, name) {
  if (typeof name !== "string") return null
  const prefix = `mcp__${serverName}__`
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null
}

/**
 * Model-facing names for a manifest, plus the alias table `model → original`
 * holding only the names that changed.
 *
 * @param {Array<{ name: string }>} tools
 * @returns {{ modelNameOf: Map<string, string>, aliases: Map<string, string> }}
 */
export function planPluginToolNames(tools) {
  const byName = {}
  for (const t of Array.isArray(tools) ? tools : []) {
    if (t && typeof t.name === "string") byName[t.name] = true
  }
  const { aliases } = sanitizeToolMap(byName)
  const modelNameOf = new Map()
  for (const [model, original] of aliases) modelNameOf.set(original, model)
  return { modelNameOf, aliases }
}

/**
 * The original qualified name for a qualified model-facing one. Identity for
 * names that were never renamed or that belong to another server.
 *
 * @param {Map<string, string> | undefined | null} aliases bare `model → original`
 * @param {string} serverName
 * @param {string} name
 * @returns {string}
 */
export function restorePluginToolName(aliases, serverName, name) {
  if (!aliases || aliases.size === 0) return name
  const bare = bareNameOnServer(serverName, name)
  if (bare === null) return name
  const original = aliases.get(bare)
  return original === undefined ? name : qualifiedPluginToolName(serverName, original)
}

/**
 * The model-facing qualified name for an original qualified one. Identity for
 * names that need no rename.
 *
 * @param {Map<string, string> | undefined | null} aliases bare `model → original`
 * @param {string} serverName
 * @param {string} name
 * @returns {string}
 */
export function modelPluginToolName(aliases, serverName, name) {
  if (!aliases || aliases.size === 0) return name
  const bare = bareNameOnServer(serverName, name)
  if (bare === null) return name
  for (const [model, original] of aliases) {
    if (original === bare) return qualifiedPluginToolName(serverName, model)
  }
  return name
}

/**
 * Translate a tool-name list (allowedTools, disallowedTools) to the names the
 * SDK will compare against. Non-string entries and other servers pass through,
 * and the list keeps its order and identity when nothing changes.
 *
 * @param {Map<string, string> | undefined | null} aliases
 * @param {string} serverName
 * @param {unknown} list
 */
export function modelPluginToolNameList(aliases, serverName, list) {
  if (!Array.isArray(list) || !aliases || aliases.size === 0) return list
  let changed = false
  const out = list.map((entry) => {
    if (typeof entry !== "string") return entry
    const mapped = modelPluginToolName(aliases, serverName, entry)
    if (mapped !== entry) changed = true
    return mapped
  })
  return changed ? out : list
}

/**
 * Rewrite the tool names inside one streamed SDK message back to the original
 * vocabulary: `tool_use` blocks of an assistant message, the `tool_use` block
 * that opens a streamed content block, and the tool inventory of the init
 * message. Returns the same object when nothing needed to change, so the
 * common case allocates nothing.
 *
 * @template T
 * @param {Map<string, string> | undefined | null} aliases
 * @param {string} serverName
 * @param {T} evt
 * @returns {T}
 */
export function restorePluginToolNamesInSdkMessage(aliases, serverName, evt) {
  if (!aliases || aliases.size === 0 || !evt || typeof evt !== "object") return evt
  const restore = (name) => restorePluginToolName(aliases, serverName, name)

  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    let changed = false
    const content = evt.message.content.map((block) => {
      if (block?.type !== "tool_use" || typeof block.name !== "string") return block
      const name = restore(block.name)
      if (name === block.name) return block
      changed = true
      return { ...block, name }
    })
    return changed ? { ...evt, message: { ...evt.message, content } } : evt
  }

  if (evt.type === "stream_event") {
    const block = evt.event?.content_block
    if (
      evt.event?.type === "content_block_start" &&
      block?.type === "tool_use" &&
      typeof block.name === "string"
    ) {
      const name = restore(block.name)
      if (name === block.name) return evt
      return { ...evt, event: { ...evt.event, content_block: { ...block, name } } }
    }
    return evt
  }

  if (evt.type === "system" && evt.subtype === "init" && Array.isArray(evt.tools)) {
    let changed = false
    const tools = evt.tools.map((name) => {
      if (typeof name !== "string") return name
      const restored = restore(name)
      if (restored !== name) changed = true
      return restored
    })
    return changed ? { ...evt, tools } : evt
  }

  if (evt.type === "tool_progress" && typeof evt.tool_name === "string") {
    const name = restore(evt.tool_name)
    return name === evt.tool_name ? evt : { ...evt, tool_name: name }
  }

  return evt
}
