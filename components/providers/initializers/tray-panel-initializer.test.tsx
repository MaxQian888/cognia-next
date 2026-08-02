import { render, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: jest.fn().mockResolvedValue({ id: "new-session" }),
}))
jest.mock("@/lib/slash-commands/registry", () => ({ dispatchSlashCommand: jest.fn() }))
jest.mock("@/lib/plugin/commands/registry", () => ({
  executeCommand: jest.fn(),
  getCommand: jest.fn(),
}))
jest.mock("@/lib/pet/window-role", () => ({ isMainAppWindow: jest.fn(() => true) }))
jest.mock("@/lib/tray/state-snapshot", () => ({
  useTrayStateSnapshot: () => ({ platform: { os: "macos" } }),
}))
jest.mock("@/lib/tauri/tray-panel", () => ({
  onTrayPanelRequest: jest.fn(),
  onTrayPanelStateRequest: jest.fn(),
  sendTrayPanelResult: jest.fn().mockResolvedValue(true),
  sendTrayPanelState: jest.fn().mockResolvedValue(true),
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: jest.fn() }))

const setActiveSession = jest.fn()
const setSelectedGuild = jest.fn()
const stage = jest.fn()

jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: jest.fn() },
}))
jest.mock("@/stores/chat/composer-intent-store", () => ({
  useComposerIntentStore: { getState: jest.fn() },
}))
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: jest.fn() },
}))

import { toast } from "sonner"
import { startNewSession } from "@/lib/chat/start-session"
import { executeCommand, getCommand } from "@/lib/plugin/commands/registry"
import { dispatchSlashCommand } from "@/lib/slash-commands/registry"
import { isMainAppWindow } from "@/lib/pet/window-role"
import {
  onTrayPanelRequest,
  onTrayPanelStateRequest,
  sendTrayPanelResult,
  sendTrayPanelState,
} from "@/lib/tauri/tray-panel"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useUIStore } from "@/stores/ui"
import type { TrayPanelResolvedEffect, TrayPanelRunRequest } from "@/lib/tray-panel/types"

import { TrayPanelInitializer } from "./tray-panel-initializer"

const onRequestMock = onTrayPanelRequest as jest.Mock
const onStateRequestMock = onTrayPanelStateRequest as jest.Mock
const sendResultMock = sendTrayPanelResult as jest.Mock
const sendStateMock = sendTrayPanelState as jest.Mock
const startNewSessionMock = startNewSession as jest.Mock
const dispatchSlashMock = dispatchSlashCommand as jest.Mock
const executeCommandMock = executeCommand as jest.Mock
const getCommandMock = getCommand as jest.Mock
const isMainAppWindowMock = isMainAppWindow as jest.Mock
const toastErrorMock = toast.error as jest.Mock

/** Capture the handler the initializer registers, then drive it directly. */
let requestHandler: ((request: TrayPanelRunRequest) => void) | undefined
let stateRequestHandler: (() => void) | undefined

function request(effect: TrayPanelResolvedEffect): TrayPanelRunRequest {
  return {
    requestId: "req-1",
    actionId: "a",
    actionLabel: "Action",
    effect,
    focusMainWindow: true,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  requestHandler = undefined
  stateRequestHandler = undefined
  isMainAppWindowMock.mockReturnValue(true)
  onRequestMock.mockImplementation((handler) => {
    requestHandler = handler
    return Promise.resolve(() => {})
  })
  onStateRequestMock.mockImplementation((handler) => {
    stateRequestHandler = handler
    return Promise.resolve(() => {})
  })
  startNewSessionMock.mockResolvedValue({ id: "new-session" })
  ;(useChatStore.getState as jest.Mock).mockReturnValue({
    activeSessionId: null,
    setActiveSession,
  })
  ;(useComposerIntentStore.getState as jest.Mock).mockReturnValue({ stage })
  ;(useUIStore.getState as jest.Mock).mockReturnValue({ setSelectedGuild })
})

async function mountAndWait() {
  render(<TrayPanelInitializer />)
  await waitFor(() => expect(requestHandler).toBeDefined())
}

