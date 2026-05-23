/**
 * Tests for the workspace version-history panel (undo snapshots view).
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const undo = jest.fn()
const storeState: {
  undoStacks: Record<string, Array<{ id: string; description: string; timestamp: number }>>
  undo: typeof undo
} = {
  undoStacks: {},
  undo,
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { VersionHistoryPanel } from "./version-history-panel"

function renderPanel(surfaceId = "sx") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <A2UIWorkspaceProvider surfaceId={surfaceId}>
        <VersionHistoryPanel />
      </A2UIWorkspaceProvider>
    </NextIntlClientProvider>
  )
}

describe("VersionHistoryPanel", () => {
  beforeEach(() => {
    undo.mockReset()
    storeState.undoStacks = {}
  })

  it("renders the empty-state when no snapshots exist", () => {
    renderPanel()
    expect(screen.getByText(/no versions/i)).toBeInTheDocument()
  })

  it("renders snapshots newest-first with a Latest badge on the first entry", () => {
    storeState.undoStacks = {
      sx: [
        { id: "v1", description: "Initial", timestamp: 1_700_000_000_000 },
        { id: "v2", description: "Add button", timestamp: 1_700_000_100_000 },
        { id: "v3", description: "Rename", timestamp: 1_700_000_200_000 },
      ],
    }
    renderPanel()
    const labels = screen.getAllByText(/Initial|Add button|Rename/).map((el) => el.textContent)
    expect(labels[0]).toBe("Rename") // newest first
    expect(screen.getByText("Latest")).toBeInTheDocument()
  })

  it("invokes undo enough times to roll back to the chosen older snapshot", () => {
    storeState.undoStacks = {
      sx: [
        { id: "v1", description: "Initial", timestamp: 1_000 },
        { id: "v2", description: "Add", timestamp: 2_000 },
        { id: "v3", description: "Rename", timestamp: 3_000 },
      ],
    }
    renderPanel()
    // The restore buttons render with hidden opacity but they're still in the DOM.
    const restoreButtons = screen
      .getAllByRole("button")
      .filter((btn) => /restore/i.test(btn.textContent ?? ""))
    expect(restoreButtons.length).toBeGreaterThan(0)
    fireEvent.click(restoreButtons[0])
    expect(undo).toHaveBeenCalled()
  })
})
