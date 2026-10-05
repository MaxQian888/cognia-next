// Runtime adapter registry (ADR-0090 Phase 3).
//
// The dispatch decision stops being a provider-id branch: a frozen execution
// spec names its `runtimeAdapter`, and this registry maps that id onto the
// EXISTING dispatchers (thin wrappers). Each adapter declares a capability
// table so unsupported commands surface as typed `capability_error` events
// instead of silent no-ops. The tables are static; the dispatchers belong to
// engines loaded by `./engines.ts`, so the registry imports neither SDK.

import { ADAPTER_CAPABILITIES } from "./capabilities.ts"
import { requireEngine } from "./engines.ts"
import type { DispatchParams } from "./types.ts"
export {
  ADAPTER_CAPABILITIES,
  COMMAND_CAPABILITIES,
  capabilityError,
  commandSupported,
  capabilitySupported,
} from "./capabilities.ts"

export const RUNTIME_ADAPTERS = {
  "claude-agent-sdk": {
    id: "claude-agent-sdk",
    capabilities: ADAPTER_CAPABILITIES["claude-agent-sdk"],
    dispatch: (params: DispatchParams) => {
      const engine = requireEngine("claude-agent-sdk")
      return engine.dispatch(params as Parameters<typeof engine.dispatch>[0])
    },
  },
  "ai-sdk": {
    id: "ai-sdk",
    capabilities: ADAPTER_CAPABILITIES["ai-sdk"],
    // The ai-sdk dispatcher derives its provider from sendOptions.provider,
    // exactly as the legacy branch did.
    dispatch: (params: DispatchParams) =>
      requireEngine("ai-sdk").dispatch({
        ...params,
        provider: params.sendOptions.provider!,
        hostRpc: params.hostRpc ?? undefined,
      }),
  },
}

/**
 * Resolve an adapter id to its registry entry, or null for unknown ids
 * (callers fail closed — never guess a runtime).
 */
export function resolveRuntimeAdapter(adapterId: string | undefined) {
  return RUNTIME_ADAPTERS[adapterId as keyof typeof RUNTIME_ADAPTERS] ?? null
}
