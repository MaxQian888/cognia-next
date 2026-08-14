// Keyless deterministic model-request replay (ADR-0118).
//
// Nothing in the system currently records what was actually sent to a model:
// the final system prompt, the normalized messages and the tool schemas are
// assembled across `build-options`, the execution resolver and the sidecar,
// then discarded. These contracts describe that surface so it can be digested
// on every run and, when recording is explicitly enabled, replayed with no API
// key and no egress.
//
// Two hard rules are encoded in the shapes below rather than left to callers:
//
//   1. Content never rides the contract. Prompts, messages, schemas and
//      response bodies are referenced (`*Ref`) into the encrypted eval asset
//      store; the contract itself carries digests, ids and enums only.
//   2. A tape is matched per actor AND per purpose. A title or compaction call
//      can never consume a tape recorded for the turn itself, and concurrent
//      children cannot desynchronize each other.

import type {
  AgentRuntimeAdapterId,
  ModelRequestPurpose,
  ValidationResult,
} from "./agent-execution"
import { MODEL_REQUEST_PURPOSES } from "./agent-execution"

/**
 * Re-exported so a replay consumer needs one import, not two.
 *
 * `ModelRequestPurpose` is declared next to the canonical event vocabulary in
 * `./agent-execution` because the `model-request` event carries it, but every
 * caller that reaches for it is doing replay work and looks for it here.
 */
export type { ModelRequestPurpose } from "./agent-execution"
export { MODEL_REQUEST_PURPOSES } from "./agent-execution"

