/**
 * The author-callable half of the host tool surface.
 *
 * `ctx.agent.invokeTool` used to reach only the calling plugin's OWN tools, so
 * a plugin that wanted the app's search-and-read policy had to reimplement it —
 * its own provider HTTP, its own extraction, its own SSRF story. Deep Research
 * did exactly that, and the host paid for it with a `request.name ===
 * "deep_research"` branch that injected private dependencies into one
 * hard-coded plugin.
 *
 * This module replaces that with a promotion list. `web_search` and `web_fetch`
 * execute host-side through the same `runWebBuiltinTool` the agent loop uses —
 * same providers, same result cache, same source verification, same PII
 * redaction, same SSRF guard, same outbound token bucket — and a plugin gets
 * them by name, typed, with no host special-casing.
 *
 * Deliberately narrow: only {@link PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS} resolve
 * here. Everything else the host registers for its own loop (`dispatch_agent`,
 * `ask_user`, session control, working-set edits) is refused, so this never
 * becomes a general back door into host internals.
 */

import { runWebBuiltinTool, type WebToolRunDeps } from "@/lib/claude/web-builtin-tools"
import { combineAbortSignals } from "@/lib/connectivity/capacitor-http"
import {
  isAuthorCallableHostTool,
  PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS,
  type PluginHostToolFailure,
} from "@/types/plugin/plugin-host-tools"

/** Structured refusal for a name that is not on the promotion list. */
export function notAuthorCallable(name: string): PluginHostToolFailure {
  return {
    ok: false,
    code: "not-author-callable",
    error:
      `"${name}" is not a host tool plugins may invoke. ` +
      `Author-callable host tools: ${PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS.join(", ")}.`,
  }
}

/**
 * Execute one author-callable host tool against a host's resolved web deps.
 *
 * Never throws for an expected condition: an unknown name, disabled web tools,
 * a missing provider, a refused target or a spent token bucket all resolve as
 * a coded {@link PluginHostToolFailure} so the caller can branch on `code`.
 */
export async function runAuthorCallableHostTool(
  name: string,
  args: Record<string, unknown>,
  deps: WebToolRunDeps,
  options: { signal?: AbortSignal } = {}
): Promise<unknown> {
  if (!isAuthorCallableHostTool(name)) return notAuthorCallable(name)
  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "execution-failed",
      error: `${name} aborted before dispatch`,
    } satisfies PluginHostToolFailure
  }
  // BOTH signals, not just the caller's. A plugin cancelling its own run must
  // cancel the fetch it started, and the host's turn-level signal must still
  // reach it — overwriting `deps.signal` meant a plugin that passes any signal
  // (Deep Research passes one on every call) silently opted the turn's Stop
  // button out of aborting its in-flight request.
  const bound: WebToolRunDeps = options.signal
    ? {
        ...deps,
        signal: deps.signal ? combineAbortSignals(deps.signal, options.signal) : options.signal,
      }
    : deps
  try {
    return await runWebBuiltinTool(name, args, bound)
  } catch (err) {
    // `runWebBuiltinTool` returns structured failures for everything it
    // anticipates, so reaching here means an unexpected throw (a broken dep, a
    // rate-limiter that raised something other than RateLimitError). Collapse
    // it rather than letting it escape into plugin code as a raw exception.
    return {
      ok: false,
      code: "execution-failed",
      error: err instanceof Error ? err.message : String(err),
    } satisfies PluginHostToolFailure
  }
}
