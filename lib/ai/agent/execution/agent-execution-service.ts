// AgentExecutionService (ADR-0090 Phase 6) — the SINGLE entry every caller
// funnels through. It is not optional and has no legacy sibling.
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
import { resolveActiveCertification } from "./certification-store"

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
  taskWorkspaceRunId?: string
  trackingUnavailable?: boolean
}

export interface AgentExecutionTaskWorkspaceOptions {
  enabled: boolean
  agentId: string
  agentKind: string
  taskId?: string
  parentRunId?: string
  executionRunId?: string
  traceSpanId?: string
  trackingPolicy?: import("@/lib/task-workspace/types").ResourceTrackingPolicy
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
  /** Filesystem tracking policy for Cognia-managed execution surfaces. */
  taskWorkspace?: AgentExecutionTaskWorkspaceOptions
}

async function resolveExecution(
  config: ExecuteAgentConfig,
  environment: AgentExecutionEnvironment,
  options: AgentExecutionTurnOptions | undefined,
  flags: Awaited<ReturnType<(typeof import("./feature-flags"))["getAgentExecutionFlags"]>>
) {
  const input = {
    surface: options?.surface ?? "agent-executor",
    environment: {
      ...environment,
      prohibitCompletionFallback:
        environment.prohibitCompletionFallback ?? environment.isHeadlessHost,
    },
    flags,
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
  } satisfies Parameters<typeof resolveAgentExecutionSpec>[0]
  const preliminary = resolveAgentExecutionSpec(input)
  if (preliminary.spec.runtimePolicySource !== "auto") return preliminary

  const certification = await resolveActiveCertification({
    runtime: preliminary.spec.runtimeAdapter,
    ingressProtocol: config.provider ?? config.defaultProvider ?? "inherit",
    routeMode: preliminary.spec.route.kind,
    translationMode: "passthrough",
    deploymentRef:
      preliminary.spec.deploymentRef ?? config.provider ?? config.defaultProvider ?? "inherit",
    model: preliminary.spec.modelBindings.primary,
    requires: [...(options?.policy?.requires ?? [])],
    prefers: [...(options?.policy?.prefers ?? [])],
  })
  if (!certification?.accepted) {
    if (!certification?.blockedRequired?.length) return preliminary
    return {
      ...preliminary,
      missingRequired: [
        ...new Set([...preliminary.missingRequired, ...certification.blockedRequired]),
      ],
    }
  }
  return resolveAgentExecutionSpec({ ...input, certifiedPath: certification.certifiedPath })
}

/**
 * Resolve the authoritative execution spec for a config WITHOUT running a rail.
 *
 * Callers that need the frozen decision itself — the connector runtime reminting
 * a gateway ticket on a recovery turn, for instance — use this instead of
 * {@link executeAgentTurn}. It is the same resolution `executeAgentTurn`
 * performs, so the two can never disagree.
 */
