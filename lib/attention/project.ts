/**
 * Pure projection from the three pending-surface inputs to the unified
 * AttentionItem list. No store access, no side effects — the aggregation
 * store feeds it and the tests exercise it directly.
 */

import type { PendingApproval } from "@/lib/claude/types"
import type { PendingGate } from "@/stores/agent/pending-gates-store"
import type { PersistedApproval } from "@/stores/agent/approval-journal-store"
import type { FleetSnapshot } from "@/lib/fleet/types"
import type { AttentionItem, AttentionKind } from "./types"

export interface AttentionInputs {
  /** Per-session chat slices (only `pendingApprovals` is read). */
  chatSessions: Record<string, { pendingApprovals: readonly PendingApproval[] }>
  gates: readonly PendingGate[]
  fleet: FleetSnapshot
  /**
   * Durable approval-journal entries. Entries whose requestId is NOT present in
   * any live chat slice are surfaced as stale info items (e.g. interrupted
   * asks restored after a relaunch). Optional — omitted in older callers.
   */
  approvalJournal?: readonly PersistedApproval[]
}

/** Label for a chat approval — subagent asks name the asking subagent. */
function approvalTitle(approval: PendingApproval): string {
  const tool = approval.displayName ?? approval.toolName
  return approval.origin === "subagent" && approval.subagentId
    ? `${approval.subagentId} · ${tool}`
    : tool
}

/** Ascending priority rank — live permission-blocking items first, stale last. */
const KIND_RANK: Record<AttentionKind, number> = {
  "fleet-permission": 0,
  "tool-approval": 1,
  "hitl-gate": 2,
  "fleet-waiting": 3,
}

export function projectAttention(inputs: AttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = []

  const liveRequestIds = new Set<string>()
  for (const [bucketId, slice] of Object.entries(inputs.chatSessions)) {
    for (const approval of slice.pendingApprovals) {
      liveRequestIds.add(approval.requestId)
      items.push({
        id: `chat:${approval.requestId}`,
        source: "chat",
        kind: "tool-approval",
        title: approvalTitle(approval),
        detail: approval.title,
        openedAt: approval.requestedAt ?? 0,
        stale: approval.status === "interrupted",
        sessionId: bucketId,
        approval,
      })
    }
  }

  // Journal-only entries (not in any live slice) — e.g. asks restored as
  // interrupted after a relaunch. Surfaced as stale info items so the user
  // sees "N approvals were interrupted" rather than silent loss.
  for (const entry of inputs.approvalJournal ?? []) {
    if (liveRequestIds.has(entry.requestId) || entry.status === "settled") continue
    items.push({
      id: `chat:${entry.requestId}`,
      source: "chat",
      kind: "tool-approval",
      title:
        entry.origin === "subagent" && entry.subagentId
          ? `${entry.subagentId} · ${entry.toolName}`
          : entry.toolName,
      openedAt: entry.requestedAt,
      stale: true,
      sessionId: entry.bucketSessionId,
    })
  }

  for (const gate of inputs.gates) {
    items.push({
      id: `team:${gate.key.scope}:${gate.key.id}`,
      source: "team",
      kind: "hitl-gate",
      title: gate.title,
      detail: gate.body,
      openedAt: gate.openedAt,
      stale: gate.status === "interrupted",
      teamId: gate.teamId,
      runId: gate.runId,
      gate,
    })
  }

  for (const session of inputs.fleet.sessions) {
    if (session.pendingPermission) {
      items.push({
        id: `fleet:${session.agent}:${session.sessionId}`,
        source: "fleet",
        kind: "fleet-permission",
        title: session.projectName ?? session.agent,
        detail: session.pendingPermission.toolName ?? session.pendingPermission.detail ?? undefined,
        openedAt: session.pendingPermission.requestedAt,
        stale: false,
        fleetSession: session,
      })
    } else if (session.status === "plan-pending" || session.status === "waiting-input") {
      // Mirrors `lib/fleet/format.ts` attentionCount semantics (minus
      // waiting-permission, which the pendingPermission branch covers).
      items.push({
        id: `fleet:${session.agent}:${session.sessionId}`,
        source: "fleet",
        kind: "fleet-waiting",
        title: session.projectName ?? session.agent,
        detail: session.lastPrompt ?? undefined,
        openedAt: session.lastEventAt,
        stale: false,
        fleetSession: session,
      })
    }
  }

  return sortAttention(items)
}

/** Live items by kind priority then age (oldest first); stale items last. */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1
    const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind]
    if (rank !== 0) return rank
    return a.openedAt - b.openedAt
  })
}

/** Count of live (answerable) items — the badge number. */
export function liveAttentionCount(items: readonly AttentionItem[]): number {
  return items.filter((i) => !i.stale).length
}