describe("TrayPanelInitializer", () => {
  it("stays inert in a secondary overlay window", async () => {
    // Delegating is not idempotent — a second execution would create a second
    // conversation.
    isMainAppWindowMock.mockReturnValue(false)
    render(<TrayPanelInitializer />)
    await Promise.resolve()
    expect(onRequestMock).not.toHaveBeenCalled()
  })

  it("delegates into a fresh session and stages the prompt", async () => {
    await mountAndWait()
    requestHandler!(
      request({ kind: "delegate", prompt: "Fix it", target: "newSession", autoSend: true })
    )

    await waitFor(() => expect(stage).toHaveBeenCalled())
    expect(startNewSessionMock).toHaveBeenCalled()
    expect(setActiveSession).toHaveBeenCalledWith("new-session")
    expect(stage).toHaveBeenCalledWith("new-session", {
      candidateId: "req-1",
      prompt: "Fix it",
      autoSend: true,
    })
    expect(sendResultMock).toHaveBeenCalledWith({ requestId: "req-1", ok: true })
  })

  it("continues the active session when the action asks for it", async () => {
    ;(useChatStore.getState as jest.Mock).mockReturnValue({
      activeSessionId: "existing",
      setActiveSession,
    })
    await mountAndWait()
    requestHandler!(
      request({ kind: "delegate", prompt: "More", target: "activeSession", autoSend: false })
    )

    await waitFor(() => expect(stage).toHaveBeenCalled())
    expect(startNewSessionMock).not.toHaveBeenCalled()
    expect(stage).toHaveBeenCalledWith("existing", expect.objectContaining({ autoSend: false }))
  })

  it("falls back to a new session when activeSession is requested but none exists", async () => {
    await mountAndWait()
    requestHandler!(
      request({ kind: "delegate", prompt: "x", target: "activeSession", autoSend: true })
    )

    await waitFor(() => expect(startNewSessionMock).toHaveBeenCalled())
    expect(stage).toHaveBeenCalledWith("new-session", expect.anything())
  })

  it("dispatches a slash command", async () => {
    await mountAndWait()
    requestHandler!(request({ kind: "slash", line: "/clear" }))

    await waitFor(() => expect(dispatchSlashMock).toHaveBeenCalledWith("/clear"))
    expect(sendResultMock).toHaveBeenCalledWith({ requestId: "req-1", ok: true })
  })

  it("runs a registered plugin command", async () => {
    getCommandMock.mockReturnValue({ id: "x.y" })
    await mountAndWait()
    requestHandler!(request({ kind: "command", commandId: "x.y" }))

    await waitFor(() => expect(executeCommandMock).toHaveBeenCalledWith("x.y"))
  })

  it("reports an unregistered command instead of silently doing nothing", async () => {
    getCommandMock.mockReturnValue(undefined)
    await mountAndWait()
    requestHandler!(request({ kind: "command", commandId: "gone" }))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(executeCommandMock).not.toHaveBeenCalled()
    expect(sendResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1", ok: false })
    )
  })

  it("reports a failure back to the panel and raises a toast", async () => {
    // The panel is normally already dismissed, so the failure has to land
    // somewhere the user will actually see it.
    dispatchSlashMock.mockRejectedValue(new Error("boom"))
    await mountAndWait()
    requestHandler!(request({ kind: "slash", line: "/broken" }))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(sendResultMock).toHaveBeenCalledWith({
      requestId: "req-1",
      ok: false,
      error: "boom",
    })
  })

  it("rejects a native effect, which must go straight to Rust", async () => {
    await mountAndWait()
    requestHandler!(request({ kind: "native", action: "show" }))

    await waitFor(() =>
      expect(sendResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "req-1", ok: false })
      )
    )
  })

  it("answers a snapshot request with the live snapshot", async () => {
    await mountAndWait()
    await waitFor(() => expect(stateRequestHandler).toBeDefined())
    stateRequestHandler!()
    expect(sendStateMock).toHaveBeenCalledWith({ platform: { os: "macos" } })
  })

  it("renders nothing", async () => {
    const { container } = render(<TrayPanelInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
