/**
 * Pure projection from the live inputs (the unified Fleet snapshot, the
 * Control Center attention aggregation and what the main window knows about
 * its conversations) to the read-only island state.
 *
 * Runs in the MAIN window only. The island window receives the result and
 * nothing else, which is what keeps the overlay away from stores, Dexie and
 * every business control plane.
 *
 * Two rules govern the merge:
 *   1. Identity is exact. Two observations fold into one row only when
 *      `taskIdentity` matches. Anything we cannot prove is the same task stays
 *      its own row, because a title-similarity guess hides real work.
 *   2. The result is safe to hover. Titles, tool names and timestamps travel.
 *      Prompts, paths, commands, plans and error bodies do not.
 */

import { redactText } from "@cognia/redact"

import type { AttentionItem } from "@/lib/attention/types"
import { truncateLine } from "@/lib/fleet/format"
import { FLEET_PERMISSION_WAIT_MS, type FleetSession, type FleetSnapshot } from "@/lib/fleet/types"
import type { ExecutionRunInterrupt } from "@/types/execution/run"
import { attentionOwner, fleetSessionOwner, ownerRoute, taskIdentity } from "./owner"
import {
  ISLAND_DONE_LINGER_MS,
  ISLAND_STATUS_RANK,
  NO_ISLAND_CAPABILITIES,
  type IslandAnswerDeadline,
  type IslandDecisionKind,
  type IslandQuestion,
  type IslandRowCapabilities,
  type IslandRowProjection,
  type IslandRowStatus,
  type IslandState,
  type IslandDetailVisibility,
  type FleetOwnerRef,
} from "./types"

/** Caps for everything that crosses the window boundary. */
const TITLE_MAX = 64
const SUMMARY_MAX = 96
const TOOL_MAX = 48
const QUESTION_MAX = 200
const OPTION_MAX = 48
const MAX_OPTIONS = 8
const MAX_QUESTIONS = 4

/** Redact then flatten then cap. The one gate every string passes through. */
function safe(value: string | null | undefined, max: number): string {
  if (!value) return ""
  return truncateLine(redactText(value).redacted, max)
}

/**
 * What the main window knows about one Cognia conversation.
 *
 * `direct` says the chat runtime drives it, which is what its Stop and its
 * send can reach: team rooms and workbench sessions run on other engines, so
 * the island leaves those controls to their own pages. `status` is the chat
 * store's, or `null` while no pane has loaded the conversation.
 */
export interface IslandConversationFacts {
  direct: boolean
  status: "idle" | "streaming" | "awaiting_approval" | "error" | null
  /** The conversation's own title, when it has one. Redacted here. */
  title?: string
}

export interface IslandProjectionInputs {
  fleet: FleetSnapshot
  attention: readonly AttentionItem[]
  /**
   * Conversations the other inputs mention, keyed by chat session id. A Cognia
   * run whose session is listed belongs to that conversation.
   */
  conversations: Readonly<Record<string, IslandConversationFacts>>
  detailVisibility: IslandDetailVisibility
  /** Main-window session id. See {@link IslandState.epoch}. */
  epoch: number
  revision: number
}

/**
 * Coarse status for a monitored session.
 *
 * `blocked` is reserved for a human wait we can prove. `working` covers the
 * autonomous middle. An interrupted or ended session is `done` and lingers for
 * {@link ISLAND_DONE_LINGER_MS} before the sweep drops it.
 */
function sessionStatus(session: FleetSession): IslandRowStatus {
  switch (session.status) {
    case "waiting-permission":
    case "plan-pending":
    case "waiting-input":
      return "blocked"
    case "working":
      return session.lastError ? "failed" : "working"
    case "ended":
      return "done"
    case "detached":
      return "stale"
    case "idle":
      return session.lastError ? "failed" : "idle"
  }
}

function statusKeyFor(row: {
  status: IslandRowStatus
  permission?: unknown
  question?: unknown
}): string {
  if (row.status !== "blocked") return row.status
  if (row.permission) return "awaitingPermission"
  if (row.question) return "awaitingInput"
  return "awaitingApproval"
}

