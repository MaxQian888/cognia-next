import { render, screen, fireEvent, act } from "@testing-library/react"
import { ShortcutsSection } from "./shortcuts-section"
import { __resetShortcutStoreForTesting, useShortcutStore } from "@/lib/shortcuts/registry"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: { fallback?: string }) => vars?.fallback ?? key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }

beforeEach(() => {
  invoke.mockReset()
  __resetShortcutStoreForTesting()
})

describe("ShortcutsSection", () => {
  it("renders one row per built-in shortcut id", () => {
    render(<ShortcutsSection />)
    expect(screen.getByText("Show / hide window")).toBeInTheDocument()
    expect(screen.getByText("Open log panel")).toBeInTheDocument()
    expect(screen.getByText("Automation kill switch")).toBeInTheDocument()
  })

  it("Record swaps the row's controls into capture mode", () => {
    render(<ShortcutsSection />)
    const records = screen.getAllByText("Record")
    fireEvent.click(records[0])
    expect(screen.getByText("Press any key…")).toBeInTheDocument()
    expect(screen.getByText("Cancel")).toBeInTheDocument()
  })

  it("Cancel leaves the row's binding untouched", () => {
    render(<ShortcutsSection />)
    fireEvent.click(screen.getAllByText("Record")[0])
    fireEvent.click(screen.getByText("Cancel"))
    expect(screen.queryByText("Press any key…")).toBeNull()
  })

  it("Save invokes shortcut_bind via the store after capturing a chord", async () => {
    invoke.mockResolvedValueOnce(null) // shortcut_check_conflict
    invoke.mockResolvedValueOnce(undefined) // shortcut_bind
    render(<ShortcutsSection />)
    fireEvent.click(screen.getAllByText("Record")[0])
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Space", ctrlKey: true, altKey: true })
      )
      await Promise.resolve()
    })
    fireEvent.click(screen.getByText("Save"))
    await act(async () => {
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith(
      "shortcut_bind",
      expect.objectContaining({ id: "tray.show", chord: "ctrl+alt+space" })
    )
  })

  it("Reset row invokes bind with the default chord", async () => {
    invoke.mockResolvedValue(undefined)
    useShortcutStore.setState({
      bindings: { "tray.show": "ctrl+alt+f1" },
      hydrated: true,
    })
    render(<ShortcutsSection />)
    fireEvent.click(screen.getAllByLabelText("Reset to default")[0])
    await act(async () => {
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith(
      "shortcut_bind",
      expect.objectContaining({ id: "tray.show", chord: "ctrl+shift+space" })
    )
  })
})
