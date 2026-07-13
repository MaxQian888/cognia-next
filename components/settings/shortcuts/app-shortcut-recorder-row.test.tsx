/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import { AppShortcutRecorderRow } from "./app-shortcut-recorder-row"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"
import type { AppShortcutRow } from "@/lib/shortcuts/unified"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/lib/plugin/context-keys/derive-context-keys", () => ({
  detectOs: () => "macos",
}))

function makeRow(overrides: Partial<AppShortcutRow> = {}): AppShortcutRow {
  return {
    descriptor: {
      id: "app.search.focus",
      scope: "app",
      labelKey: "settings.shortcuts.catalog.searchFocus",
      category: "app.navigation",
      defaultChord: "/",
    },
    chord: "/",
    isModified: false,
    ...overrides,
  }
}

describe("AppShortcutRecorderRow", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetAppKeybindingStoreForTesting()
  })

  it("shows the label and current chord, with a Record button", () => {
    render(
      <AppShortcutRecorderRow
        row={makeRow()}
        onRebind={jest.fn()}
        onReset={jest.fn()}
        labelForId={(id) => id}
      />
    )
    expect(screen.getByText("catalog.searchFocus")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "record" })).toBeInTheDocument()
  })

  it("records a pressed chord and saves it via onRebind", () => {
    const onRebind = jest.fn()
    render(
      <AppShortcutRecorderRow
        row={makeRow()}
        onRebind={onRebind}
        onReset={jest.fn()}
        labelForId={(id) => id}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "record" }))
    fireEvent.keyDown(window, { key: "p", ctrlKey: true })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(onRebind).toHaveBeenCalledWith("app.search.focus", "Ctrl+P")
  })

  it("blocks save and shows a conflict when the chord is already taken", () => {
    const onRebind = jest.fn()
    render(
      <AppShortcutRecorderRow
        row={makeRow()}
        onRebind={onRebind}
        onReset={jest.fn()}
        labelForId={(id) => `label:${id}`}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "record" }))
    // ctrl+` is terminal.toggle's default → conflict.
    fireEvent.keyDown(window, { key: "`", ctrlKey: true })
    expect(screen.getByText(/label:terminal\.toggle/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(onRebind).not.toHaveBeenCalled()
  })

  it("warns (non-blocking) for a system-reserved chord but still allows save", () => {
    const onRebind = jest.fn()
    render(
      <AppShortcutRecorderRow
        row={makeRow()}
        onRebind={onRebind}
        onReset={jest.fn()}
        labelForId={(id) => id}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "record" }))
    // Ctrl+Space is macOS Spotlight — reserved, but not an in-app conflict.
    fireEvent.keyDown(window, { key: " ", ctrlKey: true })
    expect(screen.getByText("reservedWarning")).toBeInTheDocument()
    const save = screen.getByRole("button", { name: "save" })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(onRebind).toHaveBeenCalledWith("app.search.focus", "Ctrl+Space")
  })

  it("offers Reset only when modified and calls onReset", () => {
    const onReset = jest.fn()
    const { rerender } = render(
      <AppShortcutRecorderRow
        row={makeRow({ isModified: false })}
        onRebind={jest.fn()}
        onReset={onReset}
        labelForId={(id) => id}
      />
    )
    expect(screen.queryByRole("button", { name: "resetItem" })).not.toBeInTheDocument()

    rerender(
      <AppShortcutRecorderRow
        row={makeRow({ isModified: true, chord: "ctrl+shift+t" })}
        onRebind={jest.fn()}
        onReset={onReset}
        labelForId={(id) => id}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "resetItem" }))
    expect(onReset).toHaveBeenCalledWith("app.search.focus")
  })

  it("cancel discards the recording", () => {
    const onRebind = jest.fn()
    render(
      <AppShortcutRecorderRow
        row={makeRow()}
        onRebind={onRebind}
        onReset={jest.fn()}
        labelForId={(id) => id}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "record" }))
    fireEvent.keyDown(window, { key: "p", ctrlKey: true })
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(screen.getByRole("button", { name: "record" })).toBeInTheDocument()
    expect(onRebind).not.toHaveBeenCalled()
  })
})
