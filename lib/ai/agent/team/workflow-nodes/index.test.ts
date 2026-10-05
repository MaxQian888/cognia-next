/**
 * Unit tests for the team node implementations installed into the workflow
 * engine's port (ADR-0217): the task dispatch and lead review executors, and
 * the implementation map the port loads. `runTeamNode` and `reconcileTeamRun`
 * have their own focused suites; collaborators here are module-mocked.
 */

import type { StepExecutionContext, TriggerEvent } from "@/types/workflow/visual"
import { runTeamCompose, runTeamDelegate, runTeamMessage, runTeamStatus } from "./team-ops"
import {
  dispatchTeamTask,
  reconcileTeamRun,
  reviewTeamTask,
  runTeamNode,
  teamWorkflowNodes,
} from "./index"

const getTeamRunContext = jest.fn()
jest.mock("@/lib/ai/agent/team/team-run-context", () => ({
  getTeamRunContext: (...args: unknown[]) => getTeamRunContext(...args),
}))

const buildTeammatePrompt = jest.fn()
jest.mock("@/lib/ai/agent/team/agent-team-runtime-deps", () => ({
  buildTeammatePrompt: (...args: unknown[]) => buildTeammatePrompt(...args),
}))

const dispatchTeammate = jest.fn()
jest.mock("@/lib/ai/agent/team/teammate/dispatch-teammate", () => {
  class UnavailableRequiredTeammateError extends Error {
    constructor(readonly teammateId: string) {
      super(`required teammate "${teammateId}" is unavailable`)
      this.name = "UnavailableRequiredTeammateError"
    }
  }
  return {
    dispatchTeammate: (...args: unknown[]) => dispatchTeammate(...args),
    UnavailableRequiredTeammateError,
  }
})

const readDependencyResults = jest.fn()
const autoPublishTaskResult = jest.fn()
jest.mock("@/lib/ai/agent/team/memory/shared-memory-orchestrator", () => ({
  readDependencyResults: (...args: unknown[]) => readDependencyResults(...args),
  autoPublishTaskResult: (...args: unknown[]) => autoPublishTaskResult(...args),
}))

const buildReviewEvidence = jest.fn()
jest.mock("@/lib/ai/agent/team/ledger/review-evidence", () => ({
  buildReviewEvidence: (...args: unknown[]) => buildReviewEvidence(...args),
}))

const listAgentTeamEvidence = jest.fn()
jest.mock("@/lib/db/agent-team-runtime", () => ({
  listAgentTeamEvidence: (...args: unknown[]) => listAgentTeamEvidence(...args),
}))

const trigger: TriggerEvent = { workflowId: "wf", kind: "trigger.manual", payload: {}, originAt: 1 }

function ctx(
  params: Record<string, unknown>,
  upstream: Record<string, unknown> = {}
): StepExecutionContext {
  return {
    runId: "run-1",
    workflowId: "wf",
    stepId: "step",
    params,
    upstream,
    trigger,
    signal: new AbortController().signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  } as StepExecutionContext
}

function storeWriter() {
  return { setTaskStatus: jest.fn(), addMessage: jest.fn(), addEvent: jest.fn() }
}

beforeEach(() => {
  jest.clearAllMocks()
  buildTeammatePrompt.mockReturnValue("base prompt")
  readDependencyResults.mockReturnValue([])
  buildReviewEvidence.mockResolvedValue({ commitSha: "abc123" })
  listAgentTeamEvidence.mockResolvedValue([])
})

describe("teamWorkflowNodes", () => {
  it("maps every port slot to its implementation", () => {
    expect(teamWorkflowNodes).toEqual({
      run: runTeamNode,
      dispatchTask: dispatchTeamTask,
      reviewTask: reviewTeamTask,
      reconcile: reconcileTeamRun,
      compose: runTeamCompose,
      status: runTeamStatus,
      delegate: runTeamDelegate,
      message: runTeamMessage,
    })
  })
})

