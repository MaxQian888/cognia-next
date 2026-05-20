/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type {
  AdapterInstanceRow,
  ConnectorAuditRow,
  OutboundJobRow,
} from "@/lib/db/connector-types"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbUpdate = jest.fn().mockResolvedValue(undefined)
const mockDbDelete = jest.fn().mockResolvedValue(undefined)
const mockBulkModify = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    outboundQueue: {
      orderBy: jest.fn().mockReturnThis(),
      reverse: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
      update: mockDbUpdate,
      delete: mockDbDelete,
      where: jest.fn().mockReturnValue({
        anyOf: jest.fn().mockReturnValue({ modify: mockBulkModify }),
      }),
    },
    adapterInstances: {
      toArray: jest.fn().mockResolvedValue([]),
    },
    connectorAudit: {
      where: jest.fn().mockReturnValue({
        above: jest.fn().mockReturnValue({
          filter: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    },
  })),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

/**
 * `outbound-tab.tsx` calls `useLiveQuery` three times in a fixed order:
 *   1) outboundQueue rows
 *   2) adapterInstances rows
 *   3) connectorAudit heartbeats
 * Drive each one independently from the test.
 */
function setupQueries(opts: {
  jobs: OutboundJobRow[]
  adapters?: AdapterInstanceRow[]
  heartbeats?: ConnectorAuditRow[]
}): void {
  let i = 0
  mockUseLiveQuery.mockImplementation(() => {
    const value = [opts.jobs, opts.adapters ?? [], opts.heartbeats ?? []][i % 3]
    i++
    return value as unknown as ReturnType<typeof useLiveQuery>
  })
}

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
  source: "ai-run",
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
  source: "ai-run",
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
  source: "ai-run",
}

const deadletteredJob: OutboundJobRow = {
  id: "job-dead-1",
  adapterId: "a1",
  conversationKey: "telegram:a1:00001",
  request: { conversationRef: {}, segments: [] } as unknown as OutboundJobRow["request"],
  status: "deadlettered",
  attempts: 5,
  lastError: "circuit_open",
  createdAt: now - 60000,
  nextAttemptAt: now - 50000,
  idempotencyKey: "idem-dead-1",
  source: "ai-run",
}

const deadletteredJob2: OutboundJobRow = {
  ...deadletteredJob,
  id: "job-dead-2",
  conversationKey: "telegram:a1:00002",
  idempotencyKey: "idem-dead-2",
}

function makeAdapter(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "a1",
    type: "telegram",
    displayName: "Test Bot",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { kind: "private_chat" } as unknown as AdapterInstanceRow["trigger"],
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function heartbeatRow(
  adapterId: string,
  fields: Record<string, unknown>,
  at: number = now - 1000
): ConnectorAuditRow {
  return {
    id: `aud-${adapterId}-${at}`,
    adapterId,
    kind: "adapter.heartbeat",
    at,
    fields,
  } as ConnectorAuditRow
}

beforeEach(() => {
  jest.clearAllMocks()
  setupQueries({ jobs: [pendingJob, failedJob, sentJob] })
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
    setupQueries({ jobs: [] })
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

describe("OutboundTab — derived badges (Task 2.2)", () => {
  it("renders the muted badge when the job's adapter is muted", () => {
    setupQueries({
      jobs: [pendingJob],
      adapters: [makeAdapter({ id: "a1", muted: true })],
    })
    render(<OutboundTab />)
    expect(screen.getByTestId("outbound-derived-paused-muted")).toBeInTheDocument()
  })

  it("renders the circuit-blocked badge when the heartbeat reports breaker open", () => {
    setupQueries({
      jobs: [pendingJob],
      adapters: [makeAdapter({ id: "a1" })],
      heartbeats: [heartbeatRow("a1", { breakerState: "open" })],
    })
    render(<OutboundTab />)
    expect(screen.getByTestId("outbound-derived-circuit-blocked")).toBeInTheDocument()
  })

  it("does not surface paused-* badges on sent jobs", () => {
    setupQueries({
      jobs: [sentJob],
      adapters: [makeAdapter({ id: "a2", muted: true })],
    })
    render(<OutboundTab />)
    expect(screen.queryByTestId(/outbound-derived-paused/)).not.toBeInTheDocument()
  })
})

describe("OutboundTab — row expand (Task P2.2) + deadletter age (P2.3)", () => {
  it("hides the detail block by default", () => {
    setupQueries({ jobs: [failedJob] })
    render(<OutboundTab />)
    expect(screen.queryByTestId(`outbound-detail-${failedJob.id}`)).not.toBeInTheDocument()
  })

  it("toggles the detail block when the chevron is clicked", async () => {
    setupQueries({ jobs: [failedJob] })
    render(<OutboundTab />)
    fireEvent.click(screen.getByTestId(`outbound-toggle-${failedJob.id}`))
    await waitFor(() => {
      expect(screen.getByTestId(`outbound-detail-${failedJob.id}`)).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId(`outbound-toggle-${failedJob.id}`))
    await waitFor(() => {
      expect(screen.queryByTestId(`outbound-detail-${failedJob.id}`)).not.toBeInTheDocument()
    })
  })

  it("renders the deadletter age label only for deadlettered jobs", () => {
    setupQueries({ jobs: [deadletteredJob, failedJob, pendingJob] })
    render(<OutboundTab />)
    expect(screen.getByTestId(`outbound-deadletter-age-${deadletteredJob.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`outbound-deadletter-age-${failedJob.id}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`outbound-deadletter-age-${pendingJob.id}`)).not.toBeInTheDocument()
  })

  it("expand shows the lastError + idempotencyKey when present", async () => {
    setupQueries({ jobs: [failedJob] })
    render(<OutboundTab />)
    fireEvent.click(screen.getByTestId(`outbound-toggle-${failedJob.id}`))
    const detail = await screen.findByTestId(`outbound-detail-${failedJob.id}`)
    expect(detail.textContent).toMatch(/timeout/i)
    expect(detail.textContent).toContain("idem-2")
  })
})

describe("OutboundTab — bulk-retry deadlettered (Task 5.2)", () => {
  it("does not show the bulk-retry trigger unless filter is 'deadlettered'", () => {
    setupQueries({ jobs: [deadletteredJob, deadletteredJob2] })
    render(<OutboundTab />)
    expect(screen.queryByTestId("outbound-bulk-retry-trigger")).not.toBeInTheDocument()
  })

  it("shows the bulk-retry trigger when filter is 'deadlettered' with jobs present", async () => {
    setupQueries({ jobs: [deadletteredJob, deadletteredJob2] })
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /filter deadlettered/i }))
    await waitFor(() => {
      expect(screen.getByTestId("outbound-bulk-retry-trigger")).toBeInTheDocument()
    })
  })

  it("calls outboundQueue.where('id').anyOf(ids).modify on confirmation", async () => {
    setupQueries({ jobs: [deadletteredJob, deadletteredJob2] })
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /filter deadlettered/i }))
    await waitFor(() => {
      expect(screen.getByTestId("outbound-bulk-retry-trigger")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("outbound-bulk-retry-trigger"))
    await waitFor(() => {
      expect(screen.getByTestId("outbound-bulk-retry-confirm")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("outbound-bulk-retry-confirm"))
    await waitFor(() => {
      expect(mockBulkModify).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }))
    })
  })
})
