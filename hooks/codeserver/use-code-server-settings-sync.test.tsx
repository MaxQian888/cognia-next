import { act, renderHook, waitFor } from "@testing-library/react"

import { DEFAULT_A11Y } from "@/types/appearance"
import { DEFAULT_CANVAS_SETTINGS } from "@/types/canvas/settings"

let mockIsTauri = true
let mockResolvedTheme: string | undefined = "dark"
let mockTransport: object = {}
let mockRemote: object | null = null
const mockHostListeners = new Set<() => void>()
jest.mock("@/lib/tauri/transport-instance", () => ({
  get transport() {
    return mockTransport
  },
  onTransportChange: (listener: () => void) => {
    mockHostListeners.add(listener)
    return () => mockHostListeners.delete(listener)
  },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => mockRemote,
  subscribeActiveRemoteTransport: (listener: () => void) => {
    mockHostListeners.add(listener)
    return () => mockHostListeners.delete(listener)
  },
}))

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
  mockTransport = {}
  mockRemote = null
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

it("syncs browser settings without calling the native webview", async () => {
  mockIsTauri = false
  renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
  expect(setPaneBackground).not.toHaveBeenCalled()
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

  await waitFor(() => expect(client.readUserSettings).toHaveBeenCalled())
  expect(client.writeUserSettings).not.toHaveBeenCalled()
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

describe("trust-domain profile", () => {
  it("paints the managed profile by default", async () => {
    renderHook(() => useCodeServerSettingsSync(true))

    await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
    expect(client.readUserSettings).toHaveBeenCalledWith("managed")
    expect(client.writeUserSettings.mock.calls.at(-1)![1]).toBe("managed")
  })

  it("paints the profile the pane is actually showing", async () => {
    // The two profiles keep physically separate `user-data-dir`s. Writing the
    // managed one while the native workbench is on screen would leave the user
    // looking at stock VS Code colours and silently edit the other editor.
    renderHook(() => useCodeServerSettingsSync(true, "native"))

    await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalled())
    expect(client.readUserSettings).toHaveBeenCalledWith("native")
    expect(client.writeUserSettings.mock.calls.at(-1)![1]).toBe("native")
  })
})

it("waits for an older theme write and commits only the latest pending theme", async () => {
  let finish!: () => void
  client.writeUserSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalledTimes(1))
  mockResolvedTheme = "light"
  rerender()
  await act(async () => {})
  expect(client.writeUserSettings).toHaveBeenCalledTimes(1)
  client.readUserSettings.mockResolvedValue('{"files.autoSave":"afterDelay"}')
  await act(async () => {
    finish()
  })
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalledTimes(2))
  expect(written()["workbench.colorTheme"]).toBe("Default Light Modern")
  expect(written()["files.autoSave"]).toBe("afterDelay")
})

it("retries a failed sync without requiring another theme change", async () => {
  jest.useFakeTimers()
  try {
    client.readUserSettings.mockRejectedValueOnce(new Error("temporary disconnect"))
    const { unmount } = renderHook(() => useCodeServerSettingsSync(true))
    await act(async () => {})
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000)
    })
    expect(client.writeUserSettings).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })
    expect(client.writeUserSettings).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

it("never merges an old host's settings into a newly selected host", async () => {
  let finish!: (value: string) => void
  client.readUserSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.readUserSettings).toHaveBeenCalledTimes(1))
  client.readUserSettings.mockResolvedValue('{"newHostOnly":true}')
  await act(async () => {
    mockTransport = { name: "new browser host" }
    mockHostListeners.forEach((listener) => listener())
    finish('{"oldHostOnly":true}')
  })
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalledTimes(1))
  expect(written().newHostOnly).toBe(true)
  expect(written()).not.toHaveProperty("oldHostOnly")
})

it("serializes the same profile across unmount and remount", async () => {
  let finish!: () => void
  client.writeUserSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const first = renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalledTimes(1))
  first.unmount()
  mockResolvedTheme = "light"
  renderHook(() => useCodeServerSettingsSync(true))
  await act(async () => {})
  expect(client.writeUserSettings).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish()
  })
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalledTimes(2))
  expect(written()["workbench.colorTheme"]).toBe("Default Light Modern")
})

it("discards a managed read after switching to the native profile", async () => {
  let finish!: (value: string) => void
  client.readUserSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = renderHook(
    ({ profile }: { profile: "managed" | "native" }) => useCodeServerSettingsSync(true, profile),
    { initialProps: { profile: "managed" } }
  )
  await waitFor(() => expect(client.readUserSettings).toHaveBeenCalledTimes(1))
  rerender({ profile: "native" })
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalledTimes(1))
  await act(async () => {
    finish('{"managedOnly":true}')
  })
  expect(client.writeUserSettings).toHaveBeenCalledTimes(1)
  expect(client.writeUserSettings.mock.calls[0][1]).toBe("native")
  expect(written()).not.toHaveProperty("managedOnly")
})

it("does not write unchanged merged settings", async () => {
  const first = renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalledTimes(1))
  const current = client.writeUserSettings.mock.calls[0][0]
  first.unmount()
  client.readUserSettings.mockResolvedValue(current)
  renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.readUserSettings).toHaveBeenCalledTimes(2))
  await act(async () => {})
  expect(client.writeUserSettings).toHaveBeenCalledTimes(1)
})

it("retries failed writes with a fresh read and stops retrying on cleanup", async () => {
  jest.useFakeTimers()
  try {
    client.writeUserSettings.mockRejectedValueOnce(new Error("temporarily read-only"))
    const { unmount } = renderHook(() => useCodeServerSettingsSync(true))
    await act(async () => {})
    client.readUserSettings.mockResolvedValue('{"files.autoSave":"onFocusChange"}')
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000)
    })
    expect(client.readUserSettings).toHaveBeenCalledTimes(2)
    expect(client.writeUserSettings).toHaveBeenCalledTimes(2)
    expect(written()["files.autoSave"]).toBe("onFocusChange")
    unmount()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })
    expect(client.writeUserSettings).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})

it("coalesces a burst while a write is pending", async () => {
  let finish!: () => void
  client.writeUserSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = renderHook(() => useCodeServerSettingsSync(true))
  await waitFor(() => expect(client.writeUserSettings).toHaveBeenCalledTimes(1))
  for (const accent of ["#112233", "#223344", "#334455"]) {
    settingsState.accentColor = accent
    rerender()
  }
  await act(async () => {
    finish()
  })
  expect(client.writeUserSettings).toHaveBeenCalledTimes(2)
  expect(written()["workbench.colorCustomizations"]["button.background"]).toBe("#334455")
})

it("does not restart synchronization when an unmounted read fails later", async () => {
  jest.useFakeTimers()
  try {
    let reject!: (cause: Error) => void
    client.readUserSettings.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        })
    )
    const { unmount } = renderHook(() => useCodeServerSettingsSync(true))
    unmount()
    await act(async () => {
      reject(new Error("late failure"))
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })
    expect(client.readUserSettings).toHaveBeenCalledTimes(1)
    expect(client.writeUserSettings).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})
