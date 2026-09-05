/**
 * Pure projection from the two live inputs (the unified Fleet snapshot and the
 * Control Center attention aggregation) to the read-only island state.
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
import type { FleetSession, FleetSnapshot } from "@/lib/fleet/types"
import { truncateLine } from "@/lib/fleet/format"
import { attentionOwner, fleetSessionOwner, ownerRoute, taskIdentity } from "./owner"
import {
  ISLAND_DONE_LINGER_MS,
  ISLAND_STATUS_RANK,
  NO_ISLAND_CAPABILITIES,
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
const QUESTION_MAX = 200
const OPTION_MAX = 48
const MAX_OPTIONS = 8
const MAX_QUESTIONS = 4

/** Redact then flatten then cap. The one gate every string passes through. */
function safe(value: string | null | undefined, max: number): string {
  if (!value) return ""
  return truncateLine(redactText(value).redacted, max)
}

export interface IslandProjectionInputs {
  fleet: FleetSnapshot
  attention: readonly AttentionItem[]
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
 * Capabilities for a monitored session, narrowed to what can actually be
 * honoured today.
 *
 * `interrupt` is hard-false for a `cognia` session: the Rust process-signal
 * path targets an external CLI's pid, and a Cognia run has none. Until a real
 * Cognia control adapter exists, the honest affordance is "open the page that
 * owns it", not a stop button that sends a signal to nobody.
 */
function sessionCapabilities(
  session: FleetSession,
  owner: FleetOwnerRef,
  detailVisibility: IslandDetailVisibility
): IslandRowCapabilities {
  const live = session.status !== "ended"
  const external = session.agent !== "cognia"
  return {
    openOwner: ownerRoute(owner) !== null,
    permissionDecision:
      Boolean(session.pendingPermission) && session.capabilities.approvePermission,
    questionResponse:
      Boolean(session.pendingQuestionRequest) && (session.pendingQuestions?.length ?? 0) > 0,
    reply: session.capabilities.sendMessage && live,
    interrupt: external && session.capabilities.interrupt && live,
    focusTerminal: external && session.capabilities.focusTerminal,
    openTranscript:
      external && session.capabilities.openTranscript && Boolean(session.transcriptPath),
    dismissStale: false,
    detail: detailVisibility !== "summary-only",
  }
}

function rowFromSession(
  session: FleetSession,
  detailVisibility: IslandDetailVisibility
): IslandRowProjection | null {
  const owner = fleetSessionOwner(session)
  const id = taskIdentity(owner)
  if (!id) return null

  const status = sessionStatus(session)
  const permission = session.pendingPermission
    ? {
        requestId: session.pendingPermission.requestId,
        toolName: safe(session.pendingPermission.toolName, 48) || null,
        requestedAt: session.pendingPermission.requestedAt,
      }
    : undefined
  const questions = questionsOf(session)
  const question =
    session.pendingQuestionRequest && questions.length > 0
      ? {
          requestId: session.pendingQuestionRequest.requestId,
          requestedAt: session.pendingQuestionRequest.requestedAt,
          questions,
        }
      : undefined

  // Tool NAME only. `activity.detail` carries the command or path the tool was
  // called with, which is exactly what must not survive a hover.
  const summary = status === "working" ? safe(session.activity?.toolName, SUMMARY_MAX) : ""

  const row: IslandRowProjection = {
    id,
    source: owner.kind,
    owner,
    agent: session.agent,
    status,
    priority: ISLAND_STATUS_RANK[status],
    // A Cognia session id is an opaque UUID, not a name: leave the title empty
    // so an attention item folded in below can supply one. External agents keep
    // the session id as the last resort, as their fleet list does.
    title: safe(
      session.projectName ?? (session.agent === "cognia" ? "" : session.sessionId),
      TITLE_MAX
    ),
    summary,
    startedAt: session.startedAt,
    updatedAt: session.lastEventAt,
    ...(status === "blocked" ? { waitingSince: session.lastEventAt } : {}),
    capabilities: sessionCapabilities(session, owner, detailVisibility),
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
    case "chat":
      return Boolean(owner.requestId)
    case "team":
      return Boolean(owner.teamId ?? owner.runId)
    case "run":
      return Boolean(owner.interruptId) && item.interrupt?.type !== "human_handoff"
    case "external":
      return false
  }
}

function rowFromAttention(
  item: AttentionItem,
  detailVisibility: IslandDetailVisibility
): IslandRowProjection | null {
  const owner = attentionOwner(item)
  if (!owner) return null
  const id = taskIdentity(owner)
  if (!id) return null

  const status: IslandRowStatus = item.stale ? "stale" : "blocked"
  const row: IslandRowProjection = {
    id,
    source: owner.kind,
    owner,
    status,
    priority: ISLAND_STATUS_RANK[status],
    title: safe(item.title, TITLE_MAX) || item.source,
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
      dismissStale: item.stale && canDismissStale(item, owner),
      detail: detailVisibility !== "summary-only",
    },
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
    const row = rowFromSession(session, inputs.detailVisibility)
    if (!row) continue
    // A finished session lingers so the user sees the result, then leaves.
    if (row.status === "done" && now - row.updatedAt > ISLAND_DONE_LINGER_MS) continue
    const existing = byId.get(row.id)
    byId.set(row.id, existing ? mergeRows(existing, row) : row)
  }

  for (const item of inputs.attention) {
    const row = rowFromAttention(item, inputs.detailVisibility)
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
