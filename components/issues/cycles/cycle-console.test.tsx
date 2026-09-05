/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    header,
    children,
  }: {
    header: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}))
let headerProps: Record<string, unknown> = {}
jest.mock("@/components/feature-shell/feature-page-header", () => ({
  FeaturePageHeader: (props: Record<string, unknown>) => {
    headerProps = props
    return (
      <div data-testid="header-stub">
        {props.navigation as React.ReactNode}
        {String(props.summary)}
      </div>
    )
  },
}))
jest.mock("@/components/issues/tracker-tabs", () => ({
  TrackerTabs: ({ active }: { active: string }) => <nav data-testid="tabs-stub">{active}</nav>,
}))
let editorProps: Record<string, unknown> = {}
jest.mock("@/components/issues/cycles/cycle-editor-list", () => ({
  CycleEditorList: (props: Record<string, unknown>) => {
    editorProps = props
    return <div data-testid="editor-stub" />
  },
}))
jest.mock("@/lib/db/issue-cycles", () => ({ listIssueCycles: jest.fn() }))
jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))

let cyclesForTest: unknown[] = []
let issuesForTest: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: unknown) => {
    // Compiled arrows read `(0, _issues.listIssues)(`, so match on the name only.
    const source = String(query)
    if (source.includes("listIssueCycles")) return cyclesForTest
    if (source.includes("listIssueProjects")) return []
    return issuesForTest
  },
}))
let activeProjectId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId }),
}))

import { render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import { CycleConsole } from "./cycle-console"

beforeEach(() => {
  headerProps = {}
  editorProps = {}
  cyclesForTest = []
  issuesForTest = []
  activeProjectId = "w1"
})

describe("CycleConsole", () => {
  it("sits under the tracker tabs with cycles active, and links rows to the board", () => {
    cyclesForTest = [{ id: "c1", projectId: "w1", kind: "cycle", name: "S1", status: "active" }]
    render(<CycleConsole />)
    expect(screen.getByTestId("tabs-stub")).toHaveTextContent("cycles")
    expect(headerProps.navigationPlacement).toBe("inline")
    expect(screen.getByTestId("header-stub")).toHaveTextContent("cycles.summary:1")
    expect(editorProps).toMatchObject({ projectId: "w1", linkToBoard: true })
  })

  it("tallies progress from the issues it already holds", () => {
    cyclesForTest = [{ id: "c1", projectId: "w1", kind: "cycle", name: "S1", status: "active" }]
    issuesForTest = [
      {
        id: "i1",
        cycleId: "c1",
        status: "done",
        statusCategory: statusCategoryOf("done"),
        estimate: 3,
      },
      { id: "i2", cycleId: "c1", status: "todo", statusCategory: statusCategoryOf("todo") },
      { id: "i3", cycleId: "other", status: "todo", statusCategory: statusCategoryOf("todo") },
    ]
    render(<CycleConsole />)
    const progress = editorProps.progress as Map<string, { total: number; done: number }>
    expect(progress.get("c1")).toMatchObject({ total: 2, done: 1 })
  })

  it("explains itself when no workspace is active instead of mounting an editor with nowhere to write", () => {
    activeProjectId = null
    render(<CycleConsole />)
    expect(screen.getByTestId("cycle-console-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("editor-stub")).not.toBeInTheDocument()
  })
})
