/**
 * HostState — deterministic shared-session state above Agent RPC v2.
 *
 * The protocol coordinates clients; it does not replace runtime commands or
 * AgentEventEnvelope. Wire guards are deliberately closed so credentials and
 * device-local fields cannot hitch a ride in otherwise valid actions.
 *
 * **A submitted intent is not an accomplished fact.** The Host records what a
 * client asked for as an {@link HostStateOperation}, and only a runtime-confirmed
 * event moves the turn, the decisions, or the transcript. Collapsing the two —
 * writing the finished state at submit time — is what made a `turn.abort` whose
 * dispatch failed read as a stopped run, and made an `approval.respond` that
 * never reached the runtime erase a decision the run was still blocked on.
 * Every state here therefore belongs to exactly one of two layers:
 *
 * - **Operations** record the fate of a request: accepted → dispatching →
 *   acknowledged, or failed / expired / superseded. They never assert an effect.
 * - **Axes** (`conversation`, `runtime`, `turn`) and `decisions` record what the
 *   Host observed. Only {@link reduceHostStateMutation} — fed by the Host from
 *   runtime events — may advance them.
 *
 * {@link reduceHostStateIntent} is the client's optimistic view. It may show a
 * turn *stopping* and a decision *responding*; it may never show either one
 * finished.
 */

import {
  hasOnlyKeys,
  isNonEmptyString as nonEmptyString,
  isNonNegativeInteger as nonNegativeInteger,
  isRecord,
} from "./ref-safety"

export const HOST_STATE_SESSION_CHANNEL_PREFIX = "cognia://target/" as const

export type HostStateActionOutcome = "applied" | "duplicate" | "rejected" | "conflicted"

/**
 * Does the conversation exist, and in what form?
 *
 * Separate from {@link HostStateTurnStatus} because a turn ending is not a
 * conversation ending: the runtime's `session_ended` closes one turn, and a
 * client that treats it as the end of the conversation locks a composer the
 * user can legitimately keep typing into. Only `tombstoned` and `missing`
 * permanently forbid control.
 */
export type HostStateConversationStatus = "present" | "archived" | "tombstoned" | "missing"

/**
 * Health of the agent runtime backing this session.
 *
 * `unavailable` is what a `sidecar_exited` produces: the in-flight decisions are
 * lost and the current turn cannot continue, but the conversation is intact and
 * resumable — which is why this is its own axis rather than a turn state.
 */
export type HostStateRuntimeStatus = "ready" | "restarting" | "unavailable"

/**
 * Where the current turn is.
 *
 * `stopping` exists because an abort is a request, not an event: the turn is
 * still running until the runtime says otherwise, and showing it as stopped
 * lets a client re-enable a composer against a run that is still producing.
 * `retryable-error` and `fatal-error` are split so a client knows whether
 * offering "try again" is honest. `aborted` is split from `completed` for the
 * same reason: a turn the user (or a dying runtime) cut short did not produce
 * the answer that was asked for, and reporting it as a clean finish is a lie
 * every replica then repeats. It is NOT derivable from the `turn.abort`
 * operation — a desktop Stop and a killed sidecar interrupt the turn without
 * any client ever submitting one.
 */
export type HostStateTurnStatus =
  | "idle"
  | "queued"
  | "running"
  | "awaiting-decision"
  | "stopping"
  | "completed"
  | "aborted"
  | "retryable-error"
  | "fatal-error"

/** Turn states from which no further runtime event is expected. */
export const TERMINAL_TURN_STATUSES: readonly HostStateTurnStatus[] = [
  "completed",
  "aborted",
  "retryable-error",
  "fatal-error",
]

export interface HostStateAttachmentRef {
  name: string
  mediaType: string
  size: number
  hash?: string
  /**
   * An opaque handle to bytes the Host already holds, minted by
   * `session_attachment_upload_commit` (`cognia-upload:<uploadId>`).
   *
   * Optional because the same shape describes a draft's attachment list, where
   * the bytes are still only on the device — a draft is a reminder, not a
   * transfer. It becomes load-bearing on `message.enqueue`: without it the Host
   * has a filename and a size and no way to reach the file, which is exactly
   * how remote attachments used to be dropped on the floor while the text went
   * through. Never a path or a URL: a client that could name a location would
   * be choosing what the Host reads.
   */
  ref?: string
}

export type AllowedHostStateIntent =
  | { kind: "session.create"; title?: string }
  | { kind: "session.rename"; title: string }
  | { kind: "session.archive"; archived: boolean }
  | { kind: "draft.replace"; text: string; attachments: HostStateAttachmentRef[] }
  | {
      kind: "message.enqueue"
      messageId: string
      text: string
      attachments: HostStateAttachmentRef[]
    }
  | { kind: "turn.steer"; text: string }
  | { kind: "turn.followup"; text: string }
  | { kind: "turn.abort" }
  | {
      kind: "approval.respond"
      requestId: string
      decision: "allow" | "allow_always" | "deny"
    }
  | { kind: "elicitation.respond"; requestId: string; response: HostStateJsonValue }
  | { kind: "transcript.edit"; messageId: string; text: string }
  | { kind: "transcript.truncate"; afterMessageId?: string }
  | { kind: "session.import"; envelope: HostStateJsonValue }

export type HostStateIntentKind = AllowedHostStateIntent["kind"]

const INTENT_KINDS: readonly HostStateIntentKind[] = [
  "session.create",
  "session.rename",
  "session.archive",
  "draft.replace",
  "message.enqueue",
  "turn.steer",
  "turn.followup",
  "turn.abort",
  "approval.respond",
  "elicitation.respond",
  "transcript.edit",
  "transcript.truncate",
  "session.import",
]

/**
 * Intents whose effect belongs to the runtime, not to the Host's own bookkeeping.
 *
 * Exported so the client and the Host agree on which submissions produce an
 * {@link HostStateOperation} to track. Everything outside this set — renaming,
 * archiving, replacing a draft — is settled the moment the Host writes it, and
 * carrying an operation for it would leave a row that nothing can ever
 * acknowledge.
 */
