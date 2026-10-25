/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastInfo = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (key === "heading") return `${vars?.count as number} waiting`
    return key
  },
}))

const mockCall = jest.fn()
const subscriptions = new Map<string, (payload: unknown) => void>()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: {
    call: (...a: unknown[]) => mockCall(...a),
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      subscriptions.set(event, handler)
      return () => subscriptions.delete(event)
    },
  },
}))

import { RUN_APPROVAL_EVENT_CHANNELS, RunApprovalsCard } from "./run-approvals-card"

const toolApproval = {
  interruptId: "tool-interrupt:r1:q1",
  runId: "r1",
  type: "tool_approval",
  title: "Approve im_send (outbound message)",
  runTitle: "Scheduled task: Digest",
  runKind: "agent-turn",
  toolName: "im_send",
  permissionClass: "outbound",
  createdAt: 1,
  expiresAt: 2_000_000_000_000,
}

const botApproval = {
  interruptId: "b1",
  runId: "bot-run",
  type: "bot_approval",
  title: "Publish release notes",
  runTitle: "Bot: Release notes",
  runKind: "bot",
  message: "Post to #releases?",
  risk: "high",
  detail: { channel: "#releases" },
  createdAt: 2,
  expiresAt: 2_000_000_000_000,
}

function listReturns(approvals: unknown[]) {
  mockCall.mockImplementation(async (name: string) =>
    name === "execution_run_approval_list" ? { items: approvals } : { ok: true, status: "approved" }
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  subscriptions.clear()
  listReturns([toolApproval, botApproval])
})

