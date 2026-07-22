/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const mockUseLiveQuery = jest.fn()
const mockContinue = jest.fn(async () => true)
const mockRetry = jest.fn(async () => true)
const mockDismiss = jest.fn(async () => true)
const mockResume = jest.fn(async () => ({ resumed: 1, recoveryRequired: 0 }))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => mockUseLiveQuery(...args),
}))
jest.mock("@/lib/db/connector-inbound-jobs", () => ({
  continueConnectorInboundJobSafely: (...args: unknown[]) => mockContinue(...args),
  retryConnectorInboundJobFromStart: (...args: unknown[]) => mockRetry(...args),
  dismissConnectorInboundJobRecovery: (...args: unknown[]) => mockDismiss(...args),
}))
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({ resumeDurableInboundJobs: mockResume }),
}))

import { InboundRecoveryPanel } from "./inbound-recovery-panel"

describe("InboundRecoveryPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUseLiveQuery.mockReturnValue([
      { id: "job-1", sourceMessageId: "om-1", recoveryReason: "lease_expired" },
    ])
  })

  it("offers safe continuation and resumes durable work", async () => {
    render(<InboundRecoveryPanel conversationKey="opaque" />)
    fireEvent.click(screen.getByRole("button", { name: "Continue safely" }))
    await waitFor(() => expect(mockContinue).toHaveBeenCalledWith("job-1"))
    expect(mockResume).toHaveBeenCalled()
  })

  it("warns before a full retry and supports dismiss without replay", async () => {
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true)
    render(<InboundRecoveryPanel conversationKey="opaque" />)
    fireEvent.click(screen.getByRole("button", { name: "Retry from start" }))
    await waitFor(() => expect(mockRetry).toHaveBeenCalledWith("job-1", { confirmed: true }))
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/repeat.*side effects/i))

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith("job-1"))
    confirm.mockRestore()
  })
})
