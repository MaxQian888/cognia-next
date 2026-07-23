import type { CanonicalTurn } from "@cognia/agent-config-types/canonical-session"

import { recoverRun } from "./recover-run"
import type { RecoveryCandidate } from "./recovery-planner"

jest.mock("@/lib/workflow/runtime/run-lease", () => ({
  claimRunLease: jest.fn(),
  releaseRunLease: jest.fn(),
}))
jest.mock("@/lib/db/execution-runs", () => ({
  runEventJournal: { append: jest.fn() },
  semanticRunEvent: (type: string, payload: unknown, opts: { ts?: number }) => ({
    type,
    payload,
    ts: opts.ts,
    visibility: "summary",
  }),
}))

const turns = (texts: string[]): CanonicalTurn[] =>
  texts.map((text, i) => ({ turnId: `t${i}`, role: "user", text }))

function candidate(id: string, texts: string[]): RecoveryCandidate {
  return { id, kind: "canonical-log", fidelity: "structured", turns: turns(texts) }
}

const claim = jest.fn()
const release = jest.fn()
const append = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  claim.mockResolvedValue("claimed")
  release.mockResolvedValue(undefined)
  append.mockResolvedValue({})
})

const deps = { claimLease: claim, releaseLease: release, appendJournal: append }

describe("recoverRun", () => {
  it("claims the single-writer lease BEFORE planning; a held lease stops everything", async () => {
    claim.mockResolvedValue("held")
    const outcome = await recoverRun("run-1", [candidate("a", ["x"])], deps)
    expect(outcome).toEqual({ status: "lease-held" })
    expect(append).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it("auto plan keeps the lease and returns the dominant candidate", async () => {
    const outcome = await recoverRun(
      "run-1",
      [candidate("long", ["a", "b"]), candidate("short", ["a"])],
      deps
    )
    expect(outcome).toEqual({ status: "recovered", candidateId: "long" })
    expect(release).not.toHaveBeenCalled() // caller stays the single writer
    expect(append).not.toHaveBeenCalled()
  })

  it("a paused plan appends a first-class run.recovery_required event and releases the lease", async () => {
    const outcome = await recoverRun(
      "run-1",
      [candidate("a", ["x", "y"]), candidate("b", ["x", "FORKED"])],
      deps
    )
    expect(outcome).toMatchObject({ status: "recovery_required", reason: "forked-history" })
    expect(append).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        type: "run.recovery_required",
        payload: { reason: "forked-history", detail: ["a <> b"] },
      })
    )
    expect(release).toHaveBeenCalledWith("run-1")
  })

  it("a run without a lease row (not-found) still plans, and never releases what it never claimed", async () => {
    claim.mockResolvedValue("not-found")
    const outcome = await recoverRun("run-1", [], deps)
    expect(outcome).toMatchObject({ status: "recovery_required", reason: "no-candidates" })
    expect(append).toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })
})

describe("recoverRun default deps", () => {
  it("uses claimRunLease/releaseRunLease/runEventJournal when no overrides are given", async () => {
    const lease = jest.requireMock("@/lib/workflow/runtime/run-lease")
    const runs = jest.requireMock("@/lib/db/execution-runs")
    lease.claimRunLease.mockResolvedValue("claimed")
    lease.releaseRunLease.mockResolvedValue(undefined)
    runs.runEventJournal.append.mockResolvedValue({})

    const outcome = await recoverRun("run-default", [])
    expect(outcome).toMatchObject({ status: "recovery_required", reason: "no-candidates" })
    expect(lease.claimRunLease).toHaveBeenCalledWith("run-default")
    expect(runs.runEventJournal.append).toHaveBeenCalledWith(
      "run-default",
      expect.objectContaining({ type: "run.recovery_required" })
    )
    expect(lease.releaseRunLease).toHaveBeenCalledWith("run-default")
  })
})
