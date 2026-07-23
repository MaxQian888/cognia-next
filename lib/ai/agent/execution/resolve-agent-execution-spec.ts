// The single agent-execution resolver (ADR-0090).
//
// Phase 0: runs in SHADOW mode — callers record what it *would* decide while
// the legacy paths keep executing. Phase 6 makes it authoritative. Because of
// that, `auto` here must reproduce today's provider-id decision exactly
// (sidecar/dispatch/index.mjs + the teammate runtime branch), and
// `family: "anthropic-native"` is never consulted (R5).
//
// The resolver is pure and deterministic: same input ⇒ same spec ⇒ same
// fingerprint. Anything requiring async lookup is resolved by the caller and
// passed in.

import type {
  AgentCapabilityId,
  AgentExecutionDecisionTrace,
  AgentExecutionIdentity,
  AgentExecutionPolicy,
  AgentExecutionSurface,
  AgentRuntimeAdapterId,
  ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"

import type { AgentExecutionFlag } from "./feature-flags"
import { computeExecutionFingerprint } from "./fingerprint"
import {
  executionKindFromTools,
  routePolicyFromProxyMode,
  runtimeFromLegacy,
} from "./legacy-mapping"

// ---- Runtime capability tables (Phase 0 static; refined by certification) ---

export const RUNTIME_CAPABILITIES: Record<AgentRuntimeAdapterId, readonly AgentCapabilityId[]> = {
  "claude-agent-sdk": [
    "streaming",
    "session.multi-turn",
    "session.resume",
    "tools.ordinary",
    "tools.parallel",
    "tools.fragmented-json",
    "tools.results",
    "tools.errors",
    "mcp",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "prompt-caching",
    "thinking",
    "context-management",
    "images",
    "beta-features",
    "rate-limit-handling",
    "upstream-errors",
    "stream-interruption",
    "subagents.native",
    "set-model",
    "compaction",
  ],
  "ai-sdk": [
    "streaming",
    "session.multi-turn",
    "tools.ordinary",
    "tools.parallel",
    "tools.fragmented-json",
    "tools.results",
    "tools.errors",
    "mcp",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "thinking",
    "images",
    "rate-limit-handling",
    "upstream-errors",
    "stream-interruption",
    "set-model",
    "compaction",
  ],
  external: [
    "streaming",
    "session.multi-turn",
    "session.resume",
    "tools.ordinary",
    "tools.results",
    "tools.errors",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "steer",
    "set-model",
  ],
}

// ---- Input / output ---------------------------------------------------------

export interface LegacyExecutionSignals {
  providerId?: string
  modelId?: string
  proxyMode?: "preferred" | "always" | "never"
  /** Teammate/external runtime selector ("claude", "codex", …). */
  runtime?: string
  toolsEnabled?: boolean
  requireTools?: boolean
  /** The channel the legacy code path picked (ground truth for divergence). */
  channel?: "sidecar" | "text" | "external"
}

export interface AgentExecutionEnvironment {
  isTauri: boolean
  isHeadlessHost: boolean
  sidecarReady?: boolean
  /** Managed/headless policy: forbid legacy completion fallback. */
  prohibitCompletionFallback?: boolean
}

export interface AgentExecutionResolveInput {
  surface: AgentExecutionSurface
  policy?: Partial<AgentExecutionPolicy>
  legacy?: LegacyExecutionSignals
  environment: AgentExecutionEnvironment
  /** Caller-known identity. Missing fields get deterministic placeholders. */
  identity?: Partial<AgentExecutionIdentity>
  flags: Record<AgentExecutionFlag, boolean>
  /** ISO timestamp for the trace. Injected for determinism in tests. */
  now?: string
}

export interface AgentExecutionResolution {
  spec: ResolvedAgentExecutionSpec
  trace: AgentExecutionDecisionTrace
  /**
   * Hard-required capabilities the frozen runtime cannot provide. Phase 6's
   * service fails closed (before any model turn) when this is non-empty;
   * shadow mode records it without changing behavior.
   */
  missingRequired: AgentCapabilityId[]
}

// ---- Resolution -------------------------------------------------------------

function resolveRuntimeAdapter(input: AgentExecutionResolveInput): {
  adapter: AgentRuntimeAdapterId
  source: ResolvedAgentExecutionSpec["runtimePolicySource"]
} {
  const runtimePolicy = input.policy?.runtimePolicy
  if (runtimePolicy === "claude-agent-sdk" || runtimePolicy === "ai-sdk") {
    return { adapter: runtimePolicy, source: "explicit" }
  }
  const adapter = runtimeFromLegacy({
    provider: input.legacy?.providerId,
    teammateRuntime: input.legacy?.runtime,
  })
  return {
    adapter,
    source: runtimePolicy === "auto" ? "auto" : "legacy-mapped",
  }
}

function resolveHostRef(input: AgentExecutionResolveInput): string {
  const target = input.policy?.executionTarget
  if (target?.mode === "pinned") return target.hostRef
  if (input.environment.isTauri) return "desktop-sidecar"
  if (input.environment.isHeadlessHost) return "headless-agent-host"
  return "web-renderer"
}

function deterministicIdentity(
  identity: Partial<AgentExecutionIdentity> | undefined
): AgentExecutionIdentity {
  const sessionId = identity?.sessionId ?? "session-unbound"
  return {
    sessionId,
    runId: identity?.runId ?? sessionId,
    turnId: identity?.turnId,
    attemptId: identity?.attemptId ?? "a1",
    providerAttemptId: identity?.providerAttemptId,
    parentRunId: identity?.parentRunId,
  }
}

let traceCounter = 0

/**
 * Resolve an execution request into a frozen spec + secret-free trace.
 * Callers must never re-derive runtime/route/host from anything else once a
 * spec exists for the session.
 */
export function resolveAgentExecutionSpec(
  input: AgentExecutionResolveInput
): AgentExecutionResolution {
  const { adapter, source } = resolveRuntimeAdapter(input)

  const kindMapping = executionKindFromTools({
    toolsEnabled: input.legacy?.toolsEnabled,
    requireTools: input.legacy?.requireTools,
    hasExplicitPolicy: input.policy?.executionKind !== undefined,
  })
  const executionKind = input.policy?.executionKind ?? kindMapping.executionKind
  let fallbackPolicy = input.policy?.fallbackPolicy ?? kindMapping.fallbackPolicy
  if (input.environment.prohibitCompletionFallback && fallbackPolicy === "completion") {
    fallbackPolicy = "none"
  }

  const routePolicy =
    input.policy?.routePolicy ??
    routePolicyFromProxyMode(input.legacy?.proxyMode, {
      isHeadlessManaged: input.environment.isHeadlessHost,
    })

  // Gateway routes become mintable only when tickets exist (Phase 2) and the
  // flag is on; until then every execution is direct — which matches the
  // legacy reality shadow mode must reproduce.
  const gatewayEligible = input.flags.gatewayAgentRouteTickets && routePolicy !== "direct"
  const route: ResolvedAgentExecutionSpec["route"] = gatewayEligible
    ? { kind: "gateway", routePolicy }
    : { kind: "direct", routePolicy, credentialProfileRef: input.policy?.credentialProfileRef }

  const hostRef = resolveHostRef(input)
  const identity = deterministicIdentity(input.identity)

  const runtimeCaps = RUNTIME_CAPABILITIES[adapter]
  const requires = input.policy?.requires ?? []
  const prefers = input.policy?.prefers ?? []
  const missingRequired = requires.filter((cap) => !runtimeCaps.includes(cap))
  const disabledOptional = prefers.filter((cap) => !runtimeCaps.includes(cap))

  const specWithoutFingerprint: Omit<ResolvedAgentExecutionSpec, "executionFingerprint"> = {
    specVersion: 1,
    identity,
    executionKind,
    runtimeAdapter: adapter,
    runtimePolicySource: source,
    deploymentRef: input.policy?.deploymentRef,
    modelBindings: {
      primary: input.legacy?.modelId ?? input.policy?.modelBindingRef ?? "inherit",
    },
    route,
    hostRef,
    compatibility: { evidence: "native" },
    capabilities: {
      effective: runtimeCaps.filter((cap) => !disabledOptional.includes(cap)),
      disabledOptional,
    },
    credential: input.policy?.credentialProfileRef
      ? {
          profileRef: input.policy.credentialProfileRef,
          affinity: input.policy.credentialAffinity ?? "sticky-with-failover",
        }
      : undefined,
    fallbackPolicy,
    legacyMigrated: kindMapping.legacyMigrated || undefined,
  }

  const executionFingerprint = computeExecutionFingerprint(specWithoutFingerprint)
  const spec: ResolvedAgentExecutionSpec = { ...specWithoutFingerprint, executionFingerprint }

  traceCounter += 1
  const trace: AgentExecutionDecisionTrace = {
    traceId: `aext-${traceCounter}`,
    surface: input.surface,
    at: input.now ?? new Date().toISOString(),
    flags: { ...input.flags },
    legacy: {
      providerId: input.legacy?.providerId,
      modelId: input.legacy?.modelId,
      proxyMode: input.legacy?.proxyMode,
      runtime: input.legacy?.runtime,
      toolsEnabled: input.legacy?.toolsEnabled,
      requireTools: input.legacy?.requireTools,
      channel: input.legacy?.channel,
    },
    resolved: {
      executionFingerprint,
      runtimeAdapter: adapter,
      executionKind,
      routeKind: route.kind,
      routePolicy,
      hostRef,
      deploymentRef: input.policy?.deploymentRef,
      modelBindingRef: input.policy?.modelBindingRef,
      fallbackPolicy,
      legacyMigrated: kindMapping.legacyMigrated || undefined,
      disabledOptional,
    },
    divergence: [],
  }

  return { spec, trace, missingRequired }
}

/**
 * The channel the resolved spec implies, in legacy vocabulary — used by the
 * shadow recorder to compare against what the old code actually picked.
 */
export function channelFromSpec(
  spec: ResolvedAgentExecutionSpec,
  environment: AgentExecutionEnvironment
): "sidecar" | "text" | "external" {
  if (spec.runtimeAdapter === "external") return "external"
  if (spec.executionKind === "completion") return "text"
  // Agent rail needs a host: today that means the Tauri sidecar (or the
  // headless agent host); the web renderer degrades to text.
  if (environment.isTauri || environment.isHeadlessHost) return "sidecar"
  return "text"
}
