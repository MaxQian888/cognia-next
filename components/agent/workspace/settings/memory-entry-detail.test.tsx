/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

const deleteEntryMock = jest.fn()
jest.mock("@/lib/ai/agent/team/shared-memory-orchestrator", () => ({
  deleteEntry: (...args: unknown[]) => deleteEntryMock(...args),
}))

// Stub ConfirmActionDialog so we can drive confirm / cancel.
jest.mock("./confirm-action-dialog", () => ({
  ConfirmActionDialog: ({
    open,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean
    onConfirm: () => void
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div data-testid="mem-confirm-dialog">
        <button data-testid="mem-confirm-yes" onClick={onConfirm}>
          yes
        </button>
        <button data-testid="mem-confirm-no" onClick={() => onOpenChange(false)}>
          no
        </button>
      </div>
    ) : null,
}))

import { MemoryEntryDetail } from "./memory-entry-detail"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

function makeEntry(over: Partial<SharedMemoryEntry> = {}): SharedMemoryEntry {
  return {
    key: "note",
    value: "hello world",
    writtenBy: "tm-1",
    writtenAt: new Date(0),
    version: 2,
    ...over,
  }
}

// Clipboard mock
const writeTextMock = jest.fn()
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: writeTextMock },
  configurable: true,
})

beforeEach(() => {
  deleteEntryMock.mockReset()
  markSavedMock.mockReset()
  writeTextMock.mockReset()
  writeTextMock.mockResolvedValue(undefined)
})

describe("MemoryEntryDetail", () => {
  it("returns null when entry is null", () => {
    const { container } = render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={null}
        onEdit={jest.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("returns null when open is false and entry present", () => {
    // Dialog is closed so content should not be visible.
    render(
      <MemoryEntryDetail
        open={false}
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry()}
        onEdit={jest.fn()}
      />
    )
    // Key is rendered inside a <code> inside the dialog title — when dialog is
    // closed the dialog content is not in the DOM (Radix removes it).
    expect(screen.queryByText("note")).not.toBeInTheDocument()
  })

  it("renders the entry key and version", () => {
    render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry()}
        onEdit={jest.fn()}
      />
    )
    expect(screen.getByText("note")).toBeInTheDocument()
    expect(screen.getByText("v2")).toBeInTheDocument()
  })

  it("renders a string value in the pre element", () => {
    render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry({ value: "plain text" })}
        onEdit={jest.fn()}
      />
    )
    expect(screen.getByText("plain text")).toBeInTheDocument()
  })

  it("pretty-prints an object value as JSON", () => {
    render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry({ value: { a: 1 } })}
        onEdit={jest.fn()}
      />
    )
    // Should contain pretty-printed JSON
    expect(screen.getByText(/\"a\": 1/)).toBeInTheDocument()
  })

  it("renders tags when present", () => {
    render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry({ tags: ["alpha", "beta"] })}
        onEdit={jest.fn()}
      />
    )
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
  })

  it("does not render tag section when tags are absent", () => {
    render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry({ tags: undefined })}
        onEdit={jest.fn()}
      />
    )
    // No badge with tag text — just the version badge.
    expect(screen.queryByText("alpha")).not.toBeInTheDocument()
  })

  it("does not render tag section when tags array is empty", () => {
    render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry({ tags: [] })}
        onEdit={jest.fn()}
      />
    )
    // Entry value is in the DOM but no extra badge text.
    expect(screen.getByText("hello world")).toBeInTheDocument()
  })

  it("copy button writes value to clipboard and shows copied text", async () => {
    render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry({ value: "copy me" })}
        onEdit={jest.fn()}
      />
    )
    const copyBtn = screen.getByText("copy")
    await act(async () => {
      fireEvent.click(copyBtn)
    })
    expect(writeTextMock).toHaveBeenCalledWith("copy me")
    expect(screen.getByText("copied")).toBeInTheDocument()
  })

  it("edit button calls onEdit with the entry", () => {
    const entry = makeEntry()
    const onEdit = jest.fn()
    render(
      <MemoryEntryDetail open onOpenChange={jest.fn()} teamId="t1" entry={entry} onEdit={onEdit} />
    )
    fireEvent.click(screen.getByText("edit"))
    expect(onEdit).toHaveBeenCalledWith(entry)
  })

  it("delete button opens the confirm dialog", () => {
    render(
      <MemoryEntryDetail
        open
        onOpenChange={jest.fn()}
        teamId="t1"
        entry={makeEntry()}
        onEdit={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("delete"))
    expect(screen.getByTestId("mem-confirm-dialog")).toBeInTheDocument()
    expect(deleteEntryMock).not.toHaveBeenCalled()
  })

  it("confirming delete calls deleteEntry, markSaved, and closes both dialogs", () => {
    const onOpenChange = jest.fn()
    render(
      <MemoryEntryDetail
        open
        onOpenChange={onOpenChange}
        teamId="t1"
        entry={makeEntry({ key: "mykey" })}
        onEdit={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("delete"))
    fireEvent.click(screen.getByTestId("mem-confirm-yes"))
    expect(deleteEntryMock).toHaveBeenCalledWith("t1", "mykey")
    expect(markSavedMock).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("cancelling delete does NOT call deleteEntry", () => {
    const onOpenChange = jest.fn()
    render(
      <MemoryEntryDetail
        open
        onOpenChange={onOpenChange}
        teamId="t1"
        entry={makeEntry()}
        onEdit={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("delete"))
    fireEvent.click(screen.getByTestId("mem-confirm-no"))
    expect(deleteEntryMock).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