describe("dispatchTeamTask", () => {
  const team = { id: "team-1" }

  it("requires a team and a task, without retrying", async () => {
    await expect(dispatchTeamTask(ctx({ teamId: "team-1" }))).rejects.toMatchObject({
      message: expect.stringContaining("requires 'teamId' and 'taskId'"),
      retryable: false,
    })
  })

  it("fails without a TeamRunContext for the run", async () => {
    getTeamRunContext.mockReturnValue(undefined)
    await expect(dispatchTeamTask(ctx({ teamId: "team-1", taskId: "t1" }))).rejects.toThrow(
      /no TeamRunContext registered for runId=run-1/
    )
    expect(dispatchTeammate).not.toHaveBeenCalled()
  })

  it("prefixes upstream results, normalizes the dispatch shape and publishes the result", async () => {
    const teamCtx = { team }
    getTeamRunContext.mockReturnValue(teamCtx)
    readDependencyResults.mockReturnValue([
      { taskId: "dep", taskTitle: "Research", writerName: "Ada", value: "found it" },
    ])
    dispatchTeammate.mockResolvedValue({
      text: "done",
      teammateId: "mate",
      teammateName: "Mate",
      usage: { totalTokens: 5 },
      degradedReason: "fallback rail",
    })

    const result = await dispatchTeamTask(
      ctx({
        teamId: "team-1",
        taskId: "t1",
        title: "Build",
        dependencies: ["dep", "", 7],
        access: "something-else",
        taskKind: "ui",
        repositoryId: "primary",
        fileOwnership: ["src/a.ts", "", 3],
        assignedTo: "mate",
      })
    )

    expect(readDependencyResults).toHaveBeenCalledWith("team-1", ["dep"])
    const [, options] = dispatchTeammate.mock.calls[0]
    expect(options).toMatchObject({
      taskId: "t1",
      access: "write",
      taskKind: "ui",
      repositoryId: "primary",
      fileOwnership: ["src/a.ts"],
      preferTeammateId: "mate",
      validateOutput: true,
      recordToStore: true,
    })
    const prompt = options.prompt({ id: "mate" })
    expect(prompt).toContain("### Research (by Ada)\nfound it")
    expect(prompt.endsWith("base prompt")).toBe(true)
    expect(autoPublishTaskResult).toHaveBeenCalledWith(
      { id: "team-1" },
      { id: "t1", title: "Build" },
      "done",
      { id: "mate", name: "Mate" }
    )
    expect(result.output).toEqual({
      text: "done",
      teammateId: "mate",
      teammateName: "Mate",
      access: "write",
      taskKind: "ui",
      tokenUsage: { totalTokens: 5 },
      attempt: 1,
      degradedReason: "fallback rail",
    })
  })

  it("keeps read access, defaults the task kind to code and still completes when publishing fails", async () => {
    getTeamRunContext.mockReturnValue({ team })
    dispatchTeammate.mockResolvedValue({ text: "notes", teammateId: "m", teammateName: "M" })
    autoPublishTaskResult.mockImplementation(() => {
      throw new Error("blackboard offline")
    })

    const result = await dispatchTeamTask(ctx({ teamId: "team-1", taskId: "t1", access: "read" }))

    expect(dispatchTeammate.mock.calls[0][1].prompt({ id: "m" })).toBe("base prompt")
    expect(result.output).toMatchObject({ text: "notes", access: "read", taskKind: "code" })
  })
})

