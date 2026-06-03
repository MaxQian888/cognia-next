import { renderHook } from "@testing-library/react"
import { useMonacoActiveTheme } from "./use-monaco-active-theme"

const configureMonacoLoader = jest.fn()
const syncCogniaActiveTheme = jest.fn()
const resolveActiveThemeColors = jest.fn((..._args: unknown[]) => ({
  colors: { background: "#000" },
}))
let resolvedTheme: string | undefined = "dark"

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme }),
}))
jest.mock("@/lib/canvas/monaco-loader", () => ({
  configureMonacoLoader: (...args: unknown[]) => configureMonacoLoader(...args),
}))
jest.mock("@/lib/canvas/themes/cognia-active-theme", () => ({
  COGNIA_ACTIVE_THEME_ID: "cognia-active",
  syncCogniaActiveTheme: (...args: unknown[]) => syncCogniaActiveTheme(...args),
}))
jest.mock("@/lib/themes", () => ({
  resolveActiveThemeColors: (...args: unknown[]) => resolveActiveThemeColors(...args),
}))
jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ colorTheme: "default", activeCustomThemeId: null, customThemes: [] }),
}))

function makeMonaco() {
  return { editor: { setTheme: jest.fn() } } as unknown as typeof import("monaco-editor")
}

beforeEach(() => {
  jest.clearAllMocks()
  resolvedTheme = "dark"
})

describe("useMonacoActiveTheme", () => {
  it("configures the offline Monaco loader on mount", () => {
    renderHook(() => useMonacoActiveTheme())
    expect(configureMonacoLoader).toHaveBeenCalledTimes(1)
  })

  it("exposes the active theme id", () => {
    const { result } = renderHook(() => useMonacoActiveTheme())
    expect(result.current.themeId).toBe("cognia-active")
  })

  it("applyActiveTheme syncs colors and activates the theme", () => {
    const { result } = renderHook(() => useMonacoActiveTheme())
    const monaco = makeMonaco()
    result.current.applyActiveTheme(monaco)
    expect(resolveActiveThemeColors).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedTheme: "dark" })
    )
    expect(syncCogniaActiveTheme).toHaveBeenCalled()
    expect(monaco.editor.setTheme).toHaveBeenCalledWith("cognia-active")
  })

  it("registerMonaco applies the theme immediately", () => {
    const { result } = renderHook(() => useMonacoActiveTheme())
    const monaco = makeMonaco()
    result.current.registerMonaco(monaco)
    expect(syncCogniaActiveTheme).toHaveBeenCalled()
    expect(monaco.editor.setTheme).toHaveBeenCalledWith("cognia-active")
  })

  it("is a no-op when the resolved theme is unknown", () => {
    resolvedTheme = undefined
    const { result } = renderHook(() => useMonacoActiveTheme())
    const monaco = makeMonaco()
    result.current.applyActiveTheme(monaco)
    expect(syncCogniaActiveTheme).not.toHaveBeenCalled()
    expect(monaco.editor.setTheme).not.toHaveBeenCalled()
  })

  it("re-syncs a registered editor when the palette/mode dependency changes", () => {
    const { result, rerender } = renderHook(() => useMonacoActiveTheme())
    const monaco = makeMonaco()
    result.current.registerMonaco(monaco)
    const callsAfterRegister = syncCogniaActiveTheme.mock.calls.length
    resolvedTheme = "light"
    rerender()
    expect(syncCogniaActiveTheme.mock.calls.length).toBeGreaterThan(callsAfterRegister)
  })
})
