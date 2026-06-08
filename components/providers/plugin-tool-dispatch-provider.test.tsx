import { render } from "@testing-library/react"

jest.mock("@/lib/claude/ipc", () => ({
  subscribePluginToolExec: jest.fn(),
  sendPluginToolResponse: jest.fn(),
  subscribeProtocolAdapterExec: jest.fn().mockResolvedValue(() => {}),
  sendProtocolAdapterMessage: jest.fn(),
}))
jest.mock("@/lib/claude/plugin-tool-ipc", () => ({
  handlePluginToolExec: jest.fn(),
}))
jest.mock("@/lib/claude/protocol-adapter-ipc", () => ({
  dispatchProtocolAdapterExec: jest.fn().mockResolvedValue(undefined),
}))

import { PluginToolDispatchProvider } from "./plugin-tool-dispatch-provider"
import { subscribePluginToolExec, sendPluginToolResponse } from "@/lib/claude/ipc"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"
import type { PluginToolExecEvent } from "@/lib/claude/types"

const mockSubscribe = subscribePluginToolExec as jest.Mock
const mockSend = sendPluginToolResponse as jest.Mock
const mockHandle = handlePluginToolExec as jest.Mock

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
})