function questionsOf(session: FleetSession): IslandQuestion[] {
  return (session.pendingQuestions ?? []).slice(0, MAX_QUESTIONS).map((q) => ({
    question: safe(q.question, QUESTION_MAX),
    ...(q.header ? { header: safe(q.header, 24) } : {}),
    options: q.options.slice(0, MAX_OPTIONS).map((option) => safe(option, OPTION_MAX)),
    multiSelect: q.multiSelect,
  }))
}

/**
 * The answer window of a session's parked ask.
 *
 * Only the Rust hook ingress (Claude Code, Codex, OpenCode) holds an ask open
 * for a bounded window, after which the agent's own terminal prompt takes
 * over. An ACP ask and a Cognia ask wait for the user, so they carry no
 * deadline — a countdown there disabled the buttons while the ask was still
 * live.
 */
function hookDeadline(session: FleetSession, requestedAt: number): IslandAnswerDeadline | null {
  if (session.agent === "cognia" || session.externalAgentId) return null
  return { at: requestedAt + FLEET_PERMISSION_WAIT_MS, fallback: "terminal" }
}

/** What a conversation lets the island do beyond answering its approvals. */
function conversationControls(
  owner: FleetOwnerRef,
  conversations: IslandProjectionInputs["conversations"]
): { interrupt: boolean; reply: boolean } {
  if (owner.kind !== "chat") return { interrupt: false, reply: false }
  const facts = conversations[owner.sessionId]
  if (!facts?.direct) return { interrupt: false, reply: false }
  return {
    interrupt: facts.status === "streaming" || facts.status === "awaiting_approval",
    reply: true,
  }
}

/**
 * Capabilities for a monitored session, narrowed to what can actually be
 * honoured today.
 *
 * External sessions offer what their integration proves. A Cognia run offers a
 * Stop and a reply only through the conversation that runs it: a chat turn
 * never registers with the run control plane, so a stop sent there would be
 * refused, and a run with no conversation (an IM job, a subagent) is opened in
 * its cockpit instead.
 */
function sessionCapabilities(
  session: FleetSession,
  owner: FleetOwnerRef,
  inputs: IslandProjectionInputs
): IslandRowCapabilities {
  const live = session.status !== "ended" && session.status !== "detached"
  const external = session.agent !== "cognia"
  const conversation = conversationControls(owner, inputs.conversations)
  const questions = session.pendingQuestions ?? []
  // Never consume a parked request using only the visible prefix of its
  // questions/options. The terminal remains available for larger requests.
  const completeQuestions =
    questions.length > 0 &&
    questions.length <= MAX_QUESTIONS &&
    questions.every(
      (question) => question.options.length > 0 && question.options.length <= MAX_OPTIONS
    )
  return {
    openOwner: ownerRoute(owner) !== null,
    permissionDecision:
      external &&
      live &&
      Boolean(session.pendingPermission) &&
      session.capabilities.approvePermission,
    questionResponse:
      external && live && Boolean(session.pendingQuestionRequest) && completeQuestions,
    reply: (external && session.capabilities.sendMessage && live) || conversation.reply,
    interrupt:
      (external && session.capabilities.interrupt && live) || (live && conversation.interrupt),
    focusTerminal: external && session.capabilities.focusTerminal,
    openTranscript:
      external && session.capabilities.openTranscript && Boolean(session.transcriptPath),
    dismissStale: false,
    detail: inputs.detailVisibility !== "summary-only",
  }
}

