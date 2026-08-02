/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// useUnifiedRecentRuns is the dependency that pulls Dexie + everything else
// into the test. Mock it so we control the runs the component sees.
let mockRuns: UnifiedExecutionRun[] = []
let mockLoading = false
jest.mock("@/hooks/scheduler/use-unified-recent-runs", () => ({
  useUnifiedRecentRuns: () => ({ runs: mockRuns, isLoading: mockLoading }),
}))

jest.mock("@/components/workflow/runs/run-status-pill", () => ({
  RunStatusPill: ({ status }: { status: string }) => (
    <span data-testid={`stub-pill-${status}`}>{status}</span>
  ),
}))

import { UnifiedRecentRuns } from "./unified-recent-runs"

function makeRun(overrides: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  return {
    unifiedId: "app:run-1",
    kind: "app",
    itemUnifiedId: "app:task-1",
    itemName: "Daily summary",
    status: "succeeded",
    startedAt: Date.now() - 60_000,
    origin: { tableName: "schedulerDb.executions", nativeId: "run-1" },
    ...overrides,
  }
}

describe("UnifiedRecentRuns", () => {
  beforeEach(() => {
    mockRuns = []
    mockLoading = false
  })

  it("renders the loading state when the hook is still resolving", () => {
    mockLoading = true
    render(<UnifiedRecentRuns />)
    expect(screen.getByTestId("unified-runs-loading")).toBeInTheDocument()
  })

  it("renders the empty state when there are no runs", () => {
    render(<UnifiedRecentRuns />)
    expect(screen.getByTestId("unified-runs-empty")).toBeInTheDocument()
  })

  it("renders one row per run with the kind-config icon and the status pill", () => {
    mockRuns = [
      makeRun({ unifiedId: "app:1" }),
      makeRun({ unifiedId: "workflow:2", kind: "workflow", itemName: "WF" }),
      makeRun({ unifiedId: "connector:3", kind: "connector", itemName: "Outbound" }),
    ]
    render(<UnifiedRecentRuns />)
    expect(screen.getByTestId("unified-run-row-app:1")).toBeInTheDocument()
    expect(screen.getByTestId("unified-run-row-workflow:2")).toBeInTheDocument()
    expect(screen.getByTestId("unified-run-row-connector:3")).toBeInTheDocument()
    expect(screen.getAllByTestId("stub-pill-succeeded")).toHaveLength(3)
  })

  it("clips to the limit prop (newest-first ordering is the hook's job)", () => {
    mockRuns = Array.from({ length: 12 }, (_, i) =>
      makeRun({ unifiedId: `app:${i}`, startedAt: Date.now() - i * 1000 })
    )
    render(<UnifiedRecentRuns limit={3} />)
    expect(screen.getAllByRole("button")).toHaveLength(3)
  })

  it("fires onSelectRun(run) when a clickable row is clicked", () => {
    const onSelectRun = jest.fn()
    mockRuns = [makeRun({ unifiedId: "app:1" })]
    render(<UnifiedRecentRuns onSelectRun={onSelectRun} />)
    fireEvent.click(screen.getByTestId("unified-run-row-app:1"))
    expect(onSelectRun).toHaveBeenCalledWith(mockRuns[0])
  })

  it("disables rows when no onSelectRun is supplied (read-only mode)", () => {
    mockRuns = [makeRun({ unifiedId: "app:1" })]
    render(<UnifiedRecentRuns />)
    const row = screen.getByTestId("unified-run-row-app:1") as HTMLButtonElement
    expect(row.disabled).toBe(true)
  })

  it("merges className onto the outer surface so the overview can flatten it", () => {
    mockRuns = [makeRun({ unifiedId: "app:1" })]
    const { container } = render(<UnifiedRecentRuns className="border-0 bg-transparent" />)
    const card = container.querySelector('[data-slot="card"]')!
    expect(card.className).toContain("border-0")
    expect(card.className).toContain("bg-transparent")
  })
})
