/**
 * Chat-middleware bridge — the declarative half of ADR-0026 §4 §A.
 *
 * Registers every `manifest.chatMiddlewares[]` entry into the chat-middleware
 * registry on enable, importing each entry module and binding its exported
 * `ChatMiddleware` function. Disable drops them all (resetting breaker state).
 *
 * Before this, the registry + runner existed but `manifest.chatMiddlewares`
 * was never dispatched — only the imperative `ctx.chat.use(...)` path
 * registered anything. Mirrors the other async module bridges; wired via
 * `MODULE_BRIDGE_CAPABILITIES` (`manifestField: "chatMiddlewares"`).
 *
 * NOTE: registration ≠ execution. The runner (`runChatMiddlewareChain`) is
 * invoked from a send call-site gated behind a default-off flag — see
 * `lib/claude/chat-middleware/feature-flag.ts`.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  ChatMiddleware,
  ChatMiddlewareRequest,
  ChatMiddlewareResponse,
} from "@/types/plugin/plugin-chat-middleware"
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import { canRunPythonBackedContribution } from "@/lib/plugin/python/experimental-flag"
import {
  registerChatMiddleware,
  clearChatMiddlewaresForPlugin,
} from "@/lib/claude/chat-middleware/registry"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"

export interface RegisterChatMiddlewaresOptions {
  importer: (entry: string) => Promise<Record<string, unknown>>
}

/** What a python-backed middleware's `before` hook may return. */
interface PythonMiddlewareBeforeResult {
  /** Replacement request forwarded down the chain. */
  request?: ChatMiddlewareRequest
  /** Skip the rest of the chain and return this response immediately. */
  shortCircuit?: ChatMiddlewareResponse
}

/**
 * Adapt a python-backed `before`/`after` pair into the Koa-style
 * `ChatMiddleware` the runner expects.
 *
 * WHY NOT A REAL CONTINUATION: `ChatMiddlewareNext` is a live JS closure that
 * runs the remainder of the chain (and ultimately the model call). A function
 * cannot cross the subprocess boundary, and handing Python a *handle* it could
 * resume would require the host to make a second, nested `plugin_python_call`
 * while the first is still suspended — re-entrant machinery that belongs to the
 * Python SDK, not to this bridge. Splitting the hook in two expresses the same
 * intent for every use case that mutates the request, mutates the response, or
 * short-circuits.
 *
 * LIMITATION (documented, not stubbed): a python middleware cannot invoke the
 * continuation more than once, so retry/fan-out control flow is JS-only. This
 * is part of why `chat-middleware` is `pythonExecution: "experimental"`.
 */
function createPythonChatMiddleware(pluginId: string, contributionId: string): ChatMiddleware {
  const proxy = createPythonBackedProxy<{
    before(req: ChatMiddlewareRequest): Promise<PythonMiddlewareBeforeResult | null>
    after(
      req: ChatMiddlewareRequest,
      response: ChatMiddlewareResponse
    ): Promise<ChatMiddlewareResponse | null>
  }>({
    pluginId,
    contributionId,
    methods: ["before", "after"],
    label: "chat middleware",
  })

  return async (req, next) => {
    const pre = await proxy.before(req)
    if (pre?.shortCircuit) return pre.shortCircuit
    const forwarded = pre?.request ?? req
    const response = await next()
    const post = await proxy.after(forwarded, response)
    return post ?? response
  }
}

export async function registerChatMiddlewaresForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: RegisterChatMiddlewaresOptions
): Promise<void> {
  const defs = manifest.chatMiddlewares ?? []
  for (const def of defs) {
    if (!def?.id) continue
    const pythonBacked = isPythonBackedContribution(def, manifest.type)
    if (pythonBacked && !canRunPythonBackedContribution("chatMiddlewares")) {
      loggers.manager.warn(
        `[chat-middleware-bridge] ${manifest.id}:${def.id} — python-backed middleware is ` +
          `experimental and the flag is off; skipping registration`
      )
      continue
    }
    if (!pythonBacked && (!def.entry || !def.export)) continue
    try {
      let fn: ChatMiddleware
      if (pythonBacked) {
        fn = createPythonChatMiddleware(manifest.id, def.id)
      } else {
        const resolved = resolvePluginPath(installRoot, def.entry!)
        const mod = await options.importer(resolved)
        const exported = mod[def.export!]
        if (typeof exported !== "function") {
          loggers.manager.warn(
            `[chat-middleware-bridge] ${manifest.id}:${def.id} — export "${def.export}" is not a function`
          )
          continue
        }
        fn = exported as ChatMiddleware
      }
      registerChatMiddleware({
        pluginId: manifest.id,
        middlewareId: def.id,
        fn,
        priority: def.priority,
        timeoutMs: def.timeoutMs,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loggers.manager.warn(
        `[chat-middleware-bridge] failed to register ${manifest.id}:${def.id}: ${message}`
      )
    }
  }
}

export function unregisterChatMiddlewaresForPlugin(pluginId: string): void {
  clearChatMiddlewaresForPlugin(pluginId)
}