function rowFromSession(
  session: FleetSession,
  inputs: IslandProjectionInputs
): IslandRowProjection | null {
  const owner = fleetSessionOwner(session, (id) => id in inputs.conversations)
  const id = taskIdentity(owner)
  if (!id) return null

  const status = sessionStatus(session)
  // A conversation's approvals belong to the chat store, which is the only
  // side that knows whether one is still live and how it may be answered. The
  // attention row carries it and folds in below.
  const pending = owner.kind === "chat" ? null : session.pendingPermission
  const permission = pending
    ? {
        requestId: pending.requestId,
        kind: "tool" as const,
        toolName: safe(pending.toolName, TOOL_MAX) || null,
        requestedAt: pending.requestedAt,
        deadline: hookDeadline(session, pending.requestedAt),
        allowAlways: false,
      }
    : undefined
  const questions = questionsOf(session)
  const question =
    session.pendingQuestionRequest && questions.length > 0
      ? {
          requestId: session.pendingQuestionRequest.requestId,
          requestedAt: session.pendingQuestionRequest.requestedAt,
          deadline: hookDeadline(session, session.pendingQuestionRequest.requestedAt),
          questions,
        }
      : undefined

  // Tool NAME only. `activity.detail` carries the command or path the tool was
  // called with, which is exactly what must not survive a hover.
  const summary = status === "working" ? safe(session.activity?.toolName, SUMMARY_MAX) : ""
  const conversationTitle =
    owner.kind === "chat" ? inputs.conversations[owner.sessionId]?.title : undefined

  const row: IslandRowProjection = {
    id,
    source: owner.kind,
    owner,
    agent: session.agent,
    ...(session.agentLabel ? { agentLabel: safe(session.agentLabel, 32) } : {}),
    status,
    priority: ISLAND_STATUS_RANK[status],
    // A conversation is named by its own title. Otherwise a Cognia session id
    // is an opaque UUID, not a name: leave the title empty so an attention
    // item folded in below can supply one. External agents keep the session
    // id as the last resort, as their fleet list does.
    title: safe(
      conversationTitle ??
        session.projectName ??
        session.agentLabel ??
        (session.agent === "cognia" ? "" : session.sessionId),
      TITLE_MAX
    ),
    summary,
    startedAt: session.startedAt,
    updatedAt: session.lastEventAt,
    ...(status === "blocked" ? { waitingSince: session.lastEventAt } : {}),
    capabilities: sessionCapabilities(session, owner, inputs),
    ...(permission ? { permission } : {}),
    ...(question ? { question } : {}),
    ...(session.hostRef ? { hostRef: safe(session.hostRef, 32) } : {}),
    ...(session.terminal
      ? {
          terminal: {
            app: session.terminal.app,
            label: safe(session.terminal.label, 24) || session.terminal.app,
          },
        }
      : {}),
    stale: session.status === "detached",
  }
  return { ...row, statusKey: statusKeyFor(row) }
}

/**
 * Whether Dismiss can actually clear this row, which is the only reason to
 * render the button.
 *
 * Mirrors `AttentionPanel`'s rule: a fleet row has no clearing path at all, a
 * `human_handoff` is deliberately never expired (expiring it would silently
 * un-assign work a person still owns), and the other sources need the id their
 * clearing call takes. A row that would answer `callFailed` shows no button.
 */
function canDismissStale(item: AttentionItem, owner: FleetOwnerRef): boolean {
  switch (owner.kind) {
    case "gate":
      return item.gate?.status === "interrupted"
    case "chat":
      return Boolean(owner.requestId)
    case "run":
      return Boolean(owner.interruptId) && item.interrupt?.type !== "human_handoff"
    case "team":
    case "external":
      return false
  }
}

/**
 * Durable run approvals the island can answer: their approve carries no
 * payload, so a plain approve / deny through the run control plane is the
 * whole answer. Squad reviews that need a typed decision, a human handoff, an
 * ask-user question and a workflow approval stay in the main window.
 */
const PAYLOAD_FREE_RUN_APPROVALS: ReadonlyMap<ExecutionRunInterrupt["type"], IslandDecisionKind> =
  new Map([
    ["plan_approval", "plan"],
    ["tool_approval", "tool"],
    ["squad_capability_audit", "review"],
    ["delegation_approval", "review"],
    ["bot_approval", "review"],
    ["fusion_approval", "review"],
  ])

function runApprovalKind(interrupt: ExecutionRunInterrupt): IslandDecisionKind | null {
  if (interrupt.status !== "pending") return null
  const kind = PAYLOAD_FREE_RUN_APPROVALS.get(interrupt.type)
  if (!kind) return null
  // A tool approval without a digest is the durable twin of a conversation's
  // own approval: only the conversation can release its waiter.
  if (interrupt.type === "tool_approval" && !interrupt.requestDigest) return null
  return kind
}

