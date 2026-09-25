import { render, screen } from "@testing-library/react"

import userEvent from "@testing-library/user-event"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
const focusSession = jest.fn(async (_sessionId: string) => undefined)
jest.mock("../../run-artifact-links", () => ({
  focusSessionInItsWorkspace: (id: string) => focusSession(id),
}))

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

describe("OriginSection · the conversation that created it", () => {
  it("opens the agent's conversation, in its own workspace", async () => {
    const user = userEvent.setup()
    const task = {
      createdBy: { kind: "agent", sessionId: "sess-7" },
      createdAt: new Date(2026, 0, 1),
    } as unknown as ScheduledTask
    render(<OriginSection item={item({ createdBySource: "agent" })} task={task} />)
    await user.click(screen.getByTestId("origin-open-conversation"))
    expect(focusSession).toHaveBeenCalledWith("sess-7")
    expect(push).toHaveBeenCalledWith("/")
  })

  it("has no such link for a task a person or a plugin set up", () => {
    const task = { createdBy: { kind: "user" } } as unknown as ScheduledTask
    render(<OriginSection item={item()} task={task} />)
    expect(screen.queryByTestId("origin-open-conversation")).not.toBeInTheDocument()
  })
})
