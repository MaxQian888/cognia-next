/**
 * Glue between the public `PluginContext` and the engine's injected `EngineDeps`.
 *
 * Everything the engine needs now comes from the SDK surface: the model through
 * `ctx.ai`, search and page reads through the host's promoted web tools. There
 * is no host-private injection left — no settings store, no `webToolDeps`, no
 * per-plugin AI bridge threaded in by name. The same code path therefore runs
 * on desktop, in the browser, on mobile and in the CLI; only the host's own
 * runtime resolution differs, and that is the host's business, not ours.
 */
import type { PluginContext } from "@cognia/plugin-sdk"

import { bindAiBridge } from "./lib/ai"
import { makeReadFn, makeSearchFn } from "./host-tools"
import type { EngineDeps } from "./types"

export interface BuildDepsOptions {
  /** Streamed to the user as progress cards (0..1, message). */
  reportProgress?: (progress: number, message?: string) => void
  signal?: AbortSignal
  /**
   * Session this run belongs to. Threaded into every model call and host-tool
   * invocation so the work is billed and routed to the session the user is in.
   */
  sessionId?: string
}

/**
 * Assemble the engine's dependencies for one run.
 *
 * Synchronous and total: there is no precondition to probe here any more.
 * Whether a model or a search provider is actually reachable is answered by the
 * first call that needs one, and surfaces as a classified
 * {@link import("./errors").ResearchToolError} — which is both cheaper (no
 * speculative round-trip) and more honest (a provider can disappear mid-run).
 */
export function buildEngineDeps(ctx: PluginContext, options: BuildDepsOptions = {}): EngineDeps {
  const routing = {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
  return {
    ai: bindAiBridge(ctx.ai, routing),
    search: makeSearchFn(ctx, routing),
    read: makeReadFn(ctx, routing),
    logger: {
      info: (message, ...args) => ctx.logger.info(message, ...args),
      warn: (message, ...args) => ctx.logger.warn(message, ...args),
    },
    ...(options.reportProgress ? { reportProgress: options.reportProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
}
