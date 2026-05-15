/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const mockDbUpdate = jest.fn().mockResolvedValue(1)
const mockDbGet = jest.fn()

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    outboundQueue: {
      get: mockDbGet,
      update: mockDbUpdate,
    },
  })),
}))

import type { OutboundJobRow } from "@/lib/db/connector-types"

function makeJob(id: string, status: OutboundJobRow["status"]): OutboundJobRow {
  return {
    id,
    adapterId: "a1",
    conversationKey: "ck1",
    request: {} as OutboundJobRow["request"],
    status,
    attempts: 1,
    lastError: status === "failed" ? "Network error" : undefined,
    createdAt: Date.now(),
    nextAttemptAt: Date.now(),
    idempotencyKey: "idem_1",
  }
}

let mockJob: OutboundJobRow | undefined = undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockJob),
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { OutboundStatusPill } from "./outbound-status-pill"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OutboundStatusPill", () => {
  beforeEach(() => {
    mockJob = undefined
    mockDbUpdate.mockReset().mockResolvedValue(1)
  })

  it("renders nothing when job is not found", () => {
    mockJob = undefined
    const { container } = render(<OutboundStatusPill jobId="j_missing" />)
    expect(container.firstChild).toBeNull()
  })

  it("renders Queued state", () => {
    mockJob = makeJob("j1", "pending")
    render(<OutboundStatusPill jobId="j1" />)
    const pill = screen.getByTestId("outbound-status-pill-j1")
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveAttribute("data-status", "pending")
  })

  it("renders Sending state", () => {
    mockJob = makeJob("j2", "sending")
    render(<OutboundStatusPill jobId="j2" />)
    expect(screen.getByTestId("outbound-status-pill-j2")).toHaveAttribute("data-status", "sending")
  })

  it("renders Sent state", () => {
    mockJob = makeJob("j3", "sent")
    render(<OutboundStatusPill jobId="j3" />)
    expect(screen.getByTestId("outbound-status-pill-j3")).toHaveAttribute("data-status", "sent")
  })

  it("renders Failed state with Retry button", () => {
    mockJob = makeJob("j4", "failed")
    render(<OutboundStatusPill jobId="j4" />)
    expect(screen.getByTestId("outbound-status-pill-j4")).toHaveAttribute("data-status", "failed")
    expect(screen.getByTestId("outbound-retry-btn-j4")).toBeInTheDocument()
  })

  it("renders Dead-lettered state without Retry button", () => {
    mockJob = makeJob("j5", "deadlettered")
    render(<OutboundStatusPill jobId="j5" />)
    expect(screen.getByTestId("outbound-status-pill-j5")).toHaveAttribute(
      "data-status",
      "deadlettered"
    )
    expect(screen.queryByTestId("outbound-retry-btn-j5")).not.toBeInTheDocument()
  })

  it("Retry button resets status to pending", async () => {
    mockJob = makeJob("j6", "failed")
    render(<OutboundStatusPill jobId="j6" />)
    fireEvent.click(screen.getByTestId("outbound-retry-btn-j6"))
    await waitFor(() => {
      expect(mockDbUpdate).toHaveBeenCalledWith(
        "j6",
        expect.objectContaining({ status: "pending" })
      )
    })
  })

  it("renders the localized label for each status", () => {
    // The label appears twice in the DOM: once in the trigger span and once in
    // the TooltipContent. getAllByText collects both occurrences.
    mockJob = makeJob("jq", "pending")
    const { rerender } = render(<OutboundStatusPill jobId="jq" />)
    expect(screen.getAllByText("Queued").length).toBeGreaterThanOrEqual(1)

    mockJob = makeJob("js", "sending")
    rerender(<OutboundStatusPill jobId="js" />)
    expect(screen.getAllByText("Sending").length).toBeGreaterThanOrEqual(1)

    mockJob = makeJob("jd", "deadlettered")
    rerender(<OutboundStatusPill jobId="jd" />)
    // Dead-lettered renders only in the trigger (TooltipContent shows the lastError or unknownError fallback).
    expect(screen.getAllByText("Dead-lettered").length).toBeGreaterThanOrEqual(1)
  })
})