export function intentRequiresRuntimeDispatch(kind: HostStateIntentKind): boolean {
  switch (kind) {
    case "message.enqueue":
    case "turn.steer":
    case "turn.followup":
    case "turn.abort":
    case "approval.respond":
    case "elicitation.respond":
      return true
    case "session.create":
    case "session.rename":
    case "session.archive":
    case "draft.replace":
    case "transcript.edit":
    case "transcript.truncate":
    case "session.import":
      return false
    default: {
      const exhaustive: never = kind
      throw new Error(`host_state_unknown_intent:${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * SecurityStore capability required to submit one HostState intent.
 *
 * `host_state_submit` declares a single command-level capability
 * (`workspace.write`) in `protocol/companion-commands.json`, but it carries a
 * *batch* of intents whose real authorization differs per intent: replacing a
 * draft is remote control, creating a session starts a runtime, and truncating
 * a transcript destroys durable user data. A single command-level gate can only
 * decide the batch as a whole, so this table is the per-intent authority and
 * the Host applies it action by action.
 *
 * The four capability names are the ones the SecurityStore actually issues —
 * see `GrantKind::capabilities` in `src-tauri/src/companion_api/device_grants.rs`:
 * - `host.observe` — held by every paired device; read-only.
 * - `workspace.write` — the **Remote Control** grant (desktop paired-devices
 *   toggle / `cognia-server devices grant --control`).
 * - `process.spawn` — the separate **Agent Control** grant.
 * - `host.admin` — owner only.
 *
 * `agent.run` is deliberately absent: `insert_default_grants` gives it to every
 * freshly-paired member device, so keying "may drive a session" off it would let
 * an un-granted phone send messages and answer approval prompts.
 */
export type HostStateIntentCapability =
  "host.observe" | "workspace.write" | "process.spawn" | "host.admin"

/**
 * The capability `intent` requires. Exhaustive by construction: a new member of
 * {@link AllowedHostStateIntent} fails to compile here until someone decides
 * what it costs, rather than defaulting into the cheapest bucket.
 */
export function hostStateIntentCapability(
  intent: AllowedHostStateIntent
): HostStateIntentCapability {
  return hostStateIntentKindCapability(intent.kind)
}

/**
 * The same table keyed by kind alone, for the negotiation direction: a client
 * asks what it is allowed to do *before* it has an intent to submit, and the
 * Host answers by filtering {@link HOST_STATE_INTENT_KINDS} through this.
 *
 * One table, two directions. A second hand-maintained list of "actions a
 * controller may take" would drift from the one that actually authorizes, and
 * the drift would show up as a composer offering a button that always 403s.
 */
export function hostStateIntentKindCapability(
  kind: HostStateIntentKind
): HostStateIntentCapability {
  switch (kind) {
    // Steering work the Host already chose to run, plus the session metadata
    // and draft that ride alongside it. The Remote Control grant.
    case "session.rename":
    case "session.archive":
    case "draft.replace":
    case "message.enqueue":
    case "turn.steer":
    case "turn.followup":
    case "turn.abort":
    case "approval.respond":
    case "elicitation.respond":
      return "workspace.write"
    // Creating a session starts a runtime — the same escalation that keeps
    // `spawn_external_agent` out of the remote-control grant.
    case "session.create":
      return "process.spawn"
    // Destructive rewrites of durable user data: an edit or truncate discards
    // transcript the owner may never be able to recover, and an import writes a
    // whole conversation the Host never observed.
    case "transcript.edit":
    case "transcript.truncate":
    case "session.import":
      return "host.admin"
    default: {
      const exhaustive: never = kind
      throw new Error(`host_state_unknown_intent:${JSON.stringify(exhaustive)}`)
    }
  }
}

/** Every intent kind, in submission order. */
export const HOST_STATE_INTENT_KINDS: readonly HostStateIntentKind[] = INTENT_KINDS

/**
 * Intents that only make sense from the device currently *driving* the session,
 * as opposed to one that merely holds the grant.
 *
 * Each of these answers something the runtime is holding open right now: which
 * decision, which in-flight turn, which prompt. A device that is not the
 * effective controller either cannot see that state (its event stream is not
 * caught up) or is not the one the Host is routing it to — and acting on a
 * stale view of "what is the run waiting for" is how a second phone answers a
 * prompt the first one is already looking at, or aborts a turn that started
 * after it last heard anything.
 *
 * The rest are **safe**: a draft, a queued message, a follow-up all describe
 * work to do next rather than work in flight, so the Host accepts them from any
 * granted device and lets the queue decide when they run.
 */
export function hostStateIntentRequiresLiveControl(kind: HostStateIntentKind): boolean {
  switch (kind) {
    case "turn.steer":
    case "turn.abort":
    case "approval.respond":
    case "elicitation.respond":
      return true
    case "session.create":
    case "session.rename":
    case "session.archive":
    case "draft.replace":
    case "message.enqueue":
    case "turn.followup":
    case "transcript.edit":
    case "transcript.truncate":
    case "session.import":
      return false
    default: {
      const exhaustive: never = kind
      throw new Error(`host_state_unknown_intent:${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * The intent kinds `grants` permits, in {@link HOST_STATE_INTENT_KINDS} order.
 *
 * This is the per-session capability answer `session_attach` reports: it tells
 * a client which composer actions exist for it on this Host, so an observer
 * renders a read-only view instead of a composer whose every button fails, and
 * a controller without Agent Control does not offer "new session".
 *
 * Fail-closed like {@link callerMaySubmitHostStateIntent}: no grants, no
 * actions.
 */
export function permittedHostStateIntentKinds(grants: readonly string[]): HostStateIntentKind[] {
  return HOST_STATE_INTENT_KINDS.filter((kind) =>
    grants.includes(hostStateIntentKindCapability(kind))
  )
}

/**
 * Server-verified identity of the caller behind a `host_state_submit`.
 *
 * Both fields are injected by the Rust RPC layer from the DPoP-verified JWT and
 * the SecurityStore (`rpc/host_state.rs::bind_authority`), overwriting anything
 * the client sent, so neither can be self-asserted. They travel beside the
 * protocol body rather than inside it — {@link HostStateSubmitRequest} stays a
 * closed wire shape that a client can construct in full.
 */
export interface HostStateSubmitCaller {
  deviceId: string
  /** Capabilities the device holds right now. Empty denies every intent. */
  grants: readonly string[]
}

/**
 * Whether `caller` may submit `intent`. Fail-closed: an empty or absent grant
 * list denies everything, which is what an unreadable SecurityStore produces.
 */
export function callerMaySubmitHostStateIntent(
  caller: HostStateSubmitCaller,
  intent: AllowedHostStateIntent
): boolean {
  return caller.grants.includes(hostStateIntentCapability(intent))
}

export interface HostStateAction {
  channel: string
  accountId: string
  runtimeTargetId: string
  hostId: string
  hostGeneration: number
  sessionId?: string
  clientId: string
  clientSeq: number
  actionId: string
  baseRevision?: number
  createdAt: number
  action: AllowedHostStateIntent
}

export interface HostStateQueuedMessage {
  actionId: string
  messageId: string
  text: string
  attachments: HostStateAttachmentRef[]
  clientId: string
}

/**
 * Fate of one submitted intent, tracked independently of its effect.
 *
 * - `accepted` — durably recorded, not yet handed to the runtime.
 * - `dispatching` — handed over, no acknowledgement yet.
 * - `acknowledged` — the runtime confirmed it. The effect (if any) arrives as a
 *   separate mutation; this only says the request landed.
 * - `failed` — dispatch threw, or the runtime refused it. `errorCode` says why.
 * - `expired` — the turn or generation it belonged to ended first, so no
 *   acknowledgement can ever arrive.
 * - `superseded` — a later intent replaced it before it was dispatched.
 *
 * The three terminal-without-effect states are distinct because a client must
 * offer different next steps: retry a `failed`, refresh after an `expired`, and
 * say nothing at all about a `superseded`.
 */
export type HostStateOperationStatus =
  "accepted" | "dispatching" | "acknowledged" | "failed" | "expired" | "superseded"

/** Operation states from which no further transition is expected. */
export const TERMINAL_OPERATION_STATUSES: readonly HostStateOperationStatus[] = [
  "acknowledged",
  "failed",
  "expired",
  "superseded",
]

export interface HostStateOperation {
  actionId: string
  kind: HostStateIntentKind
  status: HostStateOperationStatus
  clientId: string
  createdAt: number
  updatedAt: number
  /** Set on `failed`, `expired` and `superseded`; absent otherwise. */
  errorCode?: string
  /** Runtime handle, once dispatched. Correlates an acknowledgement back. */
  correlationId?: string
  /**
   * The decision this operation answers, for `approval.respond` and
   * `elicitation.respond`.
   *
   * It is what lets the reducer mark exactly one decision `responding` when the
   * operation is accepted, and — just as importantly — put it back to `pending`
   * when the operation fails, so a second client can still answer instead of
   * staring at a prompt permanently owned by a request that never landed.
   */
  targetRequestId?: string
}

/**
 * What kind of answer a blocked run is waiting for.
 *
 * `locked-computer-use` has **no producer yet**: host computer-use consent
 * still runs through the automation ConsentBroker
 * (`automation_consent_respond`), which is a separate plane from the canonical
 * event stream this state is projected from. The member exists so the decision
 * list is the one place a client looks for "what is this run waiting on", and
 * so the shape does not have to change when that plane is folded in. Until it
 * is, a Host never emits one — pinned by
 * `no runtime event produces a locked-computer-use decision yet`.
 */
export type HostStateDecisionKind = "tool-approval" | "elicitation" | "locked-computer-use"

/**
 * - `pending` — nobody is answering it.
 * - `responding` — one client's answer is in flight. Owned by
 *   `respondingActionId`; a second client is told `conflicted` rather than
 *   silently overwriting the first answer.
 * - `resolved` — the runtime confirmed an answer.
 * - `expired` — the request outlived its usefulness (generation change, session
 *   deleted). Nothing is coming.
 * - `interrupted` — the turn or the runtime went away while it was open. The
 *   distinction from `expired` matters: interrupted work is resumable.
 */
export type HostStateDecisionStatus =
  "pending" | "responding" | "resolved" | "expired" | "interrupted"

/** Decision states that still block the turn. */
export const OPEN_DECISION_STATUSES: readonly HostStateDecisionStatus[] = ["pending", "responding"]

export interface HostStateDecision {
  requestId: string
  kind: HostStateDecisionKind
  status: HostStateDecisionStatus
  label?: string
  requestedAt: number
  /**
   * The subagent that raised it, when the request did not come from the main
   * loop. Displayed as provenance; the answer still goes back to the real
   * ephemeral request, not to the subagent.
   */
  origin?: { subagentId: string; label?: string }
  /** The action currently answering it. Present only while `responding`. */
  respondingActionId?: string
  /**
   * True when the request is too large to project to a remote client. Such a
   * decision is displayed as Host-only rather than truncated, because approving
   * a summary of a tool call is not approving the tool call.
   *
   * **Nothing sets this yet** — the size ceiling that would decide it lives with
   * the decision surface, not with the state model. The Host already refuses to
   * answer a decision carrying it (`host_state_decision_host_only`), so the
   * enforcement side is live and only the producer is missing.
   */
  hostOnly?: boolean
}

export interface HostStateSessionChannel {
  kind: "session"
  channel: string
  sessionId: string
  revision: number
  transcriptRevision: number
  conversation: HostStateConversationStatus
  runtime: HostStateRuntimeStatus
  turn: HostStateTurnStatus
  title?: string
  draft: {
    text: string
    attachments: HostStateAttachmentRef[]
    revision: number
  }
  queue: HostStateQueuedMessage[]
  activeTurn: { turnId: string; startedAt: number } | null
  /**
   * Every open and recently-settled decision, in request order.
   *
   * One ordered array rather than a per-kind bucket: a run can be blocked on
   * more than one at a time, and the previous per-kind shape let a second
   * request overwrite the first, stranding the run on a decision no client
   * could see.
   */
  decisions: HostStateDecision[]
  /** Submitted intents and their fate, in submission order. */
  operations: HostStateOperation[]
  tombstone?: { deletedAt: number; hostSeq: number }
}

export interface HostStateSessionSummary {
  sessionId: string
  title?: string
  conversation: HostStateConversationStatus
  turn: HostStateTurnStatus
  revision: number
  transcriptRevision: number
  tombstone?: { deletedAt: number; hostSeq: number }
}

export interface HostStateSessionIndexChannel {
  kind: "session-index"
  channel: string
  revision: number
  sessions: HostStateSessionSummary[]
}

export type HostStateChannelState = HostStateSessionChannel | HostStateSessionIndexChannel

export type HostStateMutation =
  // ── session index ────────────────────────────────────────────────────────
  | { kind: "session.upserted"; session: HostStateSessionSummary; revision: number }
  | { kind: "session.deleted"; sessionId: string; deletedAt: number; revision: number }
  // ── conversation ─────────────────────────────────────────────────────────
  | { kind: "session.renamed"; title: string; revision: number }
  | {
      kind: "conversation.changed"
      /**
       * `tombstoned` is deliberately not reachable here. It is the one status
       * {@link isHostStateChannelState} cross-checks against the `tombstone`
       * record, and this mutation writes no tombstone — so a
       * `conversation.changed` carrying it produced a state whose own snapshot
       * guard refuses it, and the channel could never be synced again.
       * Tombstoning goes through `session.tombstoned`, which writes both.
       */
      conversation: Exclude<HostStateConversationStatus, "tombstoned">
      revision: number
    }
  | { kind: "session.tombstoned"; deletedAt: number; hostSeq: number; revision: number }
  | { kind: "session.imported"; title: string; transcriptRevision: number; revision: number }
  // ── runtime ──────────────────────────────────────────────────────────────
  | { kind: "runtime.changed"; runtime: HostStateRuntimeStatus; revision: number }
  // ── draft + queue ────────────────────────────────────────────────────────
  | {
      kind: "draft.replaced"
      text: string
      attachments: HostStateAttachmentRef[]
      draftRevision: number
      revision: number
    }
  | {
      kind: "message.queued"
      message: HostStateQueuedMessage
      /** Enqueueing is a request to the runtime like any other; this tracks it. */
      operation: HostStateOperation
      draftRevision: number
      revision: number
    }
  | { kind: "message.dequeued"; actionId: string; revision: number }
  /**
   * The runtime refused a queued message. Removes it from the queue AND fails
   * its operation — one mutation because they are one fact, and doing only the
   * second stranded the message in every replica's queue forever.
   */
  | {
      kind: "message.dropped"
      actionId: string
      errorCode: string
      /** Epoch ms. The reducer has no clock; this is what stamps `updatedAt`. */
      at: number
      revision: number
    }
  // ── turn ─────────────────────────────────────────────────────────────────
  | { kind: "turn.started"; turnId: string; startedAt: number; revision: number }
  | { kind: "turn.stopping"; revision: number }
  | {
      kind: "turn.settled"
      turn: "completed" | "aborted" | "retryable-error" | "fatal-error"
      revision: number
    }
  // ── decisions ────────────────────────────────────────────────────────────
  | { kind: "decision.requested"; decision: HostStateDecision; revision: number }
  | { kind: "decision.responding"; requestId: string; actionId: string; revision: number }
  | {
      kind: "decision.settled"
      requestId: string
      status: "resolved" | "expired" | "interrupted"
      revision: number
    }
  // ── operations ───────────────────────────────────────────────────────────
  | { kind: "operation.accepted"; operation: HostStateOperation; revision: number }
  | {
      kind: "operation.changed"
      actionId: string
      status: HostStateOperationStatus
      errorCode?: string
      correlationId?: string
      /**
       * Epoch ms for the operation's `updatedAt`. Optional because the reducer
       * has no clock of its own: without it the previous `updatedAt` is kept,
       * which is the only other honest answer. The revision counter is never a
       * substitute — it is not a time.
       */
      at?: number
      revision: number
    }
  // ── transcript ───────────────────────────────────────────────────────────
  | { kind: "transcript.revised"; transcriptRevision: number; revision: number }

export interface HostStateAppliedAction {
  channel: string
  hostId: string
  hostGeneration: number
  hostSeq: number
  origin?: { clientId: string; clientSeq: number; actionId: string }
  outcome: HostStateActionOutcome
  mutation?: HostStateMutation
  rejection?: { code: string; message: string; currentRevision?: number }
}

export interface HostStateSnapshot<TState extends HostStateChannelState = HostStateChannelState> {
  channel: string
  hostId: string
  hostGeneration: number
  cutHostSeq: number
  revision: number
  digest: string
  state: TState
}

export interface HostStateSnapshotRequest {
  accountId: string
  runtimeTargetId: string
  channel: string
}

export interface HostStateSubmitRequest {
  accountId: string
  runtimeTargetId: string
  actions: HostStateAction[]
}

export interface HostStateActionReceipt {
  actionId: string
  outcome: HostStateActionOutcome
  hostGeneration: number
  hostSeq: number
  rejection?: HostStateAppliedAction["rejection"]
}

export interface HostStateSubmitResponse {
  results: HostStateActionReceipt[]
}

/**
 * How far the Host has got through bringing itself back up.
 *
 * - `recovering` — the lease is held but the ledger has not been redriven yet.
 *   Nothing it reports about a turn can be trusted.
 * - `ready` — pending work was redriven and turns left in flight by a previous
 *   owner were settled.
 * - `degraded` — recovery ran and failed. The Host still serves, and says so,
 *   rather than presenting stale state as fresh.
 */
export type HostStateRecoveryStatus = "recovering" | "ready" | "degraded"

export interface HostStateStatus {
  hostId: string
  hostGeneration: number
  hostSeq: number
  leaseExpiresAt: number
  pendingDispatch: number
  pendingBroadcast: number
  recovery: HostStateRecoveryStatus
}

export interface HostStateReplica<TState extends HostStateChannelState> {
  confirmed: TState
  pending: HostStateAction[]
  hostGeneration: number
  hostSeq: number
}

export type HostStateReplicaView<TState extends HostStateChannelState> =
  HostStateReplica<TState> & {
    optimistic: TState
  }

export type HostStateJsonValue =
  null | string | number | boolean | HostStateJsonValue[] | { [key: string]: HostStateJsonValue }

export function sessionIndexChannel(runtimeTargetId: string): string {
  return `cognia://target/${encodeURIComponent(runtimeTargetId)}/sessions`
}

export function sessionStateChannel(runtimeTargetId: string, sessionId: string): string {
  return `${sessionIndexChannel(runtimeTargetId)}/${encodeURIComponent(sessionId)}`
}

export function createEmptyHostStateSession(
  channel: string,
  sessionId: string
): HostStateSessionChannel {
  return {
    kind: "session",
    channel,
    sessionId,
    revision: 0,
    transcriptRevision: 0,
    conversation: "present",
    runtime: "ready",
    turn: "idle",
    draft: { text: "", attachments: [], revision: 0 },
    queue: [],
    activeTurn: null,
    decisions: [],
    operations: [],
  }
}

/**
 * Where a session's turn lands once nothing is blocking it any more.
 *
 * Called after a decision settles. Deliberately not applied to a turn already
 * terminal or `stopping`: an abort in flight must not be re-derived back into
 * `running` because a decision happened to clear.
 */
export function deriveTurnAfterDecisions(state: HostStateSessionChannel): HostStateTurnStatus {
  if (state.decisions.some((item) => OPEN_DECISION_STATUSES.includes(item.status))) {
    return "awaiting-decision"
  }
  if (state.activeTurn) return "running"
  if (state.queue.length > 0) return "queued"
  return "idle"
}

/**
 * Action ids of messages still waiting in the queue.
 *
 * Their enqueue operation goes terminal (`acknowledged`) as soon as the runtime
 * accepts it, long before the message is delivered — so it has to be exempt
 * both from `settleOpenWork`'s expiry and from history trimming, or a queued
 * message loses the operation the UI reads its state from.
 */
function queuedActionIds(queue: HostStateSessionChannel["queue"]): Set<string> {
  return new Set(queue.map((item) => item.actionId))
}

/**
 * Settle every open decision and non-terminal operation at once.
 *
 * The turn ending, the runtime dying and the session being deleted all leave
 * requests that can never be answered. Leaving them open is what stranded a
 * client on a prompt whose run had already gone; leaving operations open is
 * what left a "sending…" row that would never resolve either way.
 *
 * An enqueue whose message is STILL IN THE QUEUE is the exception, and the
 * reason is the queue's whole purpose: it survives the turn that was running
 * when the message was typed, and the next turn delivers it. Expiring it here
 * produced a snapshot that reported the same message as queued and as
 * permanently failed at once, and told the user to refresh a send that was
 * about to land. Only `message.dequeued` — or the runtime refusing it — settles
 * one of those.
 *
 * `updatedAt` is deliberately left alone: it is an epoch-millisecond stamp and
 * the reducer has no clock. Carrying the previous value is accurate ("last time
 * we knew something new"); writing the revision counter into it was not.
 */
function settleOpenWork(
  state: HostStateSessionChannel,
  decisionStatus: "expired" | "interrupted",
  operationErrorCode: string
): Pick<HostStateSessionChannel, "decisions" | "operations"> {
  const queued = queuedActionIds(state.queue)
  return {
    decisions: state.decisions.map((item) =>
      OPEN_DECISION_STATUSES.includes(item.status)
        ? { ...item, status: decisionStatus, respondingActionId: undefined }
        : item
    ),
    operations: state.operations.map((item) =>
      TERMINAL_OPERATION_STATUSES.includes(item.status) || queued.has(item.actionId)
        ? item
        : { ...item, status: "expired" as const, errorCode: operationErrorCode }
    ),
  }
}

export function reduceHostStateMutation<TState extends HostStateChannelState>(
  state: TState,
  mutation: HostStateMutation
): TState {
  if (state.kind === "session-index") {
    if (mutation.kind === "session.upserted") {
      const sessions = state.sessions.filter(
        (item) => item.sessionId !== mutation.session.sessionId
      )
      sessions.push(mutation.session)
      sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      return { ...state, revision: mutation.revision, sessions } as TState
    }
    if (mutation.kind === "session.deleted") {
      const sessions = state.sessions.map((item) =>
        item.sessionId === mutation.sessionId
          ? {
              ...item,
              revision: mutation.revision,
              conversation: "tombstoned" as const,
              tombstone: { deletedAt: mutation.deletedAt, hostSeq: 0 },
            }
          : item
      )
      return { ...state, revision: mutation.revision, sessions } as TState
    }
    return state
  }

  const session = state as HostStateSessionChannel
  switch (mutation.kind) {
    case "session.renamed":
      return { ...state, title: mutation.title, revision: mutation.revision } as TState
    case "conversation.changed":
      return {
        ...state,
        conversation: mutation.conversation,
        revision: mutation.revision,
      } as TState
    case "runtime.changed": {
      // A runtime that went away takes the in-flight decisions with it, but not
      // the conversation: `sidecar_exited` is a restartable loss, so the turn
      // lands on `retryable-error` and the transcript stays intact.
      if (mutation.runtime === "ready") {
        return { ...state, runtime: mutation.runtime, revision: mutation.revision } as TState
      }
      const settled = settleOpenWork(session, "interrupted", "host_state_runtime_unavailable")
      const wasLive =
        session.turn === "running" ||
        session.turn === "awaiting-decision" ||
        session.turn === "stopping" ||
        session.turn === "queued"
      return {
        ...state,
        ...settled,
        runtime: mutation.runtime,
        turn: wasLive ? "retryable-error" : session.turn,
        activeTurn: null,
        revision: mutation.revision,
      } as TState
    }
    case "draft.replaced":
      return {
        ...state,
        revision: mutation.revision,
        draft: {
          text: mutation.text,
          attachments: mutation.attachments,
          revision: mutation.draftRevision,
        },
      } as TState
    case "message.queued": {
      // Deliberately does NOT advance `transcriptRevision`. Queueing writes no
      // message; a client that reconciles on transcript revision would fetch a
      // page identical to the one it has and report the send as landed.
      const queue = session.queue.some((item) => item.actionId === mutation.message.actionId)
        ? session.queue
        : [...session.queue, mutation.message]
      return {
        ...state,
        revision: mutation.revision,
        turn: session.turn === "idle" ? "queued" : session.turn,
        draft: { text: "", attachments: [], revision: mutation.draftRevision },
        queue,
        operations: appendOperation(session.operations, mutation.operation, queuedActionIds(queue)),
      } as TState
    }
    case "message.dequeued":
      return {
        ...state,
        revision: mutation.revision,
        queue: session.queue.filter((item) => item.actionId !== mutation.actionId),
      } as TState
    case "message.dropped": {
      const queue = session.queue.filter((item) => item.actionId !== mutation.actionId)
      return {
        ...state,
        revision: mutation.revision,
        queue,
        operations: session.operations.map((item) =>
          item.actionId === mutation.actionId && !TERMINAL_OPERATION_STATUSES.includes(item.status)
            ? {
                ...item,
                status: "failed" as const,
                errorCode: mutation.errorCode,
                updatedAt: mutation.at,
              }
            : item
        ),
        // Nothing is left to run for this message. A turn parked on `queued`
        // solely because of it has to fall back, or the session reads as busy
        // against an empty queue.
        turn:
          session.turn === "queued" && queue.length === 0
            ? deriveTurnAfterDecisions({ ...session, queue })
            : session.turn,
      } as TState
    }
    case "turn.started":
      return {
        ...state,
        turn: "running",
        revision: mutation.revision,
        activeTurn: { turnId: mutation.turnId, startedAt: mutation.startedAt },
      } as TState
    case "turn.stopping":
      return { ...state, turn: "stopping", revision: mutation.revision } as TState
    case "turn.settled": {
      const settled = settleOpenWork(session, "interrupted", "host_state_turn_ended")
      return {
        ...state,
        ...settled,
        turn: mutation.turn,
        revision: mutation.revision,
        activeTurn: null,
      } as TState
    }
    case "decision.requested":
      return {
        ...state,
        turn: "awaiting-decision",
        revision: mutation.revision,
        decisions: upsertDecision(session.decisions, mutation.decision),
      } as TState
    case "decision.responding":
      return {
        ...state,
        revision: mutation.revision,
        decisions: session.decisions.map((item) =>
          item.requestId === mutation.requestId
            ? { ...item, status: "responding" as const, respondingActionId: mutation.actionId }
            : item
        ),
      } as TState
    case "decision.settled": {
      const decisions = session.decisions.map((item) =>
        item.requestId === mutation.requestId
          ? { ...item, status: mutation.status, respondingActionId: undefined }
          : item
      )
      return {
        ...state,
        revision: mutation.revision,
        decisions,
        // Only a turn that was blocked gets re-derived. A `stopping` abort and
        // an already-terminal turn keep what they had.
        turn:
          session.turn === "awaiting-decision"
            ? deriveTurnAfterDecisions({ ...session, decisions })
            : session.turn,
      } as TState
    }
    case "operation.accepted": {
      // Accepting a request may change what the session is *asking for*, and
      // may never change what it has *done*. An abort shows `stopping`, not
      // stopped; an answer marks its decision `responding`, and the decision
      // stays in the list until the runtime confirms it was resolved.
      const operations = appendOperation(
        session.operations,
        mutation.operation,
        queuedActionIds(session.queue)
      )
      const operation = mutation.operation
      if (operation.kind === "turn.abort") {
        return {
          ...state,
          revision: mutation.revision,
          operations,
          turn: TERMINAL_TURN_STATUSES.includes(session.turn) ? session.turn : "stopping",
        } as TState
      }
      if (isDecisionResponse(operation.kind) && operation.targetRequestId) {
        return {
          ...state,
          revision: mutation.revision,
          operations,
          decisions: session.decisions.map((item) =>
            // Only an unclaimed decision may be taken. First valid writer wins:
            // the Host refuses the second answer at submit time, and claiming
            // it here anyway would let a late mutation hand ownership — and
            // therefore the rollback on failure — to the wrong client.
            item.requestId === operation.targetRequestId && item.status === "pending"
              ? {
                  ...item,
                  status: "responding" as const,
                  respondingActionId: operation.actionId,
                }
              : item
          ),
        } as TState
      }
      // A steer or a follow-up asks for nothing visible until the runtime acts
      // on it; its operation is the whole of the change.
      return { ...state, revision: mutation.revision, operations } as TState
    }
    case "operation.changed": {
      const previous = session.operations.find((item) => item.actionId === mutation.actionId)
      // An operation that has already settled stays settled. Its status changes
      // travel on two independent paths — the Host's own dispatch bookkeeping
      // and the runtime's event stream — so a `dispatching` written after the
      // runtime's `acknowledged` had already landed used to drag the operation
      // back out of a terminal state that nothing would ever re-enter, leaving
      // the client's row on "sending…" forever.
      //
      // `failed` is the exception, and only for a Host-side retry. It is the
      // one terminal status the Host writes about its OWN dispatch attempt, and
      // the Host is the only thing that can retry that attempt — so a later
      // status for the same action is strictly newer information, not a race.
      // Locking it too would mean a redrive that succeeded still read as a
      // failure forever, which is exactly the case recovery exists for.
      if (
        previous &&
        TERMINAL_OPERATION_STATUSES.includes(previous.status) &&
        !(previous.status === "failed" && mutation.status !== "failed")
      ) {
        return { ...state, revision: mutation.revision } as TState
      }
      const operations = session.operations.map((item) =>
        item.actionId === mutation.actionId
          ? {
              ...item,
              status: mutation.status,
              errorCode: mutation.errorCode,
              correlationId: mutation.correlationId ?? item.correlationId,
              // `updatedAt` is epoch milliseconds. Only a mutation that carries
              // a real clock reading may move it; the revision counter is not
              // one, and writing it here put every touched operation back in
              // 1970 and made `updatedAt < createdAt`.
              updatedAt: mutation.at ?? item.updatedAt,
            }
          : item
      )
      // A request that never landed must give back whatever it was holding.
      // Leaving an abort's `stopping` in place freezes a composer against a run
      // that is still going; leaving a decision `responding` leaves a prompt
      // owned forever by a device whose answer was lost, and no other client
      // can take it.
      const abandoned =
        mutation.status === "failed" ||
        mutation.status === "expired" ||
        mutation.status === "superseded"
      if (!previous || !abandoned) {
        return { ...state, revision: mutation.revision, operations } as TState
      }
      if (previous.kind === "turn.abort" && session.turn === "stopping") {
        return {
          ...state,
          revision: mutation.revision,
          operations,
          turn: deriveTurnAfterDecisions(session),
        } as TState
      }
      if (isDecisionResponse(previous.kind) && previous.targetRequestId) {
        return {
          ...state,
          revision: mutation.revision,
          operations,
          decisions: session.decisions.map((item) =>
            item.requestId === previous.targetRequestId &&
            item.status === "responding" &&
            item.respondingActionId === previous.actionId
              ? { ...item, status: "pending" as const, respondingActionId: undefined }
              : item
          ),
        } as TState
      }
      return { ...state, revision: mutation.revision, operations } as TState
    }
    case "transcript.revised":
      return {
        ...state,
        revision: mutation.revision,
        transcriptRevision: mutation.transcriptRevision,
      } as TState
    case "session.imported":
      return {
        ...state,
        title: mutation.title,
        transcriptRevision: mutation.transcriptRevision,
        revision: mutation.revision,
      } as TState
    case "session.tombstoned": {
      const settled = settleOpenWork(session, "expired", "host_state_session_deleted")
      return {
        ...state,
        ...settled,
        conversation: "tombstoned",
        turn: "idle",
        activeTurn: null,
        revision: mutation.revision,
        tombstone: { deletedAt: mutation.deletedAt, hostSeq: mutation.hostSeq },
      } as TState
    }
    case "session.upserted":
    case "session.deleted":
      return state
  }
}

/**
 * The client's optimistic view of an intent it has submitted but not yet had
 * confirmed.
 *
 * The rule this encodes: an intent may show that something is *being asked for*
 * and may never show it *done*. An abort renders as `stopping`, an answer to a
 * decision renders as `responding`, and neither is allowed to reach a terminal
 * state without a runtime-confirmed mutation. Intents whose effect is purely
 * the Host's own bookkeeping — rename, archive, draft — apply in full, because
 * there is nothing for a runtime to confirm.
 */
export function reduceHostStateIntent<TState extends HostStateChannelState>(
  state: TState,
  envelope: HostStateAction
): TState {
  if (state.kind !== "session") return state
  const session = state as HostStateSessionChannel
  const revision = session.revision + 1
  switch (envelope.action.kind) {
    case "session.rename":
      return { ...state, title: envelope.action.title, revision } as TState
    case "session.archive":
      return {
        ...state,
        conversation: envelope.action.archived ? "archived" : "present",
        revision,
      } as TState
    case "draft.replace":
      return {
        ...state,
        revision,
        draft: {
          text: envelope.action.text,
          attachments: envelope.action.attachments,
          revision: session.draft.revision + 1,
        },
      } as TState
    case "message.enqueue": {
      const intent = envelope.action
      return {
        ...state,
        turn: session.turn === "idle" ? "queued" : session.turn,
        revision,
        queue: session.queue.some((item) => item.actionId === envelope.actionId)
          ? session.queue
          : [
              ...session.queue,
              {
                actionId: envelope.actionId,
                messageId: intent.messageId,
                text: intent.text,
                attachments: intent.attachments,
                clientId: envelope.clientId,
              },
            ],
      } as TState
    }
    case "turn.abort":
      // NOT `aborted`. The run keeps producing until the runtime says it
      // stopped, and a client that shows it finished will re-open a composer
      // against a live turn.
      return {
        ...state,
        turn: TERMINAL_TURN_STATUSES.includes(session.turn) ? session.turn : "stopping",
        revision,
      } as TState
    case "approval.respond":
    case "elicitation.respond": {
      // NOT removed from `decisions`. Dropping it here is what made a failed
      // dispatch erase a decision the run was still blocked on, with no way
      // back short of a resync.
      const intent = envelope.action
      return {
        ...state,
        revision,
        decisions: session.decisions.map((item) =>
          item.requestId === intent.requestId && item.status === "pending"
            ? { ...item, status: "responding" as const, respondingActionId: envelope.actionId }
            : item
        ),
      } as TState
    }
    case "session.create":
    case "turn.steer":
    case "turn.followup":
    case "transcript.edit":
    case "transcript.truncate":
    case "session.import":
      return state
  }
}

export function reconcileHostStateReplica<TState extends HostStateChannelState>(
  replica: HostStateReplica<TState>,
  event: HostStateAppliedAction
): HostStateReplicaView<TState> {
  if (event.hostGeneration < replica.hostGeneration) throw new Error("stale_host_generation")
  if (event.hostGeneration > replica.hostGeneration) throw new Error("host_state_resync_required")
  if (event.hostSeq !== replica.hostSeq + 1) throw new Error("host_state_sequence_gap")
  if (event.channel !== replica.confirmed.channel) throw new Error("host_state_channel_mismatch")

  const confirmed = event.mutation
    ? reduceHostStateMutation(replica.confirmed, event.mutation)
    : replica.confirmed
  const pending = event.origin
    ? replica.pending.filter((item) => item.actionId !== event.origin?.actionId)
    : replica.pending
  const optimistic = pending.reduce(
    (state, pendingAction) => reduceHostStateIntent(state, pendingAction),
    confirmed
  )
  return {
    confirmed,
    pending,
    optimistic,
    hostGeneration: replica.hostGeneration,
    hostSeq: event.hostSeq,
  }
}

export function canonicalHostStateJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function hostStateDigest(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalHostStateJson(value))
  let hash = BigInt("14695981039346656037")
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * BigInt("1099511628211"))
  }
  return `hs-${hash.toString(16).padStart(16, "0")}`
}

export function isHostStateAction(value: unknown): value is HostStateAction {
  if (!isRecord(value)) return false
  if (
    !hasOnlyKeys(value, [
      "channel",
      "accountId",
      "runtimeTargetId",
      "hostId",
      "hostGeneration",
      "sessionId",
      "clientId",
      "clientSeq",
      "actionId",
      "baseRevision",
      "createdAt",
      "action",
    ]) ||
    !nonEmptyString(value.channel) ||
    !nonEmptyString(value.accountId) ||
    !nonEmptyString(value.runtimeTargetId) ||
    !nonEmptyString(value.hostId) ||
    !nonNegativeInteger(value.hostGeneration) ||
    (value.sessionId !== undefined && !nonEmptyString(value.sessionId)) ||
    !nonEmptyString(value.clientId) ||
    !nonNegativeInteger(value.clientSeq) ||
    !nonEmptyString(value.actionId) ||
    (value.baseRevision !== undefined && !nonNegativeInteger(value.baseRevision)) ||
    !nonNegativeInteger(value.createdAt)
  ) {
    return false
  }
  return isAllowedIntent(value.action)
}

export function isHostStateAppliedAction(value: unknown): value is HostStateAppliedAction {
  if (!isRecord(value)) return false
  if (
    !hasOnlyKeys(value, [
      "channel",
      "hostId",
      "hostGeneration",
      "hostSeq",
      "origin",
      "outcome",
      "mutation",
      "rejection",
    ]) ||
    !nonEmptyString(value.channel) ||
    !nonEmptyString(value.hostId) ||
    !nonNegativeInteger(value.hostGeneration) ||
    !nonNegativeInteger(value.hostSeq) ||
    !isOutcome(value.outcome)
  ) {
    return false
  }
  if (value.origin !== undefined) {
    if (
      !isRecord(value.origin) ||
      !hasOnlyKeys(value.origin, ["clientId", "clientSeq", "actionId"]) ||
      !nonEmptyString(value.origin.clientId) ||
      !nonNegativeInteger(value.origin.clientSeq) ||
      !nonEmptyString(value.origin.actionId)
    ) {
      return false
    }
  }
  if (value.mutation !== undefined && !isHostStateMutation(value.mutation)) return false
  return value.rejection === undefined || isHostStateRejection(value.rejection)
}

export function isHostStateSnapshot(value: unknown): value is HostStateSnapshot {
  if (!isRecord(value)) return false
  if (
    !hasOnlyKeys(value, [
      "channel",
      "hostId",
      "hostGeneration",
      "cutHostSeq",
      "revision",
      "digest",
      "state",
    ]) ||
    !nonEmptyString(value.channel) ||
    !nonEmptyString(value.hostId) ||
    !nonNegativeInteger(value.hostGeneration) ||
    !nonNegativeInteger(value.cutHostSeq) ||
    !nonNegativeInteger(value.revision) ||
    !nonEmptyString(value.digest) ||
    !isHostStateChannelState(value.state)
  ) {
    return false
  }
  if (value.state.channel !== value.channel) return false
  if (value.state.revision !== value.revision) return false
  return value.digest === hostStateDigest(value.state)
}

export function isHostStateSubmitResponse(value: unknown): value is HostStateSubmitResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["results"]) &&
    Array.isArray(value.results) &&
    value.results.every(isHostStateReceipt)
  )
}

