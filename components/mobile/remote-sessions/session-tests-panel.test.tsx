import { render, screen } from "@testing-library/react"

import { SessionTestsPanel } from "./session-tests-panel"
import type { SessionVerificationsState } from "./use-session-verifications"
import type { RunVerificationSummary } from "@/types/execution/run"

const state = jest.fn()
jest.mock("./use-session-verifications", () => ({
  useSessionVerifications: (...args: unknown[]) => state(...args),
}))

function runWith(verification: RunVerificationSummary, id = "artifact:1") {
  return {
    runId: "run:1",
    title: "Ship the release",
    status: "completed" as const,
    updatedAt: 9,
    verifications: [{ id, title: "Tests", kind: "verification" as const, verification }],
  }
}

function setState(over: Partial<SessionVerificationsState> = {}) {
  state.mockReturnValue({ loading: false, noRuns: false, runs: [], ...over })
}

beforeEach(() => {
  jest.clearAllMocks()
  setState()
})

describe("SessionTestsPanel", () => {
  it("shows a loading line before the mirror answers", () => {
    setState({ loading: true })
    render(<SessionTestsPanel sessionId="s1" />)
    expect(screen.getByText("Loading test results…")).toBeInTheDocument()
  })

  it("distinguishes 'nothing reached this device' from 'no tests were run'", () => {
    setState({ noRuns: true })
    const { unmount } = render(<SessionTestsPanel sessionId="s1" />)
    expect(screen.getByTestId("session-tests-no-runs")).toHaveTextContent("reached this device")
    unmount()

    setState({ noRuns: false, runs: [] })
    render(<SessionTestsPanel sessionId="s1" />)
    expect(screen.getByTestId("session-tests-none")).toHaveTextContent("recorded a test run")
  })

  it("renders a passing run with its counts and progress", () => {
    setState({
      runs: [runWith({ conclusion: "passed", passed: 12, failed: 0, skipped: 1, total: 13 })],
    })
    render(<SessionTestsPanel sessionId="s1" />)
    const card = screen.getByTestId("session-test-result")
    expect(card).toHaveAttribute("data-conclusion", "passed")
    expect(screen.getByText("Passed")).toBeInTheDocument()
    expect(screen.getByText("12 passed")).toBeInTheDocument()
    expect(screen.getByText("1 skipped")).toBeInTheDocument()
    expect(screen.getByText("12/13 tests passed")).toBeInTheDocument()
    expect(screen.getByText("Ship the release")).toBeInTheDocument()
  })

  it("shows the failure count on a failing run", () => {
    setState({
      runs: [runWith({ conclusion: "failed", passed: 8, failed: 2, skipped: 0, total: 10 })],
    })
    render(<SessionTestsPanel sessionId="s1" />)
    expect(screen.getByTestId("session-test-result")).toHaveAttribute("data-conclusion", "failed")
    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.getByText("2 failed")).toBeInTheDocument()
  })

  it("hides zero counts rather than listing them", () => {
    setState({
      runs: [runWith({ conclusion: "passed", passed: 5, failed: 0, skipped: 0, total: 5 })],
    })
    render(<SessionTestsPanel sessionId="s1" />)
    expect(screen.queryByText("0 failed")).not.toBeInTheDocument()
    expect(screen.queryByText("0 skipped")).not.toBeInTheDocument()
  })

  it("never renders an inconclusive run as a green zero", () => {
    // The vendored default would have shown "0 passed" in green here, which is
    // the exact silent-green outcome the verification summary exists to avoid.
    setState({
      runs: [runWith({ conclusion: "inconclusive", passed: 0, failed: 0, skipped: 0, total: 0 })],
    })
    render(<SessionTestsPanel sessionId="s1" />)
    expect(screen.getByTestId("session-test-result")).toHaveAttribute(
      "data-conclusion",
      "inconclusive"
    )
    expect(screen.getByText("Inconclusive")).toBeInTheDocument()
    expect(screen.getByTestId("session-test-inconclusive")).toHaveTextContent("could not be parsed")
    expect(screen.queryByText("0 passed")).not.toBeInTheDocument()
    expect(screen.queryByText(/tests passed/)).not.toBeInTheDocument()
  })

  it("omits the progress bar when the run reported no tests at all", () => {
    // Guards a divide-by-zero in the vendored progress component.
    setState({
      runs: [runWith({ conclusion: "passed", passed: 0, failed: 0, skipped: 0, total: 0 })],
    })
    render(<SessionTestsPanel sessionId="s1" />)
    expect(screen.queryByText(/tests passed/)).not.toBeInTheDocument()
  })

  it("groups several verifications under their run", () => {
    setState({
      runs: [
        {
          ...runWith({ conclusion: "passed", passed: 1, failed: 0, skipped: 0, total: 1 }),
          verifications: [
            {
              id: "a",
              title: "Tests",
              kind: "verification" as const,
              verification: { conclusion: "passed", passed: 1, failed: 0, skipped: 0, total: 1 },
            },
            {
              id: "b",
              title: "Tests",
              kind: "verification" as const,
              verification: { conclusion: "failed", passed: 0, failed: 1, skipped: 0, total: 1 },
            },
          ],
        },
      ],
    })
    render(<SessionTestsPanel sessionId="s1" />)
    expect(screen.getAllByTestId("session-test-result")).toHaveLength(2)
    expect(screen.getAllByText("Ship the release")).toHaveLength(1)
  })
})