describe("reviewTeamTask", () => {
  const lead = { id: "lead" }
  const params = { teamId: "team-1", taskId: "t1", title: "Build", dispatchNodeId: "dispatch" }
  const upstream = {
    dispatch: { text: "v1", teammateId: "mate", teammateName: "Mate", access: "read" },
  }

  function reviewCtx(overrides: Record<string, unknown> = {}) {
    const writer = storeWriter()
    const teamCtx = {
      team: { config: {} },
      lead,
      runLeadReview: jest.fn(),
      storeWriter: writer,
      ...overrides,
    }
    getTeamRunContext.mockReturnValue(teamCtx)
    return teamCtx
  }

  it("requires the team, task and dispatch node", async () => {
    await expect(reviewTeamTask(ctx({ teamId: "team-1", taskId: "t1" }))).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("fails closed when no reviewer is wired", async () => {
    reviewCtx({ runLeadReview: undefined })
    await expect(reviewTeamTask(ctx(params, upstream))).rejects.toThrow(
      /no lead\/reviewer is wired/
    )
  })

  it("refuses to review a missing dispatch output", async () => {
    reviewCtx()
    await expect(reviewTeamTask(ctx(params, {}))).rejects.toThrow(
      /no output from dispatch node "dispatch"/
    )
  })

  it("approves with the task's durable evidence and completes the card", async () => {
    const teamCtx = reviewCtx()
    listAgentTeamEvidence.mockResolvedValue([
      { id: "ev-1", taskId: "t1" },
      { id: "ev-other", taskId: "t2" },
    ])
    teamCtx.runLeadReview.mockResolvedValue({ verdict: "approved", feedback: "ship it" })

    const result = await reviewTeamTask(ctx(params, upstream))

    expect(listAgentTeamEvidence).toHaveBeenCalledWith("run-1")
    expect(teamCtx.runLeadReview.mock.calls[0][0]).toMatchObject({
      task: { id: "t1", evidenceIds: ["ev-1"] },
      workerOutput: "v1",
      workerName: "Mate",
      revision: 0,
    })
    expect(teamCtx.storeWriter.setTaskStatus).toHaveBeenCalledWith("t1", "completed", "v1")
    expect(result.output).toEqual({
      text: "v1",
      verdict: "approved",
      revisions: 0,
      reviewedCommitSha: "abc123",
      teammateId: "mate",
      teammateName: "Mate",
    })
  })

  it("hands an approved card to a human when result review is required", async () => {
    const teamCtx = reviewCtx({
      team: { config: { governancePolicy: { approval: { requireResultReview: true } } } },
    })
    teamCtx.runLeadReview.mockResolvedValue({ verdict: "approved", feedback: "ok" })
    await reviewTeamTask(ctx(params, upstream))
    expect(teamCtx.storeWriter.setTaskStatus).toHaveBeenCalledWith("t1", "review", "v1")
  })

  it("sends changes back to the same worker with the same access, then approves", async () => {
    const teamCtx = reviewCtx()
    teamCtx.runLeadReview
      .mockResolvedValueOnce({ verdict: "changes_requested", feedback: "add tests" })
      .mockResolvedValueOnce({ verdict: "approved", feedback: "good" })
    dispatchTeammate.mockResolvedValue({ text: "v2", teammateId: "mate", teammateName: "Mate" })

    const result = await reviewTeamTask(ctx({ ...params, maxRevisions: 2 }, upstream))

    expect(dispatchTeammate.mock.calls[0][1]).toMatchObject({
      requireTeammateId: "mate",
      workspaceKey: "t1",
      access: "read",
      taskKind: "code",
    })
    expect(dispatchTeammate.mock.calls[0][1].prompt).toContain("add tests")
    expect(teamCtx.runLeadReview.mock.calls[1][0]).toMatchObject({
      workerOutput: "v2",
      revision: 1,
      previousFeedback: "add tests",
    })
    expect(result.output).toMatchObject({ text: "v2", verdict: "approved", revisions: 1 })
  })

  it("fails the task when the revision budget runs out", async () => {
    const teamCtx = reviewCtx()
    teamCtx.runLeadReview.mockResolvedValue({ verdict: "changes_requested", feedback: "no" })
    await expect(reviewTeamTask(ctx({ ...params, maxRevisions: 0 }, upstream))).rejects.toThrow(
      /still requested changes after 0 revision\(s\): no/
    )
    expect(dispatchTeammate).not.toHaveBeenCalled()
    expect(teamCtx.storeWriter.setTaskStatus).toHaveBeenCalledWith(
      "t1",
      "failed",
      undefined,
      expect.stringContaining("still requested changes")
    )
  })

  it("does not treat a reviewer failure as approval", async () => {
    const teamCtx = reviewCtx()
    teamCtx.runLeadReview.mockRejectedValue(new Error("provider down"))
    await expect(reviewTeamTask(ctx(params, upstream))).rejects.toThrow(
      /could not review this task \(provider down\)/
    )
  })

  it("fails when the original worker can no longer revise", async () => {
    const teamCtx = reviewCtx()
    const { UnavailableRequiredTeammateError } = jest.requireMock(
      "@/lib/ai/agent/team/teammate/dispatch-teammate"
    ) as { UnavailableRequiredTeammateError: new (id: string) => Error }
    teamCtx.runLeadReview.mockResolvedValue({ verdict: "changes_requested", feedback: "redo" })
    dispatchTeammate.mockRejectedValue(new UnavailableRequiredTeammateError("mate"))
    await expect(reviewTeamTask(ctx({ ...params, maxRevisions: 1 }, upstream))).rejects.toThrow(
      /original worker is no longer available/
    )
  })
})
