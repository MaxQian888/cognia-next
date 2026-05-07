/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AppSettings } from "@/lib/claude/types"

// jsdom 26 ships `File.arrayBuffer()` but not `File.text()` — polyfill via
// FileReader so the component's `file.text()` call resolves the synthetic
// File objects we hand it.
if (typeof Blob.prototype.text !== "function") {
  Object.defineProperty(Blob.prototype, "text", {
    configurable: true,
    value(this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ""))
        reader.onerror = () => reject(reader.error ?? new Error("read failed"))
        reader.readAsText(this)
      })
    },
  })
}
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.onerror = () => reject(reader.error ?? new Error("read failed"))
        reader.readAsArrayBuffer(this)
      })
    },
  })
}

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, params?: { count?: number }) =>
    params?.count != null ? `${k}:${params.count}` : k,
}))

jest.mock("@/lib/appearance", () => ({
  importVscodeThemeJson: jest.fn(),
  readVsix: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appearance = require("@/lib/appearance") as {
  importVscodeThemeJson: jest.Mock
  readVsix: jest.Mock
}

const createCustomTheme = jest.fn().mockReturnValue("ct-new")
const updateCustomTheme = jest.fn()
const setActive = jest.fn()
const addImportedTheme = jest.fn()
const removeImportedTheme = jest.fn()
const deleteCustomTheme = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({
      settings: storeState.settings,
      createCustomTheme,
      updateCustomTheme,
      setActiveCustomTheme: setActive,
      addImportedTheme,
      removeImportedTheme,
      deleteCustomTheme,
    })
  ),
}))

import { VscodeImportTab } from "./vscode-import-tab"

beforeEach(() => {
  jest.clearAllMocks()
  storeState.settings = { customThemes: [], importedVscodeThemes: [] }
})

