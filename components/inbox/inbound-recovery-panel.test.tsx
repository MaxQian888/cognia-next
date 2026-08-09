/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const mockContinue = jest.fn(async (_id: string) => ({ resumed: true as const }))
const mockRetry = jest.fn(async (_id: string, _options: { confirmed: boolean }) => true)
const mockDismiss = jest.fn(async (_id: string) => true)
const mockResume = jest.fn(async () => ({ resumed: 1, recoveryRequired: 0 }))

jest.mock("@/lib/db/connector-inbound-jobs", () => ({
  retryConnectorInboundJobFromStart: (id: string, options: { confirmed: boolean }) =>
    mockRetry(id, options),
  dismissConnectorInboundJobRecovery: (id: string) => mockDismiss(id),
}))
jest.mock("@/lib/ai/agent/recovery/reconcile-crashed-runs", () => ({
  resumeCrashedAgentRun: (id: string) => mockContinue(id),
}))
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({ resumeDurableInboundJobs: mockResume }),
}))

import { InboundRecoveryNotice, type InboundRecoveryNoticeProps } from "./inbound-recovery-panel"

type Job = InboundRecoveryNoticeProps["jobs"][number]

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    sourceMessageId: "om-1",
    recoveryReason: "lease_expired",
    executionRunId: "run-1",
    ...overrides,
  } as Job
}

// The recovery-job query lives in `useInboundRecoveryJobs` and is pinned by its
// own suite; this component is handed the jobs to present.
describe("InboundRecoveryNotice", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders nothing when no job needs recovery", () => {
    const { container } = render(<InboundRecoveryNotice jobs={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("offers safe continuation and resumes durable work", async () => {
    render(<InboundRecoveryNotice jobs={[job()]} />)
    fireEvent.click(screen.getByRole("button", { name: "Continue safely" }))
    await waitFor(() => expect(mockContinue).toHaveBeenCalledWith("run-1"))
    expect(mockResume).toHaveBeenCalledWith()
  })

  it("warns before a full retry and replays once confirmed", async () => {
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true)
    render(<InboundRecoveryNotice jobs={[job()]} />)
    fireEvent.click(screen.getByRole("button", { name: "Retry from start" }))
    await waitFor(() => expect(mockRetry).toHaveBeenCalledWith("job-1", { confirmed: true }))
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/repeat.*side effects/i))
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith())
    confirm.mockRestore()
  })

  it("dismisses without replaying the inbound job", async () => {
    render(<InboundRecoveryNotice jobs={[job()]} />)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith("job-1"))
    // Dismissing is a local decision — it must not re-run the job's effects.
    expect(mockResume).not.toHaveBeenCalled()
  })

  it("declining the retry warning leaves the job untouched", () => {
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false)
    render(<InboundRecoveryNotice jobs={[job()]} />)
    fireEvent.click(screen.getByRole("button", { name: "Retry from start" }))
    expect(mockRetry).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it("skips the durable resume when the job did not actually change", async () => {
    mockContinue.mockResolvedValueOnce({ resumed: false, reason: "missing-anchor" } as never)
    render(<InboundRecoveryNotice jobs={[job()]} />)
    fireEvent.click(screen.getByRole("button", { name: "Continue safely" }))
    await waitFor(() => expect(mockContinue).toHaveBeenCalled())
    expect(mockResume).not.toHaveBeenCalled()
  })

  it("falls back to an unknown reason when the job carries none", () => {
    render(<InboundRecoveryNotice jobs={[job({ recoveryReason: undefined })]} />)
    expect(screen.getByTestId("inbound-recovery-panel")).toBeInTheDocument()
  })
})
