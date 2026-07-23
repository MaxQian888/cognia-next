// AgentExecutionService (ADR-0090 Phase 6) — the SINGLE entry every caller
// funnels through once `agentExecutionResolverV2` is on.
//
// Not a parallel implementation: the rails ARE the bodies executeAgent always
// ran (`runAgentRail` / `runCompletionRail`, exported from agent-executor) and
// the external rail is the existing ExternalAgentManager. What this service
// adds is authority: one resolver decision, fail-closed hard capabilities
// (fail-before-spend), explicit-only completion fallback carrying
// `degradedReason`, and a persisted secret-free decision trace.

import type {
  AgentCapabilityId,
  AgentExecutionIdentity,
  AgentExecutionPolicy,
  AgentExecutionSurface,
} from "@cognia/agent-config-types/agent-execution"

import type { ExecuteAgentConfig, ExecuteAgentResult } from "@/lib/ai/agent/agent-executor"
import { trackEvent } from "@/lib/telemetry/events/track-event"

import {
  resolveAgentExecutionSpec,
  type AgentExecutionEnvironment,
} from "./resolve-agent-execution-spec"

export class AgentCapabilityUnsatisfiedError extends Error {
  readonly missing: AgentCapabilityId[]

  constructor(missing: AgentCapabilityId[]) {
    super(
      `agent execution failed closed: required capabilities not satisfied by the resolved runtime: ${missing.join(", ")}`
    )
    this.name = "AgentCapabilityUnsatisfiedError"
    this.missing = missing
  }
}

export class AgentHostUnavailableError extends Error {
  constructor(hostRef: string) {
    super(
      `agent execution failed closed: host "${hostRef}" is unavailable and the execution policy forbids completion fallback`
    )
    this.name = "AgentHostUnavailableError"
  }
}

export type AgentExecutionServiceResult = ExecuteAgentResult & {
  runtime?: string
  routeKind?: "gateway" | "direct"
  executionFingerprint?: string
  degradedReason?:
    | "sidecar-unavailable"
    | "host-unavailable"
    | "legacy-completion-fallback"
    | "external-agent-unavailable"
  legacyMigrated?: boolean
}

export interface AgentExecutionTurnOptions {
  /** Which caller surface is executing (telemetry + trace). */
  surface?: AgentExecutionSurface
  /** Explicit execution policy (wins over legacy-signal mapping). */
  policy?: Partial<AgentExecutionPolicy>
  /** Legacy hard-tools signal (workflow agent.turn `requireTools`). */
  requireTools?: boolean
  /** Caller-known identity (sessionId/runId/…); deterministic placeholders otherwise. */
  identity?: Partial<AgentExecutionIdentity>
}

/**
 * One-shot agent turn through the unified authority. `environment` comes from
 * the caller (host truth: isTauri()/headless host status), never re-derived
 * here.
 */
export async function executeAgentTurn(
  prompt: string,
  config: ExecuteAgentConfig,
  environment: AgentExecutionEnvironment,
  options?: AgentExecutionTurnOptions
): Promise<AgentExecutionServiceResult> {
  const [{ getAgentExecutionFlags }, executor] = await Promise.all([
    import("./feature-flags"),
    import("@/lib/ai/agent/agent-executor"),
  ])

  const surface = options?.surface ?? "agent-executor"
  const resolution = resolveAgentExecutionSpec({
    surface,
    environment: {
      ...environment,
      // Headless/managed installs never consume legacy completion fallback.
      prohibitCompletionFallback:
        environment.prohibitCompletionFallback ?? environment.isHeadlessHost,
    },
    flags: getAgentExecutionFlags(),
    ...(options?.policy ? { policy: options.policy } : {}),
    identity: {
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      ...options?.identity,
    },
    legacy: {
      providerId: config.provider ?? config.defaultProvider,
      modelId: config.model,
      toolsEnabled: config.toolsEnabled,
      requireTools: options?.requireTools,
    },
  })
  const { spec } = resolution

  // Fail-before-spend: hard capabilities the frozen runtime cannot serve
  // reject BEFORE any provider call — a completion is never consumed instead.
  if (resolution.missingRequired.length > 0) {
    throw new AgentCapabilityUnsatisfiedError(resolution.missingRequired)
  }

  void trackEvent("agent.execution.resolved", {
    surface,
    runtime: spec.runtimeAdapter,
    routeKind: spec.route.kind,
    executionKind: spec.executionKind,
    legacyMigrated: spec.legacyMigrated === true,
  }).catch(() => {})

  const stamp = (result: ExecuteAgentResult): AgentExecutionServiceResult => ({
    ...result,
    runtime: spec.runtimeAdapter,
    routeKind: spec.route.kind,
    executionFingerprint: spec.executionFingerprint,
    ...(spec.legacyMigrated ? { legacyMigrated: true } : {}),
  })

  // Intentional completion (toolsEnabled false/absent, or explicit policy).
  if (spec.executionKind === "completion") {
    return stamp(await executor.runCompletionRail(prompt, config))
  }

  // Agent rail: requires a host. Host availability is resolver-environment
  // truth (`isTauri` / headless host), NEVER re-probed ad hoc here.
  const hostAvailable = environment.isTauri || environment.isHeadlessHost
  if (hostAvailable) {
    return stamp(await executor.runAgentRail(prompt, config))
  }

  // No host: only an EXPLICIT completion fallback may degrade — and the
  // result says so. Everything else fails closed.
  if (spec.fallbackPolicy === "completion") {
    const result = stamp(await executor.runCompletionRail(prompt, config))
    return {
      ...result,
      degradedReason: spec.legacyMigrated ? "legacy-completion-fallback" : "sidecar-unavailable",
    }
  }
  throw new AgentHostUnavailableError(spec.hostRef)
}

