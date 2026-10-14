/** @jest-environment node */

import { subscribePluginToolDispatchBridge } from "./plugin-tool-dispatch-bridge"
import type { PluginToolExecRequest, PluginToolExecResponse } from "./plugin-tool-ipc"

jest.mock("./ipc", () => ({
  subscribePluginToolExec: jest.fn(),
  sendPluginToolResponse: jest.fn(),
}))

const request: PluginToolExecRequest = {
  type: "plugin_tool_exec",
  sessionId: "session-a",
  toolUseId: "call-a",
  name: "issue_list",
  args: {},
  remoteExecutionContext: {
    hostId: "host-a",
    originDeviceId: "device-a",
    sessionId: "session-a",
    generation: 1,
    requestId: "request-a",
    issuedAt: 1,
    expiresAt: 2,
  },
}
const response: PluginToolExecResponse = {
  type: "plugin_tool_response",
  sessionId: request.sessionId,
  toolUseId: request.toolUseId,
  result: { ok: true },
}

function harness() {
  let receive!: (request: PluginToolExecRequest) => void
  const unsubscribe = jest.fn()
  const subscribe = jest.fn(async (handler: typeof receive) => {
    receive = handler
    return unsubscribe
  })
  const handle = jest.fn(async (_request: PluginToolExecRequest) => response)
  const send = jest.fn(async (_response: PluginToolExecResponse, _context?: unknown) => {})
  return { subscribe, handle, send, unsubscribe, emit: (req = request) => receive(req) }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

it("shares one consumer and executes a call only once, including completed duplicates", async () => {
  const h = harness()
  let resolve!: (response: PluginToolExecResponse) => void
  h.handle.mockImplementation(() => new Promise((done) => (resolve = done)))
  const [stopFirst, stopSecond] = await Promise.all([
    subscribePluginToolDispatchBridge(h),
    subscribePluginToolDispatchBridge(h),
  ])
  expect(h.subscribe).toHaveBeenCalledTimes(1)
  h.emit()
  h.emit()
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  resolve(response)
  await flush()
  h.emit()
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledWith(response, request.remoteExecutionContext)
  stopFirst()
  expect(h.unsubscribe).not.toHaveBeenCalled()
  stopSecond()
  stopSecond()
  expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  h.emit({ ...request, toolUseId: "after-stop" })
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
})

it("isolates call ids by session and remote host generation", async () => {
  const h = harness()
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  h.emit({ ...request, sessionId: "session-b" })
  h.emit({
    ...request,
    remoteExecutionContext: { ...request.remoteExecutionContext!, generation: 2 },
  })
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(3)
  stop()
})

it("prefers a session owner over a global consumer and preserves the original context", async () => {
  const h = harness()
  const localHandle = jest.fn(async () => response)
  const stopGlobal = await subscribePluginToolDispatchBridge(h)
  const stopSession = await subscribePluginToolDispatchBridge({
    ...h,
    sessionId: request.sessionId,
    handle: localHandle,
    prepareRequest: (req) => ({ ...req, sandboxRuntimeRef: "sandbox-a" }),
  })
  h.emit()
  await flush()
  expect(h.handle).not.toHaveBeenCalled()
  expect(localHandle).toHaveBeenCalledWith({ ...request, sandboxRuntimeRef: "sandbox-a" })
  expect(h.send).toHaveBeenCalledWith(response, request.remoteExecutionContext)
  stopSession()
  h.emit({ ...request, toolUseId: "next-call" })
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  stopGlobal()
})

it("answers executor exceptions safely without leaking arguments or exception text", async () => {
  const h = harness()
  h.handle.mockImplementation(() => {
    throw new Error("token=private-secret argument=confidential")
  })
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit({ ...request, args: { token: "private-secret" } })
  await flush()
  expect(h.send).toHaveBeenCalledWith(
    {
      type: "plugin_tool_response",
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      error: "Plugin tool executor failed",
    },
    request.remoteExecutionContext
  )
  stop()
})

it("forwards handler error responses using the existing protocol", async () => {
  const h = harness()
  h.handle.mockResolvedValue({ ...response, error: "Plugin tool is disabled" })
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  await flush()
  expect(h.send).toHaveBeenCalledWith(
    { ...response, error: "Plugin tool is disabled" },
    request.remoteExecutionContext
  )
  stop()
})

it("fails remote execution closed when the owner cannot proxy it", async () => {
  const h = harness()
  const stop = await subscribePluginToolDispatchBridge({ ...h, canExecuteRemote: () => false })
  h.emit()
  await flush()
  expect(h.handle).not.toHaveBeenCalled()
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.stringContaining("REMOTE_FEATURE_UNSUPPORTED") }),
    request.remoteExecutionContext
  )
  stop()
})

it("keeps an in-flight claim across unsubscribe and resubscribe", async () => {
  const h = harness()
  let resolve!: (response: PluginToolExecResponse) => void
  h.handle.mockImplementation(() => new Promise((done) => (resolve = done)))
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  await flush()
  stop()
  const stopAgain = await subscribePluginToolDispatchBridge(h)
  h.emit()
  resolve(response)
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledTimes(1)
  stopAgain()
})

it("can restart after a failed subscription", async () => {
  const h = harness()
  h.subscribe.mockRejectedValueOnce(new Error("unavailable"))
  await expect(subscribePluginToolDispatchBridge(h)).rejects.toThrow("unavailable")
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  stop()
})

it("does not re-execute a tool when its response transport rejects", async () => {
  const h = harness()
  h.send.mockRejectedValueOnce(new Error("disconnected"))
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  await flush()
  h.emit()
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledTimes(1)
  stop()
})
