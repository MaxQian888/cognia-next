import { act, render, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { SettingsSyncProvider } from "./settings-sync-provider"
import { applyZoom } from "@/lib/tauri/webview-zoom"
import { getPetWindowRole } from "@/lib/pet/window-role"

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
    getPetWindowRoleMock.mockReturnValue("main")
    useSettingsStore.setState({ settings: null, loaded: false })
    document.documentElement.style.fontSize = ""
    document.documentElement.removeAttribute("data-reduce-motion")
  })

  it("does nothing until settings are loaded", () => {
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    expect(mockSetTheme).not.toHaveBeenCalled()
    expect(applyZoomMock).not.toHaveBeenCalled()
  })

  it("mirrors theme, font scale, and zoom to the DOM in the main window", async () => {
    setLoadedSettings()
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    await waitFor(() => expect(mockSetTheme).toHaveBeenCalledWith("dark"))
    expect(document.documentElement.style.fontSize).toBe("16px")
    expect(applyZoomMock).toHaveBeenCalledWith(1.5)
  })

  it("sets the reduce-motion attribute only when enabled", async () => {
    setLoadedSettings({ reduceMotion: true })
    render(<SettingsSyncProvider>child</SettingsSyncProvider>)
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-reduce-motion")).toBe("true")
    )
  })

  it.each(["overlay", "popup"] as const)(
    "skips the webview zoom sync in the %s pet window (least-privilege, no capability)",
    async (role) => {
      getPetWindowRoleMock.mockReturnValue(role)
      setLoadedSettings()
      render(<SettingsSyncProvider>child</SettingsSyncProvider>)
      // Theme + font still sync (cheap DOM writes), but setZoom must not fire —
      // the pet windows lack core:webview:allow-set-webview-zoom.
      await waitFor(() => expect(mockSetTheme).toHaveBeenCalled())
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
