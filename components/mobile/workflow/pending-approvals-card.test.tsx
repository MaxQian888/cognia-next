/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
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

import { PendingApprovalsCard } from "./pending-approvals-card"

const approval = {
  approvalId: "apr_1",
  runId: "run_1",
  workflowId: "wf_1",
  stepId: "n_gate",
  title: "Deploy v2?",
  message: "Production release",
  requestedAt: 1_000,
}

beforeEach(() => {
  jest.clearAllMocks()
  subscriptions.clear()
  mockCall.mockImplementation(async (name: string) =>
    name === "workflow_approval_list" ? { approvals: [approval] } : { ok: true }
  )
})

describe("<PendingApprovalsCard />", () => {
  it("renders nothing when no approvals are pending", async () => {
    mockCall.mockResolvedValue({ approvals: [] })
    const { container } = render(<PendingApprovalsCard />)
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith("workflow_approval_list", {}))
    expect(container.querySelector("[data-testid=pending-approvals-card]")).toBeNull()
  })

  it("lists pending approvals with title and message", async () => {
    render(<PendingApprovalsCard />)
    expect(await screen.findByText("Deploy v2?")).toBeInTheDocument()
    expect(screen.getByText("Production release")).toBeInTheDocument()
    expect(screen.getByText("1 waiting")).toBeInTheDocument()
  })

  it("approves via the control RPC and removes the row", async () => {
    const user = userEvent.setup()
    render(<PendingApprovalsCard />)
    await screen.findByText("Deploy v2?")
    await user.click(screen.getByTestId("approve-apr_1"))
    await waitFor(() =>
      expect(mockCall).toHaveBeenCalledWith("workflow_approval_respond", {
        approvalId: "apr_1",
        decision: "approved",
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith("approvedToast")
    await waitFor(() => expect(screen.queryByText("Deploy v2?")).toBeNull())
  })

  it("shows the gone toast and reloads when the approval already resolved", async () => {
    const user = userEvent.setup()
    mockCall.mockImplementation(async (name: string) =>
      name === "workflow_approval_list"
        ? { approvals: [approval] }
        : { ok: false, reason: "not-found" }
    )
    render(<PendingApprovalsCard />)
    await screen.findByText("Deploy v2?")
    await user.click(screen.getByTestId("reject-apr_1"))
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("goneToast"))
  })

  it("surfaces transport failures as an error toast", async () => {
    const user = userEvent.setup()
    mockCall.mockImplementation(async (name: string) => {
      if (name === "workflow_approval_list") return { approvals: [approval] }
      throw new Error("offline")
    })
    render(<PendingApprovalsCard />)
    await screen.findByText("Deploy v2?")
    await user.click(screen.getByTestId("approve-apr_1"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("respondFailedToast"))
  })

  it("reloads when an approval lifecycle frame arrives", async () => {
    render(<PendingApprovalsCard />)
    await screen.findByText("Deploy v2?")
    expect(subscriptions.has("workflow://approval-request")).toBe(true)
    mockCall.mockResolvedValue({ approvals: [] })
    subscriptions.get("workflow://approval-resolved")?.({})
    await waitFor(() => expect(screen.queryByText("Deploy v2?")).toBeNull())
  })
})
