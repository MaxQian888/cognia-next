/**
 * Plugin SDK helper for the `chat-middleware` capability.
 *
 * Pure typesafety pass-through for `manifest.chatMiddlewares[]` entries.
 */

import type { PluginChatMiddlewareDef } from "@/types/plugin/plugin-chat-middleware"

export function defineChatMiddleware(def: PluginChatMiddlewareDef): PluginChatMiddlewareDef {
  return def
}