export function isHostStateStatus(value: unknown): value is HostStateStatus {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "hostId",
      "hostGeneration",
      "hostSeq",
      "leaseExpiresAt",
      "pendingDispatch",
      "pendingBroadcast",
      "recovery",
    ]) &&
    nonEmptyString(value.hostId) &&
    nonNegativeInteger(value.hostGeneration) &&
    nonNegativeInteger(value.hostSeq) &&
    nonNegativeInteger(value.leaseExpiresAt) &&
    nonNegativeInteger(value.pendingDispatch) &&
    nonNegativeInteger(value.pendingBroadcast) &&
    (value.recovery === "recovering" || value.recovery === "ready" || value.recovery === "degraded")
  )
}

function isOutcome(value: unknown): value is HostStateActionOutcome {
  return (
    value === "applied" || value === "duplicate" || value === "rejected" || value === "conflicted"
  )
}

function isConversationStatus(value: unknown): value is HostStateConversationStatus {
  return (
    value === "present" || value === "archived" || value === "tombstoned" || value === "missing"
  )
}

function isRuntimeStatus(value: unknown): value is HostStateRuntimeStatus {
  return value === "ready" || value === "restarting" || value === "unavailable"
}

function isTurnStatus(value: unknown): value is HostStateTurnStatus {
  return (
    value === "idle" ||
    value === "queued" ||
    value === "running" ||
    value === "awaiting-decision" ||
    value === "stopping" ||
    value === "completed" ||
    value === "aborted" ||
    value === "retryable-error" ||
    value === "fatal-error"
  )
}

