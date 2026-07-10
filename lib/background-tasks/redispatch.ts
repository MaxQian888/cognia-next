/**
 * Re-dispatch an interrupted (or finished) background run from its journal
 * row — the crash-recovery path. Two entry points share it:
 *
 *  - Job Center "Re-run" (kind `manual`): explicit user intent, resets the
 *    auto-resume attempt counter.
 *  - Boot auto-resume (kind `auto`, opt-in via
 *    `settings.backgroundTasks.autoResumeInterrupted`): re-dispatches THIS
 *    boot's freshly interrupted rows, chaining the attempt counter so a
 *    crash loop caps out instead of burning tokens forever.
 *
 * Never throws — failures resolve to a structured outcome the caller can
 * surface (toast / notification).
 */

import type { BackgroundTaskJournalRecord } from "./registry-core"

export type RedispatchOutcome =
  | { ok: true; runId: string }
  | { ok: false; reason: "missing-subagent" | "still-running" | "attempt-cap"; message: string }

export interface RedispatchOptions {
  kind: "manual" | "auto"
  /** Attempt cap for `auto` chains (default 2). Ignored for `manual`. */
  maxAutoResumeAttempts?: number
}

export const DEFAULT_MAX_AUTO_RESUME_ATTEMPTS = 2

/**
 * Re-dispatch a journaled run with its original subagent/prompt/tool flag as
 * a new BACKGROUND run, linking provenance both ways.
 */
export async function redispatchBackgroundRun(
  record: BackgroundTaskJournalRecord,
  options: RedispatchOptions
): Promise<RedispatchOutcome> {
  if (record.status === "running") {
    return {
      ok: false,
      reason: "still-running",
      message: `Run "${record.runId}" is still running.`,
    }
  }
  const priorAttempt = record.resumeAttempt ?? 0
  const cap = options.maxAutoResumeAttempts ?? DEFAULT_MAX_AUTO_RESUME_ATTEMPTS
  if (options.kind === "auto" && priorAttempt >= cap) {
    return {
      ok: false,
      reason: "attempt-cap",
      message: `Run "${record.runId}" reached the auto-resume cap (${cap}).`,
    }
  }

  const [{ getDispatchableSubagentDef }, { resolveCaller, startDispatchRun }] = await Promise.all([
    import("@/lib/claude/agents/subagents"),
    import("@/lib/claude/agents/dispatch-run"),
  ])
  if (!getDispatchableSubagentDef(record.subagentId)) {
    return {
      ok: false,
      reason: "missing-subagent",
      message: `Subagent "${record.subagentId}" is no longer available.`,
    }
  }

  const caller = await resolveCaller(record.sessionId)
  const { runId } = await startDispatchRun({
    subagentId: record.subagentId,
    prompt: record.prompt,
    toolsEnabled: record.toolsEnabled ?? true,
    background: true,
    parentSessionId: record.sessionId,
    caller,
    resumeOfRunId: record.runId,
    // Manual re-run = explicit user intent, reset the chain; auto chains it.
    resumeAttempt: options.kind === "auto" ? priorAttempt + 1 : 0,
  })

  try {
    const { updateBackgroundTaskRecord } = await import("@/lib/db/background-tasks")
    await updateBackgroundTaskRecord(record.runId, { resumedByRunId: runId })
  } catch {
    // Provenance bookkeeping is best-effort.
  }
  return { ok: true, runId }
}
