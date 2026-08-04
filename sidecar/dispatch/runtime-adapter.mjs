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
 * command surface. Only command-relevant capabilities appear here — the ones
 * `COMMAND_CAPABILITIES` below can gate on. A capability listed there but
 * missing here rejects a command the runtime can in fact serve, so the two must
 * be read together; `check-adapter-capability-parity.mjs` enforces that.
 */
export const ADAPTER_CAPABILITIES = {
  "claude-agent-sdk": new Set([
    "session.multi-turn",
    "session.resume",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "subagents.native",
    // Steering is implemented for this rail and this rail only — `routeSteer()`
    // in agent-host.mjs rejects every non-anthropic provider.
    "steer",
    "set-model",
    "compaction",
    // Capabilities the CONTROL surface gates on (see
    // `CONTROL_METHOD_CAPABILITIES` in control.mjs). They earn their place
    // here because `handleControl` now rejects an ungated control with a typed
    // `capability_error` instead of letting it fail as `unsupported_provider`.
    "context-management",
    "mcp",
    "thinking",
    "commands.dynamic",
    "session.manage",
    "plugins.native",
    "skills.native",
    "checkpoint",
    "mcp.dynamic",
    "subagents.manage",
    "tasks.background",
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
  return capabilitySupported(adapterId, required)
}

/**
 * Whether the adapter behind a session declares `capability`.
 *
 * Split out of {@link commandSupported} for the control surface, which is
 * keyed by SDK method name rather than by host command and so cannot go
 * through `COMMAND_CAPABILITIES`. Same two escapes: a session with no frozen
 * adapter id (legacy) and an adapter this build does not know are both
 * permissive, because blocking there would reject a session whose capabilities
 * we simply cannot read.
 */
export function capabilitySupported(adapterId, capability) {
  if (!adapterId || !capability) return true
  const table = ADAPTER_CAPABILITIES[adapterId]
  if (!table) return true
  return table.has(capability)
}
