/**
 * Hand a half-written scheduled-task draft from wherever it was composed to
 * the scheduler page's create sheet.
 *
 * `conversational-task-authoring.ts` has produced `CreateScheduledTaskInput`
 * drafts since ADR-0002 §6, and `conversational-task-intent.ts` has been able
 * to spot "remind me every morning to triage PRs" in a chat message for just
 * as long. ADR-0002 describes the intended flow as "intent-classifier flows
 * can produce a partial draft for the user to finish in the form" — but no
 * such flow existed, so both modules were unreachable code.
 *
 * This is the missing seam. It is deliberately a module-level stash rather
 * than a URL parameter or a store:
 *
 *   - a draft carries a full prompt (and possibly a long one); putting it in
 *     the query string would leak conversation text into history and the
 *     address bar, and blow the practical URL length;
 *   - it is consumed exactly once, by the next `/scheduler` mount, so it does
 *     not belong in persisted state.
 *
 * A staged draft that nobody consumes expires (see {@link DRAFT_TTL_MS}) so a
 * user who stages one and never navigates does not get an unexpected sheet
 * days later.
 */

import type { CreateScheduledTaskInput } from "@/types/scheduler"

/** A staged draft older than this is dropped rather than opened. */
export const DRAFT_TTL_MS = 5 * 60_000

interface StagedDraft {
  input: Partial<CreateScheduledTaskInput>
  /** Short human-readable summary of what was detected, for the sheet. */
  summary?: string
  stagedAtMs: number
}

let staged: StagedDraft | null = null

/**
 * Park a draft for the scheduler page. Replaces any previous one — the newest
 * intent is the one the user just acted on.
 */
export function stageScheduledTaskDraft(
  input: Partial<CreateScheduledTaskInput>,
  options: { summary?: string; nowMs?: number } = {}
): void {
  staged = {
    input,
    summary: options.summary,
    stagedAtMs: options.nowMs ?? Date.now(),
  }
}

/**
 * Take the staged draft, if there is a fresh one. Always clears the stash, so
 * a second mount (React StrictMode's double-effect, a back-navigation) does
 * not reopen the sheet.
 */
export function consumeScheduledTaskDraft(
  options: { nowMs?: number } = {}
): { input: Partial<CreateScheduledTaskInput>; summary?: string } | null {
  const current = staged
  staged = null
  if (!current) return null
  const now = options.nowMs ?? Date.now()
  if (now - current.stagedAtMs > DRAFT_TTL_MS) return null
  return { input: current.input, summary: current.summary }
}

/** Test seam. */
export function __clearScheduledTaskDraftForTesting(): void {
  staged = null
}
