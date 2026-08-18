import type { AgentPlan, PlanStep, PlanStepStatus } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { PluginToolInvocationError } from "@/lib/plugin/core/invoke-plugin-tool"
import type { PlanRunContext } from "./plan-run-context"
import { PLAN_APPROVAL_SCOPE, dispatchPlanStepNode, planApprovalKey } from "./step-dispatch"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"

const executeAgentMock = jest.fn()
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: (...a: unknown[]) => executeAgentMock(...a),
}))

const waitForDecisionMock = jest.fn()
jest.mock("@/lib/runtime/approval-bus", () => ({
  waitForDecision: (...a: unknown[]) => waitForDecisionMock(...a),
}))

const getWorkflowMock = jest.fn()
jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: (...a: unknown[]) => getWorkflowMock(...a),
}))

const runWorkflowMock = jest.fn()
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflowMock(...a),
}))

const resolvePluginToolByNameMock = jest.fn()
const invokePluginToolMock = jest.fn()
jest.mock("@/lib/plugin/core/invoke-plugin-tool", () => {
  const actual = jest.requireActual("@/lib/plugin/core/invoke-plugin-tool")
  return {
    PluginToolInvocationError: actual.PluginToolInvocationError,
    resolvePluginToolByName: (...a: unknown[]) => resolvePluginToolByNameMock(...a),
    invokePluginTool: (...a: unknown[]) => invokePluginToolMock(...a),
  }
})

const invokeMcpToolMock = jest.fn()
jest.mock("@/lib/mcp/invoke", () => {
  const actual = jest.requireActual("@/lib/mcp/invoke")
  return {
    McpServerNotFoundError: actual.McpServerNotFoundError,
    invokeMcpTool: (...a: unknown[]) => invokeMcpToolMock(...a),
  }
})

const mcpHooks = {
  dispatchMCPServerConnect: jest.fn(),
  dispatchMCPToolCall: jest.fn(),
  dispatchMCPToolResult: jest.fn(),
  dispatchMCPServerDisconnect: jest.fn(),
}
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => mcpHooks,
}))

const dispatchTeammateMock = jest.fn()
jest.mock("@/lib/ai/agent/team/dispatch-teammate", () => ({
  dispatchTeammate: (...a: unknown[]) => dispatchTeammateMock(...a),
}))

const createPlanTeammateRunContextMock = jest.fn()
jest.mock("./plan-teammate-context", () => ({
  createPlanTeammateRunContext: (...a: unknown[]) => createPlanTeammateRunContextMock(...a),
}))

let storeStateMock: {
  teams: Record<
    string,
    { id: string; name: string; teammateIds: string[]; config: Record<string, unknown> }
  >
  teammates: Record<
    string,
    { id: string; name: string; role: string; config: Record<string, unknown> }
  >
}
jest.mock("@/stores/agent/agent-team-store/store", () => ({
  useAgentTeamStore: { getState: () => storeStateMock },
}))

function step(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: over.id ?? "s1",
    title: over.title ?? "do the thing",
    description: over.description,
    kind: over.kind ?? "agent_turn",
    status: "pending",
    order: 0,
    dependencies: [],
    params: over.params,
    attempts: over.attempts,
  }
}

function makeCtx(s: PlanStep): {
  ctx: PlanRunContext
  calls: Array<{ stepId: string; status: PlanStepStatus; patch?: Record<string, unknown> }>
} {
  const calls: Array<{ stepId: string; status: PlanStepStatus; patch?: Record<string, unknown> }> =
    []
  const plan: AgentPlan = {
    id: "p1",
    sessionId: "ses",
    characterId: "char_1",
    title: "plan",
    source: "manual",
    executionMode: "auto",
    steps: [s],
    status: "executing",
    totalSteps: 1,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  }
  const ctx: PlanRunContext = {
    runId: "r1",
    planId: "p1",
    plan,
    characterId: "char_1",
    writer: {
      setStepStatus: async (stepId, status, patch) => {
        calls.push({ stepId, status, patch: patch as Record<string, unknown> })
      },
    },
  }
  return { ctx, calls }
}

