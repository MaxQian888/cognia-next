import type { ResolvedAgentExecutionSpec as AgentSdkResolvedExecutionSpec } from "@cognia/agent"
import type { AgentOrchestrationPolicy, ToolPresentationMode } from "./agent-composition"
import type { AgentPermissionMode } from "./agent-modes"
import {
  AGENT_CAPABILITY_IDS,
  isAgentCapabilityId,
  type AgentCapabilityEvidence,
  type AgentCapabilityId,
  type AgentCapabilitySupport,
  type AgentRuntimeAdapterId,
} from "@cognia/agent-contracts/capability-ids"
import type { AgentExtensionUiUpdate } from "@cognia/agent-contracts/extension-ui"
import {
  CANONICAL_AGENT_EVENT_KINDS,
  MODEL_REQUEST_PURPOSES,
  isAgentEventEnvelope,
  isKnownCanonicalAgentEventKind,
  type AgentEventEnvelope,
  type CanonicalAgentEvent,
  type CanonicalContentPart,
  type CanonicalSourceReference,
  type ModelRequestPurpose,
} from "@cognia/agent-contracts/canonical-event"

// The capability vocabulary, runtime adapter ids and extension UI updates are
// owned by `@cognia/agent-contracts` so integrations can name them without
// this hub.
export { AGENT_CAPABILITY_IDS, isAgentCapabilityId }
// The canonical event vocabulary is owned by `@cognia/agent-contracts`
// (integrations emit it); re-exported here for existing importers.
export {
  CANONICAL_AGENT_EVENT_KINDS,
  MODEL_REQUEST_PURPOSES,
  isAgentEventEnvelope,
  isKnownCanonicalAgentEventKind,
}
export type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
  CanonicalContentPart,
  CanonicalSourceReference,
  ModelRequestPurpose,
}
export type {
  AgentCapabilityEvidence,
  AgentCapabilityId,
  AgentCapabilitySupport,
  AgentExtensionUiUpdate,
  AgentRuntimeAdapterId,
}

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

export type AgentRoutePolicy = "gateway-required" | "gateway-preferred" | "direct"

export type AgentExecutionTarget =
  { mode: "colocate" } | { mode: "auto" } | { mode: "pinned"; hostRef: string }

export type CredentialAffinity = "session-sticky" | "sticky-with-failover" | "per-request"

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
 * Current spec version. v2 adds `capabilities.support` — the per-capability
 * `native | equivalent | unsupported` verdict the SDK-parity work needs in
 * order to refuse a provider *before* spending a model turn rather than
 * discovering the gap mid-stream.
 *
 * v1 specs are still accepted on the way in and upcast by
 * {@link upgradeResolvedAgentExecutionSpec}; nothing new is ever emitted as v1.
 */
export const RESOLVED_SPEC_VERSION = 2

/**
 * Immutable output of `resolveAgentExecutionSpec()`. Serialisable, secret-free
 * and stable for the whole session: callers must never re-derive runtime,
 * route or host from anything else once a spec exists.
 */
export interface ResolvedAgentExecutionSpec extends AgentSdkResolvedExecutionSpec {
  identity: AgentExecutionIdentity
  runtimeAdapter: AgentRuntimeAdapterId
  modelBindings: AgentModelBindings
  route: AgentResolvedRoute
  compatibility: {
    evidence: AgentCompatibilityEvidence
    recordRef?: string
    suiteVersion?: string
  }
  capabilities: {
    effective: AgentCapabilityId[]
    /** Preferred-but-unavailable capabilities the resolver switched off. */
    disabledOptional: AgentCapabilityId[]
    /**
     * v2+. Per-capability verdict for everything in `effective`, plus any
     * capability the caller asked about and did not get. Absent on an
     * un-upcast v1 spec.
     */
    support?: Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>>
  }
  credential?: {
    /** Reference into the Provider Profile Store — never a value. */
    profileRef: string
    profileVersion?: string
    affinity: CredentialAffinity
  }
}

// ---- SendOptions projection -------------------------------------------------