function isHostStateChannelState(value: unknown): value is HostStateChannelState {
  if (!isRecord(value) || !nonEmptyString(value.kind)) return false
  if (value.kind === "session-index") {
    return (
      hasOnlyKeys(value, ["kind", "channel", "revision", "sessions"]) &&
      nonEmptyString(value.channel) &&
      nonNegativeInteger(value.revision) &&
      Array.isArray(value.sessions) &&
      value.sessions.every(isSessionSummary)
    )
  }
  return (
    value.kind === "session" &&
    hasOnlyKeys(value, [
      "kind",
      "channel",
      "sessionId",
      "revision",
      "transcriptRevision",
      "conversation",
      "runtime",
      "turn",
      "title",
      "draft",
      "queue",
      "activeTurn",
      "decisions",
      "operations",
      "tombstone",
    ]) &&
    nonEmptyString(value.channel) &&
    nonEmptyString(value.sessionId) &&
    nonNegativeInteger(value.revision) &&
    nonNegativeInteger(value.transcriptRevision) &&
    isConversationStatus(value.conversation) &&
    isRuntimeStatus(value.runtime) &&
    isTurnStatus(value.turn) &&
    (value.title === undefined || typeof value.title === "string") &&
    isRecord(value.draft) &&
    hasOnlyKeys(value.draft, ["text", "attachments", "revision"]) &&
    typeof value.draft.text === "string" &&
    isAttachmentList(value.draft.attachments) &&
    nonNegativeInteger(value.draft.revision) &&
    Array.isArray(value.queue) &&
    value.queue.every(isQueuedMessage) &&
    (value.activeTurn === null || isActiveTurn(value.activeTurn)) &&
    Array.isArray(value.decisions) &&
    value.decisions.every(isDecision) &&
    Array.isArray(value.operations) &&
    value.operations.every(isOperation) &&
    (value.tombstone === undefined || isTombstone(value.tombstone)) &&
    // A tombstone and the conversation axis must agree. Two sources of truth
    // for "is this conversation gone" is how a deleted session keeps rendering
    // a composer on one client and not on another.
    (value.tombstone === undefined) === (value.conversation !== "tombstoned")
  )
}

