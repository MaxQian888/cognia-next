/**
 * The plugin contract's share of `lib/claude/chat-middleware/registry.ts`, which re-exports these.
 */

import type { ChatMiddleware } from "../../../types/plugin/plugin-chat-middleware"

export interface ChatMiddlewareRegistration {
  pluginId: string
  /** Unprefixed middleware id; key for the breaker counter. */
  middlewareId: string
  /** Full id used in logs (`<pluginId>:<middlewareId>`). */
  fullId: string
  fn: ChatMiddleware
  priority: number
  timeoutMs: number
  consecutiveFailures: number
  disabled: boolean
  /** True once the breaker has tripped — surfaced to settings UI. */
  breakerTripped: boolean
}

export type ChatMiddlewareEvent =
  | { type: "registered"; fullId: string; pluginId: string }
  | { type: "unregistered"; fullId: string; pluginId: string }
  | { type: "breaker-tripped"; fullId: string; pluginId: string; reason: string }
  | { type: "breaker-reset"; fullId: string; pluginId: string }

export interface RegisterChatMiddlewareArgs {
  pluginId: string
  middlewareId: string
  fn: ChatMiddleware
  priority?: number
  timeoutMs?: number
}
