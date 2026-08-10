/**
 * @jest-environment jsdom
 *
 * Run-history management coverage: filters, summary stats, bulk + single
 * deletion (with the cascade primitives), clear-history, export, re-run, and
 * "load more" windowing. Uses fake-indexeddb so the live query + real db
 * deletes round-trip; the execution authority + export side-effects are mocked.
 */
import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type RunStatus,
  type VisualWorkflow,
} from "@/types/workflow/visual"
import { RunList } from "./run-list"

const retryWorkflowRunMock = jest.fn(async (..._args: unknown[]) => ({
  runId: "r-new",
  result: { status: "succeeded" as const },
}))
jest.mock("@/lib/workflow/runtime/execution-authority", () => ({
  __esModule: true,
  retryWorkflowRun: (...args: unknown[]) => retryWorkflowRunMock(...args),
}))

const downloadRunsJsonMock = jest.fn()
const downloadRunsCsvMock = jest.fn()
jest.mock("@/lib/workflow/runs/run-export", () => ({
  __esModule: true,
  downloadRunsJson: (...a: unknown[]) => downloadRunsJsonMock(...a),
  downloadRunsCsv: (...a: unknown[]) => downloadRunsCsvMock(...a),
}))

const snapshot: VisualWorkflow = {
  id: "wf1",
  schemaVersion: 2,
  name: "My Flow",
  createdAt: 0,
  updatedAt: 0,
  nodes: [],
  edges: [],
  settings: DEFAULT_WORKFLOW_SETTINGS,
}

async function seedRun(
  id: string,
  patch: Partial<{
    status: RunStatus
    triggerKind: string
    startedAt: number
    completedAt: number
  }> = {}
) {
  await getDb().workflowRuns.put({
    id,
    workflowId: "wf1",
    status: patch.status ?? "succeeded",
    triggerKind: (patch.triggerKind ?? "trigger.manual") as never,
    triggerPayload: {},
    startedAt: patch.startedAt ?? 1000,
    completedAt: patch.completedAt,
    workflowSnapshot: snapshot,
  })
  await getDb().workflowRunEvents.put({
    id: `e-${id}`,
    runId: id,
    ts: 1,
    type: "step_started",
    stepId: "s1",
  })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  retryWorkflowRunMock.mockClear()
  downloadRunsJsonMock.mockClear()
  downloadRunsCsvMock.mockClear()
})

function wrap() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RunList workflowId="wf1" />
    </NextIntlClientProvider>
  )
}

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