export function isHostStateMutation(value: unknown): value is HostStateMutation {
  if (!isRecord(value) || !nonEmptyString(value.kind) || !nonNegativeInteger(value.revision)) {
    return false
  }
  switch (value.kind) {
    case "session.upserted":
      return hasOnlyKeys(value, ["kind", "session", "revision"]) && isSessionSummary(value.session)
    case "session.deleted":
      return (
        hasOnlyKeys(value, ["kind", "sessionId", "deletedAt", "revision"]) &&
        nonEmptyString(value.sessionId) &&
        nonNegativeInteger(value.deletedAt)
      )
    case "session.renamed":
      return hasOnlyKeys(value, ["kind", "title", "revision"]) && typeof value.title === "string"
    case "conversation.changed":
      // `tombstoned` is refused on the wire as well as in the type: it is the
      // only status the channel guard cross-checks against a `tombstone` record
      // this mutation does not write, so accepting one would let a peer poison
      // every replica with a state they all reject on read.
      return (
        hasOnlyKeys(value, ["kind", "conversation", "revision"]) &&
        isConversationStatus(value.conversation) &&
        value.conversation !== "tombstoned"
      )
    case "runtime.changed":
      return hasOnlyKeys(value, ["kind", "runtime", "revision"]) && isRuntimeStatus(value.runtime)
    case "draft.replaced":
      return (
        hasOnlyKeys(value, ["kind", "text", "attachments", "draftRevision", "revision"]) &&
        typeof value.text === "string" &&
        isAttachmentList(value.attachments) &&
        nonNegativeInteger(value.draftRevision)
      )
    case "message.queued":
      return (
        hasOnlyKeys(value, ["kind", "message", "operation", "draftRevision", "revision"]) &&
        isQueuedMessage(value.message) &&
        isOperation(value.operation) &&
        nonNegativeInteger(value.draftRevision)
      )
    case "message.dequeued":
      return hasOnlyKeys(value, ["kind", "actionId", "revision"]) && nonEmptyString(value.actionId)
    case "message.dropped":
      return (
        hasOnlyKeys(value, ["kind", "actionId", "errorCode", "at", "revision"]) &&
        nonEmptyString(value.actionId) &&
        nonEmptyString(value.errorCode) &&
        nonNegativeInteger(value.at)
      )
    case "turn.started":
      return (
        hasOnlyKeys(value, ["kind", "turnId", "startedAt", "revision"]) &&
        nonEmptyString(value.turnId) &&
        nonNegativeInteger(value.startedAt)
      )
    case "turn.stopping":
      return hasOnlyKeys(value, ["kind", "revision"])
    case "turn.settled":
      return (
        hasOnlyKeys(value, ["kind", "turn", "revision"]) &&
        (value.turn === "completed" ||
          value.turn === "aborted" ||
          value.turn === "retryable-error" ||
          value.turn === "fatal-error")
      )
    case "decision.requested":
      return hasOnlyKeys(value, ["kind", "decision", "revision"]) && isDecision(value.decision)
    case "decision.responding":
      return (
        hasOnlyKeys(value, ["kind", "requestId", "actionId", "revision"]) &&
        nonEmptyString(value.requestId) &&
        nonEmptyString(value.actionId)
      )
    case "decision.settled":
      return (
        hasOnlyKeys(value, ["kind", "requestId", "status", "revision"]) &&
        nonEmptyString(value.requestId) &&
        (value.status === "resolved" ||
          value.status === "expired" ||
          value.status === "interrupted")
      )
    case "operation.accepted":
      return hasOnlyKeys(value, ["kind", "operation", "revision"]) && isOperation(value.operation)
    case "operation.changed":
      return (
        hasOnlyKeys(value, [
          "kind",
          "actionId",
          "status",
          "errorCode",
          "correlationId",
          "at",
          "revision",
        ]) &&
        nonEmptyString(value.actionId) &&
        isOperationStatus(value.status) &&
        (value.errorCode === undefined || nonEmptyString(value.errorCode)) &&
        (value.correlationId === undefined || nonEmptyString(value.correlationId)) &&
        (value.at === undefined || nonNegativeInteger(value.at))
      )
    case "transcript.revised":
      return (
        hasOnlyKeys(value, ["kind", "transcriptRevision", "revision"]) &&
        nonNegativeInteger(value.transcriptRevision)
      )
    case "session.imported":
      return (
        hasOnlyKeys(value, ["kind", "title", "transcriptRevision", "revision"]) &&
        typeof value.title === "string" &&
        nonNegativeInteger(value.transcriptRevision)
      )
    case "session.tombstoned":
      return (
        hasOnlyKeys(value, ["kind", "deletedAt", "hostSeq", "revision"]) &&
        nonNegativeInteger(value.deletedAt) &&
        nonNegativeInteger(value.hostSeq)
      )
    default:
      return false
  }
}

