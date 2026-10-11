import { act, render, waitFor } from "@testing-library/react"

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
jest.mock("@/lib/tauri/tray-panel", () => ({
  onTrayPanelRequest: jest.fn(),
  sendTrayPanelResult: jest.fn().mockResolvedValue(true),
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: jest.fn() }))
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => true),
}))
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(),
  deletePref: jest.fn(),
}))
jest.mock("@cognia/logging", () => {
  const actual = jest.requireActual("@cognia/logging")
  const tray = { warn: jest.fn() }
  return {
    ...actual,
    loggers: new Proxy(actual.loggers, {
      get: (target, key) =>
        key === "tray" ? tray : (target as Record<string | symbol, unknown>)[key],
    }),
  }
})
jest.mock("@/stores/settings", () => {
  const { create } = jest.requireActual("zustand") as typeof import("zustand")
  return {
    useSettingsStore: create(() => ({
      loaded: false,
      loadFailed: false,
      settings: {} as Record<string, unknown> | null,
      save: jest.fn(),
    })),
  }
})

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

import { loggers } from "@cognia/logging"
import { toast } from "sonner"
import { startNewSession } from "@/lib/chat/start-session"
import { executeCommand, getCommand } from "@/lib/plugin/commands/registry"
import { dispatchSlashCommand } from "@/lib/slash-commands/registry"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { isTauri } from "@/lib/tauri"
import { deletePref, getPref } from "@/lib/tauri/store"
import { onTrayPanelRequest, sendTrayPanelResult } from "@/lib/tauri/tray-panel"
import { TRAY_PANEL_ACTIONS_PREF } from "@/lib/tray-panel/defaults"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useUIStore } from "@/stores/ui"
import type { TrayPanelResolvedEffect, TrayPanelRunRequest } from "@/lib/tray-panel/types"

import { TrayPanelInitializer } from "./tray-panel-initializer"

const onRequestMock = onTrayPanelRequest as jest.Mock
const sendResultMock = sendTrayPanelResult as jest.Mock
const startNewSessionMock = startNewSession as jest.Mock
const dispatchSlashMock = dispatchSlashCommand as jest.Mock
const executeCommandMock = executeCommand as jest.Mock
const getCommandMock = getCommand as jest.Mock
const isMainAppWindowMock = isMainAppWindow as jest.Mock
const toastErrorMock = toast.error as jest.Mock
const isTauriMock = isTauri as jest.Mock
const getPrefMock = getPref as jest.Mock
const deletePrefMock = deletePref as jest.Mock
const warnMock = (loggers as unknown as { tray: { warn: jest.Mock } }).tray.warn
const settingsStore = useSettingsStore as unknown as {
  getState: () => { save: jest.Mock }
  setState: (patch: Record<string, unknown>) => void
}

/** Capture the handler the initializer registers, then drive it directly. */
let requestHandler: ((request: TrayPanelRunRequest) => void) | undefined

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
  isMainAppWindowMock.mockReturnValue(true)
  onRequestMock.mockImplementation((handler) => {
    requestHandler = handler
    return Promise.resolve(() => {})
  })
  startNewSessionMock.mockResolvedValue({ id: "new-session" })
  ;(useChatStore.getState as jest.Mock).mockReturnValue({
    activeSessionId: null,
    setActiveSession,
  })
  ;(useComposerIntentStore.getState as jest.Mock).mockReturnValue({ stage })
  ;(useUIStore.getState as jest.Mock).mockReturnValue({ setSelectedGuild })
  isTauriMock.mockReturnValue(true)
  getPrefMock.mockReset().mockResolvedValue(null)
  deletePrefMock.mockReset().mockResolvedValue(undefined)
  warnMock.mockClear()
  settingsStore.getState().save.mockReset().mockResolvedValue(undefined)
  settingsStore.setState({ loaded: false, loadFailed: false, settings: {} })
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

  it("listens for run requests only; panel state comes from the glance snapshot", async () => {
    await mountAndWait()
    expect(onRequestMock).toHaveBeenCalledTimes(1)
  })
})

