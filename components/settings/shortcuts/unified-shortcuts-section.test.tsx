/** @jest-environment jsdom */

import { render, screen, fireEvent, within } from "@testing-library/react"
import { UnifiedShortcutsSection } from "./unified-shortcuts-section"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/settings/shortcuts-section", () => ({
  ShortcutsSection: () => <div data-testid="global-section" />,
}))
jest.mock("@/components/canvas/keybinding-settings", () => ({
  KeybindingSettings: ({ trigger }: { trigger: React.ReactNode }) => (
    <div data-testid="editor-section">{trigger}</div>
  ),
}))

describe("UnifiedShortcutsSection", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetAppKeybindingStoreForTesting()
  })

  it("renders all three scope groups", () => {
    render(<UnifiedShortcutsSection />)
    expect(screen.getByText("unified.groupGlobal")).toBeInTheDocument()
    expect(screen.getByText("unified.groupApp")).toBeInTheDocument()
    expect(screen.getByText("unified.groupEditor")).toBeInTheDocument()
    expect(screen.getByTestId("global-section")).toBeInTheDocument()
    expect(screen.getByTestId("editor-section")).toBeInTheDocument()
  })

  it("renders app-scope category headings and rows", () => {
    render(<UnifiedShortcutsSection />)
    expect(screen.getByText("categories.terminal")).toBeInTheDocument()
    expect(screen.getByText("categories.zoom")).toBeInTheDocument()
    expect(screen.getByText("catalog.terminalToggle")).toBeInTheDocument()
  })

  it("filters app rows by the search query", () => {
    render(<UnifiedShortcutsSection />)
    fireEvent.change(screen.getByPlaceholderText("unified.searchPlaceholder"), {
      target: { value: "zoom" },
    })
    expect(screen.getByText("catalog.zoomIn")).toBeInTheDocument()
    expect(screen.queryByText("catalog.terminalToggle")).not.toBeInTheDocument()
  })

  it("shows a no-results message when nothing matches", () => {
    render(<UnifiedShortcutsSection />)
    fireEvent.change(screen.getByPlaceholderText("unified.searchPlaceholder"), {
      target: { value: "zzzznomatch" },
    })
    expect(screen.getByText("unified.noResults")).toBeInTheDocument()
  })

  it("rebinding an app row updates the displayed chord", () => {
    render(<UnifiedShortcutsSection />)
    // Find the terminal.toggle row and record a new chord.
    const label = screen.getByText("catalog.terminalToggle")
    const row = label.closest("li") as HTMLElement
    fireEvent.click(within(row).getByRole("button", { name: "record" }))
    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true })
    fireEvent.click(within(row).getByRole("button", { name: "save" }))
    // The store now reflects the override; the row shows the new chord
    // (jsdom is non-Mac, so formatKeybinding keeps the `+`-joined form).
    expect(within(row).getByText(/ctrl\+shift\+t/i)).toBeInTheDocument()
  })
})
