/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import { DetailHeader } from "./detail-header"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function makeItem(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "workflow:t-1",
    kind: "workflow",
    sourceId: "t-1",
    name: "My workflow trigger",
    description: "Daily cron",
    status: "active",
    triggerSummary: { type: "cron", cron: "0 9 * * *" },
    origin: { deepLinkHref: "/workflows/t-1" },
    capabilities: { runNow: true, pause: true, edit: false, delete: false },
    ...overrides,
  }
}

describe("DetailHeader", () => {
  it("renders the item name, description, status badge, and kind tag", () => {
    render(<DetailHeader item={makeItem()} />)
    expect(screen.getByTestId("detail-header-name")).toHaveTextContent("My workflow trigger")
    expect(screen.getByTestId("detail-header-desc")).toHaveTextContent("Daily cron")
    // kind tag routes through t("kindFilter.<kind>") so the mock returns
    // "kindFilter.workflow" — match the prefix.
    expect(screen.getByText(/kindFilter\.workflow/)).toBeInTheDocument()
    // status badge routes through t("statuses.<status>") — match the prefix.
    expect(screen.getByText(/statuses\.active/)).toBeInTheDocument()
  })

  it("hides the description when the item has none", () => {
    render(<DetailHeader item={makeItem({ description: undefined })} />)
    expect(screen.queryByTestId("detail-header-desc")).toBeNull()
  })

  it("hides Run now when capabilities.runNow is false", () => {
    render(
      <DetailHeader
        item={makeItem({
          capabilities: { runNow: false, pause: true, edit: false, delete: false },
        })}
        onRunNow={jest.fn()}
      />
    )
    expect(screen.queryByTestId("detail-action-run")).toBeNull()
  })

  it("calls onRunNow / onPause / onResume / onEdit / onDelete with the item", () => {
    const onRunNow = jest.fn()
    const onPause = jest.fn()
    const onEdit = jest.fn()
    const onDelete = jest.fn()
    const item = makeItem({
      capabilities: { runNow: true, pause: true, edit: true, delete: true },
    })
    render(
      <DetailHeader
        item={item}
        onRunNow={onRunNow}
        onPause={onPause}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    )
    fireEvent.click(screen.getByTestId("detail-action-run"))
    fireEvent.click(screen.getByTestId("detail-action-pause-resume"))
    fireEvent.click(screen.getByTestId("detail-action-edit"))
    fireEvent.click(screen.getByTestId("detail-action-delete"))
    expect(onRunNow).toHaveBeenCalledWith(item)
    expect(onPause).toHaveBeenCalledWith(item)
    expect(onEdit).toHaveBeenCalledWith(item)
    expect(onDelete).toHaveBeenCalledWith(item)
  })

  it("calls onResume instead of onPause when the item is currently paused", () => {
    const onPause = jest.fn()
    const onResume = jest.fn()
    const item = makeItem({ status: "paused" })
    render(<DetailHeader item={item} onPause={onPause} onResume={onResume} />)
    fireEvent.click(screen.getByTestId("detail-action-pause-resume"))
    expect(onResume).toHaveBeenCalledWith(item)
    expect(onPause).not.toHaveBeenCalled()
  })

  it("renders the kind-specific icon from the shared kindConfig", () => {
    const { container } = render(<DetailHeader item={makeItem({ kind: "connector" })} />)
    // every lucide icon mounts as an <svg>
    expect(container.querySelector("[data-testid='detail-header-icon'] svg")).toBeTruthy()
  })
})
