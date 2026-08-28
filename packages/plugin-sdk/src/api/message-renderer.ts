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

/**
 * Hand text back to the composer from inside a rendered card — "insert this
 * OCR text into my draft", "quote this conclusion".
 *
 * `dispatchComposerAppend` is the call; the event name is exported alongside
 * it for a renderer that needs to listen. Address it with `sessionId`: more
 * than one composer is mounted at a time (split view has two, a workbench
 * sidechat adds another), so an un-addressed event lands in whichever is
 * active — fine for "the focused one", wrong for anything else.
 */
export { COMPOSER_APPEND_EVENT, dispatchComposerAppend } from "@/components/chat/composer"
export type { ComposerAppendDetail } from "@/components/chat/composer"
