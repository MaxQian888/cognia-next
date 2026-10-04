/**
 * Auto-archive policy: which conversations a sweep may archive after a period
 * of inactivity (`AppSettings.conversationArchive.autoArchiveAfterDays`).
 *
 * Pure leaf — no Dexie, no stores, no scheduler — so the settings control can
 * import the allowed values without pulling in the sweep, and the selection is
 * testable as data. The sweep that reads the rows and writes the archive lives
 * in `./auto-archive-schedule.ts`.
 */

import type { ChatSession, ConversationArchiveSettings } from "@cognia/agent-config-types"

import { conversationLastActivityAt } from "@/lib/chat/conversation-list-model"
import { filterExposedSessions } from "@/lib/chat/session-exposure"

/**
 * The only day counts the policy accepts, ascending. "Off" is not in the list:
 * it is `null` / absent. A stored value outside this list (hand-edited
 * settings, an option a later build dropped) resolves to off, never to the
 * nearest option — silently archiving sooner than the user chose is the one
 * failure this policy must not have.
 */
export const AUTO_ARCHIVE_AFTER_DAYS_OPTIONS = Object.freeze([7, 14, 30, 60, 90] as const)

export type AutoArchiveAfterDays = (typeof AUTO_ARCHIVE_AFTER_DAYS_OPTIONS)[number]

export const AUTO_ARCHIVE_DAY_MS = 86_400_000

/** True when `value` is one of {@link AUTO_ARCHIVE_AFTER_DAYS_OPTIONS}. */
export function isAutoArchiveAfterDays(value: unknown): value is AutoArchiveAfterDays {
  return (AUTO_ARCHIVE_AFTER_DAYS_OPTIONS as readonly unknown[]).includes(value)
}

/** The effective day count, or `null` when the policy is off. */
export function resolveAutoArchiveAfterDays(
  settings: ConversationArchiveSettings | null | undefined
): AutoArchiveAfterDays | null {
  const value = settings?.autoArchiveAfterDays
  return isAutoArchiveAfterDays(value) ? value : null
}

// The basis a 30-day policy measures is the one the conversation list files
// under "older than a month" — one definition, in the list model.
export { conversationLastActivityAt }

/** The row fields the selection reads. */
export type AutoArchiveCandidate = Pick<
  ChatSession,
  | "id"
  | "kind"
  | "visibility"
  | "archivedAt"
  | "pinned"
  | "handoffLock"
  | "platformBinding"
  | "lastMessageAt"
  | "updatedAt"
  | "projectRole"
  | "projectThread"
  | "attachedChild"
>

export interface AutoArchiveSelectionOptions {
  /** Current time (ms). Injected so the selection is deterministic. */
  now: number
  /** Days of inactivity. A non-positive or non-finite value selects nothing. */
  afterDays: number
  /** The conversation that is open in the focused view, if any. */
  activeSessionId?: string | null
  /** Conversations with a turn in flight (streaming or awaiting approval). */
  runningIds?: ReadonlySet<string>
  /**
   * Conversations open anywhere else: a tab, an embedded pane, a background
   * hold. Someone is looking at (or holding) them, which is the opposite of
   * inactive, whatever the timestamps say.
   */
  openIds?: ReadonlySet<string>
}

/**
 * Whether one conversation may be auto-archived. Every exclusion is a
 * conversation the user did not leave behind, or one whose archive would break
 * something that still owns it:
 *
 * - not listed (`filterExposedSessions(…, "main-list")`): embedded workbench
 *   asides, workflow-editor and imported subagent transcripts are not
 *   conversations the user manages, and their owner finds them by binding;
 * - already archived;
 * - pinned: pinning is an explicit "keep this at hand";
 * - handed off (`handoffLock`): the row is frozen for a cross-host transfer and
 *   every metadata write to it is refused (`assertSessionWritable`), so one
 *   such id would fail the whole bulk archive;
 * - IM-bound (`platformBinding`): those conversations live in the inbox, which
 *   keeps its own archive path (ADR-0009);
 * - open or running: activity the timestamps cannot see yet;
 * - the project coordinator (ADR-0204): an archived coordinator is no longer
 *   "live", so the next `ensureCoordinatorSession` silently starts a
 *   replacement and every thread still pointing at the old one is stranded.
 *   A long-lived routing conversation is idle by design, so age says nothing;
 * - an unresolved project thread: `listProjectThreads` drops archived threads,
 *   so archiving one would take open work off the coordinator's board and out
 *   of its PR watch. A resolved thread is done and archives like any other;
 * - an attached child the parent still owns a live lifecycle for (`staged`
 *   or `running`): the parent dispatches or reports on it, and archiving the
 *   parent already closes its children.
 */
export function isAutoArchiveEligible(
  session: AutoArchiveCandidate,
  options: AutoArchiveSelectionOptions
): boolean {
  if (session.archivedAt != null) return false
  if (session.pinned) return false
  if (session.handoffLock) return false
  if (session.platformBinding) return false
  if (session.id === options.activeSessionId) return false
  if (options.runningIds?.has(session.id)) return false
  if (options.openIds?.has(session.id)) return false
  if (session.projectRole === "coordinator") return false
  if (session.projectRole === "thread" && session.projectThread?.resolvedAt == null) return false
  const childStatus = session.attachedChild?.status
  if (childStatus === "staged" || childStatus === "running") return false
  if (!Number.isFinite(options.afterDays) || options.afterDays <= 0) return false
  return options.now - conversationLastActivityAt(session) > options.afterDays * AUTO_ARCHIVE_DAY_MS
}

/**
 * The ids a sweep should archive, in the order given. Listing exposure is
 * applied first (see {@link isAutoArchiveEligible}); duplicate rows yield one
 * id.
 */
export function selectAutoArchiveCandidates(
  sessions: readonly AutoArchiveCandidate[],
  options: AutoArchiveSelectionOptions
): string[] {
  if (!Number.isFinite(options.afterDays) || options.afterDays <= 0) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const session of filterExposedSessions(sessions, "main-list")) {
    if (seen.has(session.id) || !isAutoArchiveEligible(session, options)) continue
    seen.add(session.id)
    ids.push(session.id)
  }
  return ids
}
