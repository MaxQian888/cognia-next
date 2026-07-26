import { renderHook, waitFor } from "@testing-library/react"

import { DEFAULT_A11Y } from "@/types/appearance"
import { DEFAULT_CANVAS_SETTINGS } from "@/types/canvas/settings"

let mockIsTauri = true
let mockResolvedTheme: string | undefined = "dark"

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: mockResolvedTheme }) }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { readUserSettings: jest.fn(), writeUserSettings: jest.fn() },
}))

const setPaneBackground = jest.fn()
jest.mock("@/lib/codeserver/pane-manager", () => ({
  setCodeServerPaneBackground: (hex: string) => setPaneBackground(hex),
}))

const pluginThemes: { id: string; variables?: Record<string, string> }[] = []
jest.mock("@/lib/theme/theme-registry", () => ({
  subscribeThemeRegistry: () => () => {},
  listPluginThemes: () => pluginThemes,
}))

const settingsState = {
  colorTheme: "default",
  activeCustomThemeId: null as string | null,
  activePluginThemeId: null as string | null,
  customThemes: [] as unknown[],
  accentColor: null as string | null,
  monacoLink: { enabled: true } as { enabled: boolean; lockedThemeId?: string },
  settings: { a11y: DEFAULT_A11Y, motion: { speed: 1, reduce: false } } as Record<string, unknown>,
}
jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

const canvasState = { settings: DEFAULT_CANVAS_SETTINGS }
jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: (selector: (s: typeof canvasState) => unknown) => selector(canvasState),
}))

import { codeServerClient } from "@/lib/codeserver/client"
import { useCodeServerSettingsSync } from "./use-code-server-settings-sync"

const client = codeServerClient as jest.Mocked<typeof codeServerClient>

const written = () => JSON.parse(client.writeUserSettings.mock.calls.at(-1)![0] as string)

beforeEach(() => {
  mockIsTauri = true
  mockResolvedTheme = "dark"
  settingsState.colorTheme = "default"
  settingsState.activeCustomThemeId = null
  settingsState.activePluginThemeId = null
  settingsState.customThemes = []
  settingsState.accentColor = null
  settingsState.monacoLink = { enabled: true }
  settingsState.settings = { a11y: DEFAULT_A11Y, motion: { speed: 1, reduce: false } }
  pluginThemes.length = 0
  setPaneBackground.mockClear()
  client.readUserSettings.mockReset().mockResolvedValue("")
  client.writeUserSettings.mockReset().mockResolvedValue(undefined)
})

