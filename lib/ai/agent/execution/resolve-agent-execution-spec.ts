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
  AgentCapabilityEvidence,
  AgentCapabilityId,
  AgentExecutionDecisionTrace,
  AgentExecutionIdentity,
  AgentExecutionPolicy,
  AgentExecutionSurface,
  AgentRuntimeAdapterId,
  ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"
import { RESOLVED_SPEC_VERSION } from "@cognia/agent-config-types/agent-execution"

import type { AgentExecutionFlag } from "./feature-flags"
import { computeExecutionFingerprint } from "./fingerprint"
import {
  executionKindFromTools,
  routePolicyFromProxyMode,
  runtimeFromLegacy,
} from "./legacy-mapping"

/**
 * Per-capability verdicts for a resolved spec (contract v2).
 *
 * The rule is deliberately conservative: a capability is `native` only if it
 * is in this adapter's runtime table, and the runtime table only lists what is
 * actually wired. Everything the caller asked about and did not get is
 * recorded as `unsupported` with a reason, so a fail-closed rejection can
 * always say which capability and why.
 *
 * Note what is NOT here: the 16 SDK-parity capability ids exist in the
 * vocabulary from contract v2 onward, but they are added to
 * {@link RUNTIME_CAPABILITIES} only as each one is genuinely implemented.
 * Listing them early would make the resolver claim coverage that no code
 * provides — the exact "built but dormant" failure this repo keeps hitting.
 */
