/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { EditableSettingRow } from "./editable-setting-row"

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

// Stub the confirm dialog to a controllable harness so we can drive the
// confirm/cancel branches without radix.
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
      <div data-testid="confirm">
        <button data-testid="confirm-yes" onClick={onConfirm}>
          yes
        </button>
        <button data-testid="confirm-no" onClick={() => onOpenChange(false)}>
          no
        </button>
      </div>
    ) : null,
}))

describe("EditableSettingRow", () => {
  beforeEach(() => markSavedMock.mockReset())

  it("commits synchronously (debounceMs=0) and pings the save indicator", () => {
    const onCommit = jest.fn()
    render(
      <EditableSettingRow<number>
        label="Max"
        value={5}
        onCommit={onCommit}
        debounceMs={0}
        render={({ value, setValue }) => (
          <input
            type="number"
            value={value}
            data-testid="num"
            onChange={(e) => setValue(Number(e.target.value))}
          />
        )}
      />
    )
    fireEvent.change(screen.getByTestId("num"), { target: { value: "8" } })
    expect(onCommit).toHaveBeenCalledWith(8)
    expect(markSavedMock).toHaveBeenCalledTimes(1)
  })

  it("opens the confirm dialog when confirmBefore.predicate matches, commits on confirm", () => {
    const onCommit = jest.fn()
    render(
      <EditableSettingRow<string>
        label="Critical action"
        value="notify"
        onCommit={onCommit}
        debounceMs={0}
        confirmBefore={{
          title: "T",
          description: "D",
          confirmLabel: "OK",
          cancelLabel: "Cancel",
          predicate: (v) => v === "handoff_to_background",
        }}
        render={({ value, setValue }) => (
          <select value={value} data-testid="sel" onChange={(e) => setValue(e.target.value)}>
            <option value="notify">notify</option>
            <option value="handoff_to_background">handoff</option>
          </select>
        )}
      />
    )
    fireEvent.change(screen.getByTestId("sel"), { target: { value: "handoff_to_background" } })
    // Predicate matched → dialog opens, not yet committed.
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByTestId("confirm")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("confirm-yes"))
    expect(onCommit).toHaveBeenCalledWith("handoff_to_background")
  })

  it("does not commit a confirm-guarded change when cancelled", () => {
    const onCommit = jest.fn()
    render(
      <EditableSettingRow<string>
        label="Critical action"
        value="notify"
        onCommit={onCommit}
        debounceMs={0}
        confirmBefore={{
          title: "T",
          description: "D",
          confirmLabel: "OK",
          cancelLabel: "Cancel",
        }}
        render={({ value, setValue }) => (
          <select value={value} data-testid="sel" onChange={(e) => setValue(e.target.value)}>
            <option value="notify">notify</option>
            <option value="pause_for_review">pause</option>
          </select>
        )}
      />
    )
    fireEvent.change(screen.getByTestId("sel"), { target: { value: "pause_for_review" } })
    fireEvent.click(screen.getByTestId("confirm-no"))
    expect(onCommit).not.toHaveBeenCalled()
  })
})
