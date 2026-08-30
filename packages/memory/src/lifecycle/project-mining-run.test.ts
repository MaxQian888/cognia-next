import {
  ESTIMATED_MESSAGES_PER_WINDOW,
  PROJECT_MINING_RUN_TRANSITIONS,
  canClaimProjectMiningRun,
  canTransitionProjectMiningRun,
  estimateProjectMiningRun,
  isTerminalProjectMiningRun,
  projectMiningRunProgress,
} from "./project-mining-run"
import type { ProjectMiningRunStatus } from "../types/governance"

describe("the run state machine", () => {
  it("starts a run at preconsent and lets only a person move it on", () => {
    expect(PROJECT_MINING_RUN_TRANSITIONS.preconsent).toEqual(["queued", "cancelled"])
    expect(canTransitionProjectMiningRun("preconsent", "running")).toBe(false)
  })

  it("sends a resumed run back through queued, not straight to running", () => {
    // Resuming has to re-acquire the lease. A status that says "running" with
    // no owner is exactly the lie the lease exists to prevent.
    expect(canTransitionProjectMiningRun("paused", "running")).toBe(false)
    expect(canTransitionProjectMiningRun("paused", "queued")).toBe(true)
  })

  it("lets a run be cancelled from every non-terminal state", () => {
    for (const status of ["preconsent", "queued", "running", "paused"] as const) {
      expect(canTransitionProjectMiningRun(status, "cancelled")).toBe(true)
    }
  })

  it("makes the three end states final", () => {
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      expect(isTerminalProjectMiningRun(status)).toBe(true)
      expect(PROJECT_MINING_RUN_TRANSITIONS[status]).toEqual([])
    }
  })

  it("covers every status in the transition table", () => {
    // A new status with no row would silently be un-transitionable, which reads
    // as "cancel does nothing" rather than as a missing case.
    const statuses: ProjectMiningRunStatus[] = [
      "preconsent",
      "queued",
      "running",
      "paused",
      "succeeded",
      "failed",
      "cancelled",
    ]
    expect(Object.keys(PROJECT_MINING_RUN_TRANSITIONS).sort()).toEqual([...statuses].sort())
  })
})

describe("the lease", () => {
  const held = { leaseOwner: "w1", leaseExpiresAt: 1_000 }

  it("is free when nobody holds it", () => {
    expect(canClaimProjectMiningRun({}, "w2", 0)).toBe(true)
  })

  it("is renewable by its own holder", () => {
    expect(canClaimProjectMiningRun(held, "w1", 0)).toBe(true)
  })

  it("is not stealable while it is live", () => {
    expect(canClaimProjectMiningRun(held, "w2", 999)).toBe(false)
  })

  it("becomes claimable once it expires, so a closed tab cannot park a run", () => {
    expect(canClaimProjectMiningRun(held, "w2", 1_000)).toBe(true)
  })
})

describe("the preconsent estimate", () => {
  it("counts one model call per window", () => {
    const estimate = estimateProjectMiningRun({
      sessions: 1,
      messages: ESTIMATED_MESSAGES_PER_WINDOW * 4,
    })
    expect(estimate.windows).toBe(4)
  })

  it("never rounds a short conversation down to zero calls", () => {
    // Two messages is still one model call. Dividing by the average alone would
    // quote a sweep of fifty short sessions at zero.
    expect(estimateProjectMiningRun({ sessions: 50, messages: 100 }).windows).toBe(50)
  })

  it("quotes nothing for an empty workspace", () => {
    expect(estimateProjectMiningRun({ sessions: 0, messages: 0 })).toEqual({
      sessions: 0,
      messages: 0,
      windows: 0,
      estimatedInputTokens: 0,
    })
  })

  it("clamps nonsense counts rather than quoting a negative sweep", () => {
    expect(estimateProjectMiningRun({ sessions: -3, messages: -9 }).windows).toBe(0)
  })
})

describe("progress", () => {
  it("is null for an empty workspace rather than a bar pinned at zero", () => {
    expect(
      projectMiningRunProgress({
        sessionsScanned: 0,
        estimate: { sessions: 0, messages: 0, windows: 0, estimatedInputTokens: 0 },
      })
    ).toBeNull()
  })

  it("never exceeds one when the sweep outruns its estimate", () => {
    // Sessions created while the sweep runs are real, and a 130% bar is not.
    expect(
      projectMiningRunProgress({
        sessionsScanned: 13,
        estimate: { sessions: 10, messages: 0, windows: 0, estimatedInputTokens: 0 },
      })
    ).toBe(1)
  })
})
