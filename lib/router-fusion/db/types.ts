/**
 * Row shapes of the Router + Fusion database (ADR-0188 D39).
 *
 * Money is integer microusd everywhere. Model output and prompt text never sit
 * in these rows directly: content lives only in `fusionArtifacts`, encrypted
 * with the account content cipher, and everything else references it by id.
 */

import type {
  CompiledFusionConfig,
  DataClass,
  ExecutionMode,
  RouteDecision,
  RunBudgetState,
  RunStatus,
  TaskKind,
  VerifierProfile,
} from "@cognia/router-fusion"
import type { EncryptedContentEnvelope } from "@/lib/accounts/content-cipher"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

/**
 * Which entry point a fusion run serves.
 *
 * `gateway` is a `/v1/runs` run — work the Run API asked Router + Fusion to
 * DO. `gatewayPassthrough` is the other gateway lane: a plain chat-completions
 * proxy request that the ledger only measures (D13). They are separate because
 * the second one is not a task anybody is waiting to read about — it is one
 * upstream call with a bill — so it never becomes a row in the cockpit.
 */
export type FusionRunOrigin =
  "chat" | "gateway" | "gatewayPassthrough" | "agent" | "workflow" | "utility" | "companion"

export type FusionCostStatus = "actual" | "estimated" | "pending"

export interface FusionAccountRow {
  id: "tenant"
  /** Σ tenant holds of runs that are not terminal, plus holds pinned by uncertain calls. */
  activeHoldsMicrousd: number
  /** Deployments whose data permission was revoked, by id, with the revocation time. */
  revokedDeployments: Record<string, number>
  updatedAt: number
}

export interface FusionRunError {
  code: string
  message: string
}

export interface FusionRunRow {
  runId: string
  sessionId: string | null
  surface: RouterFusionSurface
  origin: FusionRunOrigin
  mode: ExecutionMode
  actionId: string
  actionHash: string
  ruleId: string | null
  decisionId: string
  configDigest: string
  status: RunStatus
  budget: RunBudgetState
  budgetMode: "tracked" | "strict"
  /** Single-run grant a human approved over the tenant limit (D35); never reusable. */
  grantMicrousd: number
  /** Role → pinned deployment id for the run's lifetime. */
  roleDeployments: Record<string, string>
  /** Absolute; resume never moves it (REC-05). */
  deadlineAt: number
  leaseOwner: string | null
  leaseExpiresAt: number
  /** Incremented on every lease takeover; stale writers are fenced (REC-02). */
  fencingToken: number
  lastSeq: number
  costStatus: FusionCostStatus
  /**
   * The run's own input, stored like every other content: an encrypted
   * artifact. A worker that picks the run up after a reload has nothing else to
   * read it from — the request that started it is long gone.
   */
  inputArtifactId: string | null
  /** The answer's own artifact (text or JSON, as the result delivered it). */
  resultArtifactId: string | null
  /**
   * The rest of the `RunResult` — mode executed, quality status, verification
   * report, warnings — as a JSON artifact, so `GET /v1/runs/{id}` can answer
   * with the whole result without the row holding content. Absent on runs
   * sealed before B3 and on runs that ended without a result.
   */
  resultRecordArtifactId?: string | null
  error: FusionRunError | null
  /** Session transcript version the run was created against (API-03). */
  sessionVersion: number | null
  /**
   * The gateway API key that created this run, or null for a run the app itself
   * started. Only the actor that created a run may read, cancel or give feedback
   * on it (D8/D24, AUTH-03): another key gets the same answer as for a run that
   * does not exist.
   */
  actorKeyId: string | null
  /**
   * That key's display name, captured when the run was created.
   *
   * A copy rather than a lookup on purpose: the key can be renamed or revoked
   * while the run is still in the list, and a run's history should say who
   * asked for it at the time, not who holds that id now.
   */
  actorKeyName: string | null
  /**
   * What to call this run on a surface that has nothing else to show — the
   * cockpit row for a run no local engine started (`kind: "fusion"`). Null for
   * every run whose own engine already owns a title.
   */
  title: string | null
  /**
   * The run writes its own conversation (DESIGN §12.1): its input is appended
   * to the session when the run is created, its answer when it succeeds, and a
   * failure marker — never an invented answer — when it does not. A chat turn
   * leaves this unset: the chat path writes its own transcript.
   */
  writesSessionTranscript?: boolean
  /**
   * A chat fusion turn: the chat path wrote the person's message itself, so
   * the run writes only its verified answer — carrying the run card's summary —
   * and nothing when it does not succeed (the chat shows that failure).
   */
  writesSessionAnswer?: boolean
  /** The phase the run's graph last announced, for the snapshot (`RunSnapshot.phase`). */
  phase?: string
  /** The task label the route was decided for; the acceptance claim reads it (PROF-01). */
  task?: TaskKind
  /** The profile the result must reach, after the task minimum raised it (D14). */
  acceptanceProfile?: VerifierProfile
  /** The data class the run was routed under; every call is re-checked against it (AUTH-07). */
  dataClass?: DataClass
  /**
   * The workspace a panel's read-only file tool may read: the project the
   * person at this device chose for the conversation. A Run API run has none —
   * a gateway key is not authorized for a workspace until delegate (B4).
   */
  workspaceRoot?: string
  /**
   * Who executes the run's graph. `"orchestrator"`: `executeFusionRun` does,
   * from the run's stored input, so any worker can take the run over once its
   * lease lapses and carry on from the ledger (REC-03). Unset: the window or
   * sidecar that started it owns it, and a lapsed lease means it is gone.
   */
  driver?: FusionRunDriver
  createdAt: number
  updatedAt: number
  terminalAt: number | null
}

