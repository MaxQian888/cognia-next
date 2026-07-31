import { createTargetFromSpec, type TargetDepsBundle } from "./create-from-spec"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const span: AgentTraceSpan = {
  id: "s",
  traceId: "t",
  spanId: "s",
  sessionId: "x",
  startTime: 1,
  operationName: "chat",
  providerName: "anthropic",
  surface: "chat",
}

const deps: TargetDepsBundle = {
  chat: {
    runTurn: jest.fn(async () => ({ text: "chat-out", sessionId: "sess" })),
    fetchSpans: jest.fn(async () => [span]),
    isToolCapable: () => true,
  },
  team: {
    runTeam: jest.fn(async ({ traceId }) => ({
      runId: "r",
      status: "completed",
      text: "team-out",
      traceId,
    })),
    fetchSpansByTrace: jest.fn(async () => [span]),
    isToolCapable: () => true,
  },
  workflow: {
    runWorkflow: jest.fn(async ({ traceId }) => ({
      runId: "r",
      status: "succeeded",
      output: "wf-out",
      traceId,
    })),
    fetchSpansByTrace: jest.fn(async () => [span]),
  },
}

const evalCase = {
  id: "c1",
  datasetId: "d",
  input: "go",
  capability: "x",
  source: "handwritten" as const,
  createdAt: 0,
  updatedAt: 0,
}

describe("createTargetFromSpec", () => {
  it("builds a chat target", async () => {
    const target = createTargetFromSpec(
      { kind: "chat", label: "c", model: "claude-opus-4-8" },
      deps
    )
    expect(target.label).toBe("c")
    expect((await target.run(evalCase)).output).toBe("chat-out")
  })

  it("builds a team target", async () => {
    const target = createTargetFromSpec({ kind: "team", label: "t", teamId: "tm" }, deps)
    expect((await target.run(evalCase)).output).toBe("team-out")
  })

  it("builds a workflow target", async () => {
    const target = createTargetFromSpec({ kind: "workflow", label: "w", workflowId: "wf" }, deps)
    expect((await target.run(evalCase)).output).toBe("wf-out")
  })

  it("threads the chat optional fields (characterId / cwd / timeoutMs)", async () => {
    const target = createTargetFromSpec(
      { kind: "chat", label: "c", model: "m", characterId: "char-1", cwd: "/tmp", timeoutMs: 5000 },
      deps
    )
    await target.run(evalCase)
    expect((deps.chat.runTurn as jest.Mock).mock.calls[0][0]).toMatchObject({
      characterId: "char-1",
      cwd: "/tmp",
      timeoutMs: 5000,
    })
  })

  it("threads the explicit providerId into chat execution", async () => {
    const target = createTargetFromSpec(
      { kind: "chat", label: "c", providerId: "anthropic", model: "m" },
      deps
    )
    await target.run(evalCase)
    expect((deps.chat.runTurn as jest.Mock).mock.calls.at(-1)?.[0]).toMatchObject({
      providerId: "anthropic",
    })
  })

  it("threads team / workflow timeoutMs", async () => {
    const team = createTargetFromSpec(
      { kind: "team", label: "t", teamId: "tm", timeoutMs: 9000 },
      deps
    )
    await team.run(evalCase)
    expect((deps.team.runTeam as jest.Mock).mock.calls[0][0].timeoutMs).toBe(9000)
    const wf = createTargetFromSpec(
      { kind: "workflow", label: "w", workflowId: "wf", timeoutMs: 7000 },
      deps
    )
    await wf.run(evalCase)
    expect((deps.workflow.runWorkflow as jest.Mock).mock.calls[0][0].timeoutMs).toBe(7000)
  })
})
