/** Portable message-renderer contracts and composer event bridge. */

export { defineMessageRenderer } from "../define/define-message-renderer"

export type { PluginMessageRendererDef } from "@/types/plugin/plugin-message-renderer"
export type {
  MessagePartRendererEntry,
  MessagePartRendererProps,
} from "@/lib/plugin/api/message-part-renderers"
export type { PluginMessagePartAPI } from "@/lib/plugin/api/message-part-api"

export const COMPOSER_APPEND_EVENT = "cognia:composer-append"

export interface ComposerAppendDetail {
  text?: string
  sessionId?: string
}

/** Append text to the addressed host composer without importing host React code. */
export function dispatchComposerAppend(detail: ComposerAppendDetail): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(COMPOSER_APPEND_EVENT, { detail }))
}
