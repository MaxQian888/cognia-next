import { render, waitFor } from "@testing-library/react"

jest.mock("@/lib/claude/ipc", () => ({
  subscribePluginToolExec: jest.fn(),
  sendPluginToolResponse: jest.fn(),
  subscribePluginHookExec: jest.fn().mockResolvedValue(() => {}),
  sendPluginHookResponse: jest.fn(),
  subscribeProtocolAdapterExec: jest.fn().mockResolvedValue(() => {}),
  subscribeProtocolAdapterCancel: jest.fn().mockResolvedValue(() => {}),
  sendProtocolAdapterMessage: jest.fn(),
}))
jest.mock("@/lib/claude/plugin-tool-ipc", () => ({
  handlePluginToolExec: jest.fn(),
}))
jest.mock("@/lib/claude/plugin-hook-ipc", () => ({
  handlePluginHookExec: jest.fn(),
}))
jest.mock("@/lib/claude/protocol-adapter-ipc", () => ({
  dispatchProtocolAdapterExec: jest.fn().mockResolvedValue(undefined),
}))
const mockActiveHostSupportsFeature = jest.fn((_feature?: unknown, _operation?: unknown) => true)
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  activeHostSupportsFeature: (feature: unknown, operation?: unknown) =>
    mockActiveHostSupportsFeature(feature, operation),
}))
// Defaults to "not driving another host", which is what a desktop with its own
// sidecar and a browser paired to a headless host both are. The ADR-0082
// compatibility check only applies to the third case, and the tests that mean
// it say so.
const mockIsRemoteHostActive = jest.fn(() => false)
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => mockIsRemoteHostActive(),
}))

import { PluginToolDispatchProvider } from "./plugin-tool-dispatch-provider"
import {
  subscribePluginToolExec,
  sendPluginToolResponse,
  subscribePluginHookExec,
  sendPluginHookResponse,
  subscribeProtocolAdapterExec,
  subscribeProtocolAdapterCancel,
  sendProtocolAdapterMessage,
} from "@/lib/claude/ipc"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"
import { handlePluginHookExec } from "@/lib/claude/plugin-hook-ipc"
import { dispatchProtocolAdapterExec } from "@/lib/claude/protocol-adapter-ipc"
import type { PluginToolExecEvent } from "@cognia/agent-config-types"

const mockSubscribe = subscribePluginToolExec as jest.Mock
const mockSend = sendPluginToolResponse as jest.Mock
const mockHandle = handlePluginToolExec as jest.Mock
const mockSubscribeProtocolExec = subscribeProtocolAdapterExec as jest.Mock
const mockSubscribeProtocolCancel = subscribeProtocolAdapterCancel as jest.Mock
const mockSendProtocolAdapterMessage = sendProtocolAdapterMessage as jest.Mock
const mockDispatchProtocolAdapterExec = dispatchProtocolAdapterExec as jest.Mock
const mockSubscribeHook = subscribePluginHookExec as jest.Mock
const mockSendHook = sendPluginHookResponse as jest.Mock
const mockHandleHook = handlePluginHookExec as jest.Mock