describe("RunList", () => {
  it("renders rows for runs that lack a workflowSnapshot (older schema rows)", async () => {
    // Rows imported from older schema versions carry no snapshot; the header
    // falls back to the workflow id instead of crashing on snapshot.name.
    await getDb().workflowRuns.put({
      id: "r-legacy",
      workflowId: "wf1",
      status: "succeeded",
      triggerKind: "trigger.manual" as never,
      triggerPayload: {},
      startedAt: 1000,
      completedAt: 1200,
    } as never)
    wrap()
    // The crash mode was an unguarded snapshot.name read during render —
    // reaching the row testid proves the page survived it.
    expect(await screen.findByTestId("runs-actions-r-legacy")).toBeInTheDocument()
  })

  it("renders rows and summary stats", async () => {
    await seedRun("r1", { status: "succeeded", startedAt: 1000, completedAt: 1200 })
    await seedRun("r2", { status: "failed", startedAt: 2000 })
    wrap()
    expect(await screen.findByTestId("runs-actions-r1")).toBeInTheDocument()
    expect(screen.getByTestId("runs-actions-r2")).toBeInTheDocument()
    // Total = 2, success rate = 50%. ("Failed" stat label collides with the
    // failed run's status pill, so assert on the unique labels instead.)
    expect(screen.getByText("Total runs").parentElement).toHaveTextContent("2")
    expect(screen.getByText("Success rate").parentElement).toHaveTextContent("50%")
  })

  it("filters by status", async () => {
    await seedRun("r1", { status: "succeeded" })
    await seedRun("r2", { status: "failed" })
    wrap()
    await screen.findByTestId("runs-actions-r1")
    await user().selectOptions(screen.getByTestId("runs-filter-status"), "failed")
    await waitFor(() => expect(screen.queryByTestId("runs-actions-r1")).not.toBeInTheDocument())
    expect(screen.getByTestId("runs-actions-r2")).toBeInTheDocument()
  })

  it("filters by trigger kind", async () => {
    await seedRun("r1", { triggerKind: "trigger.manual" })
    await seedRun("r2", { triggerKind: "trigger.cron" })
    wrap()
    await screen.findByTestId("runs-actions-r1")
    await user().selectOptions(screen.getByTestId("runs-filter-trigger"), "trigger.cron")
    await waitFor(() => expect(screen.queryByTestId("runs-actions-r1")).not.toBeInTheDocument())
    expect(screen.getByTestId("runs-actions-r2")).toBeInTheDocument()
  })

  it("filters by time window", async () => {
    const now = Date.now()
    await seedRun("recent", { startedAt: now - 1000 })
    await seedRun("old", { startedAt: now - 10 * 24 * 60 * 60 * 1000 })
    wrap()
    await screen.findByTestId("runs-actions-recent")
    await user().selectOptions(screen.getByTestId("runs-filter-window"), "24h")
    await waitFor(() => expect(screen.queryByTestId("runs-actions-old")).not.toBeInTheDocument())
    expect(screen.getByTestId("runs-actions-recent")).toBeInTheDocument()
  })

  it("filters by search text (debounced)", async () => {
    await seedRun("alpha", { triggerKind: "trigger.manual" })
    await seedRun("beta", { triggerKind: "trigger.cron" })
    wrap()
    await screen.findByTestId("runs-actions-alpha")
    await user().type(screen.getByTestId("runs-search"), "cron")
    await waitFor(() => expect(screen.queryByTestId("runs-actions-alpha")).not.toBeInTheDocument())
    expect(screen.getByTestId("runs-actions-beta")).toBeInTheDocument()
  })

  it("deletes a single run via the row menu + confirm dialog", async () => {
    await seedRun("r1")
    await seedRun("r2")
    wrap()
    await screen.findByTestId("runs-actions-r1")
    const u = user()
    await u.click(screen.getByTestId("runs-actions-r1"))
    await u.click(await screen.findByText("Delete"))
    await u.click(await screen.findByTestId("runs-confirm-delete"))
    await waitFor(() => expect(screen.queryByTestId("runs-actions-r1")).not.toBeInTheDocument())
    expect(await getDb().workflowRuns.get("r1")).toBeUndefined()
    // Cascade removed its events.
    expect(await getDb().workflowRunEvents.where("runId").equals("r1").count()).toBe(0)
    expect(screen.getByTestId("runs-actions-r2")).toBeInTheDocument()
  })

  it("bulk-deletes selected runs", async () => {
    await seedRun("r1")
    await seedRun("r2")
    await seedRun("r3")
    wrap()
    await screen.findByTestId("runs-select-all")
    const u = user()
    await u.click(screen.getByTestId("runs-select-all"))
    expect(screen.getByTestId("runs-selected-count")).toHaveTextContent("3")
    await u.click(screen.getByTestId("runs-bulk-delete"))
    await u.click(await screen.findByTestId("runs-confirm-delete"))
    await waitFor(() => expect(screen.queryByTestId("runs-actions-r1")).not.toBeInTheDocument())
    expect(await getDb().workflowRuns.count()).toBe(0)
  })

  it("clears all history", async () => {
    await seedRun("r1")
    await seedRun("r2")
    wrap()
    await screen.findByTestId("runs-clear-history")
    const u = user()
    await u.click(screen.getByTestId("runs-clear-history"))
    await u.click(await screen.findByTestId("runs-confirm-delete"))
    await waitFor(() => expect(screen.getByText("No runs yet")).toBeInTheDocument())
    expect(await getDb().workflowRuns.count()).toBe(0)
  })

  it("re-runs from the row menu", async () => {
    await seedRun("r1")
    wrap()
    await screen.findByTestId("runs-actions-r1")
    const u = user()
    await u.click(screen.getByTestId("runs-actions-r1"))
    await u.click(await screen.findByText("Re-run"))
    await waitFor(() => expect(retryWorkflowRunMock).toHaveBeenCalledTimes(1))
    expect(retryWorkflowRunMock).toHaveBeenCalledWith({
      runId: "r1",
      mode: "current-deployment",
      operatedBy: "workflow-run-history",
    })
  })

  it("exports the filtered runs as JSON", async () => {
    await seedRun("r1")
    wrap()
    await screen.findByTestId("runs-export")
    const u = user()
    await u.click(screen.getByTestId("runs-export"))
    await u.click(await screen.findByText("Export as JSON"))
    expect(downloadRunsJsonMock).toHaveBeenCalledTimes(1)
  })

  it("windows with load more past the page size", async () => {
    for (let i = 0; i < 55; i += 1) {
      await seedRun(`r${i}`, { startedAt: 1000 + i })
    }
    wrap()
    const loadMore = await screen.findByTestId("runs-load-more")
    // 55 total, 50 shown → 5 remaining.
    expect(loadMore).toHaveTextContent("5")
    await user().click(loadMore)
    await waitFor(() => expect(screen.queryByTestId("runs-load-more")).not.toBeInTheDocument())
  })

  it("shows a filtered-empty state when no runs match", async () => {
    await seedRun("r1", { status: "succeeded" })
    wrap()
    await screen.findByTestId("runs-actions-r1")
    await user().selectOptions(screen.getByTestId("runs-filter-status"), "failed")
    expect(await screen.findByText("No runs match")).toBeInTheDocument()
  })

  it("selects an individual run via its row checkbox", async () => {
    await seedRun("r1")
    await seedRun("r2")
    wrap()
    await screen.findByTestId("runs-select-r1")
    await user().click(screen.getByTestId("runs-select-r1"))
    expect(screen.getByTestId("runs-selected-count")).toHaveTextContent("1")
  })

  it("clears filters via the toolbar button", async () => {
    await seedRun("r1", { status: "succeeded" })
    await seedRun("r2", { status: "failed" })
    wrap()
    await screen.findByTestId("runs-actions-r1")
    const u = user()
    await u.selectOptions(screen.getByTestId("runs-filter-status"), "failed")
    await waitFor(() => expect(screen.queryByTestId("runs-actions-r1")).not.toBeInTheDocument())
    await u.click(screen.getByTestId("runs-clear-filters"))
    expect(await screen.findByTestId("runs-actions-r1")).toBeInTheDocument()
  })

  it("exports the filtered runs as CSV", async () => {
    await seedRun("r1")
    wrap()
    await screen.findByTestId("runs-export")
    const u = user()
    await u.click(screen.getByTestId("runs-export"))
    await u.click(await screen.findByText("Export as CSV"))
    expect(downloadRunsCsvMock).toHaveBeenCalledTimes(1)
  })
})