/** The decision the island can make for a pending item, if any. */
function attentionDecision(
  item: AttentionItem,
  owner: FleetOwnerRef
): IslandRowProjection["permission"] | undefined {
  if (item.stale) return undefined
  if (owner.kind === "chat" && item.approval && item.approval.status !== "interrupted") {
    const approval = item.approval
    return {
      requestId: approval.requestId,
      kind: "tool",
      toolName: safe(approval.displayName ?? approval.toolName, TOOL_MAX) || null,
      requestedAt: item.openedAt,
      deadline: null,
      allowAlways: !approval.suppressAlwaysAllowRule,
    }
  }
  if (owner.kind === "gate" && item.gate?.status === "open") {
    return {
      requestId: item.gate.key.id,
      kind: item.gate.gateType === "plan_step" ? "plan" : "budget",
      toolName: null,
      requestedAt: item.gate.openedAt,
      deadline: null,
      allowAlways: false,
    }
  }
  if (owner.kind === "run" && item.interrupt) {
    const kind = runApprovalKind(item.interrupt)
    if (!kind) return undefined
    return {
      requestId: item.interrupt.id,
      kind,
      toolName: safe(item.interrupt.toolName, TOOL_MAX) || null,
      requestedAt: item.interrupt.createdAt,
      deadline: { at: item.interrupt.expiresAt, fallback: "lapse" },
      allowAlways: false,
    }
  }
  return undefined
}

function rowFromAttention(
  item: AttentionItem,
  inputs: IslandProjectionInputs
): IslandRowProjection | null {
  const owner = attentionOwner(item)
  if (!owner) return null
  const id = taskIdentity(owner)
  if (!id) return null

  const status: IslandRowStatus = item.stale ? "stale" : "blocked"
  const permission = attentionDecision(item, owner)
  const conversation = item.stale
    ? { interrupt: false, reply: false }
    : conversationControls(owner, inputs.conversations)
  const conversationTitle =
    owner.kind === "chat" ? inputs.conversations[owner.sessionId]?.title : undefined
  const row: IslandRowProjection = {
    id,
    source: owner.kind,
    owner,
    status,
    priority: ISLAND_STATUS_RANK[status],
    title: safe(conversationTitle ?? item.title, TITLE_MAX) || item.source,
    // The attention detail line is a gate body or an approval title, which can
    // quote a command. Only the tool name from the fleet branch is safe, and
    // that arrives through the merge below.
    summary: "",
    startedAt: item.openedAt,
    updatedAt: item.openedAt,
    waitingSince: item.openedAt,
    capabilities: {
      ...NO_ISLAND_CAPABILITIES,
      openOwner: ownerRoute(owner) !== null,
      permissionDecision: Boolean(permission),
      interrupt: conversation.interrupt,
      reply: conversation.reply,
      dismissStale: item.stale && canDismissStale(item, owner),
      detail: inputs.detailVisibility !== "summary-only",
    },
    ...(permission ? { permission } : {}),
    stale: item.stale,
  }
  return { ...row, statusKey: statusKeyFor(row) }
}

/** Prefer the owner that can actually clear the wait, when kinds agree. */
function ownerWithClearingIds(base: FleetOwnerRef, incoming: FleetOwnerRef): FleetOwnerRef {
  if (incoming.kind === "chat" && base.kind === "chat" && incoming.requestId) return incoming
  if (incoming.kind === "run" && base.kind === "run" && incoming.interruptId) return incoming
  return base
}

/**
 * Fold an attention observation into the session row that shares its identity.
 *
 * The attention side is authoritative about the human wait (it knows when the
 * ask opened and whether the waiter is still there). The session side is
 * authoritative about capabilities. Neither overwrites the other.
 */
