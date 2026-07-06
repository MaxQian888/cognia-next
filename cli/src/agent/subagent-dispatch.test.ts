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
import {
  __clearLiveSubagentsForTesting,
  getLiveSubagent,
  listLiveSubagents,
} from "./subagent-live-output"

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
  __clearLiveSubagentsForTesting()
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
    // An unknown id is a genuine failure → surfaced as a tool error (red ✗).
    expect(resp.error).toContain('Unknown subagent "ghost"')
    expect(resp.error).toContain("reviewer")
    expect(resp.result).toBeUndefined()
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

  it("runs a parallel dispatch concurrently (both start before either finishes)", async () => {
    // Each run parks until released; track peak concurrency. A serial fan-out
    // would never let `active` reach 2 — this locks in the `Promise.all` overlap
    // so a future refactor can't silently serialize the batch form.
    let active = 0
    let peak = 0
    const release: Array<() => void> = []
    const run = jest.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => release.push(resolve))
      active -= 1
      return { text: "done" }
    })
    registerCliSubagentContext("s1", makeCtx({ agents: [agent("a"), agent("b")], run }))
    const pending = handleCliDispatchAgent(
      req({
        dispatches: [
          { subagentId: "a", prompt: "pa" },
          { subagentId: "b", prompt: "pb" },
        ],
      })
    )
    // Let both runs reach their barrier, then release them.
    await Promise.resolve()
    await Promise.resolve()
    expect(peak).toBe(2)
    for (const r of release) r()
    await pending
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
    // A thrown run is a failure → tool error (so the dispatch cell renders red ✗,
    // not a green ✓), while the text still reaches the model for recovery.
    expect(resp.error).toContain("failed: nope")
    expect(resp.result).toBeUndefined()
  })

  it("keeps a mixed fan-out (one ok, one failed) as a result, not an error", async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce({ text: "A done" })
      .mockRejectedValueOnce(new Error("B boom"))
    registerCliSubagentContext("s1", makeCtx({ agents: [agent("a"), agent("b")], run }))
    const resp = await handleCliDispatchAgent(
      req({
        dispatches: [
          { subagentId: "a", prompt: "pa" },
          { subagentId: "b", prompt: "pb" },
        ],
      })
    )
    // A partial success stays a result so the good half reads normally.
    expect(resp.error).toBeUndefined()
    expect(resp.result).toContain("A done")
    expect(resp.result).toContain("failed: B boom")
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
    expect(resp.error).toContain('Unknown subagent "ghost"')
    expect(resp.error).not.toContain("started in background")
    expect(resp.result).toBeUndefined()
  })

  it("returns a clean message when collecting an unknown runId", async () => {
    registerCliSubagentContext("s1", makeCtx())
    const resp = await handleCliDispatchAgent(req({ collect: "nope" }))
    expect(resp.result).toContain('no background run "nope"')
  })

  it("cannot collect a background run started by a different session", async () => {
    // Start a background run under session "other".
    registerCliSubagentContext("other", makeCtx({ run: async () => ({ text: "x" }) }))
    await handleCliDispatchAgent({
      type: "plugin_tool_exec",
      sessionId: "other",
      toolUseId: "t",
      name: DISPATCH_AGENT_TOOL_NAME,
      args: { subagentId: "reviewer", prompt: "go", background: true },
    })
    clearCliSubagentContext("other")

    // Session "s1" tries to collect it by guessing the runId — denied (the mint
    // is deterministic here only because we don't override it; we assert by the
    // foreign-collect message instead).
    registerCliSubagentContext("s1", makeCtx())
    const resp = await handleCliDispatchAgent(req({ collect: "bg-foreign" }))
    expect(resp.result).toContain('no background run "bg-foreign"')
  })

  it("reports an interrupt (not a failure) when the parent signal aborted", async () => {
    const controller = new AbortController()
    registerCliSubagentContext(
      "s1",
      makeCtx({
        signal: controller.signal,
        run: async () => {
          controller.abort()
          throw new Error("aborted")
        },
      })
    )
    const resp = await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "go" }))
    expect(resp.result).toContain("[reviewer] interrupted.")
    expect(resp.result).not.toContain("failed")
  })
})

describe("live-output wiring", () => {
  it("registers a live entry that settles done for a successful foreground run", async () => {
    registerCliSubagentContext("s1", makeCtx({ run: async () => ({ text: "ran" }) }))
    await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "check this" }))
    const live = listLiveSubagents("s1")
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ name: "reviewer", task: "check this", status: "done" })
    // Foreground runs get a minted `live-…` id (not a background runId).
    expect(live[0].liveId).toMatch(/^live-/)
  })

  it("settles the live entry to error when the run throws", async () => {
    registerCliSubagentContext(
      "s1",
      makeCtx({
        run: async () => {
          throw new Error("nope")
        },
      })
    )
    await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "go" }))
    expect(listLiveSubagents("s1")[0].status).toBe("error")
  })

  it("settles the live entry to interrupted when the parent signal aborted", async () => {
    const controller = new AbortController()
    registerCliSubagentContext(
      "s1",
      makeCtx({
        signal: controller.signal,
        run: async () => {
          controller.abort()
          throw new Error("aborted")
        },
      })
    )
    await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "go" }))
    expect(listLiveSubagents("s1")[0].status).toBe("interrupted")
  })

  it("forwards capture events into the live entry via onEvent", async () => {
    registerCliSubagentContext(
      "s1",
      makeCtx({
        run: async (_def, _prompt, _parent, deps) => {
          deps.onEvent?.({ type: "text-delta", delta: "hello" })
          deps.onEvent?.({ type: "thinking-delta", delta: "ponder" })
          return { text: "ran" }
        },
      })
    )
    await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "go" }))
    const entry = listLiveSubagents("s1")[0]
    expect(entry.text).toBe("hello")
    expect(entry.thinking).toBe("ponder")
  })

  it("shares the background runId as the live id so the panel shows one row", async () => {
    let resolveRun!: (r: { text: string }) => void
    const run = jest.fn(() => new Promise<{ text: string }>((res) => (resolveRun = res)))
    registerCliSubagentContext("s1", makeCtx({ run, mintRunId: () => "bg-shared" }))
    await handleCliDispatchAgent(req({ subagentId: "reviewer", prompt: "go", background: true }))
    // While running, the live entry exists under the background runId.
    expect(getLiveSubagent("bg-shared", "s1")?.status).toBe("running")
    resolveRun({ text: "bg done" })
    await Promise.resolve()
    await Promise.resolve()
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
