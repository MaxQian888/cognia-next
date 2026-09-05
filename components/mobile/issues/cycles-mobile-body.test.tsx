/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock("@/components/issues/tracker-tabs", () => ({
  TrackerTabs: ({ active, compact }: { active: string; compact?: boolean }) => (
    <nav data-testid="tabs-stub" data-compact={String(Boolean(compact))}>
      {active}
    </nav>
  ),
}))
jest.mock("@/lib/db/issue-cycles", () => ({ listIssueCycles: jest.fn() }))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))

let cyclesForTest: unknown[] = []
let issuesForTest: unknown[] = []
let isSyncing = false
jest.mock("@/hooks/data/use-dexie-first-query", () => ({
  useDexieFirstQuery: ({ query }: { query: unknown }) => ({
    data: String(query).includes("listIssueCycles") ? cyclesForTest : issuesForTest,
    isSyncing,
    lastSyncedAt: null,
    error: null,
  }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId: "w1" }),
}))

import { render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import { CyclesMobileBody } from "./cycles-mobile-body"

beforeEach(() => {
  cyclesForTest = []
  issuesForTest = []
  isSyncing = false
})

describe("CyclesMobileBody", () => {
  it("shows the tracker tabs as full-width segments with cycles active", () => {
    render(<CyclesMobileBody />)
    expect(screen.getByTestId("tabs-stub")).toHaveTextContent("cycles")
    expect(screen.getByTestId("tabs-stub")).toHaveAttribute("data-compact", "true")
    expect(screen.getByTestId("cycles-mobile-empty")).toBeInTheDocument()
  })

  it("separates 'not synced yet' from 'no cycles'", () => {
    isSyncing = true
    render(<CyclesMobileBody />)
    expect(screen.getByTestId("cycles-mobile-skeleton")).toBeInTheDocument()
    expect(screen.queryByTestId("cycles-mobile-empty")).not.toBeInTheDocument()
  })

  it("links each cycle to the board planned into it and tallies its issues", () => {
    cyclesForTest = [
      { id: "c1", projectId: "w1", kind: "milestone", name: "v1", status: "planned", startsAt: 0 },
    ]
    issuesForTest = [
      { id: "i1", cycleId: "c1", status: "done", statusCategory: statusCategoryOf("done") },
      { id: "i2", cycleId: "c1", status: "todo", statusCategory: statusCategoryOf("todo") },
    ]
    render(<CyclesMobileBody />)
    expect(screen.getByTestId("cycles-mobile-row-c1")).toHaveAttribute("href", "/issues?cycle=c1")
    expect(screen.getByTestId("cycles-mobile-progress-c1")).toHaveTextContent("cycles.progress:1,2,0,0")
    expect(screen.getByTestId("cycles-mobile-dates-c1")).toBeInTheDocument()
    expect(screen.getByText("cycles.kindLabel.milestone")).toBeInTheDocument()
  })
})
