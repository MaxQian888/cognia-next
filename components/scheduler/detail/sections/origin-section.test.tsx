import { render, screen } from "@testing-library/react"

import { OriginSection } from "./origin-section"
import type { ScheduledTask } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:t1",
    kind: "app",
    sourceId: "t1",
    name: "Nightly",
    status: "active",
    triggerSummary: { type: "cron" },
    origin: { tableName: "scheduledTasks", deepLinkHref: "/scheduler?taskId=t1" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

describe("OriginSection", () => {
  it("names the storage, the creator and the identifier, and never links to itself", () => {
    const task = {
      createdBy: { kind: "agent" },
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 2),
    } as unknown as ScheduledTask
    render(<OriginSection item={item({ createdBySource: "agent" })} task={task} />)
    expect(screen.getByText("scheduledTasks")).toBeInTheDocument()
    expect(screen.getByText("Agent")).toBeInTheDocument()
    expect(screen.getByText("t1")).toBeInTheDocument()
    expect(screen.queryByTestId("origin-open-source")).not.toBeInTheDocument()
  })

  it("links to the source editor for a kind that lives elsewhere", () => {
    render(
      <OriginSection
        item={item({
          kind: "workflow",
          origin: { tableName: "workflowTriggers", deepLinkHref: "/workflows/editor?id=w1" },
        })}
      />
    )
    const link = screen.getByTestId("origin-open-source")
    expect(link).toHaveAttribute("href", "/workflows/editor?id=w1")
    expect(link).toHaveTextContent("Open in workflow editor")
  })

  it("says the user created it when the task has a user creator", () => {
    render(
      <OriginSection
        item={item()}
        task={{ createdBy: { kind: "user" } } as unknown as ScheduledTask}
      />
    )
    expect(screen.getByText("You")).toBeInTheDocument()
  })
})