export type FusionRunDriver = "orchestrator"

export interface FusionRunEventRow {
  runId: string
  seq: number
  type: string
  /** Never contains model output or prompt text; artifacts are referenced by id. */
  payload: Record<string, unknown>
  createdAt: number
}

export interface FusionSessionLockRow {
  sessionId: string
  runId: string
  acquiredAt: number
}

export interface FusionRouteDecisionRow {
  decisionId: string
  runId: string
  decision: RouteDecision
  createdAt: number
}

export type FusionReservationState = "held" | "settled" | "released" | "uncertain" | "converted"

export interface FusionReservationRow {
  reservationId: string
  runId: string
  kind: "call" | "stage"
  amountMicrousd: number
  state: FusionReservationState
  /** Stage reservations carry the workflow's stage id. */
  stageId: string | null
  attemptId: string | null
  createdAt: number
  updatedAt: number
}

export type FusionAttemptState =
  "PREPARED" | "DISPATCHED" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "RECONCILED" | "ABANDONED"

export interface FusionCallAttemptRow {
  attemptId: string
  runId: string
  logicalStepId: string
  attemptNo: number
  role: string
  deploymentId: string
  state: FusionAttemptState
  reservationId: string
  requestHash: string
  fencingToken: number
  /** Committed output for replay (REC-01), stored as an encrypted artifact. */
  resultArtifactId: string | null
  resultFinishReason: "stop" | "length" | "tool_calls" | null
  providerRequestId: string | null
  actualMicrousd: number | null
  costStatus: FusionCostStatus | null
  errorClass: string | null
  unknownReason: string | null
  usage: Record<string, unknown> | null
  createdAt: number
  dispatchedAt: number | null
  settledAt: number | null
}

export type FusionLedgerKind =
  | "run_hold"
  | "call_hold"
  | "stage_hold"
  | "stage_convert"
  | "settle"
  | "overspend"
  | "release"
  | "abandon"
  | "unknown"
  | "terminal_release"
  | "grant"

