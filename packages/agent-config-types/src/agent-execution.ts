// Unified Agent execution contract (ADR-0090).
//
// Frozen vocabulary shared by the renderer resolver, the Rust hosts (which
// forward it opaquely through `SendOptions.extra`) and the Node sidecar's
// runtime adapters. Everything here must stay serialisable and secret-free:
// credentials travel as *references* only — raw keys ride `SendOptions.env` /
// `providerCredentials`, which are already inside the sidecar redaction set.
//
// Validation is hand-written guard style (this package has zero runtime
// dependencies and is source-exported into both jsdom and node consumers).

// ---- Policy vocabulary ------------------------------------------------------

/** Which runtime family the caller wants. `auto` defers to the resolver. */
export type AgentRuntimePolicy = "auto" | "claude-agent-sdk" | "ai-sdk"

/**
 * The runtime adapter actually frozen into a spec. Unlike
 * {@link AgentRuntimePolicy} this includes `external`, which is never chosen
 * by policy directly — it is derived from an external-agent binding (teammate
 * runtime / preset) by the resolver.
 */
export type AgentRuntimeAdapterId = "claude-agent-sdk" | "ai-sdk" | "external"

export type AgentRoutePolicy = "gateway-required" | "gateway-preferred" | "direct"

export type AgentExecutionTarget =
  { mode: "colocate" } | { mode: "auto" } | { mode: "pinned"; hostRef: string }

export type CredentialAffinity = "session-sticky" | "sticky-with-failover" | "per-request"

/**
 * Capability vocabulary for the compatibility matrix and the per-spec
 * effective set. "Hard" vs "preferred" is a property of the *request*
 * (`AgentExecutionPolicy.requires` / `prefers`), not of the id itself.
 */
export type AgentCapabilityId =
  | "streaming"
  | "session.multi-turn"
  | "session.resume"
  | "tools.ordinary"
  | "tools.parallel"
  | "tools.fragmented-json"
  | "tools.results"
  | "tools.errors"
  | "mcp"
  | "permissions.interrupt-resume"
  | "permissions.set-mode"
  | "prompt-caching"
  | "thinking"
  | "context-management"
  | "images"
  | "beta-features"
  | "rate-limit-handling"
  | "upstream-errors"
  | "stream-interruption"
  | "subagents.native"
  | "steer"
  | "set-model"
  | "checkpoint"
  | "compaction"

export const AGENT_CAPABILITY_IDS: readonly AgentCapabilityId[] = [
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
  "steer",
  "set-model",
  "checkpoint",
  "compaction",
]

/**
 * Caller-facing execution policy (plan §3.1). Everything is declarative;
 * the only authority that turns a policy into an executable decision is
 * `resolveAgentExecutionSpec()`.
 */
export interface AgentExecutionPolicy {
  executionKind: "agent" | "completion"
  runtimePolicy: AgentRuntimePolicy
  routePolicy: AgentRoutePolicy
  deploymentRef?: string
  modelBindingRef?: string
  credentialProfileRef?: string
  credentialAffinity?: CredentialAffinity
  executionTarget?: AgentExecutionTarget
  requires?: AgentCapabilityId[]
  prefers?: AgentCapabilityId[]
  fallbackPolicy?: "none" | "completion"
}

// ---- Identity ---------------------------------------------------------------

/**
 * Fixed identity hierarchy: session → run → turn → attempt → providerAttempt.
 * A host resume mints a new attempt; a Gateway pre-first-byte candidate switch
 * mints a new providerAttempt. Budget, trace, recovery and Team parent/child
 * aggregation all key off these ids.
 */
export interface AgentExecutionIdentity {
  sessionId: string
  runId: string
  turnId?: string
  attemptId: string
  providerAttemptId?: string
  parentRunId?: string
}

// ---- Resolved spec ----------------------------------------------------------

export type AgentCompatibilityEvidence =
  "native" | "vendor-certified" | "cognia-verified" | "experimental" | "unsupported"

export interface AgentModelBindings {
  primary: string
  fast?: string
  powerful?: string
}

export type AgentResolvedRoute =
  | {
      kind: "gateway"
      routePolicy: AgentRoutePolicy
      routePinId?: string
      /** Ticket *id*, never the ticket secret. */
      ticketRef?: string
    }
  | {
      kind: "direct"
      routePolicy: AgentRoutePolicy
      credentialProfileRef?: string
    }

