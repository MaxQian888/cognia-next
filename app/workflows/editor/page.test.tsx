import { render, screen, waitFor } from "@testing-library/react"
import { Component, type ReactNode } from "react"
import WorkflowEditorPage from "./page"

const mockGet = jest.fn()
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND")
})
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
  notFound: () => mockNotFound(),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "desktop" }))
jest.mock("@/lib/db/workflows", () => ({ getWorkflow: jest.fn() }))
jest.mock("@/components/workflow/editor/canvas", () => ({
  WorkflowEditorCanvas: ({ workflow }: { workflow: { id: string } }) => (
    <div data-testid="canvas">{workflow.id}</div>
  ),
}))
jest.mock("@/components/mobile/workflow/editor/mobile-workflow-editor", () => ({
  MobileWorkflowEditor: () => <div data-testid="mobile-editor" />,
}))

import { getWorkflow } from "@/lib/db/workflows"

// Catches the synchronous throw that `notFound()` performs during the
// effect-triggered re-render, so the test can assert it fired without the
// whole render tearing down the test.
class Boundary extends Component<{ children: ReactNode }, { errored: boolean }> {
  state = { errored: false }
  static getDerivedStateFromError() {
    return { errored: true }
  }
  render() {
    return this.state.errored ? <div data-testid="boundary" /> : this.props.children
  }
}

beforeEach(() => jest.clearAllMocks())

test("renders the canvas for the workflow id from ?id=", async () => {
  mockGet.mockReturnValue("wf-123")
  ;(getWorkflow as jest.Mock).mockResolvedValue({ id: "wf-123", name: "X" })
  render(<WorkflowEditorPage />)
  await waitFor(() => expect(screen.getByTestId("canvas")).toHaveTextContent("wf-123"))
  expect(getWorkflow).toHaveBeenCalledWith("wf-123")
})

test("calls notFound when the workflow does not exist", async () => {
  mockGet.mockReturnValue("missing")
  ;(getWorkflow as jest.Mock).mockResolvedValue(undefined)
  render(
    <Boundary>
      <WorkflowEditorPage />
    </Boundary>
  )
  await waitFor(() => expect(mockNotFound).toHaveBeenCalled())
})

test("calls notFound when ?id= is absent and never queries Dexie", async () => {
  mockGet.mockReturnValue(null)
  render(
    <Boundary>
      <WorkflowEditorPage />
    </Boundary>
  )
  await waitFor(() => expect(mockNotFound).toHaveBeenCalled())
  expect(getWorkflow).not.toHaveBeenCalled()
})
