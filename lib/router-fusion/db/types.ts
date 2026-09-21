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
  DelegateApprovalKind,
  DelegateApprovalSummary,
  ExecutionMode,
  RouteDecision,
  RunBudgetState,
  RunStatus,
  TaskKind,
  VerifierProfile,
} from "@cognia/router-fusion"
import type { EncryptedContentEnvelope } from "@/lib/accounts/content-cipher"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

export type { DelegateStepRow, DelegateStepState } from "../runtime/delegate-step-journal"

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
  /**
   * The `.cognia/workspace.json` acceptance profile a delegate run verifies
   * with (`RunRequest.acceptance_profile_id`), NOT the `acceptanceProfile`
   * above: that one names the verifier CLASS the result must reach
   * (`code_fixture`), this one names the project's command that produces the
   * report. Only delegate carries it.
   */
  acceptanceProfileId?: string
  /**
   * How a delegate run delivers its verified change. `patch_only` (the
   * default, and what every caller asks for today) leaves the user's checkout
   * untouched and hands back a patch artifact.
   *
   * `workspace_updated` is DORMANT in B4. The graph implements it — a person
   * approves exactly that patch on exactly that base, and the apply is a
   * compare-and-swap that refuses a workspace that moved (DEL-04) — and the
   * orchestrator passes it through, but no surface sets this field yet. The
   * review pane (WP-D5) is where it is meant to be chosen. Until then the
   * value is unreachable by design rather than by omission, and
   * `orchestrator-host.test.ts` pins both halves: the default, and that a run
   * carrying `workspace_updated` really reaches the approval-gated apply.
   */
  delegateDelivery?: "patch_only" | "workspace_updated"
  /**
   * The app project the run belongs to (`RunRequest.workspace_id` for a Run
   * API run, the conversation's project for a chat turn).
   *
   * A delegate run needs it: the acceptance profile and its approval live on
   * the project, and the host ports resolve both from this id. Without it a
   * delegate run cannot verify anything, so the router does not offer delegate
   * for a request that names no project and the orchestrator refuses one that
   * reached it anyway.
   */
  projectId?: string
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
  /**
   * When the run was parked (`waiting_for_input` / `waiting_for_approval`), so
   * the resume can give back the wall time a person spent deciding.
   *
   * The deadline is a bound on the WORK a run may do (D29), and an approval
   * wait is not work: a run parked for an hour would otherwise replay straight
   * into `DEADLINE_EXCEEDED`, because `performDurableCall` checks the deadline
   * before it replays a committed step. `resumeRun` moves `deadlineAt` forward
   * by exactly `now - pausedAt` and clears this, so the remaining work budget
   * is the same as the moment the run parked — never more.
   */
  pausedAt?: number | null
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

export type FusionApprovalStatus = "pending" | "approved" | "denied"

/**
 * One thing a delegate run asked a person to allow, bound to a digest
 * (ADR-0188 B4, API-08, D21).
 *
 * The digest is `sha256(kind + canonical args + revision)`
 * (`delegateApprovalDigest`), and the row's `id` is a UUID derived from
 * `runId` and that digest, so the id a surface presents when it approves IS
 * the digest: approving different arguments, or the same arguments against a
 * workspace that moved, is a different id and is refused
 * (`APPROVAL_MISMATCH`) without touching this row.
 *
 * This is the per-RUN permission. The long-lived per-project grant — "this
 * acceptance command may run in this project" — is not here: it lives on the
 * workspace trust row (`lib/project-environment/workspace-config-trust.ts`,
 * WP-D2) and is never copied into the fusion database.
 */