function isAllowedIntent(value: unknown): value is AllowedHostStateIntent {
  if (!isRecord(value) || !nonEmptyString(value.kind)) return false
  switch (value.kind) {
    case "session.create":
      return hasOnlyKeys(value, ["kind", "title"]) && isOptionalString(value.title)
    case "session.rename":
      return hasOnlyKeys(value, ["kind", "title"]) && typeof value.title === "string"
    case "session.archive":
      return hasOnlyKeys(value, ["kind", "archived"]) && typeof value.archived === "boolean"
    case "draft.replace":
      return (
        hasOnlyKeys(value, ["kind", "text", "attachments"]) &&
        typeof value.text === "string" &&
        isAttachmentList(value.attachments)
      )
    case "message.enqueue":
      return (
        hasOnlyKeys(value, ["kind", "messageId", "text", "attachments"]) &&
        nonEmptyString(value.messageId) &&
        typeof value.text === "string" &&
        isAttachmentList(value.attachments)
      )
    case "turn.steer":
    case "turn.followup":
      return hasOnlyKeys(value, ["kind", "text"]) && typeof value.text === "string"
    case "turn.abort":
      return hasOnlyKeys(value, ["kind"])
    case "approval.respond":
      return (
        hasOnlyKeys(value, ["kind", "requestId", "decision"]) &&
        nonEmptyString(value.requestId) &&
        (value.decision === "allow" ||
          value.decision === "allow_always" ||
          value.decision === "deny")
      )
    case "elicitation.respond":
      return (
        hasOnlyKeys(value, ["kind", "requestId", "response"]) &&
        nonEmptyString(value.requestId) &&
        isJsonValue(value.response)
      )
    case "transcript.edit":
      return (
        hasOnlyKeys(value, ["kind", "messageId", "text"]) &&
        nonEmptyString(value.messageId) &&
        typeof value.text === "string"
      )
    case "transcript.truncate":
      return (
        hasOnlyKeys(value, ["kind", "afterMessageId"]) &&
        (value.afterMessageId === undefined || nonEmptyString(value.afterMessageId))
      )
    case "session.import":
      return hasOnlyKeys(value, ["kind", "envelope"]) && isJsonValue(value.envelope)
    default:
      return false
  }
}

