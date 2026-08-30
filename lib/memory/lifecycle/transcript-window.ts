/**
 * Durable transcript-window identity for learning jobs.
 *
 * Learning jobs persist only source identities, never transcript content, so a
 * worker recovering a queued job has to re-derive the conversation slice that
 * existed when the job was enqueued. That used to be encoded as a message COUNT
 * parsed back out of the dedupe key (`…:<n>` → `transcript.slice(0, n)`), which
 * replays the WRONG content whenever an edit leaves the length unchanged —
 * edit-and-resend, a regenerate, or a same-length message rewrite all produce a
 * different conversation at the same length.
 *
 * A `MemoryJobCheckpoint` pins the window to real message ids instead. The
 * legacy count is still appended to every dedupe key so rows written before this
 * module existed — and rows whose checkpoint is lost in a backup round-trip —
 * keep resolving exactly as they do today.
 *
 * Pure: no Dexie, no I/O. The worker maps the returned failure codes onto its
 * own terminal/retryable error classes.
 */

import type { MemoryJob, MemoryJobCheckpoint } from "@/types/memory/governance"

/** Minimum shape this module needs from a transcript entry. */
export interface TranscriptWindowEntry {
  id?: string
  role: string
  text: string
}

/**
 * Build the checkpoint for a window spanning the whole of `transcript`.
 *
 * Returns `undefined` when the endpoints carry no ids — the caller then emits a
 * legacy-shaped dedupe key and the resolver falls back to count slicing. Never
 * fabricate ids here: a wrong id resolves to a wrong window, which is the exact
 * failure this module exists to remove.
 */
export function buildJobCheckpoint(
  transcript: readonly TranscriptWindowEntry[],
  transcriptRevision: number | undefined
): MemoryJobCheckpoint | undefined {
  const first = transcript[0]
  const last = transcript[transcript.length - 1]
  if (!first?.id || !last?.id) return undefined
  return {
    transcriptRevision: transcriptRevision ?? 0,
    firstMessageId: first.id,
    lastMessageId: last.id,
    messageCount: transcript.length,
  }
}

/**
 * Stable identity for a transcript-window job, used as both the dedupe-key tail
 * and (for turn extraction) the evidence `sourceId` prefix.
 *
 * Always ends in `:<messageCount>` so `resolveJobTranscriptWindow`'s legacy
 * branch still recovers a CORRECT prefix length if the checkpoint is ever
 * missing. Deliberately excludes `transcriptRevision`: `updateMessageMetadata`
 * bumps the revision without changing any text (the timeline-label model calls
 * it fire-and-forget), and including it would re-mine every turn on every label
 * write, defeating `enqueueMemoryJob({ reuseCompleted: true })`.
 *
 * `legacyIdentity` is supplied BY THE CALLER rather than derived here, because
 * the two existing job kinds ship different fallback shapes — turn extraction
 * uses `<session>:turn:<n>` and session distillation uses `<session>:<n>`.
 * Emitting one shape for both would orphan every in-flight job of the other kind
 * in already-shipped databases: the dedupe lookup would miss, and the work would
 * be enqueued a second time.
 */
export function transcriptJobIdentity(
  checkpoint: MemoryJobCheckpoint | undefined,
  legacyIdentity: string
): string {
  if (!checkpoint) return legacyIdentity
  return `${checkpoint.lastMessageId}:${checkpoint.messageCount}`
}

export type TranscriptWindowFailureCode =
  /** A window endpoint no longer exists — the messages are gone, replay is meaningless. */
  | "source_missing"
  /** The window still resolves but spans a different number of messages than at enqueue time. */
  | "snapshot_changed"
  /** Neither a checkpoint nor a parsable legacy count — nothing to slice by. */
  | "transcript_checkpoint_unavailable"

export type TranscriptWindowResolution<T> =
  | {
      ok: true
      transcript: T[]
      /** Set when the session advanced past the checkpoint but the window verified intact. */
      resultCode?: "revision_advanced_window_intact"
    }
  | { ok: false; code: TranscriptWindowFailureCode; terminal: boolean }

/** Legacy path: the trailing `:<n>` of the dedupe key is the prefix length. */
export function legacyTranscriptCheckpoint(dedupeKey: string): number | undefined {
  const match = dedupeKey.match(/:(\d+)$/)
  if (!match) return undefined
  const length = Number(match[1])
  return Number.isSafeInteger(length) && length > 0 ? length : undefined
}

/**
 * Resolve the transcript slice a job was enqueued for.
 *
 * `sessionTranscriptRevision` drift is a SOFT signal: it only triggers the id +
 * count verification below. Treating drift as fatal would discard the majority
 * of valid jobs, because a metadata patch bumps the revision without touching a
 * single character of any message.
 */
export function resolveJobTranscriptWindow<T extends TranscriptWindowEntry>(
  job: Pick<MemoryJob, "dedupeKey" | "checkpoint">,
  fullTranscript: readonly T[],
  sessionTranscriptRevision: number | undefined
): TranscriptWindowResolution<T> {
  const checkpoint = job.checkpoint
  if (checkpoint) {
    const firstIndex = fullTranscript.findIndex((entry) => entry.id === checkpoint.firstMessageId)
    if (firstIndex < 0) return { ok: false, code: "source_missing", terminal: true }
    const lastIndex = fullTranscript.findIndex(
      (entry, index) => index >= firstIndex && entry.id === checkpoint.lastMessageId
    )
    if (lastIndex < 0) return { ok: false, code: "source_missing", terminal: true }

    const window = fullTranscript.slice(firstIndex, lastIndex + 1)
    if (window.length !== checkpoint.messageCount) {
      return { ok: false, code: "snapshot_changed", terminal: true }
    }
    const drifted =
      sessionTranscriptRevision !== undefined &&
      sessionTranscriptRevision !== checkpoint.transcriptRevision
    return drifted
      ? { ok: true, transcript: window, resultCode: "revision_advanced_window_intact" }
      : { ok: true, transcript: window }
  }

  const length = legacyTranscriptCheckpoint(job.dedupeKey)
  if (length === undefined || length > fullTranscript.length) {
    // Retryable, not terminal: the tail may simply not have been persisted yet.
    return { ok: false, code: "transcript_checkpoint_unavailable", terminal: false }
  }
  return { ok: true, transcript: fullTranscript.slice(0, length) }
}
