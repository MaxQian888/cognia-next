/**
 * @jest-environment node
 */
import type { PluginToolExecRequest } from "@/lib/claude/plugin-tool-ipc"

import { createHostToolExecutor } from "./host-tools"

describe("createHostToolExecutor", () => {
  it("stamps the active turn scope onto host-routed calls", async () => {
    const seen: PluginToolExecRequest[] = []
    const exec = createHostToolExecutor({
      sessionId: "s1",
      getTurnScope: () => ({ turnId: "t1", attemptId: "a2" }),
      handle: async (request) => {
        seen.push(request)
        return {
          type: "plugin_tool_response",
          sessionId: request.sessionId,
          toolUseId: request.toolUseId,
          result: "ok",
        }
      },
    })
    await exec("load_skill", { skill_id: "x" })
    expect(seen[0]).toMatchObject({ turnId: "t1", attemptId: "a2" })
  })

  it("routes the call through the shared CLI plugin handle, scoped to the session", async () => {
    const seen: PluginToolExecRequest[] = []
    const exec = createHostToolExecutor({
      sessionId: "sess1",
      handle: async (req) => {
        seen.push(req)
        return {
          type: "plugin_tool_response",
          sessionId: req.sessionId,
          toolUseId: req.toolUseId,
          result: "ok",
        }
      },
      mintToolUseId: () => "call-1",
    })
    expect(await exec("ask_user", { question: "?" })).toEqual({ result: "ok" })
    expect(seen).toEqual([
      {
        type: "plugin_tool_exec",
        sessionId: "sess1",
        toolUseId: "call-1",
        name: "ask_user",
        args: { question: "?" },
      },
    ])
  })

  it("passes an error response through untouched so the model can react to it", async () => {
    const exec = createHostToolExecutor({
      sessionId: "s",
      handle: async (req) => ({
        type: "plugin_tool_response",
        sessionId: req.sessionId,
        toolUseId: req.toolUseId,
        error: "unknown subagent",
      }),
    })
    expect(await exec("dispatch_agent", {})).toEqual({ error: "unknown subagent" })
  })

  it("collapses a handler throw onto an error rather than rejecting", async () => {
    const exec = createHostToolExecutor({
      sessionId: "s",
      handle: async () => {
        throw new Error("registry gone")
      },
    })
    await expect(exec("web_search", {})).resolves.toEqual({ error: "registry gone" })
  })

  it("normalizes a missing result to null so the bridge always has a body", async () => {
    const exec = createHostToolExecutor({
      sessionId: "s",
      handle: async (req) => ({
        type: "plugin_tool_response",
        sessionId: req.sessionId,
        toolUseId: req.toolUseId,
      }),
    })
    expect(await exec("load_skill", {})).toEqual({ result: null })
  })

  it("tolerates a call with no arguments", async () => {
    const seen: PluginToolExecRequest[] = []
    const exec = createHostToolExecutor({
      sessionId: "s",
      handle: async (req) => {
        seen.push(req)
        return {
          type: "plugin_tool_response",
          sessionId: req.sessionId,
          toolUseId: req.toolUseId,
          result: 1,
        }
      },
    })
    await exec("ask_user", undefined)
    expect(seen[0].args).toEqual({})
  })

  it("mints a distinct tool-use id per call so concurrent calls never collide", async () => {
    const ids: string[] = []
    const exec = createHostToolExecutor({
      sessionId: "s",
      handle: async (req) => {
        ids.push(req.toolUseId)
        return {
          type: "plugin_tool_response",
          sessionId: req.sessionId,
          toolUseId: req.toolUseId,
          result: 1,
        }
      },
    })
    await Promise.all([exec("a", {}), exec("b", {})])
    expect(new Set(ids).size).toBe(2)
  })
})

describe("createHostToolExecutor — default handle", () => {
  it("routes through the real CLI plugin handle when none is injected", async () => {
    // `dispatch_agent` with no registered turn context is the deterministic
    // no-side-effect path through the shared handle.
    const exec = createHostToolExecutor({ sessionId: "no-such-session" })
    const outcome = await exec("dispatch_agent", { subagent_type: "explorer", prompt: "hi" })
    expect(outcome.error).toMatch(/no active subagent context/)
  })
})