function mergeRows(base: IslandRowProjection, incoming: IslandRowProjection): IslandRowProjection {
  // The session side proves liveness: a lingering attention entry whose waiter
  // is gone must not relabel a task that is demonstrably still running.
  const baseLive = base.status !== "stale" && base.status !== "done"
  const stale = base.stale || (incoming.stale && !baseLive)
  const status: IslandRowStatus = stale
    ? "stale"
    : base.status === "blocked" || incoming.status === "blocked"
      ? "blocked"
      : base.status
  const merged: IslandRowProjection = {
    ...base,
    // The session owner never carries the clearing ids (`requestId`,
    // `interruptId`); the attention owner does, and `dismissStale` needs them.
    owner: ownerWithClearingIds(base.owner, incoming.owner),
    agentLabel: base.agentLabel ?? incoming.agentLabel,
    status,
    priority: ISLAND_STATUS_RANK[status],
    stale,
    title: base.title || incoming.title,
    summary: base.summary || incoming.summary,
    startedAt: Math.min(base.startedAt, incoming.startedAt),
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt),
    waitingSince:
      base.waitingSince != null && incoming.waitingSince != null
        ? Math.min(base.waitingSince, incoming.waitingSince)
        : (base.waitingSince ?? incoming.waitingSince),
    permission: base.permission ?? incoming.permission,
    question: base.question ?? incoming.question,
    capabilities: {
      openOwner: base.capabilities.openOwner || incoming.capabilities.openOwner,
      permissionDecision:
        base.capabilities.permissionDecision || incoming.capabilities.permissionDecision,
      questionResponse:
        base.capabilities.questionResponse || incoming.capabilities.questionResponse,
      reply: base.capabilities.reply || incoming.capabilities.reply,
      interrupt: base.capabilities.interrupt || incoming.capabilities.interrupt,
      focusTerminal: base.capabilities.focusTerminal || incoming.capabilities.focusTerminal,
      openTranscript: base.capabilities.openTranscript || incoming.capabilities.openTranscript,
      dismissStale: stale && (base.capabilities.dismissStale || incoming.capabilities.dismissStale),
      detail: base.capabilities.detail || incoming.capabilities.detail,
    },
  }
  return { ...merged, statusKey: statusKeyFor(merged) }
}

/**
 * Fixed ordering: actionable human blocks, then failures, then working, then
 * recently finished, then idle, then stale. Blocked rows tie-break by the
 * oldest wait (the person has been kept longest), everything else by the most
 * recent update.
 */
export function sortIslandRows(rows: readonly IslandRowProjection[]): IslandRowProjection[] {
  return [...rows].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    if (a.status === "blocked") {
      const left = a.waitingSince ?? a.updatedAt
      const right = b.waitingSince ?? b.updatedAt
      if (left !== right) return left - right
    }
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    return a.id.localeCompare(b.id)
  })
}

/** Build the whole island projection. Pure. */
export function projectIslandState(
  inputs: IslandProjectionInputs,
  now: number = Date.now()
): IslandState {
  const byId = new Map<string, IslandRowProjection>()

  for (const session of inputs.fleet.sessions) {
    const row = rowFromSession(session, inputs)
    if (!row) continue
    // A finished session lingers so the user sees the result, then leaves.
    if (row.status === "done" && now - row.updatedAt > ISLAND_DONE_LINGER_MS) continue
    const existing = byId.get(row.id)
    byId.set(row.id, existing ? mergeRows(existing, row) : row)
  }

  for (const item of inputs.attention) {
    const row = rowFromAttention(item, inputs)
    if (!row) continue
    const existing = byId.get(row.id)
    byId.set(row.id, existing ? mergeRows(existing, row) : row)
  }

  const rows = sortIslandRows([...byId.values()]).map((row) =>
    row.title ? row : { ...row, title: row.agent ?? row.source }
  )
  return {
    epoch: inputs.epoch,
    revision: inputs.revision,
    generatedAt: now,
    activeCount: rows.filter((row) => row.status === "working" || row.status === "blocked").length,
    attentionCount: rows.filter((row) => row.status === "blocked").length,
    detailVisibility: inputs.detailVisibility,
    rows,
  }
}
