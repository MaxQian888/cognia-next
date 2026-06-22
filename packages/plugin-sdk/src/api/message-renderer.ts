/**
 * Plugin SDK — `message-renderer` capability surface.
 *
 * Re-exports the manifest authoring helper and runtime registry for plugins
 * that render custom AI SDK message part types.
 */

export { defineMessageRenderer } from "../define/define-message-renderer"

export {
  registerMessagePartRenderer,
  getMessagePartRenderer,
  clearMessagePartRenderersForPlugin,
  clearAllMessagePartRenderers,
  listMessagePartRenderers,
  subscribeMessagePartRenderers,
  getMessagePartRenderersRevision,
} from "@/lib/plugin/api/message-part-renderers"
export {
  createMessagePartAPI,
  purgeMessagePartRenderersForPlugin,
} from "@/lib/plugin/api/message-part-api"

export type { PluginMessageRendererDef } from "@/types/plugin/plugin-message-renderer"
export type {
  MessagePartRendererEntry,
  MessagePartRendererProps,
} from "@/lib/plugin/api/message-part-renderers"
export type { PluginMessagePartAPI } from "@/lib/plugin/api/message-part-api"
