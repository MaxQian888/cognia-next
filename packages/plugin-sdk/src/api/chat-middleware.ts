/**
 * Plugin SDK - `chat-middleware` capability surface.
 *
 * Exports the declarative authoring helper, the types of the imperative
 * `ctx.chat.use(...)` API, and the host middleware registry. The host builds
 * `ctx.chat`, registers manifest-declared middleware and runs the circuit
 * breaker itself; none of that wiring is on the author surface.
 */

export { defineChatMiddleware } from "../define/define-chat-middleware"

export type { RegisterChatMiddlewaresOptions } from "@cognia/plugin-contract/lib/plugin/bridge/chat-middleware-bridge"

export type { PluginChatAPI } from "@cognia/plugin-contract/lib/plugin/api/chat-api"

export {
  CIRCUIT_BREAKER_THRESHOLD,
  clearChatMiddlewaresForPlugin,
  DEFAULT_MIDDLEWARE_TIMEOUT_MS,
  getChatMiddleware,
  listActiveChatMiddlewares,
  listAllChatMiddlewares,
  MAX_MIDDLEWARE_TIMEOUT_MS,
  registerChatMiddleware,
  subscribeChatMiddlewareRegistry,
  unregisterChatMiddleware,
} from "@/lib/claude/chat-middleware/registry"

export type {
  ChatMiddlewareEvent,
  ChatMiddlewareRegistration,
  RegisterChatMiddlewareArgs,
} from "@cognia/plugin-contract/lib/claude/chat-middleware/registry"

export type {
  ChatMiddleware,
  ChatMiddlewareNext,
  ChatMiddlewareRequest,
  ChatMiddlewareResponse,
  PluginChatMiddlewareDef,
  PluginChatMiddlewareFactory,
  PluginChatMiddlewareFactoryContext,
  PluginChatMiddlewareRegistration,
} from "@cognia/plugin-contract/types/plugin/plugin-chat-middleware"
