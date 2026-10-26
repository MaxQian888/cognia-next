/**
 * @jest-environment node
 */
import { subscribePluginToolDispatch } from "./plugin-tool-dispatch"
import type { PluginToolExecRequest, PluginToolExecResponse } from "@/lib/claude/plugin-tool-ipc"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"

jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  subscribePluginHookExec: jest.fn(async () => () => {}),
}))

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

describe("CLI lifecycle hook round trips", () => {
  it("routes parent and child hooks once, acknowledges no contributors and preserves plugin decisions", async () => {
    let callback!: Parameters<typeof import("@/lib/claude/ipc").subscribePluginHookExec>[0]
    const unlisten = jest.fn()
    const subscribe = jest.fn(async (cb: typeof callback) => {
      callback = cb
      return unlisten
    })
    const parentSend = jest.fn(async () => {})
    const childSend = jest.fn(async () => {})
    const parentHandle = jest.fn(async () => ({ result: null }))
    const childHandle = jest.fn(async () => ({ result: { skip: true } }))
    const toolSubscribe = async () => () => {}
    const parent = await subscribePluginToolDispatch({
      sessionId: "parent",
      subscribe: toolSubscribe,
      hooks: { subscribe, handle: parentHandle, send: parentSend },
    })
    const child = await subscribePluginToolDispatch({
      sessionId: "child",
      subscribe: toolSubscribe,
      hooks: { subscribe, handle: childHandle, send: childSend },
    })
    const request = {
      type: "plugin_hook_exec" as const,
      sessionId: "child",
      execId: "c1",
      pluginId: "*",
      hookId: "onPreCompact",
      payload: {},
    }
    callback(request)
    callback(request)
    callback({ ...request, sessionId: "parent", execId: "p1" })
    callback({ ...request, sessionId: "unowned", execId: "u1" })
    await new Promise((resolve) => setImmediate(resolve))
    callback(request)
    await new Promise((resolve) => setImmediate(resolve))
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(childHandle).toHaveBeenCalledTimes(1)
    expect(parentHandle).toHaveBeenCalledTimes(1)
    expect(childSend).toHaveBeenCalledWith({
      sessionId: "child",
      execId: "c1",
      result: { skip: true },
    })
    expect(parentSend).toHaveBeenCalledWith({ sessionId: "parent", execId: "p1", result: null })
    child()
    expect(unlisten).not.toHaveBeenCalled()
    parent()
    parent()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("reports a throwing hook and rolls back tools if hook subscription fails", async () => {
    let callback!: Parameters<typeof import("@/lib/claude/ipc").subscribePluginHookExec>[0]
    const send = jest.fn(async () => {})
    const stop = await subscribePluginToolDispatch({
      subscribe: async () => () => {},
      hooks: {
        subscribe: async (cb) => {
          callback = cb
          return () => {}
        },
        handle: async () => {
          throw new Error("secret")
        },
        send,
      },
    })
    callback({
      type: "plugin_hook_exec",
      sessionId: "s",
      execId: "1",
      pluginId: "*",
      hookId: "onPreCompact",
      payload: {},
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(send).toHaveBeenCalledWith({
      sessionId: "s",
      execId: "1",
      error: "Plugin lifecycle hook executor failed",
    })
    stop()
    const stopTools = jest.fn()
    await expect(
      subscribePluginToolDispatch({
        subscribe: async () => stopTools,
        hooks: {
          subscribe: async () => {
            throw new Error("closed")
          },
        },
      })
    ).rejects.toThrow("closed")
    expect(stopTools).toHaveBeenCalledTimes(1)
  })
})

it("retains in-flight hook ownership across the last owner's teardown and remount", async () => {
  let callback!: Parameters<typeof import("@/lib/claude/ipc").subscribePluginHookExec>[0]
  let complete!: (result: { result: null }) => void
  const pending = new Promise<{ result: null }>((resolve) => {
    complete = resolve
  })
  const handle = jest.fn(() => pending)
  const subscribe = async (cb: typeof callback) => {
    callback = cb
    return () => {}
  }
  const deps = {
    sessionId: "child",
    subscribe: async () => () => {},
    hooks: { subscribe, handle, send: jest.fn(async () => {}) },
  }
  const first = await subscribePluginToolDispatch(deps)
  const request = {
    type: "plugin_hook_exec" as const,
    sessionId: "child",
    execId: "pending",
    pluginId: "*",
    hookId: "onPreCompact",
    payload: {},
  }
  callback(request)
  first()
  const second = await subscribePluginToolDispatch(deps)
  callback(request)
  expect(handle).toHaveBeenCalledTimes(1)
  complete({ result: null })
  await new Promise((resolve) => setImmediate(resolve))
  callback(request)
  await new Promise((resolve) => setImmediate(resolve))
  expect(handle).toHaveBeenCalledTimes(1)
  second()
})
