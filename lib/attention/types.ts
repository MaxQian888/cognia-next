/**
 * Unified "needs your attention" projection (Control Center).
 *
 * Three independent pending surfaces exist today — chat tool approvals
 * (`stores/chat/chat-store.ts`), agent-team HITL gates
 * (`stores/agent/pending-gates-store.ts`) and external fleet agents
 * (`lib/fleet/fleet-stream-store.ts`) — with no aggregate view. AttentionItem
 * is the read-only projection each of them maps into; the aggregation store
 * (`attention-store.ts`) subscribes to all three and the status-bar panel
 * renders the union.
 */

import type { PendingApproval } from "@cognia/agent-config-types"
import type { PendingGate } from "@/stores/agent/pending-gates-store"
import type { FleetSession } from "@/lib/fleet/types"

export type AttentionSource = "chat" | "team" | "fleet"

export type AttentionKind =
  | "tool-approval" // chat PendingApproval
  | "hitl-gate" // team PendingGate
  | "fleet-permission" // fleet session with pendingPermission
  | "fleet-waiting" // fleet session plan-pending / waiting-input

export interface AttentionItem {
  /** Stable id: `chat:<requestId>` | `team:<scope>:<id>` | `fleet:<agent>:<sessionId>`. */
  id: string
  source: AttentionSource
  kind: AttentionKind
  /** Raw payload label (tool name / gate title / agent name) — i18n at render. */
  title: string
  detail?: string
  openedAt: number
  /** True when the underlying waiter is gone (interrupted) — render muted, sort last. */
  stale: boolean
  /** Navigation target for chat items (bucketed parent session id). */
  sessionId?: string
  teamId?: string
  runId?: string
  approval?: PendingApproval
  gate?: PendingGate
  fleetSession?: FleetSession
}
