import { fireEvent, render, screen } from "@testing-library/react"

import { KindSummary } from "./kind-summary"
import { deriveUnifiedStatistics } from "@/lib/scheduler/unified-filter"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(
  kind: UnifiedScheduledItem["kind"],
  status: UnifiedScheduledItem["status"] = "active"
): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${Math.random()}`,
    kind,
    sourceId: "x",
    name: kind,
    status,
    triggerSummary: { type: "cron" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

describe("KindSummary", () => {
  it("lists only kinds that exist, with active/total, and pins on click", () => {
    const statistics = deriveUnifiedStatistics([
      item("app"),
      item("app", "paused"),
      item("workflow"),
    ])
    const onToggleKind = jest.fn()
    render(
      <KindSummary
        statistics={statistics}
        selectedKinds={new Set(["workflow"])}
        onToggleKind={onToggleKind}
      />
    )
    expect(screen.getByTestId("kind-summary-app")).toHaveTextContent("1/2 active")
    expect(screen.getByTestId("kind-summary-workflow")).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByTestId("kind-summary-backup")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("kind-summary-app"))
    expect(onToggleKind).toHaveBeenCalledWith("app")
  })

  it("says there are no tasks when every kind is empty", () => {
    render(
      <KindSummary
        statistics={deriveUnifiedStatistics([])}
        selectedKinds={new Set()}
        onToggleKind={jest.fn()}
      />
    )
    expect(screen.getByTestId("kind-summary-empty")).toBeInTheDocument()
  })
})
