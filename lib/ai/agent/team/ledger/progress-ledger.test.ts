import {
  assessProgressDeterministic,
  judgeProgress,
  type LedgerSnapshot,
  type ProgressLedgerVerdict,
} from "./progress-ledger"
import type { TeamRunContext } from "../team-run-context"
import { PROGRESS_LEDGER_JUDGE_PROMPT } from "../team-prompts"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"

const judgeCtx = {
  teamId: "team-1",
  team: { name: "Squad", task: "ship the feature" },
} as unknown as TeamRunContext

const verdict = (over: Partial<ProgressLedgerVerdict> = {}): ProgressLedgerVerdict => ({
  isSatisfied: false,
  isProgressing: false,
  isLooping: true,
  diagnosis: "stuck",
  recommendedAction: "replan",
  ...over,
})

const snap = (completedCount: number, outputChars: number): LedgerSnapshot => ({
  completedCount,
  outputChars,
})

describe("assessProgressDeterministic", () => {
  it("treats the first wave (no prior snapshot) as baseline progress", () => {
    const a = assessProgressDeterministic(undefined, snap(1, 100), 0)
    expect(a.stalled).toBe(false)
    expect(a.stallCount).toBe(0)
    expect(a.madeProgress).toBe(true)
  })

  it("counts new completed tasks as progress and resets the stall counter", () => {
    const a = assessProgressDeterministic(snap(1, 100), snap(2, 100), 3)
    expect(a.madeProgress).toBe(true)
    expect(a.stalled).toBe(false)
    expect(a.stallCount).toBe(0)
  })

  it("counts net new output as progress even with no new completed tasks", () => {
    const a = assessProgressDeterministic(snap(2, 100), snap(2, 500), 1)
    expect(a.madeProgress).toBe(true)
    expect(a.stallCount).toBe(0)
  })

  it("flags a stall when neither completed count nor output grew", () => {
    const a = assessProgressDeterministic(snap(2, 300), snap(2, 300), 0)
    expect(a.stalled).toBe(true)
    expect(a.madeProgress).toBe(false)
    expect(a.stallCount).toBe(1)
  })

  it("accumulates consecutive stalls", () => {
    const first = assessProgressDeterministic(snap(2, 300), snap(2, 300), 0)
    const second = assessProgressDeterministic(snap(2, 300), snap(2, 300), first.stallCount)
    expect(second.stallCount).toBe(2)
  })

  it("treats a shrinking output (e.g. a retracted result) as a stall, not progress", () => {
    const a = assessProgressDeterministic(snap(2, 500), snap(2, 400), 0)
    expect(a.stalled).toBe(true)
    expect(a.stallCount).toBe(1)
  })
})

describe("judgeProgress", () => {
  it("returns the verdict produced by the dispatch", async () => {
    const dispatch = jest.fn().mockResolvedValue(verdict({ recommendedAction: "consensus" }))
    const v = await judgeProgress({
      teamCtx: judgeCtx,
      doneTaskIds: ["t1"],
      remaining: [],
      stallCount: 2,
      dispatch,
    })
    expect(v.recommendedAction).toBe("consensus")
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("includes the objective and stall count in the judge prompt", async () => {
    const dispatch = jest.fn().mockResolvedValue(verdict())
    await judgeProgress({
      teamCtx: judgeCtx,
      doneTaskIds: [],
      remaining: [],
      stallCount: 3,
      dispatch,
    })
    const prompt = dispatch.mock.calls[0][0].prompt as string
    expect(prompt).toContain("ship the feature")
    expect(prompt).toMatch(/3/)
  })

  it("fails open to a non-escalating 'replan' verdict when the judge throws", async () => {
    const dispatch = jest.fn().mockRejectedValue(new Error("LLM down"))
    const v = await judgeProgress({
      teamCtx: judgeCtx,
      doneTaskIds: [],
      remaining: [],
      stallCount: 2,
      dispatch,
    })
    expect(v.recommendedAction).toBe("replan")
    expect(v.isProgressing).toBe(false)
  })
})

describe("judgeProgress — Prompt Center (ADR-0236)", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("sends the team project's customized judge prompt", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: PROGRESS_LEDGER_JUDGE_PROMPT.id,
          scope: "workspace",
          targetId: "ws-1",
          revisionId: "por-ledger-judge",
          body: 'Stalled on {{objective}}.\nDone: {{results}}\nLeft: {{remaining}}\nPick "continue", "replan", "consensus" or "delegate".',
          contractVersion: PROGRESS_LEDGER_JUDGE_PROMPT.contractVersion,
        },
      ])
    )
    const dispatch = jest.fn().mockResolvedValue(verdict())
    await judgeProgress({
      teamCtx: {
        teamId: "team-1",
        team: { name: "Squad", task: "ship the feature", projectId: "ws-1" },
      } as unknown as TeamRunContext,
      doneTaskIds: [],
      remaining: [],
      stallCount: 2,
      dispatch,
    })
    expect(dispatch.mock.calls[0][0].prompt).toBe(
      'Stalled on ship the feature.\nDone: (no captured output)\nLeft: (none)\nPick "continue", "replan", "consensus" or "delegate".'
    )
  })

  it("fails open without dispatching when the signal is already aborted", async () => {
    const dispatch = jest.fn().mockResolvedValue(verdict({ recommendedAction: "delegate" }))
    const controller = new AbortController()
    controller.abort()
    const v = await judgeProgress({
      teamCtx: judgeCtx,
      doneTaskIds: [],
      remaining: [],
      stallCount: 2,
      signal: controller.signal,
      dispatch,
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(v.recommendedAction).toBe("replan")
  })
})