describe("PluginToolDispatchProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockActiveHostSupportsFeature.mockReturnValue(true)
    mockIsRemoteHostActive.mockReturnValue(false)
  })

  it("runs handlePluginToolExec and writes the response when an event arrives", async () => {
    let captured: ((req: PluginToolExecEvent) => void) | null = null
    mockSubscribe.mockImplementation(async (h: (r: PluginToolExecEvent) => void) => {
      captured = h
      return () => {}
    })
    mockHandle.mockResolvedValue({
      type: "plugin_tool_response",
      sessionId: "s1",
      toolUseId: "t1",
      result: "ok",
    })
    mockSend.mockResolvedValue(undefined)

    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await Promise.resolve()
    expect(captured).toBeTruthy()

    captured!({ type: "plugin_tool_exec", sessionId: "s1", toolUseId: "t1", name: "x", args: {} })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockHandle).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: "t1", name: "x" }))
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ toolUseId: "t1", result: "ok" })
      )
    )
  })

  it("returns a remote response with the exact server-issued execution context", async () => {
    let captured:
      ((req: PluginToolExecEvent & { remoteExecutionContext?: object }) => void) | null = null
    mockSubscribe.mockImplementation(
      async (
        handler: (request: PluginToolExecEvent & { remoteExecutionContext?: object }) => void
      ) => {
        captured = handler
        return () => {}
      }
    )
    const context = {
      hostId: "host-a",
      originDeviceId: "device-a",
      sessionId: "s1",
      generation: 1,
      requestId: "request-a",
      issuedAt: 1,
      expiresAt: 2,
    }
    const response = {
      type: "plugin_tool_response",
      sessionId: "s1",
      toolUseId: "t1",
      result: "ok",
    }
    mockHandle.mockResolvedValue(response)

    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await Promise.resolve()
    captured!({
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "t1",
      name: "x",
      args: {},
      remoteExecutionContext: context,
    })
    await Promise.resolve()
    await Promise.resolve()

    await waitFor(() => expect(mockSend).toHaveBeenCalledWith(response, context))
  })

  it("fails a remote plugin tool closed when the proxy feature is not advertised", async () => {
    let captured:
      ((req: PluginToolExecEvent & { remoteExecutionContext?: object }) => void) | null = null
    mockActiveHostSupportsFeature.mockReturnValue(false)
    mockIsRemoteHostActive.mockReturnValue(true)
    mockSubscribe.mockImplementation(
      async (
        handler: (request: PluginToolExecEvent & { remoteExecutionContext?: object }) => void
      ) => {
        captured = handler
        return () => {}
      }
    )
    mockSend.mockResolvedValue(undefined)
    const context = {
      hostId: "host-a",
      originDeviceId: "device-a",
      sessionId: "s1",
      generation: 1,
      requestId: "request-a",
      issuedAt: 1,
      expiresAt: 2,
    }

    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await Promise.resolve()
    captured!({
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "t1",
      name: "x",
      args: {},
      remoteExecutionContext: context,
    })
    await Promise.resolve()

    expect(mockHandle).not.toHaveBeenCalled()
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: "t1",
        error: expect.stringContaining("REMOTE_FEATURE_UNSUPPORTED"),
      }),
      context
    )
  })

  // The regression this file used to hide: `activeHostSupportsFeature` was
  // mocked true, a value production could not produce, so the success path was
  // green while every companion refused every remote tool call and hung the
  // turn. A browser paired to a headless host is not driving another host, and
  // the frame only reached it because the host addressed it there.
  it("runs a remote plugin tool for the host this client belongs to", async () => {
    let captured:
      ((req: PluginToolExecEvent & { remoteExecutionContext?: object }) => void) | null = null
    mockIsRemoteHostActive.mockReturnValue(false)
    // Nothing advertises anything: the remote-host store is empty on a browser,
    // which is exactly the state that used to refuse.
    mockActiveHostSupportsFeature.mockReturnValue(false)
    mockSubscribe.mockImplementation(
      async (
        handler: (request: PluginToolExecEvent & { remoteExecutionContext?: object }) => void
      ) => {
        captured = handler
        return () => {}
      }
    )
    const context = {
      hostId: "host-a",
      originDeviceId: "device-a",
      sessionId: "s1",
      generation: 1,
      requestId: "request-a",
      issuedAt: 1,
      expiresAt: 2,
    }
    const response = {
      type: "plugin_tool_response",
      sessionId: "s1",
      toolUseId: "t1",
      result: "ok",
    }
    mockHandle.mockResolvedValue(response)
    mockSend.mockResolvedValue(undefined)

    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await Promise.resolve()
    captured!({
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "t1",
      name: "x",
      args: {},
      remoteExecutionContext: context,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockHandle).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: "t1" }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith(response, context))
  })

  it("unsubscribes on unmount", async () => {
    const unlisten = jest.fn()
    mockSubscribe.mockResolvedValue(unlisten)
    const { unmount } = render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await Promise.resolve()
    unmount()
    expect(unlisten).toHaveBeenCalled()
  })

  it("cancels an in-flight protocol adapter execution when the sidecar cancels it", async () => {
    let execHandler:
      ((req: { type: "protocol_adapter_exec"; sessionId: string; execId: string }) => void) | null =
      null
    let cancelHandler:
      | ((req: {
          type: "protocol_adapter_cancel"
          sessionId: string
          execId: string
          reason?: string
        }) => void)
      | null = null
    const cancel = jest.fn()
    mockSubscribeProtocolExec.mockImplementation(async (h) => {
      execHandler = h
      return () => {}
    })
    mockSubscribeProtocolCancel.mockImplementation(async (h) => {
      cancelHandler = h
      return () => {}
    })
    mockDispatchProtocolAdapterExec.mockReturnValue({ done: new Promise(() => {}), cancel })

    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await Promise.resolve()
    await Promise.resolve()

    execHandler!({
      type: "protocol_adapter_exec",
      sessionId: "s1",
      execId: "ex1",
    })
    cancelHandler!({
      type: "protocol_adapter_cancel",
      sessionId: "s1",
      execId: "ex1",
      reason: "interrupted",
    })

    expect(cancel).toHaveBeenCalledWith("interrupted")
  })

  it("fails a remote protocol adapter closed when the proxy feature is not advertised", async () => {
    let execHandler:
      | ((req: {
          type: "protocol_adapter_exec"
          sessionId: string
          execId: string
          remoteExecutionContext: object
        }) => void)
      | null = null
    mockActiveHostSupportsFeature.mockReturnValue(false)
    mockIsRemoteHostActive.mockReturnValue(true)
    mockSubscribeProtocolExec.mockImplementation(async (handler) => {
      execHandler = handler
      return () => {}
    })
    mockSendProtocolAdapterMessage.mockResolvedValue(undefined)
    const context = {
      hostId: "host-a",
      originDeviceId: "device-a",
      sessionId: "s1",
      generation: 1,
      requestId: "request-a",
      issuedAt: 1,
      expiresAt: 2,
    }

    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await Promise.resolve()
    execHandler!({
      type: "protocol_adapter_exec",
      sessionId: "s1",
      execId: "ex1",
      remoteExecutionContext: context,
    })
    await Promise.resolve()

    expect(mockDispatchProtocolAdapterExec).not.toHaveBeenCalled()
    expect(mockSendProtocolAdapterMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "protocol_adapter_error",
        error: expect.stringContaining("REMOTE_FEATURE_UNSUPPORTED"),
      }),
      context
    )
  })
})