describe("<RunApprovalsCard />", () => {
  it("renders nothing while nothing waits", async () => {
    listReturns([])
    const { container } = render(<RunApprovalsCard />)
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith("execution_run_approval_list", {}))
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a tool request by its class and a Bot step with its proposal and risk", async () => {
    render(<RunApprovalsCard />)
    expect(await screen.findByText("2 waiting")).toBeInTheDocument()
    const tool = screen.getByTestId("run-approval-tool-interrupt:r1:q1")
    expect(tool).toHaveTextContent("class.outbound")
    expect(tool).toHaveTextContent("Approve im_send (outbound message)")
    expect(tool).toHaveTextContent("Scheduled task: Digest")
    const bot = screen.getByTestId("run-approval-b1")
    expect(bot).toHaveTextContent("kind.bot")
    expect(bot).toHaveTextContent("risk.high")
    expect(bot).toHaveTextContent("Post to #releases?")
    expect(screen.getByTestId("run-approval-detail-b1")).toHaveTextContent('"channel": "#releases"')
  })

  it("walks every page the host issues", async () => {
    mockCall.mockImplementation(async (name: string, args: { pageToken?: string }) => {
      if (name !== "execution_run_approval_list") return { ok: true, status: "approved" }
      return args.pageToken === "ra:1"
        ? { items: [botApproval] }
        : { items: [toolApproval], nextPageToken: "ra:1" }
    })
    render(<RunApprovalsCard />)
    expect(await screen.findByText("2 waiting")).toBeInTheDocument()
    expect(mockCall).toHaveBeenCalledWith("execution_run_approval_list", { pageToken: "ra:1" })
  })

  it("shows nothing for an answer that is not a page", async () => {
    mockCall.mockResolvedValue({ approvals: [toolApproval] })
    const { container } = render(<RunApprovalsCard />)
    await waitFor(() => expect(mockCall).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("says when a proposal is too large to show", async () => {
    listReturns([{ ...botApproval, detail: undefined, detailTruncated: true }])
    render(<RunApprovalsCard />)
    expect(await screen.findByText("detailTruncated")).toBeInTheDocument()
    expect(screen.queryByTestId("run-approval-detail-b1")).not.toBeInTheDocument()
  })

  it("approves through the respond command and drops the answered row", async () => {
    const user = userEvent.setup()
    render(<RunApprovalsCard />)
    await user.click(await screen.findByTestId("run-approval-approve-tool-interrupt:r1:q1"))
    expect(mockCall).toHaveBeenCalledWith("execution_run_approval_respond", {
      interruptId: "tool-interrupt:r1:q1",
      decision: "approve",
    })
    await waitFor(() =>
      expect(screen.queryByTestId("run-approval-tool-interrupt:r1:q1")).not.toBeInTheDocument()
    )
    expect(toastSuccess).toHaveBeenCalledWith("approvedToast")
  })

  describe("a parked outbound request (ADR-0239)", () => {
    const chat = { kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_1" }

    it("names the recipients and allows them for the request", async () => {
      const user = userEvent.setup()
      listReturns([{ ...toolApproval, outbound: { recipients: [chat], allowForRequest: true } }])
      render(<RunApprovalsCard />)
      const row = await screen.findByTestId("run-approval-tool-interrupt:r1:q1")
      expect(row.querySelectorAll('[data-testid="outbound-recipient"]')).toHaveLength(1)
      expect(screen.getByTestId("outbound-deny-fences")).toBeInTheDocument()
      await user.click(screen.getByTestId("run-approval-allow-request-tool-interrupt:r1:q1"))
      expect(mockCall).toHaveBeenCalledWith("execution_run_approval_respond", {
        interruptId: "tool-interrupt:r1:q1",
        decision: "approve",
        forRequest: true,
      })
    })

    it("names a GitHub write's repository and PR (ADR-0239 phase 2)", async () => {
      const repository = {
        kind: "repository",
        channel: "github",
        recipient: "github:github.com/acme/web",
        thread: "12",
      }
      listReturns([
        { ...toolApproval, outbound: { recipients: [repository], allowForRequest: true } },
      ])
      render(<RunApprovalsCard />)
      const row = await screen.findByTestId("run-approval-tool-interrupt:r1:q1")
      const recipient = row.querySelector('[data-testid="outbound-recipient"]')
      // This suite renders translation keys: the PR form of a repository line.
      expect(recipient).toHaveTextContent("recipientRepositoryThread")
      expect(
        screen.getByTestId("run-approval-allow-request-tool-interrupt:r1:q1")
      ).toBeInTheDocument()
    })

    it("offers only this call when the host says a recipient cannot be named", async () => {
      listReturns([{ ...toolApproval, outbound: { recipients: [chat], allowForRequest: false } }])
      render(<RunApprovalsCard />)
      await screen.findByTestId("run-approval-tool-interrupt:r1:q1")
      expect(
        screen.queryByTestId("run-approval-allow-request-tool-interrupt:r1:q1")
      ).not.toBeInTheDocument()
      expect(screen.getByTestId("run-approval-approve-tool-interrupt:r1:q1")).toBeInTheDocument()
    })

    it("shows no recipients for a request that is not outbound", async () => {
      render(<RunApprovalsCard />)
      await screen.findByTestId("run-approval-tool-interrupt:r1:q1")
      expect(screen.queryByTestId("outbound-recipients")).not.toBeInTheDocument()
    })
  })

  it("denies, and says so", async () => {
    mockCall.mockImplementation(async (name: string) =>
      name === "execution_run_approval_list"
        ? { items: [botApproval] }
        : { ok: true, status: "denied" }
    )
    const user = userEvent.setup()
    render(<RunApprovalsCard />)
    await user.click(await screen.findByTestId("run-approval-deny-b1"))
    expect(mockCall).toHaveBeenCalledWith("execution_run_approval_respond", {
      interruptId: "b1",
      decision: "deny",
    })
    expect(toastSuccess).toHaveBeenCalledWith("deniedToast")
  })

  it("reloads when the approval was already answered or expired", async () => {
    mockCall.mockImplementation(async (name: string) =>
      name === "execution_run_approval_list"
        ? { items: [botApproval] }
        : { ok: false, reason: "gone" }
    )
    const user = userEvent.setup()
    render(<RunApprovalsCard />)
    await user.click(await screen.findByTestId("run-approval-approve-b1"))
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("goneToast"))
    expect(mockCall.mock.calls.filter(([n]) => n === "execution_run_approval_list")).toHaveLength(2)
  })

  it("names the host's refusal and survives an unreachable host", async () => {
    mockCall.mockImplementation(async (name: string) =>
      name === "execution_run_approval_list"
        ? { items: [botApproval] }
        : { ok: false, reason: "revision_conflict" }
    )
    const user = userEvent.setup()
    render(<RunApprovalsCard />)
    await user.click(await screen.findByTestId("run-approval-approve-b1"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("refusedToast", {
        description: "revision_conflict",
      })
    )

    mockCall.mockImplementation(async (name: string) => {
      if (name === "execution_run_approval_list") return { items: [botApproval] }
      throw new Error("offline")
    })
    await user.click(screen.getByTestId("run-approval-deny-b1"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("respondFailedToast"))
    expect(screen.getByTestId("run-approval-b1")).toBeInTheDocument()
  })

  it("reloads on either live channel and unsubscribes on unmount", async () => {
    const { unmount } = render(<RunApprovalsCard />)
    await screen.findByText("2 waiting")
    expect([...subscriptions.keys()].sort()).toEqual([...RUN_APPROVAL_EVENT_CHANNELS].sort())
    listReturns([botApproval])
    await act(async () => {
      subscriptions.get("run://approval-resolved")?.({ interruptId: toolApproval.interruptId })
    })
    await waitFor(() =>
      expect(screen.queryByTestId("run-approval-tool-interrupt:r1:q1")).not.toBeInTheDocument()
    )
    unmount()
    expect(subscriptions.size).toBe(0)
  })
})
