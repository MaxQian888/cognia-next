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

  it("shows VSIX picker, then imports selected themes on confirm", async () => {
    const themeB = {
      label: "B",
      uiTheme: "vs-dark",
      path: "themes/b.json",
      parse: jest.fn().mockResolvedValue({
        theme: { name: "B", colors: {}, isDark: true },
        emptyColors: false,
        matchedCount: 3,
      }),
    }
    const themeA = {
      label: "A",
      uiTheme: "vs",
      path: "themes/a.json",
      parse: jest.fn().mockResolvedValue({
        theme: { name: "A", colors: {}, isDark: false },
        emptyColors: false,
        matchedCount: 3,
      }),
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

  it("renders an error message when JSON parsing fails", async () => {
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
  })

  it("renders without infinite re-renders when settings is empty", () => {
    storeState.settings = {}
    expect(() => render(<VscodeImportTab />)).not.toThrow()
    expect(screen.getByText("noThemes")).toBeInTheDocument()
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
