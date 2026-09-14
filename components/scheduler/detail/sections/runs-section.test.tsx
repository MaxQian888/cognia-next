import { fireEvent, render, screen } from "@testing-library/react"

import { RunsSection } from "./runs-section"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

function item(kind: UnifiedScheduledItem["kind"] = "app"): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:t1`,
    kind,
    sourceId: "t1",
    name: "Nightly",
    status: "active",
    triggerSummary: { type: "cron" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

function run(id: string, status: UnifiedExecutionRun["status"] = "succeeded"): UnifiedExecutionRun {
  return {
    unifiedId: `app:${id}`,
    kind: "app",
    itemUnifiedId: "app:t1",
    itemName: "Nightly",
    status,
    startedAt: Date.now() - 60_000,
    durationMs: 1000,
    origin: { tableName: "t", nativeId: id },
  }
}

describe("RunsSection", () => {
  it("states that the OS keeps no history for a system task", () => {
    render(<RunsSection item={item("system")} runs={[]} onOpenRun={jest.fn()} />)
    expect(screen.getByTestId("runs-section-no-history")).toBeInTheDocument()
  })

  it("distinguishes loading from never ran", () => {
    const { rerender } = render(
      <RunsSection item={item()} runs={[]} onOpenRun={jest.fn()} loading />
    )
    expect(screen.getByTestId("runs-section-empty")).toHaveTextContent("Loading")
    rerender(<RunsSection item={item()} runs={[]} onOpenRun={jest.fn()} />)
    expect(screen.getByTestId("runs-section-empty")).toHaveTextContent("No executions yet")
  })

  it("lists runs, marks the open one, cancels a running one and loads more", () => {
    const onOpenRun = jest.fn()
    const onCancelRun = jest.fn()
    const onLoadMore = jest.fn()
    render(
      <RunsSection
        item={item()}
        runs={[run("r1", "running"), run("r2")]}
        selectedRunId="app:r2"
        onOpenRun={onOpenRun}
        onCancelRun={onCancelRun}
        hasMore
        onLoadMore={onLoadMore}
      />
    )
    fireEvent.click(screen.getByTestId("run-row-cancel"))
    expect(onCancelRun).toHaveBeenCalledWith(expect.objectContaining({ unifiedId: "app:r1" }))
    expect(
      screen.getByTestId("run-row-app:r2").querySelector("[aria-current='true']")
    ).not.toBeNull()
    fireEvent.click(screen.getByTestId("runs-section-load-more"))
    expect(onLoadMore).toHaveBeenCalled()
  })
})