/**
 * Where an external-agent turn actually runs (spec v3).
 *
 * The two arms are not two transports for one thing; they are two different
 * authorities, and collapsing them is what makes a browser Composer unable to
 * run an external agent at all:
 *
 *   - `local-external` — the renderer that owns the configuration also owns
 *     the process. `agentId` addresses the in-memory manager, and nothing has
 *     to be proven because nothing crossed a trust boundary.
 *   - `remote-external` — a paired host owns the process, and the caller owns
 *     nothing but a reference. So the reference has to be checkable: the host
 *     admits the run only if `revision` is still its head AND
 *     `lifecycleGeneration` still matches. The first proves the configuration
 *     text has not changed under the turn; the second proves it is still
 *     runnable (not disabled, credentials not revoked). Either alone lets
 *     through a case the other catches.
 *
 * Absent means the turn is not an external one at all — it runs on the
 * built-in sidecar, which is the pre-v3 behaviour and the safe default.
 */
export type AgentExternalBinding =
  | { kind: "local-external"; agentId: string }
  | {
      kind: "remote-external"
      /** The paired runtime target that will run it. */
      targetId: string
      /** Host-owned configuration id. Never chosen by the caller. */
      configId: string
      /** The immutable revision the caller read. */
      revision: string
      /** The readiness generation the caller read. */
      lifecycleGeneration: number
    }

/** Type guard: does this binding cross a host boundary? */
export function isRemoteExternalBinding(
  binding: AgentExternalBinding | undefined
): binding is Extract<AgentExternalBinding, { kind: "remote-external" }> {
  return binding?.kind === "remote-external"
}

/**
 * The serialized projection of a {@link ResolvedAgentExecutionSpec} that rides
 * `SendOptions.execution` renderer → Rust (via the `extra` flatten) → sidecar.
 * The sidecar treats it as frozen: dispatch reads `runtimeAdapter` and never
 * re-derives the runtime from `provider`. Secrets (ticket secret, direct
 * credentials) are NOT here — they ride `SendOptions.env`.
 */
export interface AgentExecutionSendSpec {
  specVersion: 1 | 2 | 3
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
    /** v2+. Mirrors the resolved spec so the sidecar can fail closed too. */
    support?: Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>>
  }
  identity: {
    sessionId?: string
    runId: string
    parentRunId?: string
    turnId?: string
    attemptId: string
  }
  hostRef: string
  /**
   * v2+. The turn's resolved composition axes (ADR-0117).
   *
   * Projected onto the wire so the sidecar can fail closed on its own side, in
   * the same spirit as `capabilities.support`. The concrete need is the Code
   * tool presentation: the sidecar decides which tool defs to register, so it
   * has to know whether this turn is `native`, `code`, or `both` — deriving
   * that from anything else would mean a second, drifting source of truth for
   * what the model is allowed to see.
   *
   * Only the axes are sent, never the prompt or tool text: the digests are
   * identity, not content. Absent means "native", which is the pre-ADR-0117
   * behaviour and the safe default.
   */
  composition?: AgentCompositionProjection
  /**
   * v3+. Where an external-agent turn runs. Absent on a built-in sidecar turn.
   */
  externalBinding?: AgentExternalBinding
}

/**
 * The wire-safe slice of `ResolvedAgentCompositionV1`.
 *
 * Deliberately a hand-written subset rather than the whole resolved object:
 * `warnings` is renderer-facing UI text, and shipping it would grow the
 * envelope with strings the sidecar has no use for.
 */
export interface AgentCompositionProjection {
  authority: AgentPermissionMode
  toolPresentation: ToolPresentationMode
  orchestration: AgentOrchestrationPolicy
  /** Identity of the composition, for correlating events and replay tapes. */
  compositionDigest: string
  presetId: string
}

/**
 * Upcast a v1 spec to v2.
 *
 * A v1 spec carries no per-capability verdicts, and inventing them would be a
 * lie in the dangerous direction — claiming `native` for something never
 * tested. So every capability v1 listed as effective becomes `native` with an
 * explicit reason recording *why* we believe it: it was in `effective` under
 * the v1 static table, which only ever contained natively-supported ids. The
 * 16 SDK-parity capabilities added in v2 are simply absent, which the gate
 * treats as unsupported.
 *
 * Idempotent: a v2 spec is returned unchanged.
 */
export function upgradeResolvedAgentExecutionSpec(
  spec: ResolvedAgentExecutionSpec
): ResolvedAgentExecutionSpec {
  if (spec.specVersion === 2) return spec

  const support: Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>> = {}
  for (const id of spec.capabilities.effective) {
    support[id] = {
      support: "native",
      reason: "carried forward from a v1 spec, whose effective set was natively supported only",
    }
  }

  return {
    ...spec,
    specVersion: 2,
    capabilities: { ...spec.capabilities, support },
  }
}

