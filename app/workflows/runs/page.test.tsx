import { render, screen } from "@testing-library/react"
import { Component, type ReactNode } from "react"
import WorkflowRunsPage from "./page"

const mockGet = jest.fn()
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND")
})
let platform = "desktop"
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
  notFound: () => mockNotFound(),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }))
jest.mock("@/components/workflow/runs/run-list", () => ({
  RunList: ({ workflowId }: { workflowId: string }) => (
    <div data-testid="run-list">{workflowId}</div>
  ),
}))
jest.mock("@/components/mobile/workflow/mobile-runs-list", () => ({
  MobileRunsList: ({ workflowId }: { workflowId: string }) => (
    <div data-testid="mobile-runs-list">{workflowId}</div>
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
  platform = "desktop"
})

test("passes ?id= through to the desktop runs list", () => {
  mockGet.mockReturnValue("wf-9")
  render(<WorkflowRunsPage />)
  expect(screen.getByTestId("run-list")).toHaveTextContent("wf-9")
})

test("renders the mobile runs list on mobile", () => {
  platform = "mobile"
  mockGet.mockReturnValue("wf-9")
  render(<WorkflowRunsPage />)
  expect(screen.getByTestId("mobile-runs-list")).toHaveTextContent("wf-9")
})

test("calls notFound when ?id= is absent", () => {
  mockGet.mockReturnValue(null)
  render(
    <Boundary>
      <WorkflowRunsPage />
    </Boundary>
  )
  expect(mockNotFound).toHaveBeenCalled()
})