export const MODEL_REQUEST_SURFACE_SCHEMA_VERSION = 1
export const REPLAY_SCENARIO_SCHEMA_VERSION = 1
export const REPLAY_TAPE_SCHEMA_VERSION = 1

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function isDigest(v: unknown): v is string {
  return typeof v === "string" && DIGEST_PATTERN.test(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

// ---- Encrypted artifacts ----------------------------------------------------

/**
 * Artifact kinds added to the existing eval asset store.
 *
 * They reuse `lib/ai/eval/artifact-crypto.ts` and the `.cognia-eval` bundle
 * rather than introducing a second at-rest format, which also means deleting an
 * eval asset already deletes the replay bytes that referenced it.
 */
export type ReplayArtifactKind =
  | "model-request"
  | "model-stream"
  | "permission-tape"
  | "session-log"
  | "transport"
  | "workspace-manifest"

export const REPLAY_ARTIFACT_KINDS: readonly ReplayArtifactKind[] = [
  "model-request",
  "model-stream",
  "permission-tape",
  "session-log",
  "transport",
  "workspace-manifest",
]

export function isReplayArtifactKind(v: unknown): v is ReplayArtifactKind {
  return typeof v === "string" && (REPLAY_ARTIFACT_KINDS as readonly string[]).includes(v)
}

// ---- The request surface ----------------------------------------------------

/**
 * The resolved knobs of one model call.
 *
 * Deliberately narrow: only values that change what the model returns belong
 * here, because every field participates in `requestDigest` and therefore in
 * tape matching. Credentials, endpoints, headers and proxy settings are NOT
 * request configuration for this purpose — they are how the bytes travel, not
 * what was asked, and capturing them is how a key ends up in a fixture.
 */
export interface ModelRequestConfigV1 {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  stream?: boolean
  /** Extended-thinking budget in tokens, when the provider supports it. */
  thinkingBudgetTokens?: number
  /** Tool-choice directive as the provider spells it, when one was forced. */
  toolChoice?: string
}

/** Encrypted-asset references for the bodies this surface deliberately omits. */
export interface ModelRequestArtifactRefsV1 {
  /** Final system prompt, exactly as sent. */
  promptRef?: string
  /** Normalized message list. */
  messagesRef?: string
  /** Ordered tool schemas as the provider received them. */
  toolSchemaRef?: string
}

export interface ModelRequestSurfaceV1 {
  schemaVersion: typeof MODEL_REQUEST_SURFACE_SCHEMA_VERSION
  /** Mirrors `AgentEventEnvelope` so a surface joins to its event stream. */
  sessionId: string
  runId: string
  turnId: string
  attemptId: string
  providerAttemptId?: string
  parentRunId?: string
  runtimeAdapter: AgentRuntimeAdapterId
  provider: string
  model: string
  purpose: ModelRequestPurpose
  config: ModelRequestConfigV1
  /** Absent on an ordinary (non-recording) run; digests are still present. */
  refs?: ModelRequestArtifactRefsV1
  /** SHA-256 of the final system prompt. */
  promptDigest: string
  /** SHA-256 of the normalized message list. */
  messagesDigest: string
  /** SHA-256 of the ordered tool schemas. */
  toolDigest: string
  /** SHA-256 over {@link requestDigestPayload}; the replay match key. */
  requestDigest: string
  compositionDigest?: string
  executionFingerprint?: string
  /** ISO-8601. Volatile: never part of any digest. */
  recordedAt: string
}

/**
 * The exact object `requestDigest` covers.
 *
 * Excludes identity (`runId`, `attemptId`, …) and `recordedAt` on purpose: the
 * same question asked twice must produce the same digest, otherwise a replay
 * could never match a recording made in a different session. Actor scoping is
 * applied by the *lease*, not by the digest — see {@link ReplayTapeMatchV1}.
 */
export function requestDigestPayload(
  surface: Pick<
    ModelRequestSurfaceV1,
    "provider" | "model" | "purpose" | "config" | "promptDigest" | "messagesDigest" | "toolDigest"
  >
): Record<string, unknown> {
  return {
    schemaVersion: MODEL_REQUEST_SURFACE_SCHEMA_VERSION,
    provider: surface.provider,
    model: surface.model,
    purpose: surface.purpose,
    config: surface.config,
    promptDigest: surface.promptDigest,
    messagesDigest: surface.messagesDigest,
    toolDigest: surface.toolDigest,
  }
}

export function validateModelRequestSurface(v: unknown): ValidationResult<ModelRequestSurfaceV1> {
  if (!isRecord(v)) return { ok: false, errors: ["surface must be an object"] }
  const errors: string[] = []

  if (v.schemaVersion !== MODEL_REQUEST_SURFACE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MODEL_REQUEST_SURFACE_SCHEMA_VERSION}`)
  }
  for (const key of ["sessionId", "runId", "turnId", "attemptId", "provider", "model"] as const) {
    if (!isNonEmptyString(v[key])) errors.push(`${key} must be a non-empty string`)
  }
  if (!(MODEL_REQUEST_PURPOSES as readonly string[]).includes(v.purpose as string)) {
    errors.push(`purpose must be one of ${MODEL_REQUEST_PURPOSES.join("|")}`)
  }
  if (!isRecord(v.config)) errors.push("config must be an object")
  for (const key of ["promptDigest", "messagesDigest", "toolDigest", "requestDigest"] as const) {
    if (!isDigest(v[key])) errors.push(`${key} must be a sha256:<64 hex> digest`)
  }
  if (!isNonEmptyString(v.recordedAt)) errors.push("recordedAt must be a non-empty string")

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as ModelRequestSurfaceV1 }
}

// ---- Tapes ------------------------------------------------------------------

/**
 * What a matched tape does when the request arrives.
 *
 * `cancel` and `hang` exist because the failure modes worth regression-testing
 * are not only "the model said something wrong" — they are a stream cut
 * mid-flight and a provider that never answers, both of which have broken
 * recovery in this codebase before.
 */
export type ReplayTapeBehaviorV1 =
  | { kind: "stream"; chunksRef: string }
  | { kind: "error"; status?: number; code: string; message: string; retryable?: boolean }
  | { kind: "cancel"; afterChunks?: number }
  | { kind: "hang"; holdMs: number }

/**
 * Tape selection is `(actor, purpose, requestDigest)` against the tapes that
 * actor has not consumed yet — never global call order, which breaks the moment
 * two children run concurrently.
 */
export interface ReplayTapeMatchV1 {
  actorRef: string
  purpose: ModelRequestPurpose
  requestDigest: string
}

export interface ReplayTapeV1 {
  schemaVersion: typeof REPLAY_TAPE_SCHEMA_VERSION
  tapeId: string
  match: ReplayTapeMatchV1
  behavior: ReplayTapeBehaviorV1
  /**
   * Hand-authored (or scrubbed) content, safe to commit. A real recording is
   * `false`, stays encrypted, and must never be committed — the fixture gate
   * refuses anything that is not `true`.
   */
  synthetic: boolean
}

function validateTapeBehavior(v: unknown, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push("behavior must be an object")
    return
  }
  switch (v.kind) {
    case "stream":
      if (!isNonEmptyString(v.chunksRef))
        errors.push("behavior.chunksRef must be a non-empty string")
      return
    case "error":
      if (!isNonEmptyString(v.code)) errors.push("behavior.code must be a non-empty string")
      if (typeof v.message !== "string") errors.push("behavior.message must be a string")
      return
    case "cancel":
      if (v.afterChunks !== undefined && typeof v.afterChunks !== "number") {
        errors.push("behavior.afterChunks must be a number when present")
      }
      return
    case "hang":
      if (typeof v.holdMs !== "number" || v.holdMs < 0) {
        errors.push("behavior.holdMs must be a non-negative number")
      }
      return
    default:
      errors.push("behavior.kind must be one of stream|error|cancel|hang")
  }
}

export function validateReplayTape(v: unknown): ValidationResult<ReplayTapeV1> {
  if (!isRecord(v)) return { ok: false, errors: ["tape must be an object"] }
  const errors: string[] = []

  if (v.schemaVersion !== REPLAY_TAPE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${REPLAY_TAPE_SCHEMA_VERSION}`)
  }
  if (!isNonEmptyString(v.tapeId)) errors.push("tapeId must be a non-empty string")
  if (!isRecord(v.match)) {
    errors.push("match must be an object")
  } else {
    if (!isNonEmptyString(v.match.actorRef))
      errors.push("match.actorRef must be a non-empty string")
    if (!(MODEL_REQUEST_PURPOSES as readonly string[]).includes(v.match.purpose as string)) {
      errors.push(`match.purpose must be one of ${MODEL_REQUEST_PURPOSES.join("|")}`)
    }
    if (!isDigest(v.match.requestDigest)) {
      errors.push("match.requestDigest must be a sha256:<64 hex> digest")
    }
  }
  validateTapeBehavior(v.behavior, errors)
  if (typeof v.synthetic !== "boolean") errors.push("synthetic must be a boolean")

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as ReplayTapeV1 }
}

