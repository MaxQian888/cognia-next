import { render } from "@testing-library/react"

jest.mock("@/lib/claude/ipc", () => ({
  subscribePluginToolExec: jest.fn(),
  sendPluginToolResponse: jest.fn(),
  subscribeProtocolAdapterExec: jest.fn().mockResolvedValue(() => {}),
  subscribeProtocolAdapterCancel: jest.fn().mockResolvedValue(() => {}),
  sendProtocolAdapterMessage: jest.fn(),
}))
jest.mock("@/lib/claude/plugin-tool-ipc", () => ({
  handlePluginToolExec: jest.fn(),
}))
jest.mock("@/lib/claude/protocol-adapter-ipc", () => ({
  dispatchProtocolAdapterExec: jest.fn().mockResolvedValue(undefined),
}))

import { PluginToolDispatchProvider } from "./plugin-tool-dispatch-provider"
import {
  subscribePluginToolExec,
  sendPluginToolResponse,
  subscribeProtocolAdapterExec,
  subscribeProtocolAdapterCancel,
} from "@/lib/claude/ipc"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"
import { dispatchProtocolAdapterExec } from "@/lib/claude/protocol-adapter-ipc"
import type { PluginToolExecEvent } from "@cognia/agent-config-types"

const mockSubscribe = subscribePluginToolExec as jest.Mock
const mockSend = sendPluginToolResponse as jest.Mock
const mockHandle = handlePluginToolExec as jest.Mock
const mockSubscribeProtocolExec = subscribeProtocolAdapterExec as jest.Mock
const mockSubscribeProtocolCancel = subscribeProtocolAdapterCancel as jest.Mock
const mockDispatchProtocolAdapterExec = dispatchProtocolAdapterExec as jest.Mock

describe("PluginToolDispatchProvider", () => {
  beforeEach(() => jest.clearAllMocks())

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
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: "t1", result: "ok" })
    )
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
})
