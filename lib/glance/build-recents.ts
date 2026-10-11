/**
 * Recents slice: the conversations the user last touched, for one-click
 * resume (ADR-0225 §2). Same rule as the welcome page's "Continue" list:
 * newest first, archived ones out, the conversation already on screen out.
 */

import { redactText } from "@cognia/redact"

import { truncateLine } from "@/lib/fleet/format"

import { GLANCE_RECENTS_MAX_ROWS, type GlanceRecentsSlice } from "./snapshot"

const TITLE_MAX = 64

export interface RecentSessionInput {
  id: string
  title: string
  updatedAt: number
  archivedAt?: number | null
}

export function buildRecentsSlice(
  sessions: readonly RecentSessionInput[],
  activeSessionId: string | null,
  now: number
): GlanceRecentsSlice {
  const rows = sessions
    .filter((s) => s.archivedAt == null && s.id !== activeSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, GLANCE_RECENTS_MAX_ROWS)
    .map((s) => ({
      id: s.id,
      title: truncateLine(redactText(s.title).redacted, TITLE_MAX),
      updatedAt: s.updatedAt,
    }))
  return { updatedAt: now, rows }
}
