/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { MobileActiveRunsCard } from "./mobile-active-runs-card"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { MobileHomeLayout } from "@/types/shell/mobile-home"
import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const runsRef: { current: WorkflowRunRow[] } = { current: [] }
const workflowsRef: { current: WorkflowRow[] } = { current: [] }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => unknown) => {
    const src = query.toString()
    if (src.includes("workflowRuns")) return runsRef.current
    if (src.includes("listWorkflows")) return workflowsRef.current
    return undefined
  },
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn(() => ({})) }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn() }))

const saveMock = jest.fn(async () => {})

function setLayout(layout: MobileHomeLayout) {
  useSettingsStore.setState({
    settings: { mobileHomeLayout: layout } as never,
    save: saveMock as never,
  })
}

function run(id: string, workflowId: string, startedAt: number): WorkflowRunRow {
  return { id, workflowId, status: "running", startedAt } as WorkflowRunRow
}

beforeEach(() => {
  runsRef.current = []
  workflowsRef.current = []
  saveMock.mockClear()
  setLayout({ quickActions: ["newChat"], hiddenSections: [] })
})

describe("MobileActiveRunsCard", () => {
  it("renders nothing when no workflow is running", () => {
    const { container } = render(<MobileActiveRunsCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when the activeRuns section is hidden", () => {
    runsRef.current = [run("r1", "wf-1", 100)]
    setLayout({ quickActions: ["newChat"], hiddenSections: ["activeRuns"] })
    const { container } = render(<MobileActiveRunsCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a count and the most-recent running workflow name", () => {
    runsRef.current = [run("r1", "wf-1", 100), run("r2", "wf-2", 300)]
    workflowsRef.current = [
      { id: "wf-1", name: "Nightly" } as WorkflowRow,
      { id: "wf-2", name: "Deploy" } as WorkflowRow,
    ]
    render(<MobileActiveRunsCard />)
    // Plural title with count = 2.
    expect(screen.getByText('title:{"count":2}')).toBeInTheDocument()
    // Latest (highest startedAt) is wf-2 → "Deploy".
    expect(screen.getByText("Deploy")).toBeInTheDocument()
    // Card links to the latest run's runs view.
    expect(screen.getByTestId("mobile-active-runs-card")).toHaveAttribute(
      "href",
      "/workflows/runs?id=wf-2"
    )
  })

  it("falls back to the workflow id when the name is unknown", () => {
    runsRef.current = [run("r1", "wf-unknown", 100)]
    render(<MobileActiveRunsCard />)
    expect(screen.getByText("wf-unknown")).toBeInTheDocument()
  })

  // The section had no dismiss at all, which is what made the mobile home read
  // as a wall: every other welcome block can be turned off in place.
  it("hides the section from the dismiss control", () => {
    runsRef.current = [run("r1", "wf-1", 100)]
    render(<MobileActiveRunsCard />)
    fireEvent.click(screen.getByTestId("mobile-active-runs-dismiss"))
    expect(saveMock).toHaveBeenCalledWith({
      mobileHomeLayout: { quickActions: ["newChat"], hiddenSections: ["activeRuns"] },
    })
  })

  // A <button> nested inside an <a> is invalid markup and the tap would race
  // the link's own navigation.
  it("keeps the dismiss outside the navigating link", () => {
    runsRef.current = [run("r1", "wf-1", 100)]
    render(<MobileActiveRunsCard />)
    const link = screen.getByTestId("mobile-active-runs-card")
    expect(link.contains(screen.getByTestId("mobile-active-runs-dismiss"))).toBe(false)
  })
})