export async function resolveAgentExecutionSpecForConfig(
  config: ExecuteAgentConfig,
  environment: AgentExecutionEnvironment,
  options?: AgentExecutionTurnOptions
) {
  const { getAgentExecutionFlags } = await import("./feature-flags")
  return resolveExecution(config, environment, options, getAgentExecutionFlags())
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
  const resolution = await resolveExecution(config, environment, options, getAgentExecutionFlags())
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

  const hostAvailable = environment.isTauri || environment.isHeadlessHost

  const executeResolved = async (
    effectiveConfig: ExecuteAgentConfig
  ): Promise<AgentExecutionServiceResult> => {
    // Intentional completion (toolsEnabled false/absent, or explicit policy).
    if (spec.executionKind === "completion") {
      return stamp(await executor.runCompletionRail(prompt, effectiveConfig))
    }

    // Agent rail: requires a host. Host availability is resolver-environment
    // truth (`isTauri` / headless host), NEVER re-probed ad hoc here.
    if (hostAvailable) {
      return stamp(await executor.runAgentRail(prompt, effectiveConfig))
    }

    // No host: only an EXPLICIT completion fallback may degrade — and the
    // result says so. Everything else fails closed.
    if (spec.fallbackPolicy === "completion") {
      const result = stamp(await executor.runCompletionRail(prompt, effectiveConfig))
      return {
        ...result,
        degradedReason: spec.legacyMigrated ? "legacy-completion-fallback" : "sidecar-unavailable",
      }
    }
    throw new AgentHostUnavailableError(spec.hostRef)
  }

  const tracking =
    options?.taskWorkspace ??
    (config.cwd ? { enabled: true, agentId: spec.identity.runId, agentKind: surface } : undefined)
  if (tracking?.enabled && config.cwd && spec.executionKind === "agent" && hostAvailable) {
    const [
      { acquireWorkspaceBundle },
      { openWorkspaceBundleTurnLease },
      { provisioningForWorkspaceRoot },
    ] = await Promise.all([
      import("@/lib/task-workspace/client"),
      import("@/lib/task-workspace/run-lease"),
      import("@/lib/task-workspace/workspace-provisioning"),
    ])
    const primaryLogicalRootId = "primary"
    const base =
      surface === "chat"
        ? ({ kind: "workingState" } as const)
        : ({ kind: "remoteDefault" } as const)
    const provisioning = await provisioningForWorkspaceRoot(config.cwd).catch(() => undefined)
    const bundle = await acquireWorkspaceBundle({
      ownerType: "session",
      ownerRef: spec.identity.sessionId,
      environmentKind: "managed",
      base,
      roots: [
        {
          logicalRootId: primaryLogicalRootId,
          role: "primary",
          sourceRoot: config.cwd,
        },
      ],
      ...(provisioning ? { provisioning } : {}),
    })
    const lease = await openWorkspaceBundleTurnLease(bundle, primaryLogicalRootId, {
      taskId: tracking.taskId ?? `agent:${spec.identity.sessionId}`,
      sessionId: spec.identity.sessionId,
      runId: spec.identity.runId,
      ...(tracking.parentRunId ? { parentRunId: tracking.parentRunId } : {}),
      agentId: tracking.agentId,
      agentKind: tracking.agentKind,
      workspaceRoot: config.cwd,
      base,
      executionRunId: tracking.executionRunId ?? spec.identity.runId,
      traceId: resolution.trace.traceId,
      ...(tracking.traceSpanId ? { traceSpanId: tracking.traceSpanId } : {}),
      ...(spec.identity.turnId ? { turnId: spec.identity.turnId } : {}),
      attemptId: spec.identity.attemptId,
      ...(spec.identity.providerAttemptId
        ? { providerAttemptId: spec.identity.providerAttemptId }
        : {}),
      surface,
      ...(tracking.trackingPolicy ? { trackingPolicy: tracking.trackingPolicy } : {}),
    })
    if (!lease) {
      throw new Error("Registry did not return an Agent Bundle Turn execution root")
    }
    try {
      const value = await executeResolved({ ...config, cwd: lease.primaryAlias })
      await lease.settle("ready")
      return { ...value, taskWorkspaceRunId: lease.run.runId }
    } catch (error) {
      await lease.abort().catch(() => undefined)
      throw error
    }
  }

  const result = await executeResolved(config)
  if (tracking?.enabled && (!config.cwd || !hostAvailable)) {
    return { ...result, trackingUnavailable: true }
  }
  return result
}

/**
 * Open a streaming / multi-turn handle bound to ONE frozen execution spec for
 * the session (ADR-0090 Phase 6). The handle's capability gates and frozen
 * model bindings all come from this single resolution — callers must never
 * re-derive runtime/route/host once the handle exists. Hard-required
 * capabilities fail closed BEFORE the handle is created.
 *
 * No longer dormant: `createAgentExecutionHandle` has real production callers
 * in Chat (`hooks/chat/use-claude-chat-controller.ts`) and the TUI
 * (`cli/src/tui/hooks/useAgentSession.tsx`). The old "INTENTIONALLY DORMANT
 * until Phase 7" label outlived its truth by two commits; the guard test that
 * was supposed to catch that is rewritten alongside this.
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
  const resolution = await resolveExecution(
    {
      sessionId: input.sessionId,
      provider: input.legacy?.providerId,
      model: input.legacy?.modelId,
      toolsEnabled: input.legacy?.toolsEnabled,
    },
    input.environment,
    input.options,
    getAgentExecutionFlags()
  )
  if (resolution.missingRequired.length > 0) {
    throw new AgentCapabilityUnsatisfiedError(resolution.missingRequired)
  }
  return {
    handle: createAgentExecutionHandle(input.sessionId, resolution.spec),
    spec: resolution.spec,
  }
}

/**
 * Renderer-side convenience wrapper over {@link executeAgentTurn}. Environment
 * is renderer host truth (desktop sidecar vs web); the headless brain calls
 * {@link executeAgentTurn} with its own environment instead.
 *
 * Deliberately does NOT delegate to `executeAgent`: that function now delegates
 * *here*, so a fallback in this direction would be an infinite loop.
 */
export async function executeAgentTurnFromRenderer(
  prompt: string,
  config: ExecuteAgentConfig,
  options?: AgentExecutionTurnOptions
): Promise<AgentExecutionServiceResult> {
  const { isTauri } = await import("@/lib/tauri")
  return executeAgentTurn(prompt, config, { isTauri: isTauri(), isHeadlessHost: false }, options)
}
