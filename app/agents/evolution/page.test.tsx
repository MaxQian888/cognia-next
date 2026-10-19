/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import { makeRun } from "@/lib/harness/test-fixtures"

let mockQuery = "run=run-1"
const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockQuery),
  useRouter: () => ({ push: mockPush }),
}))
let mockRun: HarnessEvolutionRun | null | undefined
jest.mock("@/hooks/harness/use-harness-data", () => ({ useHarnessRun: () => mockRun }))
let mockViewerProps: { runId: string; onOpenExperience: (id: string) => void } | undefined
jest.mock("@/components/harness/harness-run-viewer", () => ({
  HarnessRunViewer: (props: NonNullable<typeof mockViewerProps>) => {
    mockViewerProps = props
    return <div data-testid="viewer-probe" />
  },
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

import HarnessRunPage from "./page"
import MobileRouteBody from "./route-body.mobile"

beforeEach(() => {
  mockQuery = "run=run-1"
  mockRun = makeRun({ id: "run-1", characterId: "agent-1", characterName: "Analyst" })
  mockPush.mockReset()
  mockViewerProps = undefined
})

describe("/agents/evolution", () => {
  it("shows the run from the query string, with a way back to its agent", () => {
    render(<HarnessRunPage />)
    expect(mockViewerProps?.runId).toBe("run-1")
    expect(screen.getByText("Back to Analyst").closest("a")).toHaveAttribute(
      "href",
      "/agents?id=agent-1&mode=evolve"
    )
    mockViewerProps?.onOpenExperience("exp-1")
    expect(mockPush).toHaveBeenCalledWith("/agents?id=agent-1&mode=evolve")
  })

  it("asks for a run when none is named", () => {
    mockQuery = ""
    mockRun = null
    render(<HarnessRunPage />)
    expect(screen.getByText("No run selected")).toBeInTheDocument()
    expect(screen.getByText("Back to agents").closest("a")).toHaveAttribute("href", "/agents")
  })

  it("points the phone build at the desktop", () => {
    render(<MobileRouteBody runId="run-1" />)
    expect(screen.getByTestId("harness-run-page-mobile")).toHaveTextContent(
      "Runs live on the desktop"
    )
  })
})
