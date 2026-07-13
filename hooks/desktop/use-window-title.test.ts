import { renderHook, waitFor } from "@testing-library/react"
import { computeWindowTitle, useWindowTitle } from "./use-window-title"

const labelRef = { value: null as string | null }
jest.mock("@/hooks/chat/use-active-session-label", () => ({
  useActiveSessionLabel: () => ({
    activeSessionId: null,
    session: undefined,
    character: undefined,
    label: labelRef.value,
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => (key === "appName" ? "Cognia" : key),
}))

const isTauriMock = jest.fn(() => false)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const warnMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { ui: { warn: (...a: unknown[]) => warnMock(...a) } },
}))

const setTitleMock = jest.fn().mockResolvedValue(undefined)
jest.mock(
  "@tauri-apps/api/window",
  () => ({ getCurrentWindow: () => ({ setTitle: (t: string) => setTitleMock(t) }) }),
  { virtual: true }
)

beforeEach(() => {
  labelRef.value = null
  isTauriMock.mockReturnValue(false)
  setTitleMock.mockClear()
  warnMock.mockClear()
  document.title = "initial"
  // `isMainAppWindow` reads the real Tauri internals (not the mocked
  // `@/lib/tauri`); clear any pet-window label a test set.
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe("computeWindowTitle", () => {
  it("returns the app name alone when there is no label", () => {
    expect(computeWindowTitle(null, "Cognia")).toBe("Cognia")
    expect(computeWindowTitle("   ", "Cognia")).toBe("Cognia")
  })

  it("prefixes the conversation label, doc-first", () => {
    expect(computeWindowTitle("Refactor list", "Cognia")).toBe("Refactor list · Cognia")
  })
})

describe("useWindowTitle", () => {
  it("sets document.title to the app name when no session is active", () => {
    renderHook(() => useWindowTitle())
    expect(document.title).toBe("Cognia")
  })

  it("sets document.title to '<label> · Cognia' for the active session", () => {
    labelRef.value = "Plan the migration"
    renderHook(() => useWindowTitle())
    expect(document.title).toBe("Plan the migration · Cognia")
  })

  it("does not call the Tauri window API outside Tauri", () => {
    labelRef.value = "X"
    renderHook(() => useWindowTitle())
    expect(setTitleMock).not.toHaveBeenCalled()
  })

  it("calls getCurrentWindow().setTitle inside Tauri", async () => {
    isTauriMock.mockReturnValue(true)
    labelRef.value = "Ship it"
    renderHook(() => useWindowTitle())
    await waitFor(() => expect(setTitleMock).toHaveBeenCalledWith("Ship it · Cognia"))
  })

  it("does not call setTitle in a least-privilege pet window", async () => {
    isTauriMock.mockReturnValue(true)
    // A "pet" webview label makes `isMainAppWindow()` false — the pet window
    // isn't granted `core:window:allow-set-title`.
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      metadata: { currentWebview: { label: "pet" } },
    }
    labelRef.value = "Sprite"
    renderHook(() => useWindowTitle())
    // The document.title write still happens (harmless); the native call is skipped.
    await waitFor(() => expect(document.title).toBe("Sprite · Cognia"))
    expect(setTitleMock).not.toHaveBeenCalled()
  })

  it("logs a warning when the Tauri setTitle call fails", async () => {
    isTauriMock.mockReturnValue(true)
    setTitleMock.mockRejectedValueOnce(new Error("no window"))
    labelRef.value = "Boom"
    renderHook(() => useWindowTitle())
    await waitFor(() => expect(warnMock).toHaveBeenCalled())
  })

  it("stringifies a non-Error rejection in the warning", async () => {
    isTauriMock.mockReturnValue(true)
    setTitleMock.mockRejectedValueOnce("plain string failure")
    labelRef.value = "Boom2"
    renderHook(() => useWindowTitle())
    await waitFor(() => expect(warnMock).toHaveBeenCalled())
    expect(warnMock.mock.calls[0][1]).toEqual({ error: "plain string failure" })
  })

  it("does not rewrite the title when it is unchanged across re-renders", () => {
    labelRef.value = "Stable"
    const { rerender } = renderHook(() => useWindowTitle())
    document.title = "tampered"
    rerender()
    // The effect guards on the last computed title, so an unchanged value is
    // not written again.
    expect(document.title).toBe("tampered")
  })
})
