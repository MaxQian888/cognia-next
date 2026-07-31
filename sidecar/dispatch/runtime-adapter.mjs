// Runtime adapter registry (ADR-0090 Phase 3).
//
// The dispatch decision stops being a provider-id branch: a frozen execution
// spec names its `runtimeAdapter`, and this registry maps that id onto the
// EXISTING dispatchers (thin wrappers — no logic moves out of anthropic.mjs /
// ai-sdk.mjs). Each adapter declares a capability table so unsupported
// commands surface as typed `capability_error` events instead of silent
// no-ops.

import { dispatchAnthropic } from "./anthropic.mjs"
import { dispatchAiSdk } from "./ai-sdk.mjs"

/**
 * Capability tables mirror `RUNTIME_CAPABILITIES` in
 * `lib/ai/agent/execution/resolve-agent-execution-spec.ts` for the host-level
 * command surface. Only command-relevant capabilities appear here.
 */
export const ADAPTER_CAPABILITIES = {
  "claude-agent-sdk": new Set([
    "session.multi-turn",
    "session.resume",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "subagents.native",
    "set-model",
    "compaction",
  ]),
  "ai-sdk": new Set([
    "session.multi-turn",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "set-model",
    "compaction",
  ]),
}

export const RUNTIME_ADAPTERS = {
  "claude-agent-sdk": {
    id: "claude-agent-sdk",
    capabilities: ADAPTER_CAPABILITIES["claude-agent-sdk"],
    dispatch: (params) => dispatchAnthropic(params),
  },
  "ai-sdk": {
    id: "ai-sdk",
    capabilities: ADAPTER_CAPABILITIES["ai-sdk"],
    // The ai-sdk dispatcher derives its provider from sendOptions.provider,
    // exactly as the legacy branch did.
    dispatch: (params) => dispatchAiSdk({ ...params, provider: params.sendOptions.provider }),
  },
}

/**
 * Resolve an adapter id to its registry entry, or null for unknown ids
 * (callers fail closed — never guess a runtime).
 */
export function resolveRuntimeAdapter(adapterId) {
  return RUNTIME_ADAPTERS[adapterId] ?? null
}

/** Host-command → capability requirement (commands absent here are universal). */
export const COMMAND_CAPABILITIES = {
  compact: "compaction",
  restore: "compaction",
  set_mode: "permissions.set-mode",
  steer: "steer",
}

/**
 * Typed capability error payload (ADR-0090 §3.5 `capability-error`). Emitted
 * by the host when a session's adapter cannot serve a command.
 */
export function capabilityError(sessionId, capability, command) {
  return {
    type: "capability_error",
    sessionId,
    capability,
    command,
  }
}

/**
 * Whether `command` is servable by the adapter that runs `session`. Sessions
 * without a frozen adapter id (legacy) are never blocked here — their
 * dispatchers keep today's behavior.
 */
export function commandSupported(adapterId, command) {
  const required = COMMAND_CAPABILITIES[command]
  if (!required) return true
  if (!adapterId) return true
  const table = ADAPTER_CAPABILITIES[adapterId]
  if (!table) return true
  return table.has(required)
}
