/** @jest-environment jsdom */
import { act, render } from "@testing-library/react"
import type { ChatCopilotIntent } from "@/lib/reply-copilot/screen/overlay-client"
import type { ScreenCopilotControllerDeps } from "@/lib/reply-copilot/screen/controller"

const start = jest.fn(async () => undefined)
const handleIntent = jest.fn(async () => undefined)
const dispose = jest.fn()
let capturedDeps: ScreenCopilotControllerDeps | null = null
jest.mock("@/lib/reply-copilot/screen/controller", () => ({
  createScreenCopilotController: (deps: ScreenCopilotControllerDeps) => {
    capturedDeps = deps
    return { start, handleIntent, dispose }
  },
}))

let intentHandler: ((intent: ChatCopilotIntent) => void) | null = null
const offIntent = jest.fn()
jest.mock("@/lib/reply-copilot/screen/overlay-client", () => ({
  CHAT_COPILOT_COMMAND_ID: "chat-copilot.capture",
  closeChatCopilotOverlay: jest.fn(),
  openChatCopilotOverlay: jest.fn(),
  placeChatCopilotOverlay: jest.fn(),
  sendChatCopilotView: jest.fn(),
  onChatCopilotIntent: async (handler: (intent: ChatCopilotIntent) => void) => {
    intentHandler = handler
    return offIntent
  },
}))
jest.mock("@/lib/reply-copilot/screen/run-screen-copilot", () => ({
  readChatScreen: jest.fn(),
  draftForScreen: jest.fn(),
}))
const unregister = jest.fn()
const registerCommand = jest.fn((_reg: { id: string; handler: () => unknown }) => unregister)
jest.mock("@/lib/plugin/commands/registry", () => ({
  registerCommand: (reg: { id: string; handler: () => unknown }) => registerCommand(reg),
}))
const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))
const repair = jest.fn(async (_permission: string) => undefined)
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  repairSelectionToolbarPermission: (permission: string) => repair(permission),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  transport: { subscribe: jest.fn(() => () => {}) },
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: null }) },
}))

import { __resetConsentRouting, isConsentRoutedElsewhere } from "@/lib/automation/consent-routing"
import { ChatCopilotInitializer } from "./chat-copilot-initializer"

beforeEach(() => {
  __resetConsentRouting()
  jest.clearAllMocks()
})

describe("ChatCopilotInitializer", () => {
  it("registers the capture command and starts a run from it", async () => {
    render(<ChatCopilotInitializer />)
    await act(async () => {})
    expect(registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "chat-copilot.capture",
        title: "Chat copilot: read the chat in front",
        category: "chat",
        pluginId: null,
      })
    )
    await registerCommand.mock.calls[0][0].handler()
    expect(start).toHaveBeenCalled()
  })

  it("routes overlay intents to the controller", async () => {
    render(<ChatCopilotInitializer />)
    await act(async () => {})
    intentHandler?.({ kind: "retry" })
    expect(handleIntent).toHaveBeenCalledWith({ kind: "retry" })
  })

  it("claims the copilot's consent surface, links the grant and reports a missing overlay", async () => {
    render(<ChatCopilotInitializer />)
    await act(async () => {})
    const release = capturedDeps!.consent.claim()
    expect(isConsentRoutedElsewhere({ id: "x", surface: "chatCopilot" })).toBe(true)
    release()
    await capturedDeps!.openScreenRecordingSettings()
    expect(repair).toHaveBeenCalledWith("screenRecording")
    capturedDeps!.onOverlayUnavailable()
    expect(toastError).toHaveBeenCalledWith(
      "The chat copilot window could not open. Its permission prompt appears in the main window instead."
    )
  })

  it("unregisters and disposes on unmount", async () => {
    const { unmount } = render(<ChatCopilotInitializer />)
    await act(async () => {})
    unmount()
    expect(unregister).toHaveBeenCalled()
    expect(offIntent).toHaveBeenCalled()
    expect(dispose).toHaveBeenCalled()
  })
})
