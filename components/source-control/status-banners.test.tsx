import { act, fireEvent, render, screen } from "@testing-library/react"
import { useGitStore } from "@/stores/git/git-store"
import { SequencerBanner, StaleStatusBanner, WriteUnavailableBanner } from "./status-banners"

let mockWriteVerdict: { available: boolean; reason: string | null } = {
  available: true,
  reason: null,
}
const mockGate = jest.fn((_command: string) => mockWriteVerdict)
jest.mock("@/hooks/workspace/use-workspace-command-gate", () => ({
  useWorkspaceCommandGate: () => mockGate,
}))

function sequencerActions(available = true) {
  return {
    sequencerContinue: jest.fn(() => Promise.resolve(null)),
    sequencerAbort: jest.fn(() => Promise.resolve(null)),
    can: jest.fn(() => available),
  }
}

beforeEach(() => {
  act(() => useGitStore.getState().setOp("sequence", false))
})

describe("SequencerBanner", () => {
  it("renders nothing while no operation is in progress", () => {
    render(<SequencerBanner operation={null} actions={sequencerActions()} />)
    expect(screen.queryByTestId("sequencer-banner")).not.toBeInTheDocument()
  })

  it("names the operation and wires continue and abort", () => {
    const actions = sequencerActions()
    render(<SequencerBanner operation="rebase" actions={actions} />)
    expect(screen.getByTestId("sequencer-banner")).toHaveTextContent(/Rebase in progress/)
    fireEvent.click(screen.getByTestId("sequencer-continue"))
    fireEvent.click(screen.getByTestId("sequencer-abort"))
    expect(actions.sequencerContinue).toHaveBeenCalledTimes(1)
    expect(actions.sequencerAbort).toHaveBeenCalledTimes(1)
  })

  it("disables both while a sequencer step is running", () => {
    act(() => useGitStore.getState().setOp("sequence", true))
    render(<SequencerBanner operation="merge" actions={sequencerActions()} />)
    expect(screen.getByTestId("sequencer-continue")).toBeDisabled()
    expect(screen.getByTestId("sequencer-abort")).toBeDisabled()
  })

  it("disables both when the host does not offer the commands", () => {
    render(<SequencerBanner operation="merge" actions={sequencerActions(false)} />)
    expect(screen.getByTestId("sequencer-continue")).toBeDisabled()
    expect(screen.getByTestId("sequencer-abort")).toBeDisabled()
  })

  it("treats a host without a capability probe as offering both commands", () => {
    const { can: _can, ...withoutProbe } = sequencerActions()
    render(<SequencerBanner operation="cherryPick" actions={withoutProbe} />)
    expect(screen.getByTestId("sequencer-continue")).toBeEnabled()
    expect(screen.getByTestId("sequencer-abort")).toBeEnabled()
  })

  it("shows a spinner on continue while a sequencer step is running", () => {
    act(() => useGitStore.getState().setOp("sequence", true))
    render(<SequencerBanner operation="merge" actions={sequencerActions()} />)
    expect(
      screen.getByTestId("sequencer-continue").querySelector("[role='status'], svg")
    ).not.toBeNull()
  })

  it("grows its buttons to touch size on a phone", () => {
    render(<SequencerBanner operation="revert" actions={sequencerActions()} density="touch" />)
    expect(screen.getByTestId("sequencer-continue").className).toMatch(/\bh-9\b/)
  })
})

describe("StaleStatusBanner", () => {
  it("renders nothing while the snapshot is current", () => {
    render(<StaleStatusBanner message={null} onRetry={() => {}} />)
    expect(screen.queryByTestId("sc-load-error-banner")).not.toBeInTheDocument()
  })

  it("says the list is stale, with the failure, and retries", () => {
    const onRetry = jest.fn()
    render(<StaleStatusBanner message="index.lock exists" onRetry={onRetry} />)
    expect(screen.getByTestId("sc-load-error-banner")).toHaveTextContent(/index\.lock exists/)
    fireEvent.click(screen.getByTestId("sc-load-error-retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe("WriteUnavailableBanner", () => {
  beforeEach(() => {
    mockWriteVerdict = { available: true, reason: null }
    mockGate.mockClear()
  })

  it("stays out of the way while git writes are allowed", () => {
    render(<WriteUnavailableBanner />)
    expect(screen.queryByTestId("sc-write-unavailable-banner")).toBeNull()
  })

  it("says once why every write control is disabled", () => {
    // Pull, Push, Commit and Stash all gate on the same grant and lease, so
    // the phone greyed out its whole toolbar with no word of why.
    mockWriteVerdict = {
      available: false,
      reason: "This device is missing the Remote control permission.",
    }
    render(<WriteUnavailableBanner density="touch" />)
    expect(screen.getByTestId("sc-write-unavailable-banner")).toHaveTextContent(
      "This device is missing the Remote control permission."
    )
    expect(mockGate).toHaveBeenCalledWith("git_commit")
  })
})
