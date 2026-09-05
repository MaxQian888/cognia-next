/**
 * On-demand, redacted detail for one pinned island row.
 *
 * Built in the MAIN window and pushed once, in answer to an explicit request.
 * Nothing here is ever part of the regular projection, nothing is persisted,
 * and the overlay drops it the moment the row is unpinned, the island collapses
 * or the target stops existing.
 */

import { redactText } from "@cognia/redact"

import type { AttentionItem } from "@/lib/attention/types"
import { truncateLine } from "@/lib/fleet/format"
import type { FleetSession } from "@/lib/fleet/types"
import type { IslandRowDetail } from "./types"

/** Caps chosen so a detail block stays one card, not a log viewer. */
const PROMPT_MAX = 240
const PLAN_MAX = 400
const ERROR_MAX = 200
const ACTIVITY_MAX = 120
const PATH_MAX = 160

function safe(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined
  const flat = truncateLine(redactText(value).redacted, max)
  return flat.length > 0 ? flat : undefined
}

/** Redacted facts for a monitored session. */
export function detailFromSession(session: FleetSession): IslandRowDetail {
  return {
    cwd: safe(session.cwd, PATH_MAX) ?? null,
    gitBranch: safe(session.gitBranch, 64) ?? null,
    terminal: session.terminal?.sessionRef
      ? { sessionRef: safe(session.terminal.sessionRef, 48) }
      : null,
    startSource: session.startSource ?? null,
    toolUseCount: session.toolUseCount,
    turnCount: session.turnCount,
    agentPid: session.agentPid,
    startedAt: session.startedAt,
    ...(session.endedAt != null ? { endedAt: session.endedAt } : {}),
    status: session.status,
    model: session.model,
    permissionMode: session.permissionMode,
    ...(safe(session.lastPrompt, PROMPT_MAX)
      ? { prompt: safe(session.lastPrompt, PROMPT_MAX) }
      : {}),
    ...(safe(session.pendingPlan, PLAN_MAX) ? { plan: safe(session.pendingPlan, PLAN_MAX) } : {}),
    ...(safe(session.lastError?.detail, ERROR_MAX)
      ? { errorDetail: safe(session.lastError?.detail, ERROR_MAX) }
      : {}),
    ...(session.activity
      ? {
          activityLabel: [session.activity.toolName, safe(session.activity.detail, ACTIVITY_MAX)]
            .filter(Boolean)
            .join(": "),
        }
      : {}),
  }
}

/**
 * Redacted facts for a pending item that has no monitored session behind it.
 *
 * Chat approvals, team gates and run interrupts do not carry a runtime, so the
 * counters are zero and the useful part is the ask itself.
 */
export function detailFromAttention(item: AttentionItem): IslandRowDetail {
  return {
    cwd: null,
    toolUseCount: 0,
    turnCount: 0,
    agentPid: null,
    startedAt: item.openedAt,
    status: "waiting-input",
    model: null,
    permissionMode: null,
    ...(safe(item.detail, PROMPT_MAX) ? { prompt: safe(item.detail, PROMPT_MAX) } : {}),
  }
}