describe("VscodeImportTab", () => {
  it("imports a JSON file, calls createCustomTheme + setActive", async () => {
    appearance.importVscodeThemeJson.mockReturnValue({
      theme: { name: "Sample", colors: {}, isDark: true },
      emptyColors: false,
      matchedCount: 5,
    })
    render(<VscodeImportTab />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([JSON.stringify({ name: "Sample" })], "sample.json", {
      type: "application/json",
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(createCustomTheme).toHaveBeenCalled())
    expect(addImportedTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        customThemeId: "ct-new",
        sourceName: "Sample",
        sourceVariant: "dark",
        origin: { kind: "json", fileName: "sample.json" },
      })
    )
    expect(setActive).toHaveBeenCalledWith("ct-new")
  })

  it("commits an imported theme with dual-variant tokens", async () => {
    appearance.importVscodeThemeJson.mockReturnValue({
      theme: {
        name: "Solar",
        // Non-empty palette so deriveOppositeVariant has something to flip.
        colors: { background: "#101012", foreground: "#f5f5f5" },
        isDark: true,
      },
      emptyColors: false,
      matchedCount: 2,
    })
    render(<VscodeImportTab />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([JSON.stringify({ name: "Solar" })], "solar.json", {
      type: "application/json",
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() =>
      expect(createCustomTheme).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Solar",
          baseVariant: "dark",
          derivedVariant: "light",
          tokens: expect.objectContaining({
            light: expect.any(Object),
            dark: expect.any(Object),
          }),
          // Legacy fields still present for rollback safety:
          isDark: true,
          colors: expect.any(Object),
        })
      )
    )
    // The base side preserves the parsed input verbatim; the opposite side
    // is derived, so it must differ from the source values.
    const payload = createCustomTheme.mock.calls[0][0] as {
      tokens: { light: Record<string, string>; dark: Record<string, string> }
    }
    expect(payload.tokens.dark).toEqual({
      background: "#101012",
      foreground: "#f5f5f5",
    })
    expect(payload.tokens.light.background).not.toBe("#101012")
    expect(payload.tokens.light.foreground).not.toBe("#f5f5f5")
  })

  it("shows VSIX picker, then imports selected themes on confirm", async () => {
    // After Phase 3 / Task 11 every entry carries a pre-parsed
    // `parsed: ParsedTheme` field — no `parse: () => Promise<...>`
    // closure for the picker to await. This kills the GC race that
    // produced "VSIX entry vanished" in production.
    const themeB = {
      label: "B",
      uiTheme: "vs-dark",
      path: "themes/b.json",
      parsed: {
        theme: { name: "B", colors: {}, isDark: true },
        emptyColors: false,
        matchedCount: 3,
      },
    }
    const themeA = {
      label: "A",
      uiTheme: "vs",
      path: "themes/a.json",
      parsed: {
        theme: { name: "A", colors: {}, isDark: false },
        emptyColors: false,
        matchedCount: 3,
      },
    }
    appearance.readVsix.mockResolvedValue({
      displayName: "Pack",
      name: "publisher.pack",
      version: "1.0.0",
      themes: [themeA, themeB],
    })
    render(<VscodeImportTab />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1])], "pack.vsix", {
      type: "application/octet-stream",
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(screen.getByText("selectThemes")).toBeInTheDocument())
    // Both themes are pre-selected; click import.
    fireEvent.click(screen.getByRole("button", { name: /importButton/ }))
    await waitFor(() => expect(createCustomTheme).toHaveBeenCalledTimes(2))
    expect(addImportedTheme).toHaveBeenCalledTimes(2)
    expect(setActive).toHaveBeenCalled()
  })

  it("renders a destructive Alert when JSON parsing fails", async () => {
    appearance.importVscodeThemeJson.mockImplementation(() => {
      throw new Error("Invalid VSCode theme JSON")
    })
    render(<VscodeImportTab />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["not json"], "bad.json", { type: "application/json" })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(screen.getByText(/Invalid VSCode theme JSON/i)).toBeInTheDocument())
    // The error is rendered inside the destructive Alert (errorTitle
    // i18n key) — distinct from the previous bare `<p>` that was easy
    // to miss.
    expect(screen.getByText("errorTitle")).toBeInTheDocument()
  })

  it("surfaces readVsix errors through the destructive Alert", async () => {
    appearance.readVsix.mockRejectedValue(new Error("Could not unzip VSIX: corrupt file"))
    render(<VscodeImportTab />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([0])], "bad.vsix", {
      type: "application/octet-stream",
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(screen.getByText("errorTitle")).toBeInTheDocument())
    expect(screen.getByText(/Could not unzip VSIX: corrupt file/)).toBeInTheDocument()
  })

  it("times out a hung parse and shows the timeout message after 30s", async () => {
    jest.useFakeTimers()
    try {
      // Never-resolving readVsix — simulates JSZip hanging on a
      // malformed file. Without the 30s timeout the spinner would
      // stay on forever (root cause D1).
      appearance.readVsix.mockReturnValue(new Promise<never>(() => {}))
      render(<VscodeImportTab />)
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([new Uint8Array([0])], "hang.vsix", {
        type: "application/octet-stream",
      })
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } })
      })
      // Fast-forward past the 30s parse-phase timeout.
      await act(async () => {
        jest.advanceTimersByTime(31_000)
      })
      expect(screen.getByText("errorTitle")).toBeInTheDocument()
      expect(screen.getByText("timeout")).toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("renders without infinite re-renders when settings is empty", () => {
    storeState.settings = {}
    expect(() => render(<VscodeImportTab />)).not.toThrow()
    expect(screen.getByText("noThemes")).toBeInTheDocument()
  })

  it("stamps a deterministic sourceKey on every imported record", async () => {
    appearance.importVscodeThemeJson.mockReturnValue({
      theme: { name: "Sample", colors: {}, isDark: true },
      emptyColors: false,
      matchedCount: 5,
    })
    render(<VscodeImportTab />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([JSON.stringify({ name: "Sample" })], "sample.json", {
      type: "application/json",
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(addImportedTheme).toHaveBeenCalled())
    expect(addImportedTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: "json:sample.json:Sample",
        origin: { kind: "json", fileName: "sample.json" },
      })
    )
  })

  it("re-importing the same JSON updates the existing CustomTheme instead of creating a new one", async () => {
    storeState.settings = {
      customThemes: [{ id: "ct-1", name: "Sample" }],
      importedVscodeThemes: [
        {
          customThemeId: "ct-1",
          sourceKey: "json:sample.json:Sample",
          sourceName: "Sample",
          sourceVariant: "dark",
          importedAt: 0,
          origin: { kind: "json", fileName: "sample.json" },
        },
      ],
    }
    appearance.importVscodeThemeJson.mockReturnValue({
      theme: { name: "Sample", colors: { background: "#222" }, isDark: true },
      emptyColors: false,
      matchedCount: 5,
    })
    render(<VscodeImportTab />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([JSON.stringify({ name: "Sample" })], "sample.json", {
      type: "application/json",
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(updateCustomTheme).toHaveBeenCalledWith("ct-1", expect.any(Object)))
    expect(createCustomTheme).not.toHaveBeenCalled()
    // The history record we hand to addImportedTheme reuses the original
    // customThemeId so the store's filter doesn't keep both rows.
    expect(addImportedTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        customThemeId: "ct-1",
        sourceKey: "json:sample.json:Sample",
      })
    )
  })

  it("re-importing the same VSIX entry updates the existing CustomTheme instead of creating a new one", async () => {
    storeState.settings = {
      customThemes: [{ id: "ct-vsix", name: "B" }],
      importedVscodeThemes: [
        {
          customThemeId: "ct-vsix",
          sourceKey: "vsix:pack.vsix:themes/b.json",
          sourceName: "B",
          sourceVariant: "dark",
          importedAt: 0,
          origin: { kind: "vsix", vsixName: "pack.vsix", themePath: "themes/b.json" },
        },
      ],
    }
    appearance.readVsix.mockResolvedValue({
      displayName: "Pack",
      name: "publisher.pack",
      version: "1.0.0",
      themes: [
        {
          label: "B",
          uiTheme: "vs-dark",
          path: "themes/b.json",
          parsed: {
            theme: { name: "B", colors: { background: "#000" }, isDark: true },
            emptyColors: false,
            matchedCount: 3,
          },
        },
      ],
    })
    render(<VscodeImportTab />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1])], "pack.vsix", {
      type: "application/octet-stream",
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(screen.getByText("selectThemes")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /importButton/ }))
    await waitFor(() =>
      expect(updateCustomTheme).toHaveBeenCalledWith("ct-vsix", expect.any(Object))
    )
    expect(createCustomTheme).not.toHaveBeenCalled()
  })

  it("renders the history list and lets the user remove a record", async () => {
    storeState.settings = {
      customThemes: [
        {
          id: "ct-1",
          name: "Imported",
          colors: { background: "#000" },
          isDark: true,
        },
      ],
      importedVscodeThemes: [
        {
          customThemeId: "ct-1",
          sourceName: "Imported",
          sourceVariant: "dark",
          importedAt: 1,
          origin: { kind: "json", fileName: "x.json" },
        },
      ],
    }
    render(<VscodeImportTab />)
    expect(screen.getByText("Imported")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /removeButton/ }))
    expect(deleteCustomTheme).toHaveBeenCalledWith("ct-1")
    expect(removeImportedTheme).toHaveBeenCalledWith("ct-1")
  })
})
