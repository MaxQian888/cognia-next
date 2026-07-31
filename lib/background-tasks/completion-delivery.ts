/**
 * Pure framing helpers for background-run lifecycle text:
 *
 *  - `frameBackgroundResults` renders settled background runs into ONE
 *    deterministic framed turn injected into the parent chat session (the
 *    OpenCode `resumeWhenIdle` pattern — the model reacts to results without
 *    polling `collect`).
 *  - `frameResumePrompt` re-frames a finished run's prompt + outcome as
 *    context for a follow-up dispatch (`resume` mode).
 *
 * Pure and host-agnostic: no store/Dexie imports, shared by renderer + CLI.
 * These are MODEL-facing strings (tool-turn framing), not UI copy.
 */

/** Per-entry cap on re-injected result text; `collect` returns the full output. */
export const BACKGROUND_RESULT_TEXT_CAP = 8_000

export interface BackgroundResultDeliveryEntry {
  runId: string
  subagentId: string
  status: "done" | "error"
  startedAt: number
  settledAt: number
  /** Result text (done) or error message + salvaged partial output (error). */
  text: string
}

/** "3s" / "2m 05s" / "1h 02m" — coarse elapsed formatting for the notice line. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${String(minutes).padStart(2, "0")}m`
}

function frameOne(entry: BackgroundResultDeliveryEntry): string {
  const elapsed = formatElapsed(entry.settledAt - entry.startedAt)
  const header = `[background task update] Subagent "${entry.subagentId}" (runId ${entry.runId}) finished in ${elapsed} (${entry.status}):`
  const truncated = entry.text.length > BACKGROUND_RESULT_TEXT_CAP
  const body = truncated ? entry.text.slice(0, BACKGROUND_RESULT_TEXT_CAP) : entry.text
  const note = truncated
    ? `\n… [truncated — use dispatch_agent({collect:"${entry.runId}"}) for the full output]`
    : ""
  return `${header}\n${body}${note}`
}

/**
 * Frame settled background runs into ONE deterministic turn, ordered by
 * `settledAt` ascending (stable across racing completions).
 */
export function frameBackgroundResults(entries: readonly BackgroundResultDeliveryEntry[]): string {
  return [...entries]
    .sort((a, b) => a.settledAt - b.settledAt || a.runId.localeCompare(b.runId))
    .map(frameOne)
    .join("\n\n")
}

/**
 * Build a delivery entry from a settled journal row (or the equivalent settle
 * payload). Returns `null` for non-terminal rows. Error rows keep the salvaged
 * partial output (resultText) ahead of an explicit cut-off note so the parent
 * model sees the last output, not just the failure (Claude Code parity).
 */
export function deliveryEntryFromJournal(record: {
  runId: string
  subagentId: string
  status: string
  startedAt: number
  settledAt?: number
  resultText?: string
  error?: string
}): BackgroundResultDeliveryEntry | null {
  if (record.status !== "done" && record.status !== "error") return null
  const settledAt = record.settledAt ?? record.startedAt
  if (record.status === "done") {
    return {
      runId: record.runId,
      subagentId: record.subagentId,
      status: "done",
      startedAt: record.startedAt,
      settledAt,
      text: record.resultText ?? "",
    }
  }
  const error = record.error ?? "Background run failed."
  const partial = record.resultText && record.resultText !== error ? record.resultText : ""
  return {
    runId: record.runId,
    subagentId: record.subagentId,
    status: "error",
    startedAt: record.startedAt,
    settledAt,
    text: partial
      ? `${partial}\n\n[Subagent was cut off by an error and did not finish: ${error}]`
      : error,
  }
}

/**
 * Frame a `resume` follow-up: the prior prompt + outcome become explicit
 * context so the re-dispatched subagent continues rather than starts cold.
 * (The ephemeral session is deleted after a run — prompt + final text are all
 * that survives; true session resume is a documented upgrade path.)
 */
export function frameResumePrompt(
  prior: { prompt: string; outcome: string },
  followUp: string
): string {
  return (
    `You previously worked on this task:\n${prior.prompt}\n\n` +
    `Your result was:\n${prior.outcome}\n\n` +
    `Follow-up:\n${followUp}`
  )
}