/**
 * Open a streaming / multi-turn handle bound to ONE frozen execution spec for
 * the session (ADR-0090 Phase 6). The handle's capability gates and frozen
 * model bindings all come from this single resolution — callers must never
 * re-derive runtime/route/host once the handle exists. Hard-required
 * capabilities fail closed BEFORE the handle is created.
 *
 * INTENTIONALLY DORMANT until Phase 7: the team execution-binding resolver is
 * its first production caller; today only tests exercise it (pinned in
 * agent-execution-service.test.ts).
 */
export async function openAgentSession(input: {
  sessionId: string
  environment: AgentExecutionEnvironment
  legacy?: { providerId?: string; modelId?: string; toolsEnabled?: boolean }
  options?: AgentExecutionTurnOptions
}): Promise<{
  handle: import("./agent-execution-handle").AgentExecutionHandle
  spec: import("@cognia/agent-config-types/agent-execution").ResolvedAgentExecutionSpec
}> {
  const [{ getAgentExecutionFlags }, { createAgentExecutionHandle }] = await Promise.all([
    import("./feature-flags"),
    import("./agent-execution-handle"),
  ])
  const resolution = resolveAgentExecutionSpec({
    surface: input.options?.surface ?? "agent-executor",
    environment: {
      ...input.environment,
      prohibitCompletionFallback:
        input.environment.prohibitCompletionFallback ?? input.environment.isHeadlessHost,
    },
    flags: getAgentExecutionFlags(),
    ...(input.options?.policy ? { policy: input.options.policy } : {}),
    identity: { sessionId: input.sessionId, ...input.options?.identity },
    legacy: {
      ...input.legacy,
      requireTools: input.options?.requireTools,
    },
  })
  if (resolution.missingRequired.length > 0) {
    throw new AgentCapabilityUnsatisfiedError(resolution.missingRequired)
  }
  return {
    handle: createAgentExecutionHandle(input.sessionId, resolution.spec),
    spec: resolution.spec,
  }
}

/**
 * Renderer-side convenience wrapper: the unified authority behind the resolver
 * flag, the legacy `executeAgent` path otherwise. Environment is renderer host
 * truth (desktop sidecar vs web); the headless brain calls
 * {@link executeAgentTurn} with its own environment instead.
 */
export async function executeAgentTurnFromRenderer(
  prompt: string,
  config: ExecuteAgentConfig,
  options?: AgentExecutionTurnOptions
): Promise<AgentExecutionServiceResult> {
  const { isAgentExecutionFlagEnabled } = await import("./feature-flags")
  if (!isAgentExecutionFlagEnabled("agentExecutionResolverV2")) {
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    return executeAgent(prompt, config)
  }
  const { isTauri } = await import("@/lib/tauri")
  return executeAgentTurn(prompt, config, { isTauri: isTauri(), isHeadlessHost: false }, options)
}
