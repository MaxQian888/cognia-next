import { invoke as invokeRaw } from "@tauri-apps/api/core"
import { isTauri as isTauriRaw } from "@/lib/tauri"
import type { ExternalAgentPermissionRequestEvent } from "@/types/agent/external-agent"

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

const dispatchExternalAgentToolCall = jest.fn()
const dispatchExternalAgentPermissionRequest = jest.fn()
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchExternalAgentToolCall,
    dispatchExternalAgentPermissionRequest,
  }),
}))

jest.mock("@/lib/logging", () => ({
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

const invoke = invokeRaw as jest.Mock
const isTauri = isTauriRaw as jest.Mock

import {
  fireAgentHook,
  observeExternalAgentEvent,
  gateExternalAgentPermission,
  noticeFromDecision,
  type AgentHookContext,
  type ExternalHookFireNotice,
} from "./agent-hooks"

const ctx: AgentHookContext = { agentId: "a1", sessionId: "s1", cwd: "/repo" }

beforeEach(() => {
  invoke.mockReset()
  isTauri.mockReset()
  dispatchExternalAgentToolCall.mockReset()
  dispatchExternalAgentPermissionRequest.mockReset()
  isTauri.mockReturnValue(true)
  invoke.mockResolvedValue({ block: null, additionalContext: null, warnings: [] })
})

function eventsFor(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === "run_agent_hook" && c[1]?.event === name)
}

describe("fireAgentHook", () => {
  it("no-ops on web (isTauri false) and never invokes", async () => {
    isTauri.mockReturnValue(false)
    const res = await fireAgentHook("Stop", ctx)
    expect(res).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("invokes run_agent_hook with the right payload", async () => {
    invoke.mockResolvedValue({ block: null, warnings: [] })
    await fireAgentHook("PostToolUse", ctx, { toolName: "Bash", payload: { tool_name: "Bash" } })
    expect(invoke).toHaveBeenCalledWith("run_agent_hook", {
      event: "PostToolUse",
      sessionId: "s1",
      cwd: "/repo",
      toolName: "Bash",
      payload: { tool_name: "Bash" },
    })
  })

  it("returns null and swallows bridge errors", async () => {
    invoke.mockRejectedValue(new Error("ipc down"))
    const res = await fireAgentHook("Stop", ctx)
    expect(res).toBeNull()
  })

  it("passes null defaults when cwd + opts are omitted", async () => {
    invoke.mockResolvedValue({ block: null, warnings: [] })
    await fireAgentHook("Stop", { agentId: "a1", sessionId: "s1" })
    expect(invoke).toHaveBeenCalledWith("run_agent_hook", {
      event: "Stop",
      sessionId: "s1",
      cwd: null,
      toolName: null,
      payload: null,
    })
  })
})

describe("observeExternalAgentEvent", () => {
  it("fires SessionStart on session_start", async () => {
    await observeExternalAgentEvent(ctx, { type: "session_start", timestamp: new Date() })
    expect(eventsFor("SessionStart")).toHaveLength(1)
  })

  it("dispatches the System-A tool-call hook on tool_use_start", async () => {
    await observeExternalAgentEvent(ctx, {
      type: "tool_use_start",
      toolUseId: "t1",
      toolName: "Bash",
      rawInput: { cmd: "ls" },
      timestamp: new Date(),
    })
    expect(dispatchExternalAgentToolCall).toHaveBeenCalledWith("a1", "s1", "Bash", { cmd: "ls" })
  })

  it("defaults rawInput to {} when tool_use_start omits it", async () => {
    await observeExternalAgentEvent(ctx, {
      type: "tool_use_start",
      toolUseId: "t1",
      toolName: "Bash",
      timestamp: new Date(),
    })
    expect(dispatchExternalAgentToolCall).toHaveBeenCalledWith("a1", "s1", "Bash", {})
  })

  it("falls back to 'unknown' tool name on a tool_result without one", async () => {
    await observeExternalAgentEvent(ctx, {
      type: "tool_result",
      toolUseId: "t1",
      result: "ok",
      timestamp: new Date(),
    })
    const call = invoke.mock.calls.find((c) => c[1]?.event === "PostToolUse")
    expect(call?.[1]?.toolName).toBe("unknown")
  })

  it("ignores unrelated event types", async () => {
    await observeExternalAgentEvent(ctx, {
      type: "permission_response",
      response: { requestId: "r", granted: true },
      timestamp: new Date(),
    } as never)
    expect(invoke).not.toHaveBeenCalled()
    expect(dispatchExternalAgentToolCall).not.toHaveBeenCalled()
  })

  it("fires PostToolUse on a successful tool_result", async () => {
    await observeExternalAgentEvent(ctx, {
      type: "tool_result",
      toolUseId: "t1",
      toolName: "Bash",
      result: "ok",
      timestamp: new Date(),
    })
    expect(eventsFor("PostToolUse")).toHaveLength(1)
    expect(eventsFor("PostToolUseFailure")).toHaveLength(0)
  })

  it("fires PostToolUseFailure on an errored tool_result", async () => {
    await observeExternalAgentEvent(ctx, {
      type: "tool_result",
      toolUseId: "t1",
      toolName: "Bash",
      result: "boom",
      isError: true,
      timestamp: new Date(),
    })
    expect(eventsFor("PostToolUseFailure")).toHaveLength(1)
  })

  it("fires Stop + SessionEnd on done", async () => {
    await observeExternalAgentEvent(ctx, { type: "done", success: true, timestamp: new Date() })
    expect(eventsFor("Stop")).toHaveLength(1)
    expect(eventsFor("SessionEnd")).toHaveLength(1)
  })

  it("fires StopFailure on error", async () => {
    await observeExternalAgentEvent(ctx, { type: "error", error: "nope", timestamp: new Date() })
    expect(eventsFor("StopFailure")).toHaveLength(1)
  })

  it("emits a hook notice when a PostToolUse fire is consequential", async () => {
    invoke.mockResolvedValue({ block: null, additionalContext: null, warnings: ["slow hook"] })
    const emit = jest.fn()
    await observeExternalAgentEvent(
      ctx,
      {
        type: "tool_result",
        toolUseId: "t1",
        toolName: "Bash",
        result: "ok",
        timestamp: new Date(),
      },
      emit
    )
    expect(emit).toHaveBeenCalledTimes(1)
    const notice = emit.mock.calls[0][0] as ExternalHookFireNotice
    expect(notice).toMatchObject({ event: "PostToolUse", toolName: "Bash", outcome: "warning" })
    expect(notice.warnings).toEqual(["slow hook"])
  })

  it("does not emit for a no-op fire", async () => {
    const emit = jest.fn()
    await observeExternalAgentEvent(
      ctx,
      {
        type: "tool_result",
        toolUseId: "t1",
        toolName: "Bash",
        result: "ok",
        timestamp: new Date(),
      },
      emit
    )
    expect(emit).not.toHaveBeenCalled()
  })
})

describe("noticeFromDecision", () => {
  it("returns null for a missing or no-op decision", () => {
    expect(noticeFromDecision("PreToolUse", "Bash", null)).toBeNull()
    expect(
      noticeFromDecision("PreToolUse", "Bash", {
        block: null,
        additionalContext: null,
        warnings: [],
      })
    ).toBeNull()
    expect(
      noticeFromDecision("PreToolUse", "Bash", {
        block: "   ",
        additionalContext: "",
        warnings: [],
      })
    ).toBeNull()
  })

  it("derives outcome by precedence block > context > warning", () => {
    expect(
      noticeFromDecision("PreToolUse", "Bash", {
        block: "no",
        additionalContext: "ctx",
        warnings: ["w"],
      })
    ).toMatchObject({ outcome: "blocked", block: "no" })
    expect(
      noticeFromDecision("PostToolUse", "Bash", {
        block: null,
        additionalContext: "ctx",
        warnings: ["w"],
      })
    ).toMatchObject({ outcome: "context", additionalContext: "ctx" })
    expect(
      noticeFromDecision("Stop", undefined, {
        block: null,
        additionalContext: null,
        warnings: ["w"],
      })
    ).toMatchObject({ outcome: "warning", warnings: ["w"] })
  })
})

describe("gateExternalAgentPermission", () => {
  function permEvent(): ExternalAgentPermissionRequestEvent {
    return {
      type: "permission_request",
      timestamp: new Date(),
      request: {
        id: "req1",
        requestId: "req1",
        toolInfo: { id: "tool", name: "Bash" },
        rawInput: { cmd: "rm -rf /" },
        reason: "destructive",
      },
    }
  }

  it("fires permission hooks and returns false when not blocked", async () => {
    invoke.mockResolvedValue({ block: null, warnings: [] })
    const deny = jest.fn().mockResolvedValue(undefined)
    const blocked = await gateExternalAgentPermission(ctx, permEvent(), deny)
    expect(blocked).toBe(false)
    expect(deny).not.toHaveBeenCalled()
    expect(dispatchExternalAgentPermissionRequest).toHaveBeenCalledWith(
      "a1",
      "s1",
      "Bash",
      "destructive"
    )
    expect(eventsFor("PreToolUse")).toHaveLength(1)
    expect(eventsFor("PermissionRequest")).toHaveLength(1)
  })

  it("denies and returns true when PreToolUse blocks", async () => {
    invoke.mockResolvedValue({ block: "policy violation", warnings: [] })
    const deny = jest.fn().mockResolvedValue(undefined)
    const blocked = await gateExternalAgentPermission(ctx, permEvent(), deny)
    expect(blocked).toBe(true)
    expect(deny).toHaveBeenCalledWith("req1", "policy violation")
    expect(eventsFor("PermissionDenied")).toHaveLength(1)
  })

  it("still returns true even if deny throws", async () => {
    invoke.mockResolvedValue({ block: "policy", warnings: [] })
    const deny = jest.fn().mockRejectedValue(new Error("adapter gone"))
    const blocked = await gateExternalAgentPermission(ctx, permEvent(), deny)
    expect(blocked).toBe(true)
  })

  it("falls back to request.id, 'unknown' tool, and {} input on a sparse request", async () => {
    invoke.mockResolvedValue({ block: "no", warnings: [] })
    const deny = jest.fn().mockResolvedValue(undefined)
    const sparse = {
      type: "permission_request",
      timestamp: new Date(),
      request: { id: "onlyId", toolInfo: {} },
    } as never
    await gateExternalAgentPermission(ctx, sparse, deny)
    expect(deny).toHaveBeenCalledWith("onlyId", "no")
    expect(dispatchExternalAgentPermissionRequest).toHaveBeenCalledWith(
      "a1",
      "s1",
      "unknown",
      undefined
    )
  })

  it("emits a blocked hook notice when PreToolUse blocks", async () => {
    invoke.mockResolvedValue({ block: "policy violation", additionalContext: null, warnings: [] })
    const deny = jest.fn().mockResolvedValue(undefined)
    const emit = jest.fn()
    await gateExternalAgentPermission(ctx, permEvent(), deny, emit)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({
      event: "PreToolUse",
      toolName: "Bash",
      outcome: "blocked",
      block: "policy violation",
    })
  })

  it("emits a context notice for a non-blocking consequential PreToolUse", async () => {
    invoke.mockResolvedValue({ block: null, additionalContext: "extra ctx", warnings: [] })
    const deny = jest.fn().mockResolvedValue(undefined)
    const emit = jest.fn()
    const blocked = await gateExternalAgentPermission(ctx, permEvent(), deny, emit)
    expect(blocked).toBe(false)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({
      outcome: "context",
      additionalContext: "extra ctx",
    })
  })

  it("does not emit for a no-op PreToolUse fire", async () => {
    const deny = jest.fn().mockResolvedValue(undefined)
    const emit = jest.fn()
    await gateExternalAgentPermission(ctx, permEvent(), deny, emit)
    expect(emit).not.toHaveBeenCalled()
  })
})
