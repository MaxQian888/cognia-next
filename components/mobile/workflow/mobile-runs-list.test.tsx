/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"

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
  RunVerticalGantt: ({ runs }: { runs: { id: string }[] }) => (
    <ul data-testid="gantt">
      {runs.map((r) => (
        <li key={r.id} data-testid={`run-${r.id}`}>
          {r.id}
        </li>
      ))}
    </ul>
  ),
}))

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))

import { MobileRunsList } from "./mobile-runs-list"

function seed(rows: Array<Partial<WorkflowRunRow>>) {
  return getDb().workflowRuns.bulkAdd(rows as unknown as WorkflowRunRow[])
}

beforeEach(async () => {
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
    expect(screen.getByTestId("sub-page-shell")).toHaveAttribute("data-backhref", "/workflows/wf1")
  })
})