// ---- Decision trace ---------------------------------------------------------

export type AgentExecutionSurface =
  "chat" | "connector" | "agent-executor" | "workflow-agent-turn" | "team" | "plugin" | "cli"

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

const CAPABILITY_SUPPORTS: readonly string[] = ["native", "equivalent", "unsupported"]

/**
 * `capabilities.support` is v2-only, keyed by known capability ids, and every
 * non-`native` verdict must say why.
 *
 * The reason requirement is not decoration: an `unsupported` with no
 * explanation reads identically whether the runtime genuinely cannot do the
 * thing or an adapter was left half-written, and the whole point of
 * fail-closed is that those two must never be confused.
 */
function validateCapabilitySupport(support: unknown, specVersion: unknown, errors: string[]): void {
  if (support === undefined) {
    if (specVersion === 2) errors.push("capabilities.support is required on a v2 spec")
    return
  }
  if (specVersion === 1) {
    errors.push("capabilities.support is not valid on a v1 spec")
    return
  }
  if (!isRecord(support)) {
    errors.push("capabilities.support must be an object")
    return
  }

  for (const [id, entry] of Object.entries(support)) {
    if (!isAgentCapabilityId(id)) {
      errors.push(`capabilities.support has unknown capability id "${id}"`)
      continue
    }
    if (!isRecord(entry) || !CAPABILITY_SUPPORTS.includes(entry.support as string)) {
      errors.push(
        `capabilities.support.${id}.support must be one of ${CAPABILITY_SUPPORTS.join("|")}`
      )
      continue
    }
    if (entry.support !== "native" && (typeof entry.reason !== "string" || !entry.reason.trim())) {
      errors.push(`capabilities.support.${id} is "${entry.support}" and must carry a reason`)
    }
  }
}

export function validateResolvedAgentExecutionSpec(
  v: unknown
): ValidationResult<ResolvedAgentExecutionSpec> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["spec must be an object"] }

  if (v.specVersion !== 1 && v.specVersion !== 2) errors.push("specVersion must be 1 or 2")
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
  } else {
    validateCapabilitySupport(caps.support, v.specVersion, errors)
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

/**
 * Validate the v3 external binding.
 *
 * A remote binding is a claim about another machine's state, so every field is
 * load-bearing and none may be defaulted: a missing `lifecycleGeneration` that
 * silently became `0` would compare unequal to every real generation and turn
 * a checkable admission into a permanent refusal, while a missing `revision`
 * treated as "any" would remove the check entirely. Refusing the spec is the
 * only safe reading of an incomplete one.
 */
function validateExternalBinding(binding: unknown, specVersion: unknown, errors: string[]): void {
  if (binding === undefined) return
  if (specVersion !== 3) {
    errors.push("externalBinding requires specVersion 3")
    return
  }
  if (!isRecord(binding)) {
    errors.push("externalBinding must be an object")
    return
  }
  if (binding.kind === "local-external") {
    if (typeof binding.agentId !== "string" || binding.agentId.length === 0) {
      errors.push("externalBinding.agentId must be a non-empty string")
    }
    return
  }
  if (binding.kind === "remote-external") {
    for (const field of ["targetId", "configId", "revision"] as const) {
      if (typeof binding[field] !== "string" || (binding[field] as string).length === 0) {
        errors.push(`externalBinding.${field} must be a non-empty string`)
      }
    }
    if (
      typeof binding.lifecycleGeneration !== "number" ||
      !Number.isInteger(binding.lifecycleGeneration) ||
      binding.lifecycleGeneration < 1
    ) {
      errors.push("externalBinding.lifecycleGeneration must be a positive integer")
    }
    return
  }
  errors.push("externalBinding.kind must be local-external|remote-external")
}

export function validateAgentExecutionSendSpec(
  v: unknown
): ValidationResult<AgentExecutionSendSpec> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["execution spec must be an object"] }

  if (v.specVersion !== 1 && v.specVersion !== 2 && v.specVersion !== 3) {
    errors.push("specVersion must be 1, 2 or 3")
  }
  if (typeof v.executionFingerprint !== "string" || v.executionFingerprint.length === 0) {
    errors.push("executionFingerprint must be a non-empty string")
  }
  validateExternalBinding(v.externalBinding, v.specVersion, errors)
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
