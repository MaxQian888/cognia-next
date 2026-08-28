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