export function buildCapabilitySupport(
  adapter: AgentRuntimeAdapterId,
  effective: readonly AgentCapabilityId[],
  asked: readonly AgentCapabilityId[]
): Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>> {
  const support: Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>> = {}

  for (const cap of effective) support[cap] = { support: "native" }

  for (const cap of asked) {
    if (support[cap]) continue
    support[cap] = {
      support: "unsupported",
      reason: `runtime adapter "${adapter}" does not implement "${cap}"`,
    }
  }

  return support
}

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
    // `steer` is real on this rail and only on this rail: `routeSteer()`
    // (sidecar/agent-host.mjs) intercepts the control frame, refuses any
    // non-anthropic provider outright, and pushes the prompt through the live
    // input stream. Omitting it here meant a session with a frozen spec got a
    // `capability_error` for steering while the same session steered fine
    // through the live control path (`ipc.ts:steerSession`) — the fail-closed
    // gate firing on a capability the runtime actually has.
    "steer",
    "set-model",
    "compaction",
    // Stage 3: each of these is now reachable as a live control method
    // (see protocol/agent-control-methods.json) and is listed here only
    // because of that. `commands.dynamic` is the odd one out — the
    // supportedCommands control predates contract v2, but the capability was
    // never in this table, so a spec-carrying session under-reported a control
    // it could already serve.
    "commands.dynamic",
    "session.manage",
    "plugins.native",
    "skills.native",
    "checkpoint",
    "mcp.dynamic",
    "subagents.manage",
    "tasks.background",
    // Stage 3, non-control half: these are session OPTIONS that now reach
    // `query()` through the nested `claudeAgentSdk` block, plus the two
    // callback surfaces the sidecar builds around it. No command gates on
    // them, so they are absent from ADAPTER_CAPABILITIES — they are here so a
    // caller can ask the frozen spec whether the session can do this before
    // spending a turn discovering that it cannot.
    "output.structured",
    "sandbox.native",
    "hooks.lifecycle",
    "permissions.update-rules",
    // Child-process OTel: the subprocess exports into the same collector as
    // the sidecar, under the same trace. Gated on the host having an endpoint
    // (see `childTelemetryEnv`), which is why the capability is a statement
    // about the RAIL rather than about any one session.
    "observability.child",
    // Stage 4, stateful: the session mirror (Rust SQLite over host_rpc) and the
    // warm-subprocess pool. Both are claims that CODE exists — the mirror is
    // built in `sidecar/dispatch/session-store.mjs` and reaches `query()` as
    // `options.sessionStore`; the pool is claimed and refilled around the
    // `query()` call in `anthropic.mjs`.
    "session.store",
    "startup.prewarm",
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
  /** Capabilities the selected host backend can actually serve. */
  hostCapabilities?: readonly AgentCapabilityId[]
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
  /**
   * ADR-0090 Phase 5 — a certification-gate acceptance for the resolved
   * path. Callers may ONLY construct this from
   * `evaluateCompatibilityGate(...)` output (its recordRef encodes
   * bundle+key); probes/opt-ins have no way in. Absent ⇒ evidence stays the
   * legacy default and `auto` never adopts a certified non-default path.
   */
  certifiedPath?: {
    recordRef: string
    evidence: "native" | "vendor-certified" | "cognia-verified"
    suiteVersion?: string
    disabledOptional: AgentCapabilityId[]
  }
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

  const theoreticalRuntimeCaps = RUNTIME_CAPABILITIES[adapter]
  const runtimeCaps = input.environment.hostCapabilities
    ? theoreticalRuntimeCaps.filter((capability) =>
        input.environment.hostCapabilities!.includes(capability)
      )
    : theoreticalRuntimeCaps
  const requires = input.policy?.requires ?? []
  const prefers = input.policy?.prefers ?? []
  const missingRequired = requires.filter((cap) => !runtimeCaps.includes(cap))
  const disabledOptional = prefers.filter((cap) => !runtimeCaps.includes(cap))

  const effective = runtimeCaps.filter(
    (cap) =>
      !disabledOptional.includes(cap) &&
      !(input.certifiedPath?.disabledOptional.includes(cap) ?? false)
  )

  const specWithoutFingerprint: Omit<ResolvedAgentExecutionSpec, "executionFingerprint"> = {
    specVersion: RESOLVED_SPEC_VERSION,
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
    compatibility: input.certifiedPath
      ? {
          evidence: input.certifiedPath.evidence,
          recordRef: input.certifiedPath.recordRef,
          ...(input.certifiedPath.suiteVersion
            ? { suiteVersion: input.certifiedPath.suiteVersion }
            : {}),
        }
      : { evidence: "native" },
    capabilities: {
      effective,
      disabledOptional: [
        ...disabledOptional,
        ...(input.certifiedPath?.disabledOptional.filter(
          (cap) => !disabledOptional.includes(cap)
        ) ?? []),
      ],
      support: buildCapabilitySupport(adapter, effective, [...requires, ...prefers]),
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
 * Project a resolved spec onto the wire shape that rides
 * `SendOptions.execution` (ADR-0090 Phase 3/6). Secret-free by construction;
 * gateway specs carry endpoint+ticketId only when a ticket was actually
 * minted (`ticketRef` + endpoint supplied by the caller).
 */
export function sendSpecFromResolved(
  spec: ResolvedAgentExecutionSpec,
  gateway?: { endpoint: string; ticketId: string }
): import("@cognia/agent-config-types/agent-execution").AgentExecutionSendSpec {
  return {
    // The wire spec advertises the same contract version as the resolved one:
    // the sidecar reads `capabilities.support` to fail closed on its own side,
    // and a v1 wire spec would silently drop those verdicts.
    specVersion: spec.specVersion,
    executionFingerprint: spec.executionFingerprint,
    runtimeAdapter: spec.runtimeAdapter,
    executionKind: spec.executionKind,
    route:
      spec.route.kind === "gateway" && gateway
        ? { kind: "gateway", endpoint: gateway.endpoint, ticketId: gateway.ticketId }
        : {
            kind: "direct",
            ...(spec.route.kind === "direct" && spec.route.credentialProfileRef
              ? { credentialProfileRef: spec.route.credentialProfileRef }
              : {}),
          },
    modelBindings: spec.modelBindings,
    capabilities: spec.capabilities,
    identity: {
      runId: spec.identity.runId,
      attemptId: spec.identity.attemptId,
      ...(spec.identity.parentRunId ? { parentRunId: spec.identity.parentRunId } : {}),
    },
    hostRef: spec.hostRef,
  }
}

/**
 * Rebind an auto-selected frozen spec to an authenticated host and refresh its
 * fingerprint. Callers must use this helper instead of mutating `hostRef`.
 */
export function rebindResolvedAgentExecutionHost(
  spec: ResolvedAgentExecutionSpec,
  hostRef: string
): ResolvedAgentExecutionSpec {
  if (!hostRef.trim()) throw new Error("hostRef must be a non-empty string")
  const rebound = { ...spec, hostRef }
  return {
    ...rebound,
    executionFingerprint: computeExecutionFingerprint(rebound),
  }
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
