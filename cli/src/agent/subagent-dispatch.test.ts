/**
 * @jest-environment node
 */
import {
  buildCliSubagentToolManifest,
  clearCliSubagentContext,
  getCliSubagentContext,
  handleCliDispatchAgent,
  makeCliPluginToolHandle,
  registerCliSubagentContext,
  type CliSubagentDispatchContext,
} from "./subagent-dispatch"
import type { AgentSummary } from "./discover-agents"
import type { PluginToolExecRequest } from "@/lib/claude/plugin-tool-ipc"
import { DISPATCH_AGENT_TOOL_NAME } from "@/lib/claude/agents/dispatch-agent-tool"
import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import { createPermissionGate } from "./permission-gate"
import {
  __clearAllCliBackgroundRunsForTesting,
  __disposeCliBackgroundJournalForTesting,
} from "./subagent-background-tasks"

// For the end-to-end test below: mock the live-sidecar collaborators so a call
// routed through the REAL handle → REAL handleCliDispatchAgent → REAL
// runCliSubagent exercises the full path without a sidecar. Tests that inject
// `ctx.run` bypass runCliSubagent entirely and are unaffected by these mocks.
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ provider: "opencode-go" })),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: jest.fn(async (sessionId: string) => ({
    text: `subagent reply for ${sessionId}`,
    messageId: "m",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
    usage: { inputTokens: 6, outputTokens: 3 },
    resultSubtype: "success",
  })),
}))
jest.mock("@/lib/claude/ipc", () => ({ closeSession: jest.fn(async () => undefined) }))

const agent = (id: string, description = ""): AgentSummary => ({
  id,
  name: id,
  description,
  def: { id, name: id, description, prompt: `prompt-${id}` },
})

function makeCtx(overrides: Partial<CliSubagentDispatchContext> = {}): CliSubagentDispatchContext {
  return {
    agents: [agent("reviewer", "reviews code")],
    config: {
      ...DEFAULT_RESOLVED_CONFIG,
      builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
      cwd: "/work",
    },
    home: "/home/.cognia",
    cwd: "/work",
    gate: createPermissionGate({ yes: true }),
    mcpServers: [],
    approvedTools: new Set<string>(),
    disabledMcpTools: new Set<string>(),
    run: async () => ({ text: "ran" }),
    ...overrides,
  }
}

function req(
  args: Record<string, unknown>,
  name = DISPATCH_AGENT_TOOL_NAME
): PluginToolExecRequest {
  return { type: "plugin_tool_exec", sessionId: "s1", toolUseId: "t1", name, args }
}

afterEach(async () => {
  clearCliSubagentContext("s1")
  await __disposeCliBackgroundJournalForTesting()
  __clearAllCliBackgroundRunsForTesting()
})

describe("buildCliSubagentToolManifest", () => {
  it("returns null when there are no subagents", () => {
    expect(buildCliSubagentToolManifest([])).toBeNull()
  })

  it("builds a dispatch_agent entry seeded with the available subagents", () => {
    const m = buildCliSubagentToolManifest([agent("reviewer", "reviews")])
    expect(m?.name).toBe(DISPATCH_AGENT_TOOL_NAME)
    expect(JSON.stringify(m)).toContain("reviewer")
  })
})

describe("register / clear / get context", () => {
  it("round-trips a context by session id", () => {
    const ctx = makeCtx()
    registerCliSubagentContext("s1", ctx)
    expect(getCliSubagentContext("s1")).toBe(ctx)
    clearCliSubagentContext("s1")
    expect(getCliSubagentContext("s1")).toBeUndefined()
  })
})

