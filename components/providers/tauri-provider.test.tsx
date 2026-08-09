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

jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
jest.mock("@/lib/pet/window-role", () => ({ isMainAppWindow: () => isMainAppWindowMock() }))
jest.mock("@/lib/tauri/cli", () => ({ getLaunchCli: () => getLaunchCliMock() }))
jest.mock("@/lib/tauri/deep-link", () => ({ getLaunchDeepLink: () => getLaunchDeepLinkMock() }))
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => startNewSessionMock(...args),
}))

jest.mock("@/hooks/chat/use-session-notifications", () => ({
  useSessionNotifications: jest.fn(),
}))
jest.mock("@/hooks/system", () => ({ useTauriEvents: jest.fn() }))
jest.mock("@/lib/tauri/notification", () => ({
  ensureNotificationPermission: jest.fn(async () => undefined),
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
jest.mock("sonner", () => ({ toast: { success: jest.fn(), message: jest.fn() } }))

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(<T,>(selector: (s: unknown) => T): T => selector({}), {
    getState: () => ({ clear: chatClearMock, setActiveSession: jest.fn() }),
  }),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(<T,>(selector: (s: unknown) => T): T => selector({}), {
    getState: () => ({ save: saveSettingsMock }),
  }),
}))
jest.mock("@/stores/ui", () => ({
  useUIStore: Object.assign(<T,>(selector: (s: unknown) => T): T => selector({}), {
    getState: () => ({ setSelectedGuild: setSelectedGuildMock }),
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

  it("renders its children", () => {
    const { getByTestId } = render(
      <TauriProvider>
        <div data-testid="child" />
      </TauriProvider>
    )
    expect(getByTestId("child")).toBeInTheDocument()
  })
})
