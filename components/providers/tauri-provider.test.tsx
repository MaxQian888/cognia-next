/**
 * @jest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react"

// ── Mocks ───────────────────────────────────────────────────────────────
// This provider is the desktop boot sequence: it fans out to tray, shortcuts,
// notifications, crash context, and CLI/deep-link handling. Everything is
// stubbed so the suite can exercise the launch-argument branch on its own.

const isTauriMock = jest.fn(() => true)
const isMainAppWindowMock = jest.fn(() => true)
const getLaunchCliMock = jest.fn(async () => ({
  workspacePath: undefined as string | undefined,
  newChat: false,
}))
const getLaunchDeepLinkMock = jest.fn(async () => [] as string[])
const startNewSessionMock = jest.fn(async (..._args: unknown[]) => ({ id: "s-new" }))
const setSelectedGuildMock = jest.fn()
const saveSettingsMock = jest.fn(async () => undefined)
const chatClearMock = jest.fn()
const setActiveSessionMock = jest.fn()
const requestOpenSettingsMock = jest.fn()
const openPathAsWorkspaceMock = jest.fn()
const ensureNotificationPermissionMock = jest.fn(async () => "granted")

jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
jest.mock("@/lib/pet/window-role", () => ({ isMainAppWindow: () => isMainAppWindowMock() }))
jest.mock("@/lib/tauri/cli", () => ({ getLaunchCli: () => getLaunchCliMock() }))
jest.mock("@/lib/tauri/deep-link", () => ({ getLaunchDeepLink: () => getLaunchDeepLinkMock() }))
const publishLogtoDeepLinkCallbackMock = jest.fn()
jest.mock("@/lib/logto/deep-link-callback", () => ({
  publishLogtoDeepLinkCallback: (route: unknown) => publishLogtoDeepLinkCallbackMock(route),
}))
jest.mock("@/lib/workspace/open-folder", () => ({
  openPathAsWorkspace: (path: string) => openPathAsWorkspaceMock(path),
}))
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => startNewSessionMock(...args),
}))

jest.mock("@/hooks/chat/use-session-notifications", () => ({
  useSessionNotifications: jest.fn(),
}))
jest.mock("@/hooks/system", () => ({ useTauriEvents: jest.fn() }))
jest.mock("@/lib/tauri/notification", () => ({
  ensureNotificationPermission: () => ensureNotificationPermissionMock(),
}))
jest.mock("@/lib/tauri/close-behavior", () => ({
  getCloseBehavior: jest.fn(async () => "quit"),
  pushCloseBehaviorToRust: jest.fn(async () => undefined),
}))
jest.mock("@/lib/tauri/shell-window", () => ({
  setWindowBackgroundColor: jest.fn(async () => undefined),
}))
jest.mock("@/lib/appearance/shell-sync", () => ({
  getShellColors: () => ({ backgroundHex: "#000000" }),
}))
jest.mock("@/lib/tray/store", () => ({
  useTrayStore: { getState: () => ({ hydrate: jest.fn(async () => undefined) }) },
}))
jest.mock("@/lib/tray/sync", () => ({ useSyncTrayToRust: jest.fn() }))
jest.mock("@/lib/shortcuts/sync", () => ({ useSyncShortcutsToRust: jest.fn() }))
jest.mock("@/lib/tray/icon-builder", () => ({
  rasterizeAndRegisterTrayIcons: jest.fn(async () => undefined),
}))
jest.mock("@/lib/native/crash-context", () => ({
  pushCrashContext: jest.fn(async () => undefined),
}))
jest.mock("@/lib/notifications/install", () => ({ installNotificationBridges: jest.fn() }))
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }))
const routerPushMock = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPushMock }) }))
const handlePromotedTaskWakeMock = jest.fn(async (..._args: unknown[]) => ({ ran: true }))
jest.mock("@/lib/scheduler/promoted-wake", () => ({
  handlePromotedTaskWake: (...args: unknown[]) => handlePromotedTaskWakeMock(...args),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), message: jest.fn() } }))

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(<T,>(selector: (s: unknown) => T): T => selector({}), {
    getState: () => ({ clear: chatClearMock, setActiveSession: setActiveSessionMock }),
  }),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(<T,>(selector: (s: unknown) => T): T => selector({}), {
    getState: () => ({ save: saveSettingsMock }),
  }),
}))
jest.mock("@/stores/ui", () => ({
  useUIStore: Object.assign(<T,>(selector: (s: unknown) => T): T => selector({}), {
    getState: () => ({
      setSelectedGuild: setSelectedGuildMock,
      requestOpenSettings: requestOpenSettingsMock,
    }),
  }),
}))

import { TauriProvider } from "./tauri-provider"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  isMainAppWindowMock.mockReturnValue(true)
  getLaunchCliMock.mockResolvedValue({ workspacePath: undefined, newChat: false })
  getLaunchDeepLinkMock.mockResolvedValue([])
  startNewSessionMock.mockResolvedValue({ id: "s-new" })
})

describe("<TauriProvider /> launch CLI args", () => {
  it("does not prompt for OS notification permission during boot", async () => {
    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )

    await waitFor(() => expect(getLaunchCliMock).toHaveBeenCalled())
    expect(ensureNotificationPermissionMock).not.toHaveBeenCalled()
  })

  it("starts a conversation in the DM guild for --new-chat", async () => {
    getLaunchCliMock.mockResolvedValue({ workspacePath: undefined, newChat: true })

    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )

    await waitFor(() => expect(startNewSessionMock).toHaveBeenCalled())
    expect(setSelectedGuildMock).toHaveBeenCalledWith({ kind: "dm" })
    // The old behavior nuked every open pane and created nothing.
    expect(chatClearMock).not.toHaveBeenCalled()
  })

  it("leaves sessions alone when --new-chat is absent", async () => {
    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )

    await waitFor(() => expect(getLaunchCliMock).toHaveBeenCalled())
    expect(startNewSessionMock).not.toHaveBeenCalled()
  })

  it("skips the whole boot sequence outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)

    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )

    await waitFor(() => expect(getLaunchCliMock).not.toHaveBeenCalled())
    expect(startNewSessionMock).not.toHaveBeenCalled()
  })

  it("skips the boot sequence in pet windows (least-privilege)", async () => {
    isMainAppWindowMock.mockReturnValue(false)
    getLaunchCliMock.mockResolvedValue({ workspacePath: undefined, newChat: true })

    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )

    await waitFor(() => expect(getLaunchCliMock).not.toHaveBeenCalled())
    expect(startNewSessionMock).not.toHaveBeenCalled()
  })

  it("routes a cold-start scheduler wake-up link through the shared promoted-task handler", async () => {
    getLaunchDeepLinkMock.mockResolvedValue([
      "cognia://scheduler/task/task-9?run=tok-1",
      "cognia://scheduler/",
      "https://example.com/not-cognia",
    ])
    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )
    await waitFor(() => expect(handlePromotedTaskWakeMock).toHaveBeenCalledTimes(1))
    const [input, deps] = handlePromotedTaskWakeMock.mock.calls[0] as unknown as [
      { taskId: string; runToken?: string },
      { navigate: (path: string) => void },
    ]
    expect(input).toEqual({ taskId: "task-9", runToken: "tok-1" })
    deps.navigate("/scheduler")
    expect(routerPushMock).toHaveBeenCalledWith("/scheduler")
  })

  it("publishes a cold-start Logto callback link to the sign-in seam", async () => {
    getLaunchDeepLinkMock.mockResolvedValue(["cognia://logto/callback?code=c-2&state=st-2"])
    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )
    await waitFor(() => expect(publishLogtoDeepLinkCallbackMock).toHaveBeenCalledTimes(1))
    expect(publishLogtoDeepLinkCallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "logto_callback", code: "c-2", state: "st-2" })
    )
  })

  it("opens the conversation a cold-start session link names", async () => {
    // `cognia://session/<id>` is the link every Browser Companion submission
    // carries. The cold-start path knew only `chat`, so a click that launched
    // Cognia opened it on nothing.
    getLaunchDeepLinkMock.mockResolvedValue(["cognia://session/s-7"])
    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )
    await waitFor(() => expect(setActiveSessionMock).toHaveBeenCalledWith("s-7"))
    expect(setSelectedGuildMock).toHaveBeenCalledWith({ kind: "dm" })
  })

  it("keeps the older chat alias working at cold start", async () => {
    getLaunchDeepLinkMock.mockResolvedValue(["cognia://chat/c-1"])
    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )
    await waitFor(() => expect(setActiveSessionMock).toHaveBeenCalledWith("c-1"))
  })

  it("routes the rest of the vocabulary at cold start too", async () => {
    getLaunchDeepLinkMock.mockResolvedValue([
      "cognia://issues/issue-3",
      "cognia://settings?tab=advanced",
      "cognia://workspace?path=%2Fwork",
    ])
    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith("/issues?id=issue-3"))
    await waitFor(() => expect(requestOpenSettingsMock).toHaveBeenCalledWith("advanced"))
    await waitFor(() => expect(openPathAsWorkspaceMock).toHaveBeenCalledWith("/work"))
  })

  it("logs an unknown launch link and carries on with the next one", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    getLaunchDeepLinkMock.mockResolvedValue(["cognia://nope", "cognia://session/s-8"])
    render(
      <TauriProvider>
        <div />
      </TauriProvider>
    )
    await waitFor(() => expect(setActiveSessionMock).toHaveBeenCalledWith("s-8"))
    expect(warn).toHaveBeenCalledWith("unhandled launch deep link", "cognia://nope")
    warn.mockRestore()
  })

  it("renders its children", () => {
    const { getByTestId } = render(
      <TauriProvider>
        <div data-testid="child" />
      </TauriProvider>
    )
    expect(getByTestId("child")).toBeInTheDocument()
  })
})
