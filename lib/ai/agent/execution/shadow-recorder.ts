// Shadow decision recorder (ADR-0090 Phase 0, removed in Phase 6).
//
// Records what the new resolver WOULD have decided next to what the legacy
// path actually did, without ever influencing execution: the entire body is
// exception-safe and side-effect-free towards the caller. Retained traces are
// secret-free by construction (the resolver trace carries ids/enums only) and
// double-checked by tests.

import type { AgentExecutionDecisionTrace } from "@cognia/agent-config-types/agent-execution"

import { trackEvent } from "@/lib/telemetry/events/track-event"

import { isAgentExecutionFlagEnabled } from "./feature-flags"
import {
  channelFromSpec,
  type AgentExecutionEnvironment,
  type AgentExecutionResolution,
} from "./resolve-agent-execution-spec"

export interface ShadowDecisionRecord {
  trace: AgentExecutionDecisionTrace
  /** The channel the legacy code path actually chose. */
  legacyChannel: "sidecar" | "text" | "external" | undefined
  /** The channel the resolved spec implies in legacy vocabulary. */
  resolvedChannel: "sidecar" | "text" | "external"
}

const RING_SIZE = 64
const ring: ShadowDecisionRecord[] = []

/** Dev/debug inspection of the most recent shadow decisions (newest last). */
export function getShadowDecisions(): readonly ShadowDecisionRecord[] {
  return ring.slice()
}

/** Test hook — the ring is module-global. */
export function __clearShadowDecisions(): void {
  ring.length = 0
}

function computeDivergence(
  record: ShadowDecisionRecord
): AgentExecutionDecisionTrace["divergence"] {
  const divergence: AgentExecutionDecisionTrace["divergence"] = []
  const { trace, legacyChannel, resolvedChannel } = record

  if (legacyChannel !== undefined && legacyChannel !== resolvedChannel) {
    divergence.push("runtime")
  }
  // Legacy execution is always direct today; a resolved gateway route is a
  // (flag-gated) divergence worth surfacing.
  if (trace.resolved.routeKind !== "direct") {
    divergence.push("route")
  }
  if (legacyChannel === "text" && trace.resolved.executionKind === "agent") {
    if (!divergence.includes("kind")) divergence.push("kind")
  }
  if (legacyChannel === "sidecar" && trace.resolved.executionKind === "completion") {
    if (!divergence.includes("kind")) divergence.push("kind")
  }
  return divergence
}

/**
 * Record one shadow decision. Never throws; never changes behavior.
 * No-ops entirely unless `agentExecutionResolverV2` is enabled, so the
 * legacy hot paths pay one flag read when the rollout hasn't started.
 */
export function recordShadowDecision(args: {
  resolution: AgentExecutionResolution
  environment: AgentExecutionEnvironment
  legacyChannel?: "sidecar" | "text" | "external"
}): void {
  try {
    if (!isAgentExecutionFlagEnabled("agentExecutionResolverV2")) return

    const resolvedChannel = channelFromSpec(args.resolution.spec, args.environment)
    const record: ShadowDecisionRecord = {
      trace: args.resolution.trace,
      legacyChannel: args.legacyChannel,
      resolvedChannel,
    }
    const divergence = computeDivergence(record)
    record.trace.divergence = divergence

    ring.push(record)
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)

    if (divergence.length > 0) {
      void trackEvent("agent.execution.shadow_divergence", {
        surface: record.trace.surface,
        divergence: divergence.join(","),
        oldChannel: args.legacyChannel ?? "unknown",
        newRuntime: record.trace.resolved.runtimeAdapter,
        newRouteKind: record.trace.resolved.routeKind,
        legacyMigrated: record.trace.resolved.legacyMigrated === true,
      }).catch(() => {})
    }
  } catch {
    // Shadow instrumentation must never affect the executing path.
  }
}
