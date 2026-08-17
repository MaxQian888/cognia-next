/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/components/ui/tooltip")

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
    source: "ai-run",
  }
}

let mockJob: OutboundJobRow | undefined = undefined
let mockLatestJob: OutboundJobRow | null = null

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockJob),
}))

// The conversationKey mode resolves the newest job through this hook; mock
// it so both addressing modes are independently controllable.
const mockUseLatestOutboundJob = jest.fn((_key: string | null | undefined) => mockLatestJob)
jest.mock("@/hooks/connectors/use-latest-outbound-job", () => ({
  useLatestOutboundJob: (key: string | null | undefined) => mockUseLatestOutboundJob(key),
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
    mockLatestJob = null
    mockUseLatestOutboundJob.mockClear()
    mockDbUpdate.mockReset().mockResolvedValue(1)
  })

  describe("conversationKey mode (newest job of a conversation)", () => {
    it("renders nothing when the conversation has no outbound job", () => {
      mockLatestJob = null
      const { container } = render(<OutboundStatusPill conversationKey="ck1" />)
      expect(container.firstChild).toBeNull()
      expect(mockUseLatestOutboundJob).toHaveBeenCalledWith("ck1")
    })

    it("renders the newest job's status and retries by that job's id", async () => {
      mockLatestJob = makeJob("latest-1", "failed")
      render(<OutboundStatusPill conversationKey="ck1" />)
      const pill = screen.getByTestId("outbound-status-pill-latest-1")
      expect(pill).toHaveAttribute("data-status", "failed")
      fireEvent.click(screen.getByTestId("outbound-retry-btn-latest-1"))
      await waitFor(() => {
        expect(mockDbUpdate).toHaveBeenCalledWith(
          "latest-1",
          expect.objectContaining({ status: "pending" })
        )
      })
    })

    it("does not consult the by-id query and jobId mode ignores the latest job", () => {
      // jobId mode: the conversation hook is passed null and the by-id row wins.
      mockLatestJob = makeJob("latest-2", "deadlettered")
      mockJob = makeJob("byid", "sent")
      render(<OutboundStatusPill jobId="byid" />)
      expect(screen.getByTestId("outbound-status-pill-byid")).toHaveAttribute("data-status", "sent")
      expect(screen.queryByTestId("outbound-status-pill-latest-2")).not.toBeInTheDocument()
      expect(mockUseLatestOutboundJob).toHaveBeenCalledWith(null)
    })
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

  it("renders ambiguous delivery as unknown without offering an unsafe retry", () => {
    mockJob = makeJob("j-unknown", "delivery_unknown")
    render(<OutboundStatusPill jobId="j-unknown" />)
    expect(screen.getByTestId("outbound-status-pill-j-unknown")).toHaveAttribute(
      "data-status",
      "delivery_unknown"
    )
    expect(screen.queryByTestId("outbound-retry-btn-j-unknown")).not.toBeInTheDocument()
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

  // ADR-0009 v41 / E2 — provenance badge next to the status pill.
  describe("OutboundSourceBadge (v41 / E2)", () => {
    it("renders nothing for the dominant source=ai-run path", () => {
      mockJob = { ...makeJob("ar", "sent"), source: "ai-run" }
      render(<OutboundStatusPill jobId="ar" />)
      expect(screen.queryByTestId("outbound-source-badge-ar")).not.toBeInTheDocument()
    })

    it("renders Workflow badge with click-to-jump link when source=workflow", () => {
      mockJob = {
        ...makeJob("wf", "sent"),
        source: "workflow",
        sourceWorkflow: { workflowId: "wf_42", runId: "run_7", nodeId: "n_send_3" },
      }
      render(<OutboundStatusPill jobId="wf" />)
      const badge = screen.getByTestId("outbound-source-badge-wf")
      expect(badge).toHaveAttribute("data-source", "workflow")
      expect(badge.tagName).toBe("A")
      expect(badge).toHaveAttribute("href", "/workflows/run?id=wf_42&runId=run_7#node-n_send_3")
    })

    it("renders Manual badge when source=manual", () => {
      mockJob = { ...makeJob("mn", "sent"), source: "manual" }
      render(<OutboundStatusPill jobId="mn" />)
      const badge = screen.getByTestId("outbound-source-badge-mn")
      expect(badge).toHaveAttribute("data-source", "manual")
    })

    it("renders Draft-approved badge when source=draft-approved", () => {
      mockJob = { ...makeJob("dr", "sent"), source: "draft-approved" }
      render(<OutboundStatusPill jobId="dr" />)
      const badge = screen.getByTestId("outbound-source-badge-dr")
      expect(badge).toHaveAttribute("data-source", "draft-approved")
    })

    it("renders Skill badge when source=skill (im.* chat-management sends)", () => {
      mockJob = { ...makeJob("sk", "sent"), source: "skill" }
      render(<OutboundStatusPill jobId="sk" />)
      const badge = screen.getByTestId("outbound-source-badge-sk")
      expect(badge).toHaveAttribute("data-source", "skill")
    })

    it("renders Plugin badge when source=plugin (ctx.connectors.enqueueSend)", () => {
      mockJob = { ...makeJob("pl", "sent"), source: "plugin" }
      render(<OutboundStatusPill jobId="pl" />)
      const badge = screen.getByTestId("outbound-source-badge-pl")
      expect(badge).toHaveAttribute("data-source", "plugin")
    })

    it("omits the workflow badge when source=workflow but sourceWorkflow is missing", () => {
      mockJob = { ...makeJob("wfo", "sent"), source: "workflow" }
      render(<OutboundStatusPill jobId="wfo" />)
      // Missing sourceWorkflow → cannot render a click-to-jump → render nothing.
      expect(screen.queryByTestId("outbound-source-badge-wfo")).not.toBeInTheDocument()
    })
  })
})