beforeEach(() => {
  executeAgentMock.mockReset()
  waitForDecisionMock.mockReset()
  getWorkflowMock.mockReset()
  runWorkflowMock.mockReset()
  resolvePluginToolByNameMock.mockReset()
  invokePluginToolMock.mockReset()
  dispatchTeammateMock.mockReset()
  createPlanTeammateRunContextMock.mockReset()
  invokeMcpToolMock.mockReset()
  mcpHooks.dispatchMCPServerConnect.mockReset()
  mcpHooks.dispatchMCPToolCall.mockReset()
  mcpHooks.dispatchMCPToolResult.mockReset()
  mcpHooks.dispatchMCPServerDisconnect.mockReset()
})

const signal = new AbortController().signal

describe("planApprovalKey", () => {
  it("namespaces by plan + step under the plan scope", () => {
    expect(planApprovalKey("p1", "s9")).toEqual({ scope: PLAN_APPROVAL_SCOPE, id: "p1:s9" })
  })
})

describe("dispatchPlanStepNode — agent_turn", () => {
  it("runs executeAgent tool-enabled as the plan character and marks completed", async () => {
    executeAgentMock.mockResolvedValue({ text: "did it", channel: "sidecar" })
    const { ctx, calls } = makeCtx(
      step({ kind: "agent_turn", params: { kind: "agent_turn", prompt: "go" } })
    )
    const res = await dispatchPlanStepNode(ctx, "s1", signal)
    expect(res.output).toMatchObject({ text: "did it" })
    expect(executeAgentMock).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({ toolsEnabled: true, characterId: "char_1" })
    )
    expect(calls.map((c) => c.status)).toEqual(["in_progress", "completed"])
    expect(calls[1].patch).toMatchObject({ result: "did it" })
  })

  it("derives the prompt from title + description when no param prompt", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok", channel: "text" })
    const { ctx } = makeCtx(step({ title: "Build", description: "the widget" }))
    await dispatchPlanStepNode(ctx, "s1", signal)
    expect(executeAgentMock).toHaveBeenCalledWith("Build\n\nthe widget", expect.anything())
  })

  it("marks the step failed and rethrows when the turn throws", async () => {
    executeAgentMock.mockRejectedValue(new Error("boom"))
    const { ctx, calls } = makeCtx(step({ attempts: 1 }))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toThrow("boom")
    expect(calls[1]).toMatchObject({ status: "failed", patch: { error: "boom", attempts: 2 } })
  })
})

describe("dispatchPlanStepNode — approval_gate", () => {
  it("completes when approved", async () => {
    waitForDecisionMock.mockResolvedValue({ outcome: "approve" })
    const { ctx, calls } = makeCtx(step({ kind: "approval_gate" }))
    const res = await dispatchPlanStepNode(ctx, "s1", signal)
    expect(res.output).toMatchObject({ outcome: "approve" })
    expect(waitForDecisionMock).toHaveBeenCalledWith(
      { scope: PLAN_APPROVAL_SCOPE, id: "p1:s1" },
      signal
    )
    expect(calls[1].status).toBe("completed")
  })

  it("fails (non-retryable) when rejected, carrying feedback", async () => {
    waitForDecisionMock.mockResolvedValue({ outcome: "reject", feedback: "no good" })
    const { ctx, calls } = makeCtx(step({ kind: "approval_gate" }))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      message: expect.stringContaining("no good"),
      retryable: false,
    })
    expect(calls[1].status).toBe("failed")
  })

  // The gate is only answerable if it reaches `usePendingGatesStore` — that
  // store is what `GateModalsHost` renders. Registering late (or not at all)
  // means the step blocks to the run timeout with no UI.
  it("registers the gate in the pending-gates store while blocked", async () => {
    usePendingGatesStore.setState({ gates: [] })
    let seen: ReturnType<typeof usePendingGatesStore.getState>["gates"] = []
    waitForDecisionMock.mockImplementation(async () => {
      seen = usePendingGatesStore.getState().gates
      return { outcome: "approve" }
    })
    const { ctx } = makeCtx(
      step({
        kind: "approval_gate",
        title: "Ship it?",
        params: { kind: "approval_gate", prompt: "Confirm the deploy" },
      })
    )
    await dispatchPlanStepNode(ctx, "s1", signal)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      key: { scope: PLAN_APPROVAL_SCOPE, id: "p1:s1" },
      gateType: "plan_step",
      title: "Ship it?",
      body: "Confirm the deploy",
      planId: "p1",
      sessionId: "ses",
      status: "open",
    })
  })

  it.each([
    ["approve", { outcome: "approve" } as const, false],
    ["reject", { outcome: "reject" } as const, true],
  ])("clears the gate entry after %s", async (_label, decision, throws) => {
    usePendingGatesStore.setState({ gates: [] })
    waitForDecisionMock.mockResolvedValue(decision)
    const { ctx } = makeCtx(step({ kind: "approval_gate" }))
    const run = dispatchPlanStepNode(ctx, "s1", signal)
    if (throws) await expect(run).rejects.toThrow()
    else await run
    expect(usePendingGatesStore.getState().gates).toHaveLength(0)
  })

  it("clears the gate entry when the wait aborts (pause / cancel)", async () => {
    usePendingGatesStore.setState({ gates: [] })
    waitForDecisionMock.mockRejectedValue(new Error("Aborted"))
    const { ctx } = makeCtx(step({ kind: "approval_gate" }))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toThrow("Aborted")
    expect(usePendingGatesStore.getState().gates).toHaveLength(0)
  })
})