/**
 * Reject a tape set that cannot be matched deterministically.
 *
 * Two tapes for the same actor, purpose and digest but different behaviour
 * would make replay depend on iteration order. Fuzzy-matching them would hide
 * the authoring mistake, so fixture construction fails instead.
 */
export function findAmbiguousTapes(tapes: readonly ReplayTapeV1[]): string[] {
  const byKey = new Map<string, ReplayTapeV1[]>()
  for (const tape of tapes) {
    const key = `${tape.match.actorRef} ${tape.match.purpose} ${tape.match.requestDigest}`
    const bucket = byKey.get(key)
    if (bucket) bucket.push(tape)
    else byKey.set(key, [tape])
  }

  const conflicts: string[] = []
  for (const [key, bucket] of byKey) {
    if (bucket.length < 2) continue
    const shapes = new Set(bucket.map((tape) => JSON.stringify(tape.behavior)))
    // Identical duplicates are fine: a turn that asks the same question twice
    // consumes one tape each. Different answers for one key are not.
    if (shapes.size > 1) conflicts.push(key.split(" ").join(" · "))
  }
  return conflicts
}

// ---- Scenarios --------------------------------------------------------------

/**
 * `canonical` re-plays `AgentEventEnvelope` frames and validates renderers,
 * recovery and permission state. `runtime` runs the real SDK, agent loop, tool
 * pipeline, permissions and persistence, substituting only the model endpoint.
 */
