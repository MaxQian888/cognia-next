// Legacy → policy mapping (ADR-0090 Phase 0, drives behavior in Phase 6).
//
// This is the single implementation of the frozen migration table from the
// plan's §6.1. It must stay table-free of provider names: vendor relay ids
// map through the same generic rules as any other non-anthropic
// provider id (R5 — `family: "anthropic-native"` is never compatibility
// evidence).

import type {
  AgentRoutePolicy,
  AgentRuntimeAdapterId,
} from "@cognia/agent-config-types/agent-execution"

export interface LegacyRuntimeSignals {
  /** `SendOptions.provider` — undefined means the anthropic default path. */
  provider?: string
  /**
   * Teammate/external runtime selector (e.g. "claude", "codex", "opencode").
   * Anything other than "claude"/undefined binds an external agent adapter.
   */
  teammateRuntime?: string
}

/** Mirrors `sidecar/dispatch/index.mjs` + the teammate runtime branch exactly. */
export function runtimeFromLegacy(signals: LegacyRuntimeSignals): AgentRuntimeAdapterId {
  const teammateRuntime = signals.teammateRuntime
  if (teammateRuntime !== undefined && teammateRuntime !== "claude") {
    return "external"
  }
  const provider = signals.provider ?? "anthropic"
  return provider === "anthropic" ? "claude-agent-sdk" : "ai-sdk"
}

export interface RoutePolicyEnvironment {
  /** Headless / managed hosts default to gateway-required (ADR-0090 §2). */
  isHeadlessManaged: boolean
}

/**
 * `proxyMode` → `routePolicy`. The original value must be preserved on the
 * decision trace by the caller (plan §6.1: "映射后保留原值用于 rollback").
 */
export function routePolicyFromProxyMode(
  proxyMode: "preferred" | "always" | "never" | undefined,
  environment: RoutePolicyEnvironment
): AgentRoutePolicy {
  switch (proxyMode) {
    case "always":
      return "gateway-required"
    case "preferred":
      return "gateway-preferred"
    case "never":
      return "direct"
    default:
      return environment.isHeadlessManaged ? "gateway-required" : "gateway-preferred"
  }
}

export interface LegacyToolsSignals {
  toolsEnabled?: boolean
  requireTools?: boolean
  /** True when the caller supplied an explicit AgentExecutionPolicy. */
  hasExplicitPolicy?: boolean
}

export interface ExecutionKindMapping {
  executionKind: "agent" | "completion"
  fallbackPolicy: "none" | "completion"
  legacyMigrated: boolean
}

/**
 * The ADR-0090 `toolsEnabled`/`requireTools` migration table, row by row:
 *
 * | signals                              | kind       | fallback   | migrated |
 * | ------------------------------------ | ---------- | ---------- | -------- |
 * | explicit policy present              | agent      | none       | false    |
 * | toolsEnabled: false                  | completion | none       | false    |
 * | toolsEnabled: true + requireTools    | agent      | none       | false    |
 * | toolsEnabled: true, requireTools ∅/f | agent      | completion | true     |
 * | toolsEnabled ∅ (legacy text caller)  | completion | none       | false    |
 */
export function executionKindFromTools(signals: LegacyToolsSignals): ExecutionKindMapping {
  if (signals.hasExplicitPolicy) {
    return { executionKind: "agent", fallbackPolicy: "none", legacyMigrated: false }
  }
  if (signals.toolsEnabled === false || signals.toolsEnabled === undefined) {
    return {
      executionKind: "completion",
      fallbackPolicy: "none",
      legacyMigrated: false,
    }
  }
  if (signals.requireTools === true) {
    return { executionKind: "agent", fallbackPolicy: "none", legacyMigrated: false }
  }
  return { executionKind: "agent", fallbackPolicy: "completion", legacyMigrated: true }
}