/**
 * Immutable output of `resolveAgentExecutionSpec()`. Serialisable, secret-free
 * and stable for the whole session: callers must never re-derive runtime,
 * route or host from anything else once a spec exists.
 */
export interface ResolvedAgentExecutionSpec {
  specVersion: 1
  identity: AgentExecutionIdentity
  /** Deterministic hash over the non-volatile spec fields (see fingerprint.ts). */
  executionFingerprint: string
  executionKind: "agent" | "completion"
  runtimeAdapter: AgentRuntimeAdapterId
  runtimePolicySource: "explicit" | "auto" | "legacy-mapped"
  deploymentRef?: string
  modelBindings: AgentModelBindings
  route: AgentResolvedRoute
  /** e.g. "desktop-sidecar" | "headless-agent-host" | a pinned ADR-0082 host ref. */
  hostRef: string
  compatibility: {
    evidence: AgentCompatibilityEvidence
    recordRef?: string
    suiteVersion?: string
  }
  capabilities: {
    effective: AgentCapabilityId[]
    /** Preferred-but-unavailable capabilities the resolver switched off. */
    disabledOptional: AgentCapabilityId[]
  }
  credential?: {
    /** Reference into the Provider Profile Store — never a value. */
    profileRef: string
    profileVersion?: string
    affinity: CredentialAffinity
  }
  fallbackPolicy: "none" | "completion"
  /** Set when legacy `toolsEnabled`/provider-id signals drove the mapping. */
  legacyMigrated?: boolean
}

// ---- SendOptions projection -------------------------------------------------

/**
 * The serialized projection of a {@link ResolvedAgentExecutionSpec} that rides
 * `SendOptions.execution` renderer → Rust (via the `extra` flatten) → sidecar.
 * The sidecar treats it as frozen: dispatch reads `runtimeAdapter` and never
 * re-derives the runtime from `provider`. Secrets (ticket secret, direct
 * credentials) are NOT here — they ride `SendOptions.env`.
 */
export interface AgentExecutionSendSpec {
  specVersion: 1
  executionFingerprint: string
  runtimeAdapter: AgentRuntimeAdapterId
  executionKind: "agent" | "completion"
  route:
    | { kind: "gateway"; endpoint: string; ticketId: string }
    | { kind: "direct"; credentialProfileRef?: string }
  modelBindings: AgentModelBindings
  capabilities: {
    effective: AgentCapabilityId[]
    disabledOptional: AgentCapabilityId[]
  }
  identity: { runId: string; parentRunId?: string; attemptId: string }
  hostRef: string
}

// ---- Canonical events -------------------------------------------------------

/**
 * Canonical event kinds, a superset of the capture layer's
 * `CaptureStreamEvent` plus lifecycle / permission / subagent / checkpoint /
 * failure kinds. Raw runtime payloads are allowed only inside the controlled
 * `diagnostic` attachment.
 */
export type CanonicalAgentEvent =
  | { kind: "lifecycle"; phase: "started" | "ended" | "interrupted"; detail?: string }
  | { kind: "text-delta"; delta: string }
  | { kind: "thinking-delta"; delta: string }
  | {
      kind: "tool-call"
      toolName: string
      input: Record<string, unknown>
      toolCallId?: string
    }
  | {
      kind: "tool-result"
      toolName: string
      toolCallId?: string
      input?: Record<string, unknown>
      result: unknown
      isError?: boolean
    }
  | {
      kind: "permission-request"
      requestId: string
      toolName: string
      input?: Record<string, unknown>
    }
  | {
      kind: "permission-resolved"
      requestId: string
      behavior: "allow" | "deny"
    }
  | { kind: "subagent"; phase: "started" | "ended"; runtimeBinding?: string }
  | { kind: "usage"; usage: Record<string, unknown>; partial?: boolean }
  | {
      kind: "compact"
      trigger: "manual" | "auto"
      preTokens?: number
      postTokens?: number
    }
  | { kind: "checkpoint"; checkpointId: string }
  | { kind: "warning"; code: string; message: string }
  | { kind: "failure"; code: string; message: string; retryable?: boolean }
  | { kind: "capability-error"; capability: AgentCapabilityId; command?: string }
  | { kind: "diagnostic"; runtime: string; payload: unknown }