describe("handleCliDispatchAgent", () => {
  it("errors when no context is registered for the session", async () => {
    const resp = await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "go" }))
    expect(resp.error).toContain("no active subagent context")
  })

  it("runs a single dispatch and formats the reply with a token/finish suffix", async () => {
    const run = jest.fn().mockResolvedValue({
      text: "looks good",
      usage: { inputTokens: 10, outputTokens: 4 },
      finishReason: "error_max_turns",
    })
    registerCliSubagentContext("s1", makeCtx({ run }))
    const resp = await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "check" }))
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reviewer" }),
      "check",
      "s1",
      expect.objectContaining({ cwd: "/work" })
    )
    expect(resp.result).toContain("looks good")
    expect(resp.result).toContain("14 tok")
    expect(resp.result).toContain("error_max_turns")
  })

  it("reports an unknown subagent id with the available list", async () => {
    registerCliSubagentContext("s1", makeCtx())
    const resp = await handleCliDispatchAgent(req({ subagentId: "ghost", prompt: "go" }))
    expect(resp.result).toContain('Unknown subagent "ghost"')
    expect(resp.result).toContain("reviewer")
  })

  it("fans out a parallel dispatch and joins the results", async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce({ text: "A done" })
      .mockResolvedValueOnce({ text: "B done" })
    registerCliSubagentContext("s1", makeCtx({ agents: [agent("a"), agent("b")], run }))
    const resp = await handleCliDispatchAgent(
      req({
        dispatches: [
          { subagentId: "a", prompt: "pa" },
          { subagentId: "b", prompt: "pb" },
        ],
      })
    )
    expect(resp.result).toContain("A done")
    expect(resp.result).toContain("B done")
    expect(resp.result).toContain("---")
  })

  it("surfaces a thrown run as a failed-line result", async () => {
    registerCliSubagentContext(
      "s1",
      makeCtx({
        run: async () => {
          throw new Error("nope")
        },
      })
    )
    const resp = await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "go" }))
    expect(resp.result).toContain("failed: nope")
  })

  it("returns the parse-error message for an unusable payload", async () => {
    registerCliSubagentContext("s1", makeCtx())
    const resp = await handleCliDispatchAgent(req({}))
    expect(resp.result).toContain("dispatch_agent:")
  })

  it("starts a background dispatch and returns a runId immediately", async () => {
    let resolveRun!: (r: { text: string }) => void
    const run = jest.fn(
      () =>
        new Promise<{ text: string }>((res) => {
          resolveRun = res
        })
    )
    registerCliSubagentContext("s1", makeCtx({ run, mintRunId: () => "bg-xyz" }))
    const resp = await handleCliDispatchAgent(
      req({ subagentId: "reviewer", prompt: "go", background: true })
    )
    // The dispatch returned before the run settled.
    expect(resp.result).toContain("started in background")
    expect(resp.result).toContain("bg-xyz")
    expect(run).toHaveBeenCalledTimes(1)
    resolveRun({ text: "bg done" })
  })

  it("collects a backgrounded run's result on a later collect call", async () => {
    const run = jest.fn().mockResolvedValue({ text: "async finished" })
    registerCliSubagentContext("s1", makeCtx({ run, mintRunId: () => "bg-collect" }))
    await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "go", background: true }))
    const resp = await handleCliDispatchAgent(req({ collect: "bg-collect" }))
    expect(resp.result).toContain("async finished")
    // A second collect of the same id is now unknown (entry dropped).
    const again = await handleCliDispatchAgent(req({ collect: "bg-collect" }))
    expect(again.result).toContain('no background run "bg-collect"')
  })

  it("reports an unknown subagent synchronously even in background mode", async () => {
    registerCliSubagentContext("s1", makeCtx())
    const resp = await handleCliDispatchAgent(
      req({ subagentId: "ghost", prompt: "go", background: true })
    )
    expect(resp.result).toContain('Unknown subagent "ghost"')
    expect(resp.result).not.toContain("started in background")
  })

  it("returns a clean message when collecting an unknown runId", async () => {
    registerCliSubagentContext("s1", makeCtx())
    const resp = await handleCliDispatchAgent(req({ collect: "nope" }))
    expect(resp.result).toContain('no background run "nope"')
  })
})

describe("makeCliPluginToolHandle", () => {
  it("routes dispatch_agent + Task to the CLI handler and everything else to the fallback", async () => {
    const fallback = jest
      .fn()
      .mockResolvedValue({ type: "plugin_tool_response", sessionId: "s1", toolUseId: "t1" })
    const handle = makeCliPluginToolHandle(fallback)
    registerCliSubagentContext("s1", makeCtx())

    const a = await handle(req({ subagentId: "reviewer", prompt: "go" }, "dispatch_agent"))
    expect(a.result).toContain("ran")
    const b = await handle(req({ subagentId: "reviewer", prompt: "go" }, "Task"))
    expect(b.result).toContain("ran")
    expect(fallback).not.toHaveBeenCalled()

    await handle(req({}, "web_search"))
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it("routes load_skill to the CLI skill-load handler, not the fallback", async () => {
    const fallback = jest
      .fn()
      .mockResolvedValue({ type: "plugin_tool_response", sessionId: "s1", toolUseId: "t1" })
    const handle = makeCliPluginToolHandle(fallback)
    // No skill_id → the handler guides the model (settles without the fallback).
    const resp = await handle(req({}, "load_skill"))
    expect(fallback).not.toHaveBeenCalled()
    expect(resp.type).toBe("plugin_tool_response")
    expect(resp.result).toContain("skill_id")
  })

  it("defaults the fallback to the shared plugin-tool handler", () => {
    expect(typeof makeCliPluginToolHandle()).toBe("function")
  })
})

describe("end-to-end: handle → handler → real runCliSubagent", () => {
  it("runs a real subagent over the (mocked) live sidecar and returns its reply", async () => {
    const cap = jest.requireMock("@/lib/claude/run-and-capture") as {
      runAndCaptureAssistantReply: jest.Mock
    }
    const ipc = jest.requireMock("@/lib/claude/ipc") as { closeSession: jest.Mock }
    cap.runAndCaptureAssistantReply.mockClear()
    ipc.closeSession.mockClear()

    // No `run` override → handleCliDispatchAgent uses the REAL runCliSubagent.
    registerCliSubagentContext(
      "s1",
      makeCtx({
        run: undefined,
        config: {
          ...DEFAULT_RESOLVED_CONFIG,
          builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
          provider: "opencode-go",
          providers: { "opencode-go": { apiKey: "k" } },
          cwd: "/work",
        },
      })
    )

    const resp = await makeCliPluginToolHandle()(req({ subagentId: "reviewer", prompt: "do it" }))

    // The real runner drove a child session under the parent id and tore it down.
    expect(cap.runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
    const childId = cap.runAndCaptureAssistantReply.mock.calls[0][0] as string
    expect(childId).toMatch(/^s1::sub-/)
    expect(ipc.closeSession).toHaveBeenCalledWith(childId)
    // The subagent's reply (+ token suffix) is the tool result the model reads.
    expect(resp.result).toContain(`subagent reply for ${childId}`)
    expect(resp.result).toContain("9 tok")
  })
})