export type ReplayLevel = "canonical" | "runtime"

/** Browsers cannot host `runtime` replay; the scenario declares what it needs. */
export type ReplayPlatform = "browser" | "tauri" | "headless"

/**
 * How complete the capture is.
 *
 * `wire-only` is the honest verdict for an external/ACP agent that does not
 * expose its internal model requests: the protocol and canonical events are
 * captured, the model surface is not. A report must show this rather than
 * presenting a partial capture as a full snapshot.
 */
export type ReplayFidelity = "full" | "wire-only"

export interface ReplayActorV1 {
  actorRef: string
  role: "root" | "child"
  parentActorRef?: string
}

export type ReplayInputStepV1 =
  | { kind: "prompt"; actorRef: string; text: string }
  | { kind: "cancel"; actorRef: string; afterMs?: number }
  | { kind: "resume"; actorRef: string }

export interface ReplayPermissionEntryV1 {
  actorRef: string
  toolName: string
  decision: "allow" | "deny" | "allow-always"
}

export interface ReplayExpectationsV1 {
  /**
   * Fail the run on missing requests, extra requests, unconsumed permission
   * entries, unfinished children or orphaned logs. Off only for a scenario
   * that is deliberately exploratory.
   */
  assertConsumed: boolean
  fidelity: ReplayFidelity
  workspaceManifestRef?: string
  uiSnapshotRef?: string
}

export interface ReplayScenarioV1 {
  schemaVersion: typeof REPLAY_SCENARIO_SCHEMA_VERSION
  scenarioId: string
  title: string
  level: ReplayLevel
  platform: ReplayPlatform
  actors: ReplayActorV1[]
  inputSteps: ReplayInputStepV1[]
  permissionScript: ReplayPermissionEntryV1[]
  workspaceSeedRef?: string
  expectations: ReplayExpectationsV1
}

const REPLAY_LEVELS: readonly string[] = ["canonical", "runtime"]
const REPLAY_PLATFORMS: readonly string[] = ["browser", "tauri", "headless"]
const REPLAY_FIDELITIES: readonly string[] = ["full", "wire-only"]

function validateReplayInputSteps(
  value: unknown,
  actorRefs: ReadonlySet<string>,
  errors: string[]
): void {
  if (!Array.isArray(value)) {
    errors.push("inputSteps must be an array")
    return
  }
  value.forEach((step, index) => {
    const prefix = `inputSteps[${index}]`
    if (!isRecord(step)) {
      errors.push(`${prefix} must be an object`)
      return
    }
    if (!isNonEmptyString(step.actorRef)) {
      errors.push(`${prefix}.actorRef must be a non-empty string`)
    } else if (!actorRefs.has(step.actorRef)) {
      errors.push(`${prefix} names unknown actorRef ${step.actorRef}`)
    }
    switch (step.kind) {
      case "prompt":
        if (!hasOnlyKeys(step, ["kind", "actorRef", "text"])) {
          errors.push(`${prefix} contains unsupported fields`)
        }
        if (typeof step.text !== "string") errors.push(`${prefix}.text must be a string`)
        return
      case "cancel":
        if (!hasOnlyKeys(step, ["kind", "actorRef", "afterMs"])) {
          errors.push(`${prefix} contains unsupported fields`)
        }
        if (
          step.afterMs !== undefined &&
          (typeof step.afterMs !== "number" || !Number.isFinite(step.afterMs) || step.afterMs < 0)
        ) {
          errors.push(`${prefix}.afterMs must be a non-negative number when present`)
        }
        return
      case "resume":
        if (!hasOnlyKeys(step, ["kind", "actorRef"])) {
          errors.push(`${prefix} contains unsupported fields`)
        }
        return
      default:
        errors.push(`${prefix}.kind must be one of prompt|cancel|resume`)
    }
  })
}

