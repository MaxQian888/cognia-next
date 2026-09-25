import { render, screen } from "@testing-library/react"

jest.mock("./sections/kind-facts-section", () => ({
  kindHasFacts: (item: { kind: string }) => item.kind !== "app",
  KindFactsSection: ({ item }: { item: { kind: string } }) => (
    <div data-testid="kind-facts">{item.kind}</div>
  ),
}))
jest.mock("../task-process-panel", () => ({
  TaskProcessPanel: ({ taskId }: { taskId: string }) => (
    <div data-testid="process-panel">{taskId}</div>
  ),
}))
jest.mock("../task-workspace-move", () => ({
  TaskWorkspaceMove: () => <div data-testid="workspace-move" />,
}))
jest.mock("../task-dependency-graph", () => ({
  TaskDependencyGraph: ({ onSelectTask }: { onSelectTask: (id: string) => void }) => (
    <button data-testid="dependency-graph" onClick={() => onSelectTask("up")} />
  ),
}))

import { ItemDetail, type ItemDetailProps } from "./item-detail"
import { buildOutcomeCells } from "@/lib/scheduler/outcome-strip"
import type { ScheduledTask } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:t1",
    kind: "app",
    sourceId: "t1",
    name: "Nightly",
    status: "active",
    triggerSummary: { type: "cron", cron: "0 2 * * *" },
    origin: { tableName: "scheduledTasks", deepLinkHref: "/scheduler?taskId=t1" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Nightly",
    type: "chat",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 2 * * *" },
    payload: { type: "chat", prompt: "x" },
    config: { timeout: 60_000, maxRetries: 0 },
    notification: { channels: ["toast"], onStart: false, onComplete: true, onError: true },
    tags: ["ops"],
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ScheduledTask
}

function props(over: Partial<ItemDetailProps> = {}): ItemDetailProps {
  return {
    item: item(),
    task: task(),
    signals: [],
    runs: [],
    outcomeCells: buildOutcomeCells([], { now: Date.now() }),
    allTasks: [task()],
    actions: { onRunNow: jest.fn(), onPause: jest.fn(), onResume: jest.fn(), onDelete: jest.fn() },
    onOpenRun: jest.fn(),
    onSelectItem: jest.fn(),
    ...over,
  }
}

describe("ItemDetail", () => {
  it("asks for a selection when there is none", () => {
    render(<ItemDetail {...props({ item: null })} />)
    expect(screen.getByTestId("item-detail-empty")).toBeInTheDocument()
  })

  it("composes an app task: hero, schedule, outcomes, runs, notifications, tags, workspace, origin", () => {
    render(<ItemDetail {...props()} />)
    expect(screen.getByTestId("item-hero")).toBeInTheDocument()
    for (const id of [
      "schedule",
      "outcomes",
      "runs",
      "notifications",
      "tags",
      "workspace",
      "origin",
    ]) {
      expect(screen.getByTestId(`console-section-${id}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId("console-section-facts")).not.toBeInTheDocument()
    expect(screen.queryByTestId("console-section-processes")).not.toBeInTheDocument()
    expect(screen.queryByTestId("console-section-dependencies")).not.toBeInTheDocument()
  })

  it("adds processes for a spawning type and the dependency graph when chained", () => {
    const upstream = task({ id: "up", name: "Upstream" })
    const chained = task({
      type: "background-command",
      trigger: { type: "cron", cronExpression: "* * * * *", dependsOn: ["up"] },
    })
    const p = props({ task: chained, allTasks: [chained, upstream] })
    render(<ItemDetail {...p} />)
    expect(screen.getByTestId("process-panel")).toHaveTextContent("t1")
    screen.getByTestId("dependency-graph").click()
    expect(p.onSelectItem).toHaveBeenCalledWith("app:up")
  })

  it("composes another kind with its facts and no app-only sections, and can drop the hero", () => {
    render(
      <ItemDetail
        {...props({
          item: item({ kind: "system", unifiedId: "system:s1", sourceId: "s1" }),
          task: undefined,
          hideHero: true,
        })}
      />
    )
    expect(screen.queryByTestId("item-hero")).not.toBeInTheDocument()
    expect(screen.getByTestId("kind-facts")).toHaveTextContent("system")
    expect(screen.queryByTestId("console-section-notifications")).not.toBeInTheDocument()
    expect(screen.getByTestId("runs-section-no-history")).toBeInTheDocument()
    expect(screen.queryByTestId("item-outcomes")).not.toBeInTheDocument()
  })
})

describe("ItemDetail · hands the page's action state to the masthead", () => {
  it("shows the in-flight action and the way back", () => {
    const onBack = jest.fn()
    render(<ItemDetail {...props({ pendingAction: "starting", onBack })} />)
    expect(screen.getByTestId("item-action-run")).toHaveAttribute("aria-busy", "true")
    screen.getByTestId("item-hero-back").click()
    expect(onBack).toHaveBeenCalled()
  })

  it("has no back control when the shell brings its own", () => {
    render(<ItemDetail {...props()} />)
    expect(screen.queryByTestId("item-hero-back")).not.toBeInTheDocument()
  })
})
