/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import {
  createRunRetrospectiveService,
  generateConfiguredRunRetrospective,
} from "./run-retrospective"

const mockBuildUtilityLlmClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (args: unknown) => mockBuildUtilityLlmClient(args),
}))

async function terminalRun(
  id: string,
  status: "completed" | "failed" | "cancelled" = "completed",
  projectId?: string
) {
  await createExecutionRun({
    id,
    ...(projectId ? { projectId } : {}),
    kind: "agent-turn",
    sourceId: "turn-1",
    sessionId: "session-1",
    title: "Chat run",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
  })
  await runEventJournal.append(id, {
    ts: 2,
    type: "tool.started",
    visibility: "detail",
    payload: {
      toolName: "Read",
      summary: "Read jane@example.com",
      toolArguments: { password: "secret", path: "/private/raw" },
    },
  })
  await runEventJournal.append(id, {
    ts: 3,
    type:
      status === "completed"
        ? "run.completed"
        : status === "failed"
          ? "run.failed"
          : "run.cancelled",
    visibility: "summary",
    payload: { summary: "Finished" },
  })
}

describe("run retrospective service", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("generates once for a terminal ExecutionRun from redacted safe projections", async () => {
    await terminalRun("run-1")
    const runModel = jest.fn(async (_prompt: string) => ({
      issueTimeline: [{ at: 2, summary: "The read step needed review" }],
      proposals: [
        {
          targetKind: "memory-candidate" as const,
          title: "Remember the review boundary",
          after: "Notify jane@example.com only after approval",
          evidenceRefs: [{ namespace: "cognia", type: "execution-run", id: "run-1" }],
        },
      ],
    }))
    const service = createRunRetrospectiveService({ runModel, now: () => 10 })

    const first = await service.generate("run-1")
    const second = await service.generate("run-1")

    expect(second).toEqual(first)
    expect(runModel).toHaveBeenCalledTimes(1)
    const prompt = runModel.mock.calls[0]?.[0] ?? ""
    expect(prompt).toContain("<EMAIL_001>")
    expect(prompt).not.toContain("toolArguments")
    expect(prompt).not.toContain("password")
    expect(first.proposals[0]).toMatchObject({
      targetKind: "memory-candidate",
      status: "pending",
      after: "Notify <EMAIL_001> only after approval",
    })
  })

  it("rejects non-terminal runs and structurally oversized model output", async () => {
    await createExecutionRun({
      id: "running",
      kind: "agent-turn",
      sourceId: "turn-running",
      title: "Running",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const service = createRunRetrospectiveService({
      runModel: async () => ({ issueTimeline: [], proposals: [] }),
    })
    await expect(service.generate("running")).rejects.toThrow("terminal")

    await terminalRun("oversized")
    const oversized = createRunRetrospectiveService({
      runModel: async () => ({
        issueTimeline: [],
        proposals: Array.from({ length: 9 }, (_, index) => ({
          targetKind: "observation" as const,
          title: `Observation ${index}`,
          after: "safe",
        })),
      }),
    })
    await expect(oversized.generate("oversized")).rejects.toThrow("8 proposals")
  })
})

describe("generateConfiguredRunRetrospective", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    mockBuildUtilityLlmClient.mockReset()
  })

  it("attributes the analysis call to the run's own workspace", async () => {
    await terminalRun("run-ws", "completed", "ws-run")
    mockBuildUtilityLlmClient.mockReturnValue({
      complete: async () => JSON.stringify({ issueTimeline: [], proposals: [] }),
    })
    await generateConfiguredRunRetrospective("run-ws")
    expect(mockBuildUtilityLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "run-retrospective", workspaceId: "ws-run" })
    )
  })

  it("still refuses without a utility model", async () => {
    await terminalRun("run-none")
    mockBuildUtilityLlmClient.mockReturnValue(null)
    await expect(generateConfiguredRunRetrospective("run-none")).rejects.toThrow(
      /utility model is required/
    )
    expect(mockBuildUtilityLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null })
    )
  })
})
