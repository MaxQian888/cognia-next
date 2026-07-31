import { render, screen } from "@testing-library/react"
import AgentRunsPage from "./page"

const replace = jest.fn()
let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}))

let lastProps: Record<string, unknown> = {}
jest.mock("@/components/agent-runs/agent-runs-panel", () => ({
  AgentRunsPanel: (props: Record<string, unknown>) => {
    lastProps = props
    return <div data-testid="panel">panel</div>
  },
}))

beforeEach(() => {
  replace.mockReset()
  searchParams = new URLSearchParams()
  lastProps = {}
})

describe("AgentRunsPage", () => {
  it("renders the panel inside a Suspense boundary", () => {
    render(<AgentRunsPage />)
    expect(screen.getByTestId("panel")).toBeInTheDocument()
  })

  it("passes the ?run= + ?kind= params through to the panel", () => {
    searchParams = new URLSearchParams("run=goal:g1&kind=team")
    render(<AgentRunsPage />)
    expect(lastProps.selectedId).toBe("goal:g1")
    expect(lastProps.filterKind).toBe("team")
  })

  it("writes ?run= when a run is selected", () => {
    render(<AgentRunsPage />)
    ;(lastProps.onSelect as (id: string | null) => void)("plan:p1")
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("run=plan%3Ap1"))
  })

  it("drops ?kind= when the filter resets to all", () => {
    searchParams = new URLSearchParams("kind=goal")
    render(<AgentRunsPage />)
    ;(lastProps.onFilterKind as (k: string) => void)("all")
    expect(replace).toHaveBeenCalledWith(expect.not.stringContaining("kind="))
  })
})
