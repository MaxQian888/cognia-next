import type { DispatchParams } from "./types.ts"
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

import { dispatchAnthropic } from "./claude-agent-sdk/index.ts"
import { dispatchAiSdk } from "./ai-sdk/index.ts"
import { resolveRuntimeAdapter } from "./registry.ts"

// Legacy-dispatch counter (Phase 9 retirement evidence). Read by the host's
// telemetry surface; exported for tests.
export const dispatchTelemetry = { legacyDispatchCount: 0, frozenDispatchCount: 0 }

export function dispatch(params: DispatchParams) {
  const adapterId = params.sendOptions?.execution?.runtimeAdapter
  if (adapterId) {
    const adapter = resolveRuntimeAdapter(adapterId)
    if (!adapter) {
      // Fail closed: never guess a runtime. The two cases read differently on
      // purpose. `external` is a KNOWN adapter that this host cannot serve at
      // all (an external agent runs in the renderer's external-agent manager,
      // not here), so a frame carrying it means a turn was routed to the wrong
      // executor. Anything else is version skew between the resolver and this
      // host.
      throw new Error(
        adapterId === "external"
          ? 'runtimeAdapter "external" is not served by the sidecar: this turn belongs to the external-agent manager'
          : `unknown frozen runtimeAdapter: ${adapterId}`
      )
    }
    dispatchTelemetry.frozenDispatchCount += 1
    return adapter.dispatch(params)
  }

  dispatchTelemetry.legacyDispatchCount += 1
  const provider = params.sendOptions.provider ?? "anthropic"
  if (provider === "anthropic") {
    return dispatchAnthropic(params as Parameters<typeof dispatchAnthropic>[0])
  }
  return dispatchAiSdk({ ...params, provider, hostRpc: params.hostRpc ?? undefined })
}
