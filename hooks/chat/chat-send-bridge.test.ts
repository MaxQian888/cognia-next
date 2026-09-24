import {
  registerChatRetryBridge,
  registerChatSendBridge,
  retryChatTurn,
  sendChatMessage,
  __resetChatSendBridgeForTesting,
} from "./chat-send-bridge"

describe("chat-send-bridge", () => {
  beforeEach(() => __resetChatSendBridgeForTesting())
  afterEach(() => __resetChatSendBridgeForTesting())

  it("delivers the text to the registered send with its target session", () => {
    const send = jest.fn()
    registerChatSendBridge(send)
    expect(sendChatMessage("s-1", "hello")).toBe(true)
    expect(send).toHaveBeenCalledWith("hello", "s-1")
  })

  it("returns false when no runtime is registered rather than pretending", () => {
    expect(sendChatMessage("s-1", "hello")).toBe(false)
  })

  it("rejects empty text and empty session ids without calling send", () => {
    const send = jest.fn()
    registerChatSendBridge(send)
    expect(sendChatMessage("", "hello")).toBe(false)
    expect(sendChatMessage("s-1", "   ")).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it("stops delivering after the hook unregisters", () => {
    const send = jest.fn()
    const unregister = registerChatSendBridge(send)
    unregister()
    expect(sendChatMessage("s-1", "hello")).toBe(false)
  })

  it("a later registration replaces the earlier one", () => {
    const first = jest.fn()
    const second = jest.fn()
    registerChatSendBridge(first)
    registerChatSendBridge(second)
    sendChatMessage("s-1", "hi")
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith("hi", "s-1")
  })
})

describe("chat retry bridge", () => {
  beforeEach(() => __resetChatSendBridgeForTesting())

  it("re-runs the named session's turn through the registered retry", () => {
    const retry = jest.fn()
    registerChatRetryBridge(retry)
    expect(retryChatTurn("s-1")).toBe(true)
    expect(retry).toHaveBeenCalledWith("s-1")
  })

  it("returns false with no runtime, an empty id, or after unregistering", () => {
    expect(retryChatTurn("s-1")).toBe(false)
    const retry = jest.fn()
    const unregister = registerChatRetryBridge(retry)
    expect(retryChatTurn("")).toBe(false)
    unregister()
    expect(retryChatTurn("s-1")).toBe(false)
    expect(retry).not.toHaveBeenCalled()
  })
})
