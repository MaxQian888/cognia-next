/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("@/lib/platform/os", () => ({
  ...jest.requireActual("@/lib/platform/os"),
  usesAppleModifierGlyphs: jest.fn(() => false),
}))

import { usesAppleModifierGlyphs } from "@/lib/platform/os"
import { INBOX_TRIAGE_SHORTCUTS } from "@/lib/inbox/triage-keymap"
import { InboxShortcutsHelp } from "./inbox-shortcuts-help"

const mockApple = usesAppleModifierGlyphs as jest.Mock

describe("InboxShortcutsHelp", () => {
  it("lists every keymap entry, grouped under headings", () => {
    render(<InboxShortcutsHelp open onOpenChange={jest.fn()} />)
    const dialog = screen.getByTestId("inbox-shortcuts-help")
    expect(
      within(dialog).getByRole("heading", { name: "Inbox keyboard shortcuts" })
    ).toBeInTheDocument()
    for (const group of ["Move and open", "Select", "Triage"]) {
      expect(within(dialog).getByRole("heading", { name: group })).toBeInTheDocument()
    }
    for (const entry of INBOX_TRIAGE_SHORTCUTS) {
      expect(within(dialog).getByTestId(`inbox-shortcut-${entry.id}`)).toBeInTheDocument()
    }
    expect(within(dialog).getByTestId("inbox-shortcut-resolve")).toHaveTextContent(
      "Resolve (with undo)D"
    )
    expect(within(dialog).getByTestId("inbox-shortcut-next")).toHaveTextContent("J/↓")
  })

  it("prints the platform's modifier", () => {
    mockApple.mockReturnValue(false)
    const { unmount } = render(<InboxShortcutsHelp open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("inbox-shortcut-selectAll")).toHaveTextContent("CtrlA")
    unmount()
    mockApple.mockReturnValue(true)
    render(<InboxShortcutsHelp open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("inbox-shortcut-selectAll")).toHaveTextContent("⌘A")
  })

  it("renders nothing while closed and reports Escape", () => {
    const onOpenChange = jest.fn()
    const { rerender } = render(<InboxShortcutsHelp open={false} onOpenChange={onOpenChange} />)
    expect(screen.queryByTestId("inbox-shortcuts-help")).not.toBeInTheDocument()
    rerender(<InboxShortcutsHelp open onOpenChange={onOpenChange} />)
    fireEvent.keyDown(screen.getByTestId("inbox-shortcuts-help"), { key: "Escape" })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
