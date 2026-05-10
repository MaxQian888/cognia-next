/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"

import { RecentRunsFeed } from "./recent-runs-feed"

jest.mock("next/link", () => {
  const Link = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

const liveQueries: Array<unknown> = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    void factory
    return liveQueries.shift()
  },
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    workflowRuns: {
      orderBy: () => ({
        reverse: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
      }),
    },
  }),
}))

jest.mock("@/lib/db/workflows", () => ({
  listWorkflows: () => Promise.resolve([]),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = { runsHeader: "Recent runs", noRuns: "No runs" }
    return map[key] ?? key
  },
}))

const wf = (id: string, name: string): WorkflowRow =>
  ({
    id,
    name,
    schemaVersion: 1,
    nodes: [],
    edges: [],
    settings: {},
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as WorkflowRow

const run = (id: string, workflowId: string, status: string, startedAt: number): WorkflowRunRow =>
  ({
    id,
    workflowId,
    status,
    triggerKind: "trigger.manual",
    triggerPayload: null,
    startedAt,
  }) as unknown as WorkflowRunRow

beforeEach(() => {
  liveQueries.length = 0
})

describe("<RecentRunsFeed />", () => {
  it("shows the empty placeholder when no runs exist", () => {
    liveQueries.push([], [])
    render(<RecentRunsFeed />)
    expect(screen.getByTestId("recent-runs-empty")).toHaveTextContent("No runs")
  })

  it("renders run rows with status dot + workflow name", () => {
    liveQueries.push([run("r1", "w1", "succeeded", Date.now() - 60_000)], [wf("w1", "Daily Snap")])
    render(<RecentRunsFeed />)
    const row = screen.getByTestId("recent-run-r1")
    expect(row).toHaveTextContent("Daily Snap")
    expect(row.querySelector("[data-status='succeeded']")).not.toBeNull()
    expect(row).toHaveAttribute("href", "/workflows/w1/runs/r1")
  })

  it("falls back to the workflow id when the workflow row is missing", () => {
    liveQueries.push([run("r9", "missing", "running", Date.now())], [])
    render(<RecentRunsFeed />)
    expect(screen.getByTestId("recent-run-r9")).toHaveTextContent("missing")
  })

  it("formats relative timestamps across all buckets", () => {
    liveQueries.push(
      [
        run("r-now", "w", "running", Date.now() - 1_000),
        run("r-min", "w", "succeeded", Date.now() - 90_000),
        run("r-hr", "w", "failed", Date.now() - 90 * 60 * 1000),
        run("r-day", "w", "cancelled", Date.now() - 5 * 86_400_000),
      ],
      []
    )
    render(<RecentRunsFeed />)
    expect(screen.getByTestId("recent-run-r-now")).toHaveTextContent(/now/)
    expect(screen.getByTestId("recent-run-r-min")).toHaveTextContent(/2m/)
    expect(screen.getByTestId("recent-run-r-hr")).toHaveTextContent(/2h/)
    expect(screen.getByTestId("recent-run-r-day")).toHaveTextContent(/5d/)
  })

  it("renders an unknown status with the muted-foreground dot color", () => {
    liveQueries.push([run("rx", "w", "weird-status", Date.now())], [])
    render(<RecentRunsFeed />)
    const dot = screen.getByTestId("recent-run-rx").querySelector("[data-status='weird-status']")
    expect(dot).not.toBeNull()
    expect(dot).toHaveClass("bg-muted-foreground")
  })
})