describe("PluginToolDispatchProvider — plugin lifecycle hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSubscribe.mockResolvedValue(() => {})
    mockSubscribeProtocolExec.mockResolvedValue(() => {})
    mockSubscribeProtocolCancel.mockResolvedValue(() => {})
  })

  const req = {
    type: "plugin_hook_exec" as const,
    sessionId: "s1",
    execId: "e1",
    pluginId: "p1",
    hookId: "onPreToolUse",
    payload: { hook_event_name: "PreToolUse" },
  }

  it("subscribes once at mount — without this a configured plugin hook silently times out", async () => {
    mockSubscribeHook.mockResolvedValue(() => {})
    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await waitFor(() => expect(mockSubscribeHook).toHaveBeenCalledTimes(1))
  })

  it("routes a request through the handler and answers the sidecar", async () => {
    mockHandleHook.mockResolvedValue({ result: { block: "denied" } })
    mockSubscribeHook.mockImplementation(async (cb: (r: typeof req) => void) => {
      cb(req)
      return () => {}
    })

    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)

    await waitFor(() => expect(mockHandleHook).toHaveBeenCalledWith(req))
    await waitFor(() =>
      expect(mockSendHook).toHaveBeenCalledWith({
        sessionId: "s1",
        execId: "e1",
        result: { block: "denied" },
      })
    )
  })

  it("forwards a handler error so the sidecar stops waiting on its timeout", async () => {
    mockHandleHook.mockResolvedValue({ error: "no live handler for p1:onPreToolUse" })
    mockSubscribeHook.mockImplementation(async (cb: (r: typeof req) => void) => {
      cb(req)
      return () => {}
    })

    render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)

    await waitFor(() =>
      expect(mockSendHook).toHaveBeenCalledWith({
        sessionId: "s1",
        execId: "e1",
        error: "no live handler for p1:onPreToolUse",
      })
    )
  })

  it("unsubscribes on unmount", async () => {
    const unlisten = jest.fn()
    mockSubscribeHook.mockResolvedValue(unlisten)
    const { unmount } = render(<PluginToolDispatchProvider>child</PluginToolDispatchProvider>)
    await waitFor(() => expect(mockSubscribeHook).toHaveBeenCalled())
    unmount()
    await waitFor(() => expect(unlisten).toHaveBeenCalled())
  })
})
