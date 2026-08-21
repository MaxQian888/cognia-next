/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import { DeleteItemDialog } from "./delete-item-dialog"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"

function makeItem(kind: ScheduledItemKind, name: string, sourceId = "1"): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name,
    status: "active",
    triggerSummary: { type: "interval", intervalMs: 60_000 },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

describe("DeleteItemDialog", () => {
  it("stays closed when nothing is pending", () => {
    render(<DeleteItemDialog item={null} onOpenChange={jest.fn()} onConfirm={jest.fn()} />)
    expect(screen.queryByTestId("scheduler-delete-item-dialog")).toBeNull()
  })

  it("names the item and its source so the user knows what they are deleting", () => {
    render(
      <DeleteItemDialog
        item={makeItem("workflow", "Nightly ETL")}
        onOpenChange={jest.fn()}
        onConfirm={jest.fn()}
      />
    )
    const dialog = screen.getByTestId("scheduler-delete-item-dialog")
    expect(dialog).toHaveTextContent("Nightly ETL")
    expect(dialog).toHaveTextContent("Workflow")
  })

  it("dispatches the confirm handler", () => {
    const onConfirm = jest.fn()
    render(
      <DeleteItemDialog
        item={makeItem("backup", "Weekly backup")}
        onOpenChange={jest.fn()}
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByTestId("scheduler-delete-item-confirm"))
    expect(onConfirm).toHaveBeenCalled()
  })

  it("reports dismissal so the page can clear the pending item", () => {
    const onOpenChange = jest.fn()
    render(
      <DeleteItemDialog
        item={makeItem("app", "Daily digest")}
        onOpenChange={onOpenChange}
        onConfirm={jest.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
