/**
 * @jest-environment node
 */
import { subscribePluginToolDispatch } from "./plugin-tool-dispatch"
import type { PluginToolExecRequest, PluginToolExecResponse } from "@/lib/claude/plugin-tool-ipc"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"

const req: PluginToolExecRequest = {
  type: "plugin_tool_exec",
  sessionId: "s1",
  toolUseId: "t1",
  name: "web_fetch",
  args: { url: "https://example.com" },
}

describe("subscribePluginToolDispatch", () => {
  it("recovers the session's read ceiling on the CLI rail", async () => {
    const ref = await sandboxSessionRuntime.bindSession({
      sessionId: "cli-read-ceiling",
      binding: { shellTier: "os", computerTarget: "local" },
      policy: { readableRoots: ["/workspace/docs"] },
      confine: { writable: ["/scratch"] },
      workspaceRoot: "/workspace",
      sandboxEnabled: true,
      computerUseEnabled: false,
    })
    let callback!: (request: PluginToolExecRequest) => void
    const send = jest.fn(async () => {})
    const stop = await subscribePluginToolDispatch({
      subscribe: async (handler) => {
        callback = handler
        return () => {}
      },
      handle: async (event) => ({
        type: "plugin_tool_response",
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        result: sandboxSessionRuntime.clampRequest(event.sandboxRuntimeRef!, {
          writable: [],
          targetFiles: [],
          readable: ["/"],
          cwd: "/cwd",
          maxCpuSeconds: 0,
          maxMemoryMb: 0,
          network: "off",
          networkHosts: [],
        }),
      }),
      send,
    })
    try {
      callback({ ...req, sessionId: "cli-read-ceiling", name: "sandbox_bash" })
      await new Promise((resolve) => setImmediate(resolve))
      expect(sandboxSessionRuntime.activeRefForSession("cli-read-ceiling")).toBe(ref)
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({
            readable: ["/workspace/docs", "/scratch", "/workspace", "/cwd"],
          }),
        }),
        undefined
      )
    } finally {
      stop()
      await sandboxSessionRuntime.releaseSession("cli-read-ceiling")
    }
  })

  it("runs each plugin_tool_exec event through the executor and sends the response", async () => {
    let handler: ((r: PluginToolExecRequest) => void) | null = null
    const sent: PluginToolExecResponse[] = []
    const unsub = jest.fn()

    const ret = await subscribePluginToolDispatch({
      subscribe: async (h) => {
        handler = h as (r: PluginToolExecRequest) => void
        return unsub
      },
      handle: async (r) => ({
        type: "plugin_tool_response",
        sessionId: r.sessionId,
        toolUseId: r.toolUseId,
        result: { ok: true },
      }),
      send: async (resp) => void sent.push(resp),
    })

    // Fire an event; the executor result must be sent back.
    handler!(req)
    await new Promise((r) => setImmediate(r))
    expect(sent).toEqual([
      { type: "plugin_tool_response", sessionId: "s1", toolUseId: "t1", result: { ok: true } },
    ])
    ret()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it("ignores other sessions instead of answering their tool calls twice", async () => {
    let callback!: (request: PluginToolExecRequest) => void
    const handle = jest.fn(async () => ({
      type: "plugin_tool_response" as const,
      sessionId: "s1",
      toolUseId: "t1",
    }))
    const send = jest.fn(async () => {})
    const stop = await subscribePluginToolDispatch({
      sessionId: "s1",
      subscribe: async (cb) => {
        callback = cb
        return () => {}
      },
      handle,
      send,
    })
    callback({ ...req, sessionId: "other" })
    await Promise.resolve()
    expect(handle).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    stop()
  })

  it("settles throwing tool executors with an error response", async () => {
    let callback!: (request: PluginToolExecRequest) => void
    const send = jest.fn(async () => {})
    const stop = await subscribePluginToolDispatch({
      subscribe: async (cb) => {
        callback = cb
        return () => {}
      },
      handle: () => {
        throw new Error("executor crashed")
      },
      send,
    })
    callback(req)
    await new Promise((resolve) => setImmediate(resolve))
    expect(send).toHaveBeenCalledWith(
      {
        type: "plugin_tool_response",
        sessionId: "s1",
        toolUseId: "t1",
        error: "Plugin tool executor failed",
      },
      undefined
    )
    stop()
  })

  it("releases its shared transport subscription", async () => {
    const unsub = jest.fn()
    const ret = await subscribePluginToolDispatch({
      subscribe: async () => unsub,
      handle: async () => ({ type: "plugin_tool_response", sessionId: "x", toolUseId: "y" }),
      send: async () => {},
    })
    ret()
    ret()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it("preserves remote context and sandbox placement through the shared bridge", async () => {
    let callback!: (request: PluginToolExecRequest) => void
    const context = {
      hostId: "host-a",
      originDeviceId: "device-a",
      sessionId: "s1",
      generation: 1,
      requestId: "request-a",
      issuedAt: 1,
      expiresAt: 2,
    }
    const handle = jest.fn(async () => ({
      type: "plugin_tool_response" as const,
      sessionId: "s1",
      toolUseId: "t1",
      result: "ok",
    }))
    const send = jest.fn(async () => {})
    const runtimeRef = jest.fn(() => "sandbox-a")
    const stop = await subscribePluginToolDispatch({
      subscribe: async (handler) => {
        callback = handler
        return () => {}
      },
      handle,
      send,
      runtimeRef,
    })
    const event = { ...req, remoteExecutionContext: context }
    callback(event)
    callback(event)
    await new Promise((resolve) => setImmediate(resolve))
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith({ ...event, sandboxRuntimeRef: "sandbox-a" })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ result: "ok" }), context)
    callback({ ...event, toolUseId: "t2", sandboxRuntimeRef: "bound" })
    await new Promise((resolve) => setImmediate(resolve))
    expect(handle).toHaveBeenLastCalledWith(expect.objectContaining({ sandboxRuntimeRef: "bound" }))
    expect(runtimeRef).toHaveBeenCalledTimes(1)
    stop()
  })
})