function isHostStateReceipt(value: unknown): value is HostStateActionReceipt {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["actionId", "outcome", "hostGeneration", "hostSeq", "rejection"]) &&
    nonEmptyString(value.actionId) &&
    isOutcome(value.outcome) &&
    nonNegativeInteger(value.hostGeneration) &&
    nonNegativeInteger(value.hostSeq) &&
    (value.rejection === undefined || isHostStateRejection(value.rejection))
  )
}

function isHostStateRejection(
  value: unknown
): value is { code: string; message: string; currentRevision?: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "message", "currentRevision"]) &&
    nonEmptyString(value.code) &&
    typeof value.message === "string" &&
    (value.currentRevision === undefined || nonNegativeInteger(value.currentRevision))
  )
}

function isOperationStatus(value: unknown): value is HostStateOperationStatus {
  return (
    value === "accepted" ||
    value === "dispatching" ||
    value === "acknowledged" ||
    value === "failed" ||
    value === "expired" ||
    value === "superseded"
  )
}

function isIntentKind(value: unknown): value is HostStateIntentKind {
  return typeof value === "string" && INTENT_KINDS.includes(value as HostStateIntentKind)
}

function isOperation(value: unknown): value is HostStateOperation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "actionId",
      "kind",
      "status",
      "clientId",
      "createdAt",
      "updatedAt",
      "errorCode",
      "correlationId",
      "targetRequestId",
    ]) &&
    nonEmptyString(value.actionId) &&
    isIntentKind(value.kind) &&
    isOperationStatus(value.status) &&
    nonEmptyString(value.clientId) &&
    nonNegativeInteger(value.createdAt) &&
    nonNegativeInteger(value.updatedAt) &&
    (value.errorCode === undefined || nonEmptyString(value.errorCode)) &&
    (value.correlationId === undefined || nonEmptyString(value.correlationId)) &&
    (value.targetRequestId === undefined || nonEmptyString(value.targetRequestId))
  )
}