export interface FusionAcceptanceApprovalRow {
  /** `uuidFromName(<runId>\u0000<requestDigest>)`: deterministic, so asking twice is one row. */
  id: string
  runId: string
  /** The project the run belongs to; null for a run created without one. */
  projectId: string | null
  kind: DelegateApprovalKind
  /** sha256 over the kind, the canonical arguments and the revision (API-08). */
  requestDigest: string
  /** The workspace revision the digest covers. */
  revision: string
  /** The graph step that asked, so a replay finds its own request. */
  logicalStepId: string
  status: FusionApprovalStatus
  /** Paths, file counts and the patch's hash — never file content. */
  summary: DelegateApprovalSummary
  /** Who caused the request. Never who decided it: that is only ever a person. */
  requestedBy: "worker" | "lead" | "runtime"
  /** The machine reason a denial carried, if any; free text is never stored. */
  decisionReason: string | null
  decidedAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * The combined patch a delegate run produced, against the revision it started
 * from (ADR-0188 B4, DEL-04).
 *
 * The patch itself is an artifact (encrypted, on the artifact content window);
 * this row is its index: what it touches, what revision it applies to, what
 * revision it produced, and whether an approved apply has landed it in the
 * user's workspace. The review pane reads it, and an apply that replays finds
 * `appliedRevision` already set instead of writing twice.
 */
export interface FusionPatchSetRow {
  /** `uuidFromName(<runId>\u0000<patchSha256>)`: the same patch of the same run is one row. */
  patchSetId: string
  runId: string
  /** The revision the patch applies to; an apply is a compare-and-swap on it. */
  baseRevision: string
  /** The staged revision the patch produces, once the run staged it. */
  resultRevision: string | null
  /** sha256 over the patch's canonical JSON (`delegatePatchSha256`). */
  patchSha256: string
  /** The artifact holding the patch document. */
  patchArtifactId: string
  fileCount: number
  /** The paths the patch touches, so a list needs no artifact read. */
  paths: string[]
  /** `patch_only`, or the delivery the run was asked for. */
  delivery: "patch_only" | "workspace_updated"
  /** The user's workspace revision after an approved apply; null until then. */
  appliedRevision: string | null
  appliedAt: number | null
  createdAt: number
  /** The artifact content window: a patch is model-derived content. */
  expiresAt: number
}

/**
 * One routed decision as the learned router's training set sees it (ADR-0188
 * D12/D28, B6 EVAL-01/EVAL-03).
 *
 * Derived, never authoritative: `lib/router-fusion/eval/sample-collector.ts`
 * builds a row from the run, its route decision and its ledger, so a lost
 * sample is rebuilt by collecting again. It carries NUMBERS ONLY — the encoded
 * feature vector, the action, the money and the label — and never prompt or
 * answer text, which is what makes an export safe to hand to a model trainer.
 *
 * `accepted` is the independent acceptance label: a run is accepted only when
 * it succeeded AND its result claimed `quality_status: "accepted"`. Degraded,
 * unknown, failed, cancelled, expired and refused runs are all `false`, and
 * their cost still counts (EVAL-03).
 */
export interface FusionRoutingSampleRow {
  /** `uuidFromName(<runId> <decisionId>)`: collecting the same run twice is one row. */
  sampleId: string
  runId: string
  /** The independence unit of the split: the session, or the run when there is none (EVAL-01). */
  groupId: string
  /** The action that actually ran. */
  actionId: string
  actionHash: string
  mode: ExecutionMode
  ruleId: string | null
  /**
   * The action the deterministic RULES policy would have chosen for this
   * request, which is what a replay comparison evaluates the baseline arm by.
   *
   * Equal to `actionId` for every sample the rules router produced — which is
   * every recorded sample today, because nothing else routes. It is a separate
   * field because a randomized logging policy (an exploration arm) would make
   * the two differ, and a replay estimate is only identifiable when it can tell
   * them apart.
   */
  baselineActionId: string
  /** The encoding this vector was produced by; a predictor refuses any other. */
  featuresVersion: string
  /** Feature values in `featureNames` order, as `encodeRoutingFeatures` produced them. */
  features: number[]
  /**
   * The router's probability of having selected this action, in (0, 1]. The
   * rules router is deterministic, so the chosen action has propensity 1.0;
   * a stochastic policy records the probability it drew with, which is what
   * an inverse-propensity estimate needs.
   */
  propensity: number
  /** Where the sample came from; a live report never mixes in a simulated row. */
  origin: "recorded" | "simulated"
  /** Actual spend of the run, integer microusd. Every run's cost is in the numerator. */
  costMicrousd: number
  /** `actual` when the bill is settled; an estimate is reported, never hidden. */
  costStatus: FusionCostStatus
  accepted: boolean
  /** The result's own verdict, kept so a report can say WHY a run was not accepted. */
  qualityStatus: "accepted" | "degraded" | "unknown" | null
  runStatus: RunStatus
  /** When the route was decided; the split's time axis (EVAL-01). */
  decidedAt: number
  createdAt: number
  /** The routing-sample window; `lib/router-fusion/db/retention.ts` reaps past it. */
  expiresAt: number
}

/**
 * A sealed learned-router manifest (`@cognia/eval-core` `routing/manifest.ts`).
 *
 * Exactly one row may be `active: 1`, and it is always a published manifest:
 * activation is the promotion, and rollback is the same pointer moved back to
 * `previousManifestSha256`. The manifest document is stored verbatim so its
 * sha256 seal can be re-verified on load — a row whose body no longer hashes to
 * its key is refused rather than used.
 */
export interface FusionPredictorManifestRow {
  /** The manifest's own sha256 seal; the primary key. */
  manifestSha256: string
  kind: "training" | "published"
  /** 1 for the one active published manifest, 0 otherwise (IndexedDB indexes no booleans). */
  active: 0 | 1
  featuresVersion: string
  /** The manifest document, exactly as sealed. */
  manifest: Record<string, unknown>
  /** The published manifest this one replaced, so a rollback knows where to go. */
  previousManifestSha256: string | null
  /** The promotion gate's verdict that allowed activation; null for a training row. */
  gateVerdict: "pass" | "fail" | "inconclusive" | null
  /** Why the gate said what it said, for the UI. */
  gateReasons: string[]
  /** Report label: a manifest trained on simulated samples can never claim a saving (EVAL-04). */
  label: "live" | "simulated"
  activatedAt: number | null
  deactivatedAt: number | null
  createdAt: number
}

/**
 * What the learned router WOULD have chosen for a sample, recorded beside the
 * rules decision that actually ran (ADR-0188 D28).
 *
 * A shadow decision never acts: nothing reads it on a routing path, and the
 * only consumers are the report and the UI. It exists so a candidate predictor
 * can be watched on real traffic before anybody promotes it.
 */
export interface FusionShadowDecisionRow {
  /** `uuidFromName(<sampleId> <manifestSha256>)`: one shadow per sample per predictor. */
  shadowId: string
  sampleId: string
  runId: string
  /** The predictor that produced it. */
  manifestSha256: string
  predictorVersion: string
  /** The action the rules router actually ran. */
  actualActionId: string
  /** The action the predictor would have picked, or null when it had no calibrated head. */
  shadowActionId: string | null
  /** Calibrated p_pass of the shadow choice; null when there was none. */
  shadowPPass: number | null
  /** Calibrated p_pass the predictor gave the action that actually ran; null when it had no head. */
  actualPPass: number | null
  /** True when the predictor would have run the same action. */
  agreed: boolean
  /** False when the sample's features fall outside the head's training range. */
  inDistribution: boolean
  createdAt: number
  /** The routing-sample window: a shadow decision is reaped with the samples it annotates. */
  expiresAt: number
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