export interface FusionLedgerRow {
  /** Unique per effect: replaying the same effect is a no-op (BUD-03). */
  dedupeKey: string
  runId: string
  attemptId: string | null
  kind: FusionLedgerKind
  amountMicrousd: number
  createdAt: number
}

export interface FusionArtifactRow {
  artifactId: string
  runId: string | null
  namespace: string
  mediaType: string
  contentSha256: string
  sizeBytes: number
  /** Plaintext only for a database that is not account-scoped (legacy/test). */
  content: string | null
  encryptedContent: EncryptedContentEnvelope | null
  createdAt: number
  /** Content retention (7 days by default); the row is reaped after it. */
  expiresAt: number
}

/**
 * One `Idempotency-Key` a caller used, and the run it produced (API-02).
 *
 * The same key with the same body replays that run; the same key with a
 * different body is a conflict, never a second run. Keys are scoped to the
 * actor and the endpoint, so two keys cannot collide across callers.
 */
export interface FusionIdempotencyRow {
  /** `<actorKeyId>\u0000<endpoint>\u0000<key>`. */
  scopedKey: string
  requestHash: string
  runId: string
  createdAt: number
  /** Keys expire; after that the same key starts a new run. */
  expiresAt: number
}

/** A caller's verdict on a finished run (`feedback:write`). */
export interface FusionFeedbackRow {
  feedbackId: string
  runId: string
  actorKeyId: string | null
  rating: "up" | "down"
  /** Free text, stored like every other content: as an encrypted artifact. */
  commentArtifactId: string | null
  createdAt: number
}

/**
 * The Run API's name for a conversation (ADR-0188 D24).
 *
 * The contracts name a session with a UUID; the app's sessions have ids of
 * their own. The API id is minted when a key opens a conversation and belongs
 * to that key: another key resolving it gets "not found".
 */
export interface FusionApiSessionRow {
  apiSessionId: string
  sessionId: string
  actorKeyId: string | null
  createdAt: number
}

/**
 * One tool operation a run's model requested and the runtime decided
 * (DESIGN §11). Keyed by what makes it the same operation — the step, the
 * policy, the tool, its canonical arguments and the content it read — so a
 * repeat returns this receipt and a change of arguments or content is a new
 * operation, never a reused grant.
 */
export interface FusionToolOperationRow {
  operationId: string
  runId: string
  logicalStepId: string
  policyId: string
  toolName: string
  argsHash: string
  status: "succeeded" | "refused" | "failed"
  refusalCode: string | null
  /** Content-pinned references the operation produced. */
  evidence: Array<{
    artifact_id: string
    content_sha256: string
    locator: string
    retrieved_at: string
  }>
  /** What the model was shown, as an encrypted artifact. */
  summaryArtifactId: string | null
  /** Refused network hops (host, reason, hop) — the SSRF audit trail (SAFE-01). */
  audit?: Array<{ host: string; reason: string; hop: number }>
  createdAt: number
}

export interface FusionConfigSnapshotRow {
  digest: string
  config: CompiledFusionConfig
  createdAt: number
}

export type FusionOutboxKind =
  | "usage_row"
  | "execution_run_milestone"
  /**
   * Create and advance the account-database execution run for a fusion run no
   * local engine started (ADR-0188). `execution_run_milestone` annotates a run
   * that already exists; this one is the run.
   */
  | "execution_run_projection"
  /**
   * Append a run's input or answer to its session, or mark its input as the
   * input of a run that failed. The content is read back from the run's
   * artifacts when the effect is applied; the row carries only ids.
   */
  | "session_message"

export interface FusionOutboxRow {
  /** Idempotent id derived from what the effect is about, never random. */
  effectId: string
  runId: string
  kind: FusionOutboxKind
  payload: Record<string, unknown>
  status: "pending" | "applied" | "skipped"
  attempts: number
  lastError: string | null
  createdAt: number
  appliedAt: number | null
}
