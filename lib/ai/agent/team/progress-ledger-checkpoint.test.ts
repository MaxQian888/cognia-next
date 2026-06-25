import { createLedgerCheckpoint } from "./progress-ledger-checkpoint"
import type { TeamRunContext } from "./team-run-context"
import type { AgentTeamTask } from "@/types/agent/agent-team"
import type { ReplanCheckpointOutcome } from "./replan-checkpoint"
import type { ProgressLedgerVerdict } from "./progress-ledger"

const task = (id: string): AgentTeamTask =>
  ({
    id,
    teamId: "team-1",
    title: id,
    description: id,
    dependencies: [],
  }) as unknown as AgentTeamTask

function makeCtx(
  progressLedger: Partial<NonNullable<TeamRunContext["team"]["config"]["progressLedger"]>> = {}
) {
  const addEvent = jest.fn()
  const setTaskStatus = jest.fn()
  const notify = jest.fn()
  const ctx = {
    runId: "run-1",
    teamId: "team-1",
    team: {
      id: "team-1",
      name: "Squad",
      task: "ship it",
      leadId: "lead-1",
      teammateIds: ["lead-1", "w1"],
      config: { progressLedger: { enabled: true, stallThreshold: 2, ...progressLedger } },
    },
    storeWriter: { addEvent, setTaskStatus },
    notifier: { notify },
  } as unknown as TeamRunContext
  return { ctx, addEvent, setTaskStatus, notify }
}

const outcome = (over: Partial<ReplanCheckpointOutcome> = {}): ReplanCheckpointOutcome => ({
  remaining: [],
  finish: false,
  decision: {
    action: "continue",
    reasoning: "x",
    newTasks: [],
    cancelTaskIds: [],
    reorderTaskIds: [],
  },
  ...over,
})

const verdict = (over: Partial<ProgressLedgerVerdict> = {}): ProgressLedgerVerdict => ({
  isSatisfied: false,
  isProgressing: false,
  isLooping: true,
  diagnosis: "stuck in a loop",
  recommendedAction: "replan",
  ...over,
})

describe("createLedgerCheckpoint", () => {
  it("delegates to the lead re-plan and skips the judge while progressing", async () => {
    const { ctx, addEvent } = makeCtx()
    const replan = jest.fn().mockResolvedValue(outcome())
    const judge = jest.fn()
    const cp = createLedgerCheckpoint({ ctx, replan, judge })
    // New task ids each wave → completedCount grows → progress, never stalls.
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    await cp({ justRanTaskIds: ["b"], remaining: [] })
    expect(replan).toHaveBeenCalledTimes(2)
    expect(judge).not.toHaveBeenCalled()
    expect(addEvent).toHaveBeenCalled() // progress_update emitted each wave
  })

  it("does not invoke the judge until the stall threshold is crossed", async () => {
    const { ctx } = makeCtx({ stallThreshold: 2 })
    const replan = jest.fn().mockResolvedValue(outcome())
    const judge = jest.fn().mockResolvedValue(verdict())
    const cp = createLedgerCheckpoint({ ctx, replan, judge })
    await cp({ justRanTaskIds: ["a"], remaining: [] }) // wave 1: baseline
    await cp({ justRanTaskIds: ["a"], remaining: [] }) // wave 2: stall #1 (< threshold)
    expect(judge).not.toHaveBeenCalled()
    await cp({ justRanTaskIds: ["a"], remaining: [] }) // wave 3: stall #2 → judge
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it("finishes the run early when the judge reports the objective is satisfied", async () => {
    const { ctx, setTaskStatus } = makeCtx()
    const replan = jest.fn().mockResolvedValue(outcome())
    const judge = jest.fn().mockResolvedValue(verdict({ isSatisfied: true }))
    const cp = createLedgerCheckpoint({ ctx, replan, judge })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    const res = await cp({ justRanTaskIds: ["a"], remaining: [task("left")] })
    expect(res.finish).toBe(true)
    expect(res.remaining).toEqual([])
    expect(setTaskStatus).toHaveBeenCalledWith("left", "cancelled")
  })

  it("autonomously opens a consensus when allowed, then falls through to re-plan", async () => {
    const { ctx } = makeCtx({ allowAutonomousConsensus: true })
    const replan = jest.fn().mockResolvedValue(outcome())
    const judge = jest.fn().mockResolvedValue(verdict({ recommendedAction: "consensus" }))
    const consensus = jest.fn()
    const cp = createLedgerCheckpoint({ ctx, replan, judge, consensus })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    expect(consensus).toHaveBeenCalledTimes(1)
    expect(consensus.mock.calls[0][0]).toMatchObject({ teamId: "team-1", initiatorId: "lead-1" })
    expect(replan).toHaveBeenCalled()
  })

  it("does NOT open a consensus when the flag is off", async () => {
    const { ctx } = makeCtx({ allowAutonomousConsensus: false })
    const replan = jest.fn().mockResolvedValue(outcome())
    const judge = jest.fn().mockResolvedValue(verdict({ recommendedAction: "consensus" }))
    const consensus = jest.fn()
    const cp = createLedgerCheckpoint({ ctx, replan, judge, consensus })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    expect(consensus).not.toHaveBeenCalled()
    expect(replan).toHaveBeenCalled()
  })

  it("autonomously delegates when allowed", async () => {
    const { ctx } = makeCtx({ allowAutonomousDelegation: true })
    const replan = jest.fn().mockResolvedValue(outcome())
    const judge = jest.fn().mockResolvedValue(verdict({ recommendedAction: "delegate" }))
    const delegate = jest
      .fn()
      .mockReturnValue({ delegation: {}, completionPromise: Promise.resolve({}) })
    const cp = createLedgerCheckpoint({ ctx, replan, judge, delegate })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    await cp({ justRanTaskIds: ["a"], remaining: [] })
    expect(delegate).toHaveBeenCalledTimes(1)
    expect(delegate.mock.calls[0][0]).toMatchObject({ sourceTeamId: "team-1" })
  })
})
