/**
 * Plugin SDK - `chat-middleware` capability surface.
 *
 * Re-exports the declarative authoring helper, manifest bridge, imperative
 * `ctx.chat.use(...)` runtime API, and the host middleware registry.
 */

export { defineChatMiddleware } from "../define/define-chat-middleware"

export {
  registerChatMiddlewaresForPlugin,
  unregisterChatMiddlewaresForPlugin,
} from "@/lib/plugin/bridge/chat-middleware-bridge"

export type { RegisterChatMiddlewaresOptions } from "@/lib/plugin/bridge/chat-middleware-bridge"

export { clearChatMiddlewaresForPluginContext, createChatAPI } from "@/lib/plugin/api/chat-api"

export type { PluginChatAPI } from "@/lib/plugin/api/chat-api"

export {
  CIRCUIT_BREAKER_THRESHOLD,
  clearChatMiddlewaresForPlugin,
  DEFAULT_MIDDLEWARE_TIMEOUT_MS,
  getChatMiddleware,
  listActiveChatMiddlewares,
  listAllChatMiddlewares,
  MAX_MIDDLEWARE_TIMEOUT_MS,
  recordMiddlewareFailure,
  recordMiddlewareSuccess,
  registerChatMiddleware,
  resetChatMiddlewareBreaker,
  subscribeChatMiddlewareRegistry,
  unregisterChatMiddleware,
} from "@/lib/claude/chat-middleware/registry"

export type {
  ChatMiddlewareEvent,
  ChatMiddlewareRegistration,
  RegisterChatMiddlewareArgs,
} from "@/lib/claude/chat-middleware/registry"

export type {
  ChatMiddleware,
  ChatMiddlewareNext,
  ChatMiddlewareRequest,
  ChatMiddlewareResponse,
  PluginChatMiddlewareDef,
  PluginChatMiddlewareFactory,
  PluginChatMiddlewareFactoryContext,
  PluginChatMiddlewareRegistration,
} from "@/types/plugin/plugin-chat-middleware"
