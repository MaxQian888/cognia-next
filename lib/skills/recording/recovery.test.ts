import {
  danglingRows,
  orphanedBundles,
  reconcileOnStartup,
  type LocalRecordingRow,
} from "./recovery"
import type { RecordStatus, RecoverableBundle } from "./types"

const ID = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"
const OTHER = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e02"

function native(patch: Partial<RecordStatus> = {}): RecordStatus {
  return { recording: false, stepCount: 0, usage: [], ...patch }
}

function row(patch: Partial<LocalRecordingRow> = {}): LocalRecordingRow {
  return { id: ID, status: "captured", updatedAt: 1, ...patch }
}

function bundle(patch: Partial<RecoverableBundle> = {}): RecoverableBundle {
  return {
    recordingId: ID,
    startedAt: 1,
    stepCount: 3,
    totalBytes: 100,
    outcome: "open",
    scopeSummary: "Safari",
    scopeKind: "window",
    ...patch,
  }
}

describe("reconcileOnStartup", () => {
  it("reattaches to a live session we already know about", () => {
    const plan = reconcileOnStartup(
      native({ recording: true, recordingId: ID }),
      [row({ status: "recording" })],
      []
    )
    expect(plan).toEqual({ action: "reattach", recordingId: ID })
  })

  it("adopts a live session we have no row for", () => {
    // A cleared profile or a fresh install: orphaning a running recording would
    // leave the input hook installed with nothing able to stop it.
    const plan = reconcileOnStartup(native({ recording: true, recordingId: ID }), [], [])
    expect(plan).toEqual({ action: "adopt", recordingId: ID })
  })

  it("offers a stranded recording rather than resuming it silently", () => {
    const plan = reconcileOnStartup(native(), [row({ status: "recording" })], [bundle()])
    expect(plan).toEqual({ action: "offerInterrupted", recordingId: ID, hasSteps: true })
  })

  it("reports a stranded recording that captured nothing", () => {
    const plan = reconcileOnStartup(
      native(),
      [row({ status: "recording" })],
      [bundle({ stepCount: 0 })]
    )
    expect(plan).toMatchObject({ action: "offerInterrupted", hasSteps: false })
  })

  it("handles a stranded row whose bundle is missing entirely", () => {
    const plan = reconcileOnStartup(native(), [row({ status: "recording" })], [])
    expect(plan).toMatchObject({ action: "offerInterrupted", hasSteps: false })
  })

  it("offers to resume captured, drafting and interrupted work", () => {
    for (const status of ["captured", "drafting", "interrupted"] as const) {
      expect(reconcileOnStartup(native(), [row({ status })], [])).toEqual({
        action: "offerResume",
        recordingId: ID,
      })
    }
  })

  it("does nothing when there is nothing to do", () => {
    expect(reconcileOnStartup(native(), [], [])).toEqual({ action: "none" })
  })

  it("prefers a stranded recording over merely resumable work", () => {
    const plan = reconcileOnStartup(
      native(),
      [row({ id: OTHER, status: "drafting" }), row({ status: "recording" })],
      []
    )
    expect(plan).toMatchObject({ action: "offerInterrupted", recordingId: ID })
  })
})

describe("orphanedBundles", () => {
  it("finds bundles with no local row", () => {
    // Exactly what a crash leaves behind. Never auto-deleted: a recording the
    // user has not seen is not ours to discard.
    expect(orphanedBundles([bundle(), bundle({ recordingId: OTHER })], [row()])).toEqual([
      bundle({ recordingId: OTHER }),
    ])
  })

  it("returns nothing when every bundle is known", () => {
    expect(orphanedBundles([bundle()], [row()])).toEqual([])
  })
})

describe("danglingRows", () => {
  it("finds rows whose capture is gone", () => {
    expect(danglingRows([row()], []).map((r) => r.id)).toEqual([ID])
  })

  it("ignores saved rows — the skill outlives its recording", () => {
    expect(danglingRows([row({ status: "saved" })], [])).toEqual([])
  })

  it("ignores rows whose bundle is present", () => {
    expect(danglingRows([row()], [bundle()])).toEqual([])
  })

  it("ignores conversation-derived rows that do not use a native bundle", () => {
    expect(danglingRows([row({ source: { kind: "session" } })], [])).toEqual([])
  })
})
