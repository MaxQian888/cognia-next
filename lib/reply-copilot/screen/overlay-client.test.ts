/** @jest-environment jsdom */

const invokeMock = jest.fn()
const emitToMock = jest.fn()
const subscribeMock = jest.fn((_event: string, _handler: unknown) => () => {})
let tauri = false

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: {
    call: (...a: unknown[]) => invokeMock(...a),
    subscribe: (event: string, handler: unknown) => subscribeMock(event, handler),
  },
}))
jest.mock("@tauri-apps/api/event", () => ({
  emitTo: (...a: unknown[]) => emitToMock(...a),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

import {
  CHAT_COPILOT_COMMAND_ID,
  CHAT_COPILOT_INTENT_EVENT,
  CHAT_COPILOT_VIEW_EVENT,
  CHAT_COPILOT_WINDOW_LABEL,
  MAIN_WINDOW_LABEL,
  closeChatCopilotOverlay,
  copyFromChatCopilotOverlay,
  onChatCopilotIntent,
  onChatCopilotView,
  openChatCopilotOverlay,
  placeChatCopilotOverlay,
  resizeChatCopilotOverlay,
  revealChatCopilotOverlay,
  sendChatCopilotIntent,
  sendChatCopilotView,
} from "./overlay-client"

const anchor = { x: 10, y: 20, width: 500, height: 400, scale: 2 }

beforeEach(() => {
  tauri = false
  invokeMock.mockReset().mockResolvedValue(undefined)
  emitToMock.mockReset().mockResolvedValue(undefined)
  subscribeMock.mockClear()
})

describe("chat copilot overlay client", () => {
  it("names the command the shortcut and tray dispatch", () => {
    expect(CHAT_COPILOT_COMMAND_ID).toBe("chat-copilot.capture")
  })

  it("is inert outside Tauri", async () => {
    await expect(openChatCopilotOverlay(anchor)).resolves.toBe(false)
    await expect(sendChatCopilotView({ phase: "capturing", runId: 1 })).resolves.toBe(false)
    await expect(sendChatCopilotIntent({ kind: "ready" })).resolves.toBe(false)
    await closeChatCopilotOverlay()
    ;(await onChatCopilotIntent(jest.fn()))()
    ;(await onChatCopilotView(jest.fn()))()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(emitToMock).not.toHaveBeenCalled()
    expect(subscribeMock).not.toHaveBeenCalled()
  })

  it("drives the overlay window's commands", async () => {
    tauri = true
    await expect(openChatCopilotOverlay(null)).resolves.toBe(true)
    await placeChatCopilotOverlay(anchor)
    await resizeChatCopilotOverlay(360, 480)
    await revealChatCopilotOverlay()
    await closeChatCopilotOverlay()
    expect(invokeMock.mock.calls).toEqual([
      ["chat_copilot_open", { anchor: null }],
      ["chat_copilot_place", { anchor }],
      ["chat_copilot_resize", { width: 360, height: 480 }],
      ["chat_copilot_reveal", undefined],
      ["chat_copilot_close", undefined],
    ])
  })

  it("copies through the host clipboard in Tauri, rejecting on failure", async () => {
    tauri = true
    await copyFromChatCopilotOverlay("三点可以")
    expect(invokeMock).toHaveBeenCalledWith("chat_copilot_copy", { text: "三点可以" })
    invokeMock.mockRejectedValueOnce(new Error("denied"))
    await expect(copyFromChatCopilotOverlay("x")).rejects.toThrow("denied")
  })

  it("reports an overlay that could not open", async () => {
    tauri = true
    invokeMock.mockRejectedValueOnce(new Error("no panel"))
    await expect(openChatCopilotOverlay(anchor)).resolves.toBe(false)
  })

  it("sends views to the overlay and intents to the main window, by label", async () => {
    tauri = true
    await expect(sendChatCopilotView({ phase: "reading", runId: 2 })).resolves.toBe(true)
    await expect(sendChatCopilotIntent({ kind: "retry" })).resolves.toBe(true)
    expect(emitToMock.mock.calls).toEqual([
      [CHAT_COPILOT_WINDOW_LABEL, CHAT_COPILOT_VIEW_EVENT, { phase: "reading", runId: 2 }],
      [MAIN_WINDOW_LABEL, CHAT_COPILOT_INTENT_EVENT, { kind: "retry" }],
    ])
    emitToMock.mockRejectedValueOnce(new Error("no window"))
    await expect(sendChatCopilotView({ phase: "capturing", runId: 3 })).resolves.toBe(false)
  })

  it("subscribes each side to its own event", async () => {
    tauri = true
    await onChatCopilotIntent(jest.fn())
    await onChatCopilotView(jest.fn())
    expect(subscribeMock.mock.calls.map(([event]) => event)).toEqual([
      CHAT_COPILOT_INTENT_EVENT,
      CHAT_COPILOT_VIEW_EVENT,
    ])
  })
})