it("writes the app palette across the whole workbench chrome", async () => {
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  const settings = written()
  expect(settings["workbench.colorTheme"]).toBe("Default Dark Modern")
  const colors = settings["workbench.colorCustomizations"]
  // Not just the editor: the areas that used to stay stock VS Code grey.
  expect(colors["editor.background"]).toMatch(/^#[0-9a-f]{6}$/i)
  expect(colors["titleBar.activeBackground"]).toMatch(/^#[0-9a-f]{6}$/i)
  expect(colors["statusBar.background"]).toMatch(/^#[0-9a-f]{6}$/i)
  expect(colors["terminal.background"]).toMatch(/^#[0-9a-f]{6}$/i)
})

it("propagates the standalone accent override", async () => {
  // The original regression: the hook never passed `accentColor`, so changing the
  // accent repainted the app and left the Pro IDE behind.
  settingsState.accentColor = "#ff0088"
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  expect(written()["workbench.colorCustomizations"]["button.background"]).toBe("#ff0088")
})

it("follows a light/dark flip", async () => {
  const { rerender } = renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())

  mockResolvedTheme = "light"
  rerender()

  await waitFor(() => expect(written()["workbench.colorTheme"]).toBe("Default Light Modern"))
})

it("switches to a high-contrast base theme when a11y asks for it", async () => {
  settingsState.settings = {
    a11y: { ...DEFAULT_A11Y, highContrast: "dark" },
    motion: { speed: 1, reduce: false },
  }
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  const settings = written()
  expect(settings["workbench.colorTheme"]).toBe("Default High Contrast")
  expect(settings["workbench.colorCustomizations"]["editor.background"]).toBe("#000000")
})

it("keeps driving colours in high contrast even when a theme is pinned", async () => {
  // Accessibility outranks the pin, matching Monaco's own resolution ladder.
  settingsState.monacoLink = { enabled: false, lockedThemeId: "monokai" }
  settingsState.settings = {
    a11y: { ...DEFAULT_A11Y, highContrast: "dark" },
    motion: { speed: 1, reduce: false },
  }
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  expect(written()["workbench.colorTheme"]).toBe("Default High Contrast")
})

it("stands down from colours — without deleting them — when the editor link is off", async () => {
  client.readUserSettings.mockResolvedValue(
    JSON.stringify({ "workbench.colorTheme": "Monokai", "editor.fontSize": 30 })
  )
  settingsState.monacoLink = { enabled: false }
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  const settings = written()
  // The user's own pick survives…
  expect(settings["workbench.colorTheme"]).toBe("Monokai")
  expect(settings).not.toHaveProperty("workbench.colorCustomizations")
  // …while the non-colour preferences still sync (fontSize is app-owned).
  expect(settings["editor.fontSize"]).toBe(DEFAULT_CANVAS_SETTINGS.editor.fontSize)
})

it("stands down from colours when a specific theme is pinned", async () => {
  settingsState.monacoLink = { enabled: true, lockedThemeId: "monokai" }
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  expect(written()).not.toHaveProperty("workbench.colorCustomizations")
})

it("mirrors the app's editor preferences", async () => {
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  const settings = written()
  const editor = DEFAULT_CANVAS_SETTINGS.editor
  expect(settings["editor.fontFamily"]).toBe(editor.fontFamily)
  expect(settings["editor.tabSize"]).toBe(editor.tabSize)
  expect(settings["terminal.integrated.fontSize"]).toBe(editor.fontSize)
})

it("collapses workbench animation when the appearance slice reduces motion", async () => {
  settingsState.settings = { a11y: DEFAULT_A11Y, motion: { speed: 1, reduce: true } }
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  const settings = written()
  expect(settings["workbench.reduceMotion"]).toBe("on")
  expect(settings["editor.cursorBlinking"]).toBe("solid")
})

it("paints from an active plugin theme's declared tokens", async () => {
  pluginThemes.push({ id: "pt-1", variables: { "--background": "#123456" } })
  settingsState.activePluginThemeId = "pt-1"
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  expect(written()["workbench.colorCustomizations"]["editor.background"]).toBe("#123456")
})

it("ignores a dangling plugin-theme pointer", async () => {
  settingsState.activePluginThemeId = "gone"
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  // Falls back to the preset palette rather than throwing or writing nothing.
  expect(written()["workbench.colorCustomizations"]["editor.background"]).toMatch(/^#[0-9a-f]{6}$/i)
})

it("re-syncs when a custom palette changes", async () => {
  const { rerender } = renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  client.writeUserSettings.mockClear()

  settingsState.activeCustomThemeId = "my-theme"
  rerender()

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
})

it("preserves unmanaged settings the user made inside VS Code", async () => {
  client.readUserSettings.mockResolvedValue('{ "files.autoSave": "afterDelay" }')
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  expect(written()["files.autoSave"]).toBe("afterDelay")
})

it("does nothing while disabled", async () => {
  renderHook(() => useCodeServerSettingsSync(false))
  await waitFor(() => expect(client.readUserSettings).not.toHaveBeenCalled())
})

it("does nothing outside the desktop shell", async () => {
  mockIsTauri = false
  renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.readUserSettings).not.toHaveBeenCalled())
})

it("waits for next-themes to settle before writing anything", async () => {
  // Writing on an undefined theme would flash the wrong palette into the file.
  mockResolvedTheme = undefined
  renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.readUserSettings).not.toHaveBeenCalled())
})

it("never lets a sync failure escape", async () => {
  client.readUserSettings.mockRejectedValue(new Error("no app data dir"))
  client.writeUserSettings.mockRejectedValue(new Error("read-only fs"))

  renderHook(() => useCodeServerSettingsSync(true))

  // The write is still attempted from the empty-settings fallback, and neither
  // rejection surfaces as an unhandled promise.
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
})

it("paints the native pane webview in the same background as the app", async () => {
  // The webview draws its own background under code-server; left at the platform
  // default it flashed white over a dark app on every load.
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(setPaneBackground).toHaveBeenCalled())
  expect(setPaneBackground).toHaveBeenLastCalledWith(expect.stringMatching(/^#[0-9a-f]{6}$/i))
})

it("leaves the pane background alone when the editor link is off", async () => {
  // The user owns the editor's colours in that mode, so the app must not keep
  // pushing its own background underneath their chosen theme.
  settingsState.monacoLink = { enabled: false }
  renderHook(() => useCodeServerSettingsSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  expect(setPaneBackground).not.toHaveBeenCalled()
})