function isDecisionKind(value: unknown): value is HostStateDecisionKind {
  return value === "tool-approval" || value === "elicitation" || value === "locked-computer-use"
}

function isDecisionStatus(value: unknown): value is HostStateDecisionStatus {
  return (
    value === "pending" ||
    value === "responding" ||
    value === "resolved" ||
    value === "expired" ||
    value === "interrupted"
  )
}

function isDecision(value: unknown): value is HostStateDecision {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "requestId",
      "kind",
      "status",
      "label",
      "requestedAt",
      "origin",
      "respondingActionId",
      "hostOnly",
    ]) ||
    !nonEmptyString(value.requestId) ||
    !isDecisionKind(value.kind) ||
    !isDecisionStatus(value.status) ||
    !isOptionalString(value.label) ||
    !nonNegativeInteger(value.requestedAt) ||
    (value.respondingActionId !== undefined && !nonEmptyString(value.respondingActionId)) ||
    (value.hostOnly !== undefined && typeof value.hostOnly !== "boolean")
  ) {
    return false
  }
  if (value.origin === undefined) return true
  return (
    isRecord(value.origin) &&
    hasOnlyKeys(value.origin, ["subagentId", "label"]) &&
    nonEmptyString(value.origin.subagentId) &&
    isOptionalString(value.origin.label)
  )
}

function isQueuedMessage(value: unknown): value is HostStateQueuedMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["actionId", "messageId", "text", "attachments", "clientId"]) &&
    nonEmptyString(value.actionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.text === "string" &&
    isAttachmentList(value.attachments) &&
    nonEmptyString(value.clientId)
  )
}

function isSessionSummary(value: unknown): value is HostStateSessionSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "sessionId",
      "title",
      "conversation",
      "turn",
      "revision",
      "transcriptRevision",
      "tombstone",
    ]) &&
    nonEmptyString(value.sessionId) &&
    isOptionalString(value.title) &&
    isConversationStatus(value.conversation) &&
    isTurnStatus(value.turn) &&
    nonNegativeInteger(value.revision) &&
    nonNegativeInteger(value.transcriptRevision) &&
    (value.tombstone === undefined || isTombstone(value.tombstone))
  )
}

function isTombstone(value: unknown): value is { deletedAt: number; hostSeq: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["deletedAt", "hostSeq"]) &&
    nonNegativeInteger(value.deletedAt) &&
    nonNegativeInteger(value.hostSeq)
  )
}

function isActiveTurn(value: unknown): value is { turnId: string; startedAt: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["turnId", "startedAt"]) &&
    nonEmptyString(value.turnId) &&
    nonNegativeInteger(value.startedAt)
  )
}

function isAttachmentList(value: unknown): value is HostStateAttachmentRef[] {
  return Array.isArray(value) && value.every(isAttachment)
}

function isAttachment(value: unknown): value is HostStateAttachmentRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "mediaType", "size", "hash", "ref"]) &&
    nonEmptyString(value.name) &&
    nonEmptyString(value.mediaType) &&
    nonNegativeInteger(value.size) &&
    (value.hash === undefined || nonEmptyString(value.hash)) &&
    (value.ref === undefined || nonEmptyString(value.ref))
  )
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function isJsonValue(value: unknown): value is HostStateJsonValue {
  if (value === null) return true
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every((item) => item === undefined || isJsonValue(item))
}

function canonicalize(value: unknown): HostStateJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("HostState canonical JSON requires finite numbers")
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) throw new Error("HostState canonical JSON accepts JSON values only")
  return Object.keys(value)
    .sort()
    .reduce<Record<string, HostStateJsonValue>>((result, key) => {
      const item = value[key]
      if (item !== undefined) result[key] = canonicalize(item)
      return result
    }, {})
}

function isDecisionResponse(kind: HostStateIntentKind): boolean {
  return kind === "approval.respond" || kind === "elicitation.respond"
}

/**
 * How much settled history a channel keeps.
 *
 * The lists used to be append-only, so a session accumulated one operation per
 * message, steer, abort and decision answer for its entire life. Channel state
 * is persisted AND serialized into every `host_state_snapshot`, and the service
 * refuses a snapshot over `MAX_HOST_STATE_SNAPSHOT_BYTES` — so a long-running
 * session eventually crossed the cap and could never be snapshotted again,
 * which takes `installHostStateSync` down with it for the whole account.
 *
 * A COUNT, not a time window: the reducer has no clock, and every replica must
 * derive byte-identical state from the same mutation sequence.
 */
export const MAX_RETAINED_OPERATIONS = 100
export const MAX_RETAINED_DECISIONS = 100

/**
 * Drop the oldest settled entries once `retained` is exceeded.
 *
 * Nothing live is ever dropped, whatever the count: the cap trims history, and
 * an entry the reducer still has to transition is not history. Relative order
 * is preserved because the survivors are selected by a filter over the original
 * array rather than reassembled.
 */
function trimSettled<T>(
  items: T[],
  retained: number,
  isLive: (item: T) => boolean,
  identity: (item: T) => string
): T[] {
  if (items.length <= retained) return items
  const settled = items.filter((item) => !isLive(item))
  const keepCount = Math.max(0, retained - (items.length - settled.length))
  const keep = new Set(settled.slice(settled.length - keepCount).map(identity))
  return items.filter((item) => isLive(item) || keep.has(identity(item)))
}

/**
 * Append an operation unless its action is already tracked. Idempotent.
 *
 * `protectedActionIds` names operations that are terminal but still referenced
 * by something on screen — the messages sitting in `queue`, whose enqueue
 * operation is `acknowledged` long before the runtime delivers them.
 */
function appendOperation(
  operations: HostStateOperation[],
  operation: HostStateOperation,
  protectedActionIds: ReadonlySet<string> = new Set()
): HostStateOperation[] {
  const next = operations.some((item) => item.actionId === operation.actionId)
    ? operations
    : [...operations, operation]
  return trimSettled(
    next,
    MAX_RETAINED_OPERATIONS,
    (item) =>
      !TERMINAL_OPERATION_STATUSES.includes(item.status) || protectedActionIds.has(item.actionId),
    (item) => item.actionId
  )
}

/**
 * Replace a decision in place, preserving request order.
 *
 * Order matters: a run blocked on three prompts must present them in the order
 * the runtime raised them, and appending a re-request to the end would reorder
 * the queue a user is working through.
 */
function upsertDecision(
  decisions: HostStateDecision[],
  decision: HostStateDecision
): HostStateDecision[] {
  const index = decisions.findIndex((item) => item.requestId === decision.requestId)
  const next =
    index === -1
      ? [...decisions, decision]
      : decisions.map((item, at) => (at === index ? decision : item))
  return trimSettled(
    next,
    MAX_RETAINED_DECISIONS,
    (item) => OPEN_DECISION_STATUSES.includes(item.status),
    (item) => item.requestId
  )
}
