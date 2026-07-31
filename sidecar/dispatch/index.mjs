// Dispatch entry point — routes to the right runtime adapter.
//
// Returns the same `Session` shape regardless of runtime:
//   { q, pushUserMessage, closeInput, pendingApprovals, pendingPluginToolCalls }
//
// ADR-0090 Phase 3: a frozen execution spec (`sendOptions.execution`,
// resolved once by `resolveAgentExecutionSpec()`) names its
// `runtimeAdapter`, and dispatch obeys it — the provider id is no longer
// re-interpreted when a spec is present. Sends WITHOUT a spec keep the
// legacy provider-id branch (counted via telemetry so Phase 9 can retire it
// with evidence).
//
// Both runners support tool-calling (ADR-0043): the non-Anthropic path bridges
// built-in + plugin tools to native AI SDK tools and gates execution through the
// same `permission_request` round-trip (`pendingApprovals`). Plugin tools
// round-trip through `pendingPluginToolCalls`. A2UI remains Anthropic-only.

import { dispatchAnthropic } from "./anthropic.mjs"
import { dispatchAiSdk } from "./ai-sdk.mjs"
import { resolveRuntimeAdapter } from "./runtime-adapter.mjs"

// Legacy-dispatch counter (Phase 9 retirement evidence). Read by the host's
// telemetry surface; exported for tests.
export const dispatchTelemetry = { legacyDispatchCount: 0, frozenDispatchCount: 0 }

/**
 * @param {{
 *   sessionId: string,
 *   firstPrompt: any,
 *   sendOptions: Record<string, any>,
 *   emit: (msg: any) => void,
 *   log: (level: "info"|"warn"|"error", message: string) => void,
 * }} params
 */
export function dispatch(params) {
  const adapterId = params.sendOptions?.execution?.runtimeAdapter
  if (adapterId) {
    const adapter = resolveRuntimeAdapter(adapterId)
    if (!adapter) {
      // Fail closed: an unknown frozen adapter is a protocol error, never a
      // guess. (The resolver can only produce known ids; this guards skew.)
      throw new Error(`unknown frozen runtimeAdapter: ${adapterId}`)
    }
    dispatchTelemetry.frozenDispatchCount += 1
    return adapter.dispatch(params)
  }

  dispatchTelemetry.legacyDispatchCount += 1
  const provider = params.sendOptions.provider ?? "anthropic"
  if (provider === "anthropic") {
    return dispatchAnthropic(params)
  }
  return dispatchAiSdk({ ...params, provider })
}