describe("TrayPanelInitializer: action catalogue import", () => {
  const stored = [
    {
      id: "mine",
      label: "Mine",
      fields: [],
      trigger: { kind: "manual" },
      effect: { kind: "navigate", path: "/x" },
    },
  ]
  const save = () => settingsStore.getState().save
  const loadSettings = (patch: Record<string, unknown> = {}) =>
    act(() => settingsStore.setState({ loaded: true, loadFailed: false, ...patch }))

  it("imports the stored catalogue into settings once they loaded, then drops the pref", async () => {
    getPrefMock.mockResolvedValue(stored)
    loadSettings()
    render(<TrayPanelInitializer />)

    await waitFor(() => expect(deletePrefMock).toHaveBeenCalledTimes(1))
    expect(getPrefMock).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF)
    expect(save()).toHaveBeenCalledTimes(1)
    expect(save()).toHaveBeenCalledWith({ trayPanelActions: stored })
    expect(deletePrefMock).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF)
    // The pref is deleted only after the catalogue is in settings.
    expect(save().mock.invocationCallOrder[0]).toBeLessThan(
      deletePrefMock.mock.invocationCallOrder[0]
    )
  })

  it("waits for settings to load", async () => {
    getPrefMock.mockResolvedValue(stored)
    render(<TrayPanelInitializer />)
    await waitFor(() => expect(onRequestMock).toHaveBeenCalled())
    expect(getPrefMock).not.toHaveBeenCalled()

    loadSettings()
    await waitFor(() => expect(save()).toHaveBeenCalledWith({ trayPanelActions: stored }))
  })

  it("does not run when settings failed to load", async () => {
    // A failed load falls back to defaults in memory; saving into that would
    // write a catalogue over a database that could not be read.
    getPrefMock.mockResolvedValue(stored)
    loadSettings({ loadFailed: true })
    render(<TrayPanelInitializer />)
    await waitFor(() => expect(onRequestMock).toHaveBeenCalled())
    await Promise.resolve()
    expect(getPrefMock).not.toHaveBeenCalled()
    expect(save()).not.toHaveBeenCalled()
    expect(deletePrefMock).not.toHaveBeenCalled()
  })

  it("does not run outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    loadSettings()
    render(<TrayPanelInitializer />)
    await waitFor(() => expect(onRequestMock).toHaveBeenCalled())
    expect(getPrefMock).not.toHaveBeenCalled()
  })

  it("does not run in a secondary window", async () => {
    isMainAppWindowMock.mockReturnValue(false)
    loadSettings()
    render(<TrayPanelInitializer />)
    await Promise.resolve()
    expect(getPrefMock).not.toHaveBeenCalled()
    expect(save()).not.toHaveBeenCalled()
  })

  it("runs once per mount, not on every settings load", async () => {
    getPrefMock.mockResolvedValue(stored)
    loadSettings()
    render(<TrayPanelInitializer />)
    await waitFor(() => expect(deletePrefMock).toHaveBeenCalledTimes(1))

    act(() => settingsStore.setState({ loaded: false }))
    loadSettings()
    await Promise.resolve()
    expect(getPrefMock).toHaveBeenCalledTimes(1)
    expect(save()).toHaveBeenCalledTimes(1)
  })

  it("keeps a catalogue settings already hold and only drops the pref", async () => {
    getPrefMock.mockResolvedValue(stored)
    loadSettings({ settings: { trayPanelActions: [] } })
    render(<TrayPanelInitializer />)

    await waitFor(() => expect(deletePrefMock).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF))
    expect(save()).not.toHaveBeenCalled()
  })

  it("does nothing when there is no pref", async () => {
    loadSettings()
    render(<TrayPanelInitializer />)
    await waitFor(() => expect(getPrefMock).toHaveBeenCalled())
    await Promise.resolve()
    expect(save()).not.toHaveBeenCalled()
    expect(deletePrefMock).not.toHaveBeenCalled()
  })

  it("logs a rejected save, keeps the pref, and retries on the next settings load", async () => {
    getPrefMock.mockResolvedValue(stored)
    save().mockRejectedValueOnce(new Error("disk full"))
    loadSettings()
    render(<TrayPanelInitializer />)

    await waitFor(() => expect(warnMock).toHaveBeenCalledTimes(1))
    expect(warnMock).toHaveBeenCalledWith(
      "tray panel action import failed",
      expect.objectContaining({ error: expect.stringContaining("disk full") })
    )
    expect(deletePrefMock).not.toHaveBeenCalled()

    act(() => settingsStore.setState({ loaded: false }))
    loadSettings()
    await waitFor(() => expect(deletePrefMock).toHaveBeenCalledTimes(1))
    expect(save()).toHaveBeenCalledTimes(2)
  })

  it("logs a failing pref read without crashing", async () => {
    getPrefMock.mockRejectedValue(new Error("store unavailable"))
    loadSettings()
    render(<TrayPanelInitializer />)
    await waitFor(() => expect(warnMock).toHaveBeenCalledTimes(1))
    expect(deletePrefMock).not.toHaveBeenCalled()
  })
})

describe("TrayPanelInitializer: render", () => {
  it("renders nothing", async () => {
    const { container } = render(<TrayPanelInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
