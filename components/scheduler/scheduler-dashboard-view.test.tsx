/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

// The summary band renders live under test — only its Card-free layout matters
// here; its own numbers/bars are covered by scheduler-overview-summary.test.

jest.mock("./task-execution-chart", () => ({
  __esModule: true,
  TaskExecutionChart: ({ runs }: { runs: unknown[] }) => (
    <div data-testid="task-execution-chart-stub" data-points={runs.length} />
  ),
  toChartPointsFromUnifiedRuns: (runs: unknown[]) => runs,
}))

// Stub the execution monitor — it has its own dedicated test and pulls live
// Dexie / broker sources we don't want to stand up for the dashboard layout test.
jest.mock("@/components/execution/execution-monitor-panel", () => ({
  __esModule: true,
  ExecutionMonitorPanel: () => <div data-testid="execution-monitor-stub" />,
}))

// Stub the calendar/timeline views — they have their own dedicated tests; here
// we only assert the dashboard routes to the right one for the active mode and
// hands it the merged item list.
jest.mock("./scheduler-calendar-view", () => ({
  __esModule: true,
  SchedulerCalendarView: ({ items }: { items: unknown[] }) => (
    <div data-testid="calendar-view-stub" data-items={items.length} />
  ),
}))
jest.mock("./scheduler-timeline-view", () => ({
  __esModule: true,
  SchedulerTimelineView: ({ items }: { items: unknown[] }) => (
    <div data-testid="timeline-view-stub" data-items={items.length} />
  ),
}))

// Stub the unified runs widget — it has its own test and pulls live Dexie
// sources; here we only assert the dashboard mounts it.
jest.mock("./unified-recent-runs", () => ({
  __esModule: true,
  UnifiedRecentRuns: () => <div data-testid="unified-recent-runs-stub" />,
}))

const viewState = { view: "overview" as "overview" | "calendar" | "timeline" }
jest.mock("@/hooks/scheduler/use-scheduler-dashboard-view", () => ({
  __esModule: true,
  useSchedulerDashboardView: () => ({ view: viewState.view, setView: jest.fn() }),
  isSchedulerDashboardView: (v: string) => ["overview", "calendar", "timeline"].includes(v),
}))

import { SchedulerDashboardView } from "./scheduler-dashboard-view"
import { deriveUnifiedStatistics } from "@/lib/scheduler/unified-filter"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

const NOW = 1_800_000_000_000

function makeItem(overrides: Partial<UnifiedScheduledItem> & { sourceId: string }) {
  const kind: ScheduledItemKind = overrides.kind ?? "app"
  return {
    unifiedId: `${kind}:${overrides.sourceId}`,
    kind,
    name: `Item ${overrides.sourceId}`,
    status: "active",
    triggerSummary: { type: "interval", intervalMs: 60_000 },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  } as UnifiedScheduledItem
}

const ITEMS: UnifiedScheduledItem[] = [
  makeItem({
    sourceId: "t1",
    name: "Upcoming task 1",
    nextRunAt: NOW + 60_000,
    successCount: 95,
    failureCount: 5,
  }),
  makeItem({
    sourceId: "wf",
    kind: "workflow",
    name: "Upcoming workflow",
    nextRunAt: NOW + 120_000,
  }),
  makeItem({ sourceId: "p1", name: "Paused one", status: "paused" }),
]

const RUNS: UnifiedExecutionRun[] = [
  {
    unifiedId: "app:r1",
    kind: "app",
    itemUnifiedId: "app:t1",
    itemName: "Run 1",
    status: "succeeded",
    startedAt: NOW - 60_000,
  } as UnifiedExecutionRun,
]

function setup(overrides: Partial<React.ComponentProps<typeof SchedulerDashboardView>> = {}) {
  const items = overrides.items ?? ITEMS
  const props: React.ComponentProps<typeof SchedulerDashboardView> = {
    statistics: deriveUnifiedStatistics(items),
    items,
    recentRuns: RUNS,
    onSelectItem: jest.fn(),
    onSelectRun: jest.fn(),
    now: NOW,
    ...overrides,
  }
  return { props, ...render(<SchedulerDashboardView {...props} />) }
}

beforeEach(() => {
  viewState.view = "overview"
})

describe("SchedulerDashboardView", () => {
  it("pairs the view toggle with the active view's name", () => {
    setup()
    expect(screen.getByTestId("scheduler-dashboard-view-toggle")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-dashboard-title")).toHaveTextContent(
      "dashboardView.overview"
    )
  })

  it("renders the summary band over the merged cross-source counts", () => {
    setup()
    expect(screen.getByTestId("scheduler-overview-summary")).toBeInTheDocument()
    // 3 items across app + workflow, not the app-store's own task count.
    expect(screen.getByTestId("summary-total-items")).toHaveTextContent("3")
    expect(screen.getByTestId("summary-success-rate")).toHaveTextContent("95%")
  })

  it("renders '—' rather than 0% when no source has recorded a run", () => {
    setup({ items: [makeItem({ sourceId: "fresh" })] })
    expect(screen.getByTestId("summary-success-rate")).toHaveTextContent("—")
  })

  it("hands the calendar view the whole merged list", () => {
    viewState.view = "calendar"
    setup()
    expect(screen.getByTestId("calendar-view-stub")).toHaveAttribute("data-items", "3")
    expect(screen.queryByTestId("scheduler-overview-summary")).toBeNull()
  })

  it("hands the timeline view the whole merged list", () => {
    viewState.view = "timeline"
    setup()
    expect(screen.getByTestId("timeline-view-stub")).toHaveAttribute("data-items", "3")
  })

  it("lists upcoming runs from every source and dispatches the unifiedId", () => {
    const onSelectItem = jest.fn()
    setup({ onSelectItem })
    expect(screen.getByTestId("overview-upcoming-app:t1")).toBeInTheDocument()
    expect(screen.getByTestId("overview-upcoming-workflow:wf")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("overview-upcoming-app:t1"))
    expect(onSelectItem).toHaveBeenCalledWith("app:t1")
  })

  it("omits paused items from upcoming", () => {
    setup()
    expect(screen.queryByTestId("overview-upcoming-app:p1")).toBeNull()
  })

  it("renders the no-upcoming empty state when nothing is scheduled ahead", () => {
    setup({ items: [makeItem({ sourceId: "p", status: "paused" })] })
    expect(screen.getByText("noUpcomingTasks")).toBeInTheDocument()
  })

  it("charts the cross-source runs it is given", () => {
    setup()
    expect(screen.getByTestId("task-execution-chart-stub")).toHaveAttribute("data-points", "1")
  })

  it("always mounts the unified cross-kind recent-runs widget", () => {
    setup()
    expect(screen.getByTestId("unified-recent-runs-stub")).toBeInTheDocument()
  })

  it("wires the kind rail back to the sidebar filter", () => {
    const onSelectKind = jest.fn()
    setup({ onSelectKind, selectedKinds: new Set<ScheduledItemKind>(["workflow"]) })
    fireEvent.click(screen.getByTestId("kind-summary-app"))
    expect(onSelectKind).toHaveBeenCalledWith("app")
    expect(screen.getByTestId("kind-summary-workflow")).toHaveAttribute("aria-pressed", "true")
  })

  it("lays the overview out as flat blocks rather than nested cards", () => {
    const { container } = setup()
    // The summary and upcoming blocks are plain sections — the only `Card`s in
    // the overview tree belong to stubbed child widgets.
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(0)
    expect(screen.getByTestId("overview-upcoming")).toBeInTheDocument()
  })
})
