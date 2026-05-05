/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { OutboundJobRow } from "@/lib/db/connector-types"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbUpdate = jest.fn().mockResolvedValue(undefined)
const mockDbDelete = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    outboundQueue: {
      orderBy: jest.fn().mockReturnThis(),
      reverse: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
      update: mockDbUpdate,
      delete: mockDbDelete,
    },
  })),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { OutboundTab } from "./outbound-tab"

const now = Date.now()

const pendingJob: OutboundJobRow = {
  id: "job-pending",
  adapterId: "a1",
  conversationKey: "telegram:a1:12345",
  request: { conversationRef: {}, segments: [] } as unknown as OutboundJobRow["request"],
  status: "pending",
  attempts: 0,
  createdAt: now - 5000,
  nextAttemptAt: now + 5000,
  idempotencyKey: "idem-1",
}

const failedJob: OutboundJobRow = {
  id: "job-failed",
  adapterId: "a1",
  conversationKey: "telegram:a1:99999",
  request: { conversationRef: {}, segments: [] } as unknown as OutboundJobRow["request"],
  status: "failed",
  attempts: 3,
  lastError: "timeout",
  createdAt: now - 30000,
  nextAttemptAt: now + 60000,
  idempotencyKey: "idem-2",
}

const sentJob: OutboundJobRow = {
  id: "job-sent",
  adapterId: "a2",
  conversationKey: "discord:a2:77777",
  request: { conversationRef: {}, segments: [] } as unknown as OutboundJobRow["request"],
  status: "sent",
  attempts: 1,
  createdAt: now - 10000,
  nextAttemptAt: now - 5000,
  idempotencyKey: "idem-3",
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUseLiveQuery.mockReturnValue([pendingJob, failedJob, sentJob] as unknown as ReturnType<
    typeof useLiveQuery
  >)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OutboundTab", () => {
  it("renders all jobs by default (no filter)", () => {
    render(<OutboundTab />)
    expect(screen.getByText("telegram:a1:12345")).toBeInTheDocument()
    expect(screen.getByText("telegram:a1:99999")).toBeInTheDocument()
    expect(screen.getByText("discord:a2:77777")).toBeInTheDocument()
  })

  it("shows empty state when no jobs", () => {
    mockUseLiveQuery.mockReturnValue([] as unknown as ReturnType<typeof useLiveQuery>)
    render(<OutboundTab />)
    expect(screen.getByText(/no outbound jobs in flight/i)).toBeInTheDocument()
  })

  it("renders status filter chips for all statuses", () => {
    render(<OutboundTab />)
    const statuses = ["pending", "sending", "sent", "failed", "deadlettered"]
    for (const s of statuses) {
      expect(
        screen.getByRole("button", { name: new RegExp(`filter ${s}`, "i") })
      ).toBeInTheDocument()
    }
  })

  it("renders status badges for each job", () => {
    render(<OutboundTab />)
    // "pending"/"failed"/"sent" each appear in both the filter chip and the job badge
    expect(screen.getAllByText("pending").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("failed").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("sent").length).toBeGreaterThanOrEqual(2)
  })

  it("renders Retry button for failed jobs", () => {
    render(<OutboundTab />)
    expect(screen.getByRole("button", { name: /retry job-failed/i })).toBeInTheDocument()
  })

  it("does not render Retry button for pending jobs", () => {
    render(<OutboundTab />)
    expect(screen.queryByRole("button", { name: /retry job-pending/i })).not.toBeInTheDocument()
  })

  it("renders Cancel button for pending jobs", () => {
    render(<OutboundTab />)
    expect(screen.getByRole("button", { name: /cancel job-pending/i })).toBeInTheDocument()
  })

  it("does not render Cancel button for sent jobs", () => {
    render(<OutboundTab />)
    expect(screen.queryByRole("button", { name: /cancel job-sent/i })).not.toBeInTheDocument()
  })

  it("clicking Retry sets job status back to pending", async () => {
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /retry job-failed/i }))
    await waitFor(() => {
      expect(mockDbUpdate).toHaveBeenCalledWith(
        "job-failed",
        expect.objectContaining({ status: "pending" })
      )
    })
  })

  it("clicking Cancel deletes the job", async () => {
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /cancel job-pending/i }))
    await waitFor(() => {
      expect(mockDbDelete).toHaveBeenCalledWith("job-pending")
    })
  })

  it("filters to only pending jobs when 'pending' filter is pressed", async () => {
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /filter pending/i }))
    await waitFor(() => {
      expect(screen.getByText("telegram:a1:12345")).toBeInTheDocument()
      expect(screen.queryByText("telegram:a1:99999")).not.toBeInTheDocument()
      expect(screen.queryByText("discord:a2:77777")).not.toBeInTheDocument()
    })
  })
})
