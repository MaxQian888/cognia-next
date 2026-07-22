import { renderHook, waitFor } from "@testing-library/react"

let mockIsTauri = true
let mockResolvedTheme: string | undefined = "dark"

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: mockResolvedTheme }) }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { readUserSettings: jest.fn(), writeUserSettings: jest.fn() },
}))
jest.mock("@/lib/themes", () => ({
  resolveActiveThemeColors: jest.fn(() => ({ colors: { background: "#101010" } })),
}))

const settingsState = {
  colorTheme: "default",
  activeCustomThemeId: null as string | null,
  customThemes: [] as unknown[],
}
jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

import { codeServerClient } from "@/lib/codeserver/client"
import { resolveActiveThemeColors } from "@/lib/themes"
import { useCodeServerThemeSync } from "./use-code-server-theme-sync"

const client = codeServerClient as jest.Mocked<typeof codeServerClient>
const resolveColors = resolveActiveThemeColors as jest.Mock

const written = () => JSON.parse(client.writeUserSettings.mock.calls.at(-1)![0] as string)

beforeEach(() => {
  mockIsTauri = true
  mockResolvedTheme = "dark"
  settingsState.colorTheme = "default"
  settingsState.activeCustomThemeId = null
  settingsState.customThemes = []
  resolveColors.mockClear()
  client.readUserSettings.mockReset().mockResolvedValue("")
  client.writeUserSettings.mockReset().mockResolvedValue(undefined)
})

it("writes the app palette into code-server's settings", async () => {
  renderHook(() => useCodeServerThemeSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  const settings = written()
  expect(settings["workbench.colorTheme"]).toBe("Default Dark Modern")
  expect(settings["workbench.colorCustomizations"]["editor.background"]).toBe("#101010")
})

it("follows a light/dark flip", async () => {
  const { rerender } = renderHook(() => useCodeServerThemeSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())

  mockResolvedTheme = "light"
  rerender()

  await waitFor(() => expect(written()["workbench.colorTheme"]).toBe("Default Light Modern"))
})

it("re-syncs when a custom palette changes", async () => {
  const { rerender } = renderHook(() => useCodeServerThemeSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  client.writeUserSettings.mockClear()

  settingsState.activeCustomThemeId = "my-theme"
  rerender()

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
})

it("preserves settings the user made inside VS Code", async () => {
  client.readUserSettings.mockResolvedValue('{ "editor.tabSize": 4 }')
  renderHook(() => useCodeServerThemeSync(true))

  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  expect(written()["editor.tabSize"]).toBe(4)
})

it("does nothing while disabled", async () => {
  renderHook(() => useCodeServerThemeSync(false))
  await waitFor(() => expect(client.readUserSettings).not.toHaveBeenCalled())
})

it("does nothing outside the desktop shell", async () => {
  mockIsTauri = false
  renderHook(() => useCodeServerThemeSync(true))
  await waitFor(() => expect(client.readUserSettings).not.toHaveBeenCalled())
})

it("waits for next-themes to settle before writing anything", async () => {
  // Writing on an undefined theme would flash the wrong palette into the file.
  mockResolvedTheme = undefined
  renderHook(() => useCodeServerThemeSync(true))
  await waitFor(() => expect(client.readUserSettings).not.toHaveBeenCalled())
})

it("never lets a theming failure escape", async () => {
  client.readUserSettings.mockRejectedValue(new Error("no app data dir"))
  client.writeUserSettings.mockRejectedValue(new Error("read-only fs"))

  renderHook(() => useCodeServerThemeSync(true))

  // The write is still attempted from the empty-settings fallback, and neither
  // rejection surfaces as an unhandled promise.
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
})