/**
 * Envelope wrapped around every canonical event (plan §3.5). Delivery is
 * at-least-once; consumers dedupe on `eventId`. `sequence` is monotonic
 * within an attempt.
 */
export interface AgentEventEnvelope {
  eventId: string
  sequence: number
  sessionId: string
  runId: string
  turnId: string
  attemptId: string
  providerAttemptId?: string
  parentRunId?: string
  hostRef: string
  runtime: string
  timestamp: string
  event: CanonicalAgentEvent
}

// ---- Decision trace ---------------------------------------------------------

export type AgentExecutionSurface =
  "chat" | "agent-executor" | "workflow-agent-turn" | "team" | "plugin"

/**
 * Secret-free record of one resolver decision. Only ids / enums / refs are
 * allowed — no env values, headers, URLs-with-credentials or key material.
 * Volatile by design: excluded from the execution fingerprint.
 */
export interface AgentExecutionDecisionTrace {
  traceId: string
  surface: AgentExecutionSurface
  at: string
  flags: Record<string, boolean>
  legacy: {
    providerId?: string
    modelId?: string
    proxyMode?: string
    runtime?: string
    toolsEnabled?: boolean
    requireTools?: boolean
    channel?: "sidecar" | "text" | "external"
  }
  resolved: {
    executionFingerprint: string
    runtimeAdapter: AgentRuntimeAdapterId
    executionKind: "agent" | "completion"
    routeKind: "gateway" | "direct"
    routePolicy: AgentRoutePolicy
    hostRef: string
    deploymentRef?: string
    modelBindingRef?: string
    fallbackPolicy: "none" | "completion"
    legacyMigrated?: boolean
    disabledOptional: AgentCapabilityId[]
  }
  divergence: Array<"runtime" | "route" | "model" | "fallback" | "host" | "kind">
}

// ---- Validators -------------------------------------------------------------

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const RUNTIME_POLICIES: readonly string[] = ["auto", "claude-agent-sdk", "ai-sdk"]
const RUNTIME_ADAPTERS: readonly string[] = ["claude-agent-sdk", "ai-sdk", "external"]
const ROUTE_POLICIES: readonly string[] = ["gateway-required", "gateway-preferred", "direct"]
const AFFINITIES: readonly string[] = ["session-sticky", "sticky-with-failover", "per-request"]
const EXECUTION_KINDS: readonly string[] = ["agent", "completion"]
const FALLBACK_POLICIES: readonly string[] = ["none", "completion"]

function isCapabilityIdArray(v: unknown): v is AgentCapabilityId[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === "string" && (AGENT_CAPABILITY_IDS as readonly string[]).includes(x))
  )
}

export function validateAgentExecutionPolicy(v: unknown): ValidationResult<AgentExecutionPolicy> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["policy must be an object"] }

  if (!EXECUTION_KINDS.includes(v.executionKind as string)) {
    errors.push(`executionKind must be one of ${EXECUTION_KINDS.join("|")}`)
  }
  if (!RUNTIME_POLICIES.includes(v.runtimePolicy as string)) {
    errors.push(`runtimePolicy must be one of ${RUNTIME_POLICIES.join("|")}`)
  }
  if (!ROUTE_POLICIES.includes(v.routePolicy as string)) {
    errors.push(`routePolicy must be one of ${ROUTE_POLICIES.join("|")}`)
  }
  for (const key of ["deploymentRef", "modelBindingRef", "credentialProfileRef"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      errors.push(`${key} must be a string when present`)
    }
  }
  if (v.credentialAffinity !== undefined && !AFFINITIES.includes(v.credentialAffinity as string)) {
    errors.push(`credentialAffinity must be one of ${AFFINITIES.join("|")}`)
  }
  if (v.executionTarget !== undefined) {
    const t = v.executionTarget
    const okTarget =
      isRecord(t) &&
      (t.mode === "colocate" ||
        t.mode === "auto" ||
        (t.mode === "pinned" && typeof t.hostRef === "string" && t.hostRef.length > 0))
    if (!okTarget) errors.push("executionTarget must be colocate|auto|pinned{hostRef}")
  }
  for (const key of ["requires", "prefers"] as const) {
    if (v[key] !== undefined && !isCapabilityIdArray(v[key])) {
      errors.push(`${key} must be an array of known capability ids`)
    }
  }
  if (v.fallbackPolicy !== undefined && !FALLBACK_POLICIES.includes(v.fallbackPolicy as string)) {
    errors.push(`fallbackPolicy must be one of ${FALLBACK_POLICIES.join("|")}`)
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as AgentExecutionPolicy }
}