function validateReplayPermissionScript(
  value: unknown,
  actorRefs: ReadonlySet<string>,
  errors: string[]
): void {
  if (!Array.isArray(value)) {
    errors.push("permissionScript must be an array")
    return
  }
  value.forEach((entry, index) => {
    const prefix = `permissionScript[${index}]`
    if (!isRecord(entry)) {
      errors.push(`${prefix} must be an object`)
      return
    }
    if (!hasOnlyKeys(entry, ["actorRef", "toolName", "decision"])) {
      errors.push(`${prefix} contains unsupported fields`)
    }
    if (!isNonEmptyString(entry.actorRef)) {
      errors.push(`${prefix}.actorRef must be a non-empty string`)
    } else if (!actorRefs.has(entry.actorRef)) {
      errors.push(`${prefix} names unknown actorRef ${entry.actorRef}`)
    }
    if (!isNonEmptyString(entry.toolName)) {
      errors.push(`${prefix}.toolName must be a non-empty string`)
    }
    if (!["allow", "deny", "allow-always"].includes(String(entry.decision))) {
      errors.push(`${prefix}.decision must be one of allow|deny|allow-always`)
    }
  })
}

export function validateReplayScenario(v: unknown): ValidationResult<ReplayScenarioV1> {
  if (!isRecord(v)) return { ok: false, errors: ["scenario must be an object"] }
  const errors: string[] = []

  if (v.schemaVersion !== REPLAY_SCENARIO_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${REPLAY_SCENARIO_SCHEMA_VERSION}`)
  }
  for (const key of ["scenarioId", "title"] as const) {
    if (!isNonEmptyString(v[key])) errors.push(`${key} must be a non-empty string`)
  }
  if (!REPLAY_LEVELS.includes(v.level as string)) {
    errors.push(`level must be one of ${REPLAY_LEVELS.join("|")}`)
  }
  if (!REPLAY_PLATFORMS.includes(v.platform as string)) {
    errors.push(`platform must be one of ${REPLAY_PLATFORMS.join("|")}`)
  }
  if (v.level === "runtime" && v.platform === "browser") {
    errors.push("runtime replay requires a tauri or headless platform")
  }

  const actorRefs = new Set<string>()
  if (!Array.isArray(v.actors) || v.actors.length === 0) {
    errors.push("actors must be a non-empty array")
  } else {
    for (const actor of v.actors as unknown[]) {
      if (!isRecord(actor) || !isNonEmptyString(actor.actorRef)) {
        errors.push("each actor must have a non-empty actorRef")
        continue
      }
      if (actorRefs.has(actor.actorRef)) errors.push(`duplicate actorRef ${actor.actorRef}`)
      actorRefs.add(actor.actorRef)
      if (actor.role !== "root" && actor.role !== "child") {
        errors.push(`actor ${actor.actorRef} role must be root|child`)
      }
      if (actor.role === "child" && !isNonEmptyString(actor.parentActorRef)) {
        errors.push(`child actor ${actor.actorRef} must name a parentActorRef`)
      }
    }
    for (const actor of v.actors as unknown[]) {
      if (!isRecord(actor)) continue
      const parent = actor.parentActorRef
      if (typeof parent === "string" && !actorRefs.has(parent)) {
        errors.push(`actor ${String(actor.actorRef)} names an unknown parentActorRef ${parent}`)
      }
    }
  }

  validateReplayInputSteps(v.inputSteps, actorRefs, errors)
  validateReplayPermissionScript(v.permissionScript, actorRefs, errors)

  if (!isRecord(v.expectations)) {
    errors.push("expectations must be an object")
  } else {
    if (typeof v.expectations.assertConsumed !== "boolean") {
      errors.push("expectations.assertConsumed must be a boolean")
    }
    if (!REPLAY_FIDELITIES.includes(v.expectations.fidelity as string)) {
      errors.push(`expectations.fidelity must be one of ${REPLAY_FIDELITIES.join("|")}`)
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as ReplayScenarioV1 }
}
