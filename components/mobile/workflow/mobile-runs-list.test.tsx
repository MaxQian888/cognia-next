/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { getDb } from "@/lib/db/schema"
import type { WorkflowRunRow } from "@/types/workflow/visual"

jest.mock("@/components/mobile/me/sub-page-shell", () => ({
  SubPageShell: ({
    children,
    title,
    backHref,
  }: {
    children: React.ReactNode
    title: string
    backHref?: string
  }) => (
    <div data-testid="sub-page-shell" data-title={title} data-backhref={backHref}>
      {children}
    </div>
  ),
}))

jest.mock("./run-vertical-gantt", () => ({
  RunVerticalGantt: ({
    runs,
    onCancelRun,
  }: {
    runs: { id: string; status: string }[]
    onCancelRun?: (run: { id: string }) => void
  }) => (
    <ul data-testid="gantt">
      {runs.map((r) => (
        <li key={r.id} data-testid={`run-${r.id}`}>
          {r.id}
          {onCancelRun && r.status === "running" ? (
            <button data-testid={`run-cancel-${r.id}`} onClick={() => onCancelRun(r)} />
          ) : null}
        </li>
      ))}
    </ul>
  ),
}))

const transportCallMock = jest.fn(async (_cmd: string, _payload: unknown) => ({
  cancelled: true,
  live: true,
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (cmd: string, payload: unknown) => transportCallMock(cmd, payload) },
}))

const toastSuccessMock = jest.fn()
const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccessMock(...a),
    error: (...a: unknown[]) => toastErrorMock(...a),
  },
}))

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))

import { MobileRunsList } from "./mobile-runs-list"

function seed(rows: Array<Partial<WorkflowRunRow>>) {
  return getDb().workflowRuns.bulkAdd(rows as unknown as WorkflowRunRow[])
}

beforeEach(async () => {
  transportCallMock.mockClear().mockResolvedValue({ cancelled: true, live: true })
  toastSuccessMock.mockClear()
  toastErrorMock.mockClear()
  await getDb().workflowRuns.clear()
})

describe("<MobileRunsList />", () => {
  it("lists this workflow's runs newest-first and excludes other workflows", async () => {
    await seed([
      { id: "r1", workflowId: "wf1", status: "succeeded", startedAt: 100 },
      { id: "r2", workflowId: "wf1", status: "failed", startedAt: 300 },
      { id: "r3", workflowId: "other", status: "succeeded", startedAt: 400 },
    ])
    render(<MobileRunsList workflowId="wf1" />)
    await waitFor(() => expect(screen.getByTestId("run-r2")).toBeInTheDocument())
    expect(screen.getByTestId("run-r1")).toBeInTheDocument()
    expect(screen.queryByTestId("run-r3")).toBeNull()

    const items = screen.getByTestId("gantt").querySelectorAll("li")
    expect(items[0]).toHaveAttribute("data-testid", "run-r2") // newest first
    expect(items[1]).toHaveAttribute("data-testid", "run-r1")
  })

  it("wires the back href to the workflow detail route", () => {
    render(<MobileRunsList workflowId="wf1" />)
    expect(screen.getByTestId("sub-page-shell")).toHaveAttribute("data-backhref", "/workflows/editor?id=wf1")
  })

  it("filters runs by the status chips", async () => {
    await seed([
      { id: "r1", workflowId: "wf1", status: "succeeded", startedAt: 100 },
      { id: "r2", workflowId: "wf1", status: "failed", startedAt: 300 },
    ])
    render(<MobileRunsList workflowId="wf1" />)
    await waitFor(() => expect(screen.getByTestId("run-r2")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("mobile-runs-filter-failed"))
    await waitFor(() => expect(screen.queryByTestId("run-r1")).toBeNull())
    expect(screen.getByTestId("run-r2")).toBeInTheDocument()
  })

  it("cancels an in-flight run via workflow_cancel_run after confirmation", async () => {
    await seed([{ id: "r1", workflowId: "wf1", status: "running", startedAt: 100 }])
    render(<MobileRunsList workflowId="wf1" />)
    await waitFor(() => expect(screen.getByTestId("run-cancel-r1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("run-cancel-r1"))
    fireEvent.click(await screen.findByTestId("mobile-runs-confirm-cancel-run"))
    await waitFor(() =>
      expect(transportCallMock).toHaveBeenCalledWith("workflow_cancel_run", { runId: "r1" })
    )
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled())
  })

  it("reports a failed cancel when the desktop rejects or is unreachable", async () => {
    transportCallMock.mockResolvedValueOnce({ cancelled: false, live: false })
    await seed([{ id: "r1", workflowId: "wf1", status: "running", startedAt: 100 }])
    render(<MobileRunsList workflowId="wf1" />)
    await waitFor(() => expect(screen.getByTestId("run-cancel-r1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("run-cancel-r1"))
    fireEvent.click(await screen.findByTestId("mobile-runs-confirm-cancel-run"))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })

  it("clears run history after confirmation", async () => {
    await seed([
      { id: "r1", workflowId: "wf1", status: "succeeded", startedAt: 100 },
      { id: "r2", workflowId: "wf1", status: "failed", startedAt: 300 },
    ])
    render(<MobileRunsList workflowId="wf1" />)
    await waitFor(() => expect(screen.getByTestId("run-r1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("mobile-runs-clear"))
    fireEvent.click(await screen.findByTestId("mobile-runs-confirm-clear"))
    await waitFor(async () => expect(await getDb().workflowRuns.count()).toBe(0))
  })
})
