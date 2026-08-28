/**
 * Plugin SDK — `tool-renderer` capability surface.
 *
 * Re-exports the manifest authoring helper and the runtime registry for
 * plugins that render a custom card for a tool's result in the chat
 * transcript. Distinct from `./message-renderer`, which renders whole AI SDK
 * message *parts*; this one keys off a tool name.
 *
 * A plugin registers from `activate(ctx)` and the plugin manager clears
 * everything it contributed on disable via
 * `clearToolResultRenderersForPlugin(pluginId)` — the same call a plugin's own
 * tests should use for cleanup.
 */

export { defineToolRenderer } from "../define/define-tool-renderer"

export {
  clearAllToolResultRenderers,
  clearToolResultRenderersForPlugin,
  getToolResultRenderer,
  getToolResultRenderersRevision,
  listToolResultRenderers,
  registerToolResultRenderer,
  subscribeToolResultRenderers,
  toolResultRendererKey,
} from "@/lib/plugin/api/tool-result-renderers"

export type {
  ToolResultRendererEntry,
  ToolResultRendererProps,
} from "@/lib/plugin/api/tool-result-renderers"

/**
 * The card chrome the host's own tool cards are built from. A renderer that
 * hand-rolls its own frame drifts from the transcript around it — different
 * padding, different header affordances, a different empty state — so the
 * shell, the output parser and the media-src resolver are all shared rather
 * than re-implemented per plugin.
 *
 * `useParsedOutput` / `parseOutputJson` handle the awkward part: a tool result
 * arrives as `unknown` and may be a JSON string, an already-parsed object, or
 * neither. `blockMediaSrc` turns an MCP content block into something an `<img>`
 * or `<video>` can load, including base64 payloads.
 */
export {
  blockMediaSrc,
  hostOf,
  languageFromPath,
  McpCardShell,
  parseOutputJson,
  useParsedOutput,
} from "@/components/chat/message-parts/mcp-renderers/common"

/** The host's image renderer — zoom, download, and error states included. */
export { ImageBlock } from "@/components/chat/renderers/image-block"

/** One content block of an MCP tool result. */
export type { McpResultBlock } from "@/lib/claude/parts-extensions"

/**
 * Copy-to-clipboard with the host's own feedback timing, and the icon that
 * animates the confirmation. A card that copies text should feel like every
 * other copy button in the app.
 */
export { useCopy } from "@/hooks/ui/use-copy"
export type { UseCopyOptions, UseCopyResult } from "@/hooks/ui/use-copy"
export { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
export type { CopyFeedbackIconProps } from "@/components/shared/animated-action-icon"
