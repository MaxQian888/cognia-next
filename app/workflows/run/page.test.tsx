import { render, screen } from "@testing-library/react"
import { Component, type ReactNode } from "react"
import WorkflowRunPage from "./page"

const params: Record<string, string | null> = {}
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND")
})
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (k: string) => params[k] ?? null }),
  notFound: () => mockNotFound(),
}))
jest.mock("@/components/workflow/runs/run-detail", () => ({
  RunDetail: ({ workflowId, runId }: { workflowId: string; runId: string }) => (
    <div data-testid="run-detail">{`${workflowId}/${runId}`}</div>
  ),
}))

class Boundary extends Component<{ children: ReactNode }, { errored: boolean }> {
  state = { errored: false }
  static getDerivedStateFromError() {
    return { errored: true }
  }
  render() {
    return this.state.errored ? <div data-testid="boundary" /> : this.props.children
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  params.id = undefined as unknown as string
  params.runId = undefined as unknown as string
})

test("passes ?id= and ?runId= through to run detail", () => {
  params.id = "wf-1"
  params.runId = "run-7"
  render(<WorkflowRunPage />)
  expect(screen.getByTestId("run-detail")).toHaveTextContent("wf-1/run-7")
})

test("calls notFound when ?id= or ?runId= is missing", () => {
  params.id = "wf-1"
  params.runId = null
  render(
    <Boundary>
      <WorkflowRunPage />
    </Boundary>
  )
  expect(mockNotFound).toHaveBeenCalled()
})
