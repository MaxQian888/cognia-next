/**
 * Reconciling what the renderer thinks with what the native side actually has.
 *
 * The two can disagree in every combination, and each disagreement means
 * something different:
 *
 * | native | local row | what happened |
 * |---|---|---|
 * | recording | matching row | normal reattach — the Sheet was closed, or the app reloaded mid-recording |
 * | recording | none | the renderer lost its row (fresh profile, cleared storage); adopt the live session rather than orphan it |
 * | idle | row says `recording` | the app or the recorder died; the bundle on disk is the truth |
 * | idle | row says `drafting` | ordinary resume — reopen the draft |
 * | idle | none | nothing to do |
 *
 * The decision is pure so every row of that table is a test rather than a thing
 * to reason about at 3am.
 */

import type { RecordStatus, RecordingId, RecoverableBundle } from "./types"

export type LocalRecordingStatus =
  "recording" | "captured" | "drafting" | "saved" | "interrupted" | "discarded"

export interface LocalRecordingRow {
  id: RecordingId
  status: LocalRecordingStatus
  updatedAt: number
  source?: { kind: "session" | "run" }
}

export type RecoveryPlan =
  /** A native session is live and ours; rejoin it. */
  | { action: "reattach"; recordingId: RecordingId }
  /** A native session is live that we have no row for; adopt it. */
  | { action: "adopt"; recordingId: RecordingId }
  /**
   * A row claims to be recording but nothing is. The bundle is intact — offer
   * to pick up at review rather than deciding for the user.
   */
  | { action: "offerInterrupted"; recordingId: RecordingId; hasSteps: boolean }
  /** Work in progress the user can resume. */
  | { action: "offerResume"; recordingId: RecordingId }
  | { action: "none" }

/**
 * Decide what to do at startup, or when the Sheet reopens.
 *
 * `rows` are the local recordings that are not finished, newest first.
 */
export function reconcileOnStartup(
  native: RecordStatus,
  rows: readonly LocalRecordingRow[],
  bundles: readonly RecoverableBundle[]
): RecoveryPlan {
  if (native.recording && native.recordingId) {
    const known = rows.some((row) => row.id === native.recordingId)
    return known
      ? { action: "reattach", recordingId: native.recordingId }
      : { action: "adopt", recordingId: native.recordingId }
  }

  // Nothing is running. A row that still claims otherwise did not shut down
  // cleanly — the process died, or the kill switch fired while the app was gone.
  const stranded = rows.find((row) => row.status === "recording")
  if (stranded) {
    const bundle = bundles.find((b) => b.recordingId === stranded.id)
    return {
      action: "offerInterrupted",
      recordingId: stranded.id,
      hasSteps: (bundle?.stepCount ?? 0) > 0,
    }
  }

  const resumable = rows.find(
    (row) => row.status === "captured" || row.status === "drafting" || row.status === "interrupted"
  )
  if (resumable) return { action: "offerResume", recordingId: resumable.id }

  return { action: "none" }
}

/**
 * Bundles on disk with no local row.
 *
 * Left for the user to decide about, never auto-deleted: a recording they have
 * not seen is not ours to discard, and these are exactly the ones a crash
 * produces.
 */
export function orphanedBundles(
  bundles: readonly RecoverableBundle[],
  rows: readonly LocalRecordingRow[]
): RecoverableBundle[] {
  const known = new Set(rows.map((row) => row.id))
  return bundles.filter((bundle) => !known.has(bundle.recordingId))
}

/**
 * Local rows whose bundle is gone.
 *
 * A row without a bundle cannot be reviewed — the timeline and every frame lived
 * there — so it is only good for tidying up.
 */
export function danglingRows(
  rows: readonly LocalRecordingRow[],
  bundles: readonly RecoverableBundle[]
): LocalRecordingRow[] {
  const present = new Set(bundles.map((bundle) => bundle.recordingId))
  return rows.filter((row) => !row.source && row.status !== "saved" && !present.has(row.id))
}