describe("dispatchPlanStepNode — sub_workflow", () => {
  it("runs the nested workflow and completes on success", async () => {
    getWorkflowMock.mockResolvedValue({ id: "wf1", name: "Nested", nodes: [], edges: [] })
    runWorkflowMock.mockResolvedValue({ runId: "x", status: "succeeded", output: { ok: 1 } })
    const { ctx, calls } = makeCtx(
      step({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "wf1" } })
    )
    const res = await dispatchPlanStepNode(ctx, "s1", signal)
    expect(res.output).toEqual({ ok: 1 })
    expect(calls[1].status).toBe("completed")
  })

  it("fails when the workflow id is missing from params", async () => {
    const { ctx } = makeCtx(
      step({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "" } })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("fails when the workflow is not found", async () => {
    getWorkflowMock.mockResolvedValue(undefined)
    const { ctx } = makeCtx(
      step({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "ghost" } })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("fails (retryable) when the nested run did not succeed", async () => {
    getWorkflowMock.mockResolvedValue({ id: "wf1", name: "Nested", nodes: [], edges: [] })
    runWorkflowMock.mockResolvedValue({ runId: "x", status: "failed" })
    const { ctx } = makeCtx(
      step({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "wf1" } })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toThrow(/status "failed"/)
  })
})

describe("dispatchPlanStepNode — tool_call", () => {
  function toolStep(toolName = "web_fetch", input: Record<string, unknown> = { url: "x" }) {
    return step({ kind: "tool_call", params: { kind: "tool_call", toolName, input } })
  }

  it("resolves the owning plugin, invokes the tool, and completes", async () => {
    resolvePluginToolByNameMock.mockResolvedValue({ pluginId: "web-tools" })
    invokePluginToolMock.mockResolvedValue({
      result: { ok: 1 },
      pluginId: "web-tools",
      toolName: "web_fetch",
    })
    const { ctx, calls } = makeCtx(toolStep())
    const res = await dispatchPlanStepNode(ctx, "s1", signal)
    expect(res.output).toMatchObject({
      toolName: "web_fetch",
      pluginId: "web-tools",
      data: { ok: 1 },
    })
    expect(invokePluginToolMock).toHaveBeenCalledWith(
      "web-tools",
      "web_fetch",
      { url: "x" },
      expect.objectContaining({ signal, reason: "plan:tool_call", sessionId: "ses" })
    )
    expect(calls.map((c) => c.status)).toEqual(["in_progress", "completed"])
    expect(calls[1].patch).toMatchObject({ result: '{"ok":1}' })
  })

  it("is non-retryable when no plugin registered the tool name", async () => {
    resolvePluginToolByNameMock.mockResolvedValue(undefined)
    const { ctx } = makeCtx(toolStep("Read"))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      message: expect.stringContaining("agent_turn"),
      retryable: false,
    })
    expect(invokePluginToolMock).not.toHaveBeenCalled()
  })

  it("is non-retryable when params omit the tool name", async () => {
    const { ctx } = makeCtx(
      step({ kind: "tool_call", params: { kind: "tool_call", toolName: "", input: {} } })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it.each(["plugin-not-found", "plugin-disabled", "tool-not-found", "permission-denied"] as const)(
    "maps %s to a non-retryable failure",
    async (code) => {
      resolvePluginToolByNameMock.mockResolvedValue({ pluginId: "web-tools" })
      invokePluginToolMock.mockRejectedValue(
        new PluginToolInvocationError(code, "web-tools", "web_fetch", code)
      )
      const { ctx, calls } = makeCtx(toolStep())
      await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
        retryable: false,
      })
      expect(calls[1].status).toBe("failed")
    }
  )

  it("keeps execution-failed retryable (rethrows as-is)", async () => {
    resolvePluginToolByNameMock.mockResolvedValue({ pluginId: "web-tools" })
    const err = new PluginToolInvocationError("execution-failed", "web-tools", "web_fetch", "boom")
    invokePluginToolMock.mockRejectedValue(err)
    const { ctx, calls } = makeCtx(toolStep())
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toBe(err)
    expect((err as { retryable?: boolean }).retryable).toBeUndefined()
    expect(calls[1]).toMatchObject({ status: "failed", patch: { attempts: 1 } })
  })

  it("threads the abort signal into invokePluginTool", async () => {
    resolvePluginToolByNameMock.mockResolvedValue({ pluginId: "web-tools" })
    invokePluginToolMock.mockResolvedValue({
      result: "ok",
      pluginId: "web-tools",
      toolName: "web_fetch",
    })
    const ac = new AbortController()
    const { ctx } = makeCtx(toolStep())
    await dispatchPlanStepNode(ctx, "s1", ac.signal)
    expect(invokePluginToolMock).toHaveBeenCalledWith(
      "web-tools",
      "web_fetch",
      expect.anything(),
      expect.objectContaining({ signal: ac.signal })
    )
  })
})

describe("dispatchPlanStepNode — mcp_tool_call", () => {
  const mcpStep = (serverId: string, toolName: string, input?: Record<string, unknown>) =>
    step({ kind: "mcp_tool_call", params: { kind: "mcp_tool_call", serverId, toolName, input } })

  it("invokes the MCP tool, fires lifecycle hooks, and completes", async () => {
    invokeMcpToolMock.mockResolvedValue({
      serverId: "srv1",
      toolName: "screenshot",
      isError: false,
      content: [{ type: "text", text: "done" }],
    })
    const { ctx, calls } = makeCtx(mcpStep("srv1", "screenshot", { a: 1 }))
    const res = await dispatchPlanStepNode(ctx, "s1", signal)

    expect(invokeMcpToolMock).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv1", toolName: "screenshot", args: { a: 1 }, signal })
    )
    expect(mcpHooks.dispatchMCPServerConnect).toHaveBeenCalledWith("srv1", "srv1")
    expect(mcpHooks.dispatchMCPToolCall).toHaveBeenCalledWith("srv1", "screenshot", { a: 1 })
    expect(mcpHooks.dispatchMCPToolResult).toHaveBeenCalledWith(
      "srv1",
      "screenshot",
      expect.objectContaining({ isError: false })
    )
    expect(mcpHooks.dispatchMCPServerDisconnect).toHaveBeenCalledWith("srv1")
    expect((res.output as { serverId: string }).serverId).toBe("srv1")
    expect(calls.at(-1)).toMatchObject({ status: "completed" })
  })

  it("requires serverId and toolName", async () => {
    const { ctx } = makeCtx(
      step({
        kind: "mcp_tool_call",
        params: { kind: "mcp_tool_call", serverId: "", toolName: "x" },
      })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("maps McpServerNotFoundError to a non-retryable failure and still disconnects", async () => {
    const { McpServerNotFoundError } = jest.requireActual("@/lib/mcp/invoke")
    invokeMcpToolMock.mockRejectedValue(new McpServerNotFoundError("srv-missing"))
    const { ctx } = makeCtx(mcpStep("srv-missing", "x"))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
    expect(mcpHooks.dispatchMCPServerDisconnect).toHaveBeenCalledWith("srv-missing")
  })

  it("propagates non-not-found errors as retryable", async () => {
    const err = new Error("ECONNREFUSED")
    invokeMcpToolMock.mockRejectedValue(err)
    const { ctx } = makeCtx(mcpStep("srv1", "x"))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toBe(err)
  })
})

describe("dispatchPlanStepNode — teammate_dispatch", () => {
  function dispatchStep(
    over: Partial<{ teamId: string; teammateId: string; spawnPrompt: string }> = {}
  ) {
    return step({
      kind: "teammate_dispatch",
      params: {
        kind: "teammate_dispatch",
        teamId: over.teamId ?? "team1",
        teammateId: over.teammateId,
        spawnPrompt: over.spawnPrompt,
      },
    })
  }

  beforeEach(() => {
    storeStateMock = {
      teams: { team1: { id: "team1", name: "T", teammateIds: ["tm1"], config: {} } },
      teammates: { tm1: { id: "tm1", name: "Worker", role: "teammate", config: {} } },
    }
    createPlanTeammateRunContextMock.mockReturnValue({ runId: "r1", teamId: "team1" })
  })

  it("dispatches one teammate turn and completes with its text", async () => {
    dispatchTeammateMock.mockResolvedValue({
      text: "result",
      teammateId: "tm1",
      teammateName: "Worker",
      channel: "text",
    })
    const { ctx, calls } = makeCtx(dispatchStep({ spawnPrompt: "do x" }))
    const res = await dispatchPlanStepNode(ctx, "s1", signal)
    expect(res.output).toMatchObject({ text: "result", teammateId: "tm1", channel: "text" })
    expect(createPlanTeammateRunContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", team: expect.objectContaining({ id: "team1" }) })
    )
    expect(dispatchTeammateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: "s1",
        prompt: "do x",
        recordToStore: false,
        validateOutput: true,
      })
    )
    expect(calls[1].status).toBe("completed")
  })

  it("derives the prompt from the step when spawnPrompt is absent", async () => {
    dispatchTeammateMock.mockResolvedValue({
      text: "ok",
      teammateId: "tm1",
      teammateName: "Worker",
      channel: "text",
    })
    const { ctx } = makeCtx(
      step({
        kind: "teammate_dispatch",
        title: "Title",
        description: "Desc",
        params: { kind: "teammate_dispatch", teamId: "team1" },
      })
    )
    await dispatchPlanStepNode(ctx, "s1", signal)
    expect(dispatchTeammateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: "Title\n\nDesc" })
    )
  })

  it("is non-retryable when the team is not loaded", async () => {
    storeStateMock.teams = {}
    const { ctx } = makeCtx(dispatchStep())
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
    expect(dispatchTeammateMock).not.toHaveBeenCalled()
  })

  it("is non-retryable when a named teammate is missing", async () => {
    const { ctx } = makeCtx(dispatchStep({ teammateId: "ghost" }))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("is non-retryable when the team has no resolvable teammates", async () => {
    storeStateMock.teammates = {}
    const { ctx } = makeCtx(dispatchStep())
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("keeps a no-available-teammate failure retryable", async () => {
    const err = new Error("dispatchTeammate: no available teammate")
    dispatchTeammateMock.mockRejectedValue(err)
    const { ctx, calls } = makeCtx(dispatchStep())
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toBe(err)
    expect((err as { retryable?: boolean }).retryable).toBeUndefined()
    expect(calls[1].status).toBe("failed")
  })

  it("threads the abort signal into dispatchTeammate", async () => {
    dispatchTeammateMock.mockResolvedValue({
      text: "ok",
      teammateId: "tm1",
      teammateName: "Worker",
      channel: "text",
    })
    const ac = new AbortController()
    const { ctx } = makeCtx(dispatchStep())
    await dispatchPlanStepNode(ctx, "s1", ac.signal)
    expect(dispatchTeammateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: ac.signal })
    )
  })
})

describe("dispatchPlanStepNode — guards", () => {
  it("throws non-retryable when the step id is absent from the plan", async () => {
    const { ctx } = makeCtx(step())
    await expect(dispatchPlanStepNode(ctx, "ghost", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })
})