function validateIdentity(v: unknown, errors: string[], path: string): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object`)
    return
  }
  for (const key of ["sessionId", "runId", "attemptId"] as const) {
    if (typeof v[key] !== "string" || v[key].length === 0) {
      errors.push(`${path}.${key} must be a non-empty string`)
    }
  }
  for (const key of ["turnId", "providerAttemptId", "parentRunId"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      errors.push(`${path}.${key} must be a string when present`)
    }
  }
}

function validateModelBindings(v: unknown, errors: string[], path: string): void {
  if (!isRecord(v) || typeof v.primary !== "string" || v.primary.length === 0) {
    errors.push(`${path}.primary must be a non-empty string`)
    return
  }
  for (const key of ["fast", "powerful"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      errors.push(`${path}.${key} must be a string when present`)
    }
  }
}

export function validateResolvedAgentExecutionSpec(
  v: unknown
): ValidationResult<ResolvedAgentExecutionSpec> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["spec must be an object"] }

  if (v.specVersion !== 1) errors.push("specVersion must be 1")
  validateIdentity(v.identity, errors, "identity")
  if (typeof v.executionFingerprint !== "string" || v.executionFingerprint.length === 0) {
    errors.push("executionFingerprint must be a non-empty string")
  }
  if (!EXECUTION_KINDS.includes(v.executionKind as string)) {
    errors.push(`executionKind must be one of ${EXECUTION_KINDS.join("|")}`)
  }
  if (!RUNTIME_ADAPTERS.includes(v.runtimeAdapter as string)) {
    errors.push(`runtimeAdapter must be one of ${RUNTIME_ADAPTERS.join("|")}`)
  }
  if (!["explicit", "auto", "legacy-mapped"].includes(v.runtimePolicySource as string)) {
    errors.push("runtimePolicySource must be explicit|auto|legacy-mapped")
  }
  validateModelBindings(v.modelBindings, errors, "modelBindings")

  const route = v.route
  if (!isRecord(route)) {
    errors.push("route must be an object")
  } else if (route.kind === "gateway") {
    if (!ROUTE_POLICIES.includes(route.routePolicy as string)) {
      errors.push("route.routePolicy must be a route policy")
    }
    for (const key of ["routePinId", "ticketRef"] as const) {
      if (route[key] !== undefined && typeof route[key] !== "string") {
        errors.push(`route.${key} must be a string when present`)
      }
    }
  } else if (route.kind === "direct") {
    if (!ROUTE_POLICIES.includes(route.routePolicy as string)) {
      errors.push("route.routePolicy must be a route policy")
    }
    if (
      route.credentialProfileRef !== undefined &&
      typeof route.credentialProfileRef !== "string"
    ) {
      errors.push("route.credentialProfileRef must be a string when present")
    }
  } else {
    errors.push("route.kind must be gateway|direct")
  }

  if (typeof v.hostRef !== "string" || v.hostRef.length === 0) {
    errors.push("hostRef must be a non-empty string")
  }

  const compat = v.compatibility
  if (
    !isRecord(compat) ||
    !["native", "vendor-certified", "cognia-verified", "experimental", "unsupported"].includes(
      compat.evidence as string
    )
  ) {
    errors.push("compatibility.evidence must be a known evidence level")
  }

  const caps = v.capabilities
  if (
    !isRecord(caps) ||
    !isCapabilityIdArray(caps.effective) ||
    !isCapabilityIdArray(caps.disabledOptional)
  ) {
    errors.push("capabilities.effective/disabledOptional must be capability id arrays")
  }

  if (v.credential !== undefined) {
    const cred = v.credential
    if (
      !isRecord(cred) ||
      typeof cred.profileRef !== "string" ||
      cred.profileRef.length === 0 ||
      !AFFINITIES.includes(cred.affinity as string)
    ) {
      errors.push("credential must carry profileRef + affinity (reference only)")
    } else if ("value" in cred || "apiKey" in cred || "secret" in cred || "token" in cred) {
      errors.push("credential must not carry secret material")
    }
  }

  if (!FALLBACK_POLICIES.includes(v.fallbackPolicy as string)) {
    errors.push(`fallbackPolicy must be one of ${FALLBACK_POLICIES.join("|")}`)
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as ResolvedAgentExecutionSpec }
}

export function validateAgentExecutionSendSpec(
  v: unknown
): ValidationResult<AgentExecutionSendSpec> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["execution spec must be an object"] }

  if (v.specVersion !== 1) errors.push("specVersion must be 1")
  if (typeof v.executionFingerprint !== "string" || v.executionFingerprint.length === 0) {
    errors.push("executionFingerprint must be a non-empty string")
  }
  if (!RUNTIME_ADAPTERS.includes(v.runtimeAdapter as string)) {
    errors.push(`runtimeAdapter must be one of ${RUNTIME_ADAPTERS.join("|")}`)
  }
  if (!EXECUTION_KINDS.includes(v.executionKind as string)) {
    errors.push(`executionKind must be one of ${EXECUTION_KINDS.join("|")}`)
  }

  const route = v.route
  if (!isRecord(route)) {
    errors.push("route must be an object")
  } else if (route.kind === "gateway") {
    if (typeof route.endpoint !== "string" || route.endpoint.length === 0) {
      errors.push("route.endpoint must be a non-empty string")
    }
    if (typeof route.ticketId !== "string" || route.ticketId.length === 0) {
      errors.push("route.ticketId must be a non-empty string")
    }
  } else if (route.kind === "direct") {
    if (
      route.credentialProfileRef !== undefined &&
      typeof route.credentialProfileRef !== "string"
    ) {
      errors.push("route.credentialProfileRef must be a string when present")
    }
  } else {
    errors.push("route.kind must be gateway|direct")
  }

  validateModelBindings(v.modelBindings, errors, "modelBindings")

  const caps = v.capabilities
  if (
    !isRecord(caps) ||
    !isCapabilityIdArray(caps.effective) ||
    !isCapabilityIdArray(caps.disabledOptional)
  ) {
    errors.push("capabilities.effective/disabledOptional must be capability id arrays")
  }

  const identity = v.identity
  if (
    !isRecord(identity) ||
    typeof identity.runId !== "string" ||
    identity.runId.length === 0 ||
    typeof identity.attemptId !== "string" ||
    identity.attemptId.length === 0
  ) {
    errors.push("identity must carry runId + attemptId")
  } else if (identity.parentRunId !== undefined && typeof identity.parentRunId !== "string") {
    errors.push("identity.parentRunId must be a string when present")
  }

  if (typeof v.hostRef !== "string" || v.hostRef.length === 0) {
    errors.push("hostRef must be a non-empty string")
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as AgentExecutionSendSpec }
}

const CANONICAL_EVENT_KINDS: readonly string[] = [
  "lifecycle",
  "text-delta",
  "thinking-delta",
  "tool-call",
  "tool-result",
  "permission-request",
  "permission-resolved",
  "subagent",
  "usage",
  "compact",
  "checkpoint",
  "warning",
  "failure",
  "capability-error",
  "diagnostic",
]

export function isAgentEventEnvelope(v: unknown): v is AgentEventEnvelope {
  if (!isRecord(v)) return false
  if (typeof v.eventId !== "string" || v.eventId.length === 0) return false
  if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 0) {
    return false
  }
  for (const key of ["sessionId", "runId", "turnId", "attemptId", "hostRef", "runtime"] as const) {
    if (typeof v[key] !== "string" || v[key].length === 0) return false
  }
  for (const key of ["providerAttemptId", "parentRunId"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") return false
  }
  if (typeof v.timestamp !== "string" || v.timestamp.length === 0) return false
  const event = v.event
  if (!isRecord(event) || !CANONICAL_EVENT_KINDS.includes(event.kind as string)) return false
  return true
}

/** Narrow helper used by tests + adapters when only capability ids are known at runtime. */
export function isAgentCapabilityId(v: unknown): v is AgentCapabilityId {
  return typeof v === "string" && (AGENT_CAPABILITY_IDS as readonly string[]).includes(v)
}
