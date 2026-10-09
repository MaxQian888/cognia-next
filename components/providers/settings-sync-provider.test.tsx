import { act, render, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { SettingsSyncProvider } from "./settings-sync-provider"
import { applyZoom } from "@/lib/tauri/webview-zoom"
import { getPetWindowRole } from "@/lib/pet/window-role"
import { readAccountTheme } from "@/lib/appearance/lock-screen-preferences"

let mockAccountId: string | null = "acct_alpha"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId: mockAccountId }),
}))

const mockSetTheme = jest.fn()
jest.mock("next-themes", () => ({
  useTheme: () => ({ setTheme: mockSetTheme }),
}))

jest.mock("@/lib/tauri/webview-zoom", () => ({
  applyZoom: jest.fn().mockResolvedValue(1),
  DEFAULT_ZOOM: 1,
}))

jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: jest.fn(() => "main"),
}))

const applyZoomMock = applyZoom as jest.Mock
const getPetWindowRoleMock = getPetWindowRole as jest.Mock

function setLoadedSettings(over: Record<string, unknown> = {}): void {
  useSettingsStore.setState({
    loaded: true,
    settings: {
      id: "singleton",
      theme: "dark",
      fontScale: "md",
      reduceMotion: false,
      webviewZoom: 1.5,
      ...over,
    } as never,
  })
}

describe("SettingsSyncProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAccountId = "acct_alpha"
    window.localStorage.clear()
    getPetWindowRoleMock.mockReturnValue("main")
    useSettingsStore.setState({ settings: null, loaded: false })
    document.documentElement.style.fontSize = ""
    document.documentElement.removeAttribute("data-reduce-motion")
  })

  it("does nothing until settings are loaded", () => {
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    expect(mockSetTheme).not.toHaveBeenCalled()
    expect(readAccountTheme("acct_alpha")).toBeNull()
    expect(applyZoomMock).not.toHaveBeenCalled()
  })

  it("mirrors theme, font scale, and zoom to the DOM in the main window", async () => {
    setLoadedSettings()
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    await waitFor(() => expect(mockSetTheme).toHaveBeenCalledWith("dark"))
    expect(document.documentElement.style.fontSize).toBe("16px")
    expect(applyZoomMock).toHaveBeenCalledWith(1.5)
    expect(readAccountTheme("acct_alpha")).toBe("dark")
  })

  it("keeps each account's mode separate, including follow-system", () => {
    setLoadedSettings({ theme: "dark" })
    const { rerender } = render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    mockAccountId = "acct_beta"
    act(() => setLoadedSettings({ theme: "system" }))
    rerender(<SettingsSyncProvider>child</SettingsSyncProvider>)
    expect(readAccountTheme("acct_alpha")).toBe("dark")
    expect(readAccountTheme("acct_beta")).toBe("system")
  })

  it("does not cache unscoped settings as an account preference", () => {
    mockAccountId = null
    setLoadedSettings()
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    expect(readAccountTheme("acct_alpha")).toBeNull()
  })

  it("sets the reduce-motion attribute only when enabled", async () => {
    setLoadedSettings({ reduceMotion: true })
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-reduce-motion")).toBe("true")
    )
  })

  it.each([
    "overlay",
    "popup",
    "island",
    "selection-toolbar",
    "tray-panel",
    "usage-dock",
    "chat-copilot",
  ] as const)(
    "leaves the shared mode and the zoom to the main window in the %s window",
    async (role) => {
      getPetWindowRoleMock.mockReturnValue(role)
      setLoadedSettings({ theme: "system" })
      render(<SettingsSyncProvider>child</SettingsSyncProvider>)
      // Font still syncs (a cheap per-document DOM write).
      await waitFor(() => expect(document.documentElement.style.fontSize).toBe("16px"))
      // These windows never opened the account, so their `theme` is a default:
      // writing it to next-themes' shared key flipped the main window (dark →
      // light) through the storage event. They follow that key instead.
      expect(mockSetTheme).not.toHaveBeenCalled()
      expect(readAccountTheme("acct_alpha")).toBeNull()
      // And setZoom must not fire — they lack core:webview:allow-set-webview-zoom.
      expect(applyZoomMock).not.toHaveBeenCalled()
    }
  )

  it("applies the zoom sync in the web context", async () => {
    getPetWindowRoleMock.mockReturnValue("web")
    setLoadedSettings()
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    await waitFor(() => expect(applyZoomMock).toHaveBeenCalledWith(1.5))
  })

  it("does not re-fire setZoom when an unrelated settings field changes", async () => {
    setLoadedSettings()
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    await waitFor(() => expect(applyZoomMock).toHaveBeenCalledTimes(1))

    // A save that leaves the four synced fields untouched used to re-run the
    // whole effect via the whole-object `settings` dep — every re-run ended
    // in a webview setZoom repaint, the visible flicker after any save.
    act(() => setLoadedSettings({ sidebarDensity: "compact" }))
    expect(mockSetTheme).toHaveBeenCalledTimes(1)
    expect(applyZoomMock).toHaveBeenCalledTimes(1)
  })

  it("does not re-fire setZoom when only the theme changes", async () => {
    setLoadedSettings()
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    await waitFor(() => expect(applyZoomMock).toHaveBeenCalledTimes(1))

    // Theme save lands after the live setTheme() already painted — the zoom
    // IPC re-asserting the same factor a frame later was the repaint flicker.
    act(() => setLoadedSettings({ theme: "light" }))
    await waitFor(() => expect(mockSetTheme).toHaveBeenCalledWith("light"))
    expect(applyZoomMock).toHaveBeenCalledTimes(1)
  })

  it("re-applies zoom when webviewZoom itself changes", async () => {
    setLoadedSettings()
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    await waitFor(() => expect(applyZoomMock).toHaveBeenCalledWith(1.5))

    act(() => setLoadedSettings({ webviewZoom: 1.25 }))
    await waitFor(() => expect(applyZoomMock).toHaveBeenCalledWith(1.25))
    expect(applyZoomMock).toHaveBeenCalledTimes(2)
  })
})
