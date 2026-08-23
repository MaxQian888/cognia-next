/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastInfo = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (key === "heading") return `${String(vars?.count)} forms waiting`
    if (key === "requiredError") return `${String(vars?.field)} is required`
    if (key === "numberMinError") return `${String(vars?.field)} too small`
    if (key === "numberMaxError") return `${String(vars?.field)} too large`
    return key
  },
}))

const mockCall = jest.fn()
const subscriptions = new Map<string, (payload: unknown) => void>()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: {
    call: (...args: unknown[]) => mockCall(...args),
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      subscriptions.set(event, handler)
      return () => subscriptions.delete(event)
    },
  },
}))

const uploadSessionAttachment = jest.fn()
jest.mock("@/lib/companion/attachment-upload-client", () => ({
  uploadSessionAttachment: (...args: unknown[]) => uploadSessionAttachment(...args),
}))

import { PendingHumanInputCard } from "./pending-human-input-card"

const request = {
  id: "hir_1",
  status: "pending" as const,
  runId: "run_1",
  workflowId: "wf_1",
  stepId: "ask",
  title: "Release review",
  message: "Complete the deployment checklist.",
  fields: [
    { id: "summary", type: "short-text" as const, label: "Summary", required: true },
    { id: "details", type: "long-text" as const, label: "Details" },
    { id: "score", type: "number" as const, label: "Score", min: 1, max: 5 },
    { id: "confirmed", type: "boolean" as const, label: "Confirmed", required: true },
    {
      id: "region",
      type: "single-select" as const,
      label: "Region",
      options: [
        { value: "us", label: "US" },
        { value: "eu", label: "EU" },
      ],
    },
    {
      id: "checks",
      type: "multi-select" as const,
      label: "Checks",
      options: [
        { value: "security", label: "Security" },
        { value: "legal", label: "Legal" },
      ],
    },
    { id: "evidence", type: "file" as const, label: "Evidence" },
  ],
  actions: [
    { id: "approve", label: "Approve", tone: "primary" as const },
    { id: "reject", label: "Reject", tone: "destructive" as const },
  ],
  completionPolicy: { mode: "any" as const },
  createdAt: 1_000,
  expiresAt: 61_000,
}

beforeEach(() => {
  jest.clearAllMocks()
  subscriptions.clear()
  mockCall.mockImplementation(async (name: string) =>
    name === "workflow_human_input_list"
      ? { requests: [request] }
      : { ok: true, completed: true }
  )
  uploadSessionAttachment.mockResolvedValue({
    ref: "cognia-upload:upl_1",
    name: "proof.png",
    mediaType: "image/png",
    size: 3,
    hash: "a".repeat(64),
  })
})

describe("<PendingHumanInputCard />", () => {
  it("renders authored fields and actions", async () => {
    render(<PendingHumanInputCard />)

    expect(await screen.findByText("Release review")).toBeInTheDocument()
    expect(screen.getByText("Complete the deployment checklist.")).toBeInTheDocument()
    expect(screen.getByLabelText(/Summary/)).toBeInTheDocument()
    expect(screen.getByLabelText("Details")).toHaveAttribute("rows")
    expect(screen.getByLabelText("Score")).toHaveAttribute("type", "number")
    expect(screen.getByLabelText(/Confirmed/)).toHaveAttribute("role", "checkbox")
    expect(screen.getByLabelText("Region")).toBeInTheDocument()
    expect(screen.getByLabelText("Security")).toBeInTheDocument()
    expect(screen.getByLabelText("Evidence")).toHaveAttribute("type", "file")
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument()
  })

  it("validates required values and numeric bounds before calling the Host", async () => {
    const user = userEvent.setup()
    render(<PendingHumanInputCard />)
    await screen.findByText("Release review")

    await user.type(screen.getByLabelText("Score"), "9")
    await user.click(screen.getByRole("button", { name: "Approve" }))

    expect(await screen.findByText("Summary is required")).toBeInTheDocument()
    expect(screen.getByText("Confirmed is required")).toBeInTheDocument()
    expect(screen.getByText("Score too large")).toBeInTheDocument()
    expect(mockCall).not.toHaveBeenCalledWith(
      "workflow_human_input_submit",
      expect.anything()
    )
  })

  it("uploads a file, submits normalized values, and removes a completed request", async () => {
    const user = userEvent.setup()
    render(<PendingHumanInputCard />)
    await screen.findByText("Release review")

    await user.type(screen.getByLabelText(/Summary/), "Ready")
    await user.type(screen.getByLabelText("Details"), "All checks passed")
    await user.type(screen.getByLabelText("Score"), "5")
    await user.click(screen.getByLabelText(/Confirmed/))
    await user.selectOptions(screen.getByLabelText("Region"), "eu")
    await user.click(screen.getByLabelText("Security"))
    const file = new File([new Uint8Array([1, 2, 3])], "proof.png", { type: "image/png" })
    await user.upload(screen.getByLabelText("Evidence"), file)
    await waitFor(() => expect(uploadSessionAttachment).toHaveBeenCalled())

    await user.click(screen.getByRole("button", { name: "Approve" }))

    await waitFor(() =>
      expect(mockCall).toHaveBeenCalledWith("workflow_human_input_submit", {
        requestId: "hir_1",
        actionId: "approve",
        values: {
          summary: "Ready",
          details: "All checks passed",
          score: 5,
          confirmed: true,
          region: "eu",
          checks: ["security"],
          evidence: "cognia-upload:upl_1",
        },
      })
    )
    expect(uploadSessionAttachment).toHaveBeenCalledWith(
      "human-input:hir_1",
      expect.objectContaining({ name: "proof.png", mediaType: "image/png" }),
      expect.any(Object)
    )
    expect(toastSuccess).toHaveBeenCalledWith("submittedToast")
    await waitFor(() => expect(screen.queryByText("Release review")).not.toBeInTheDocument())
  })

  it("keeps an all/quorum request visible until the Host reports completion", async () => {
    const user = userEvent.setup()
    mockCall.mockImplementation(async (name: string) =>
      name === "workflow_human_input_list"
        ? { requests: [{ ...request, fields: [] }] }
        : { ok: true, completed: false }
    )
    render(<PendingHumanInputCard />)
    await screen.findByText("Release review")
    await user.click(screen.getByRole("button", { name: "Approve" }))

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("waitingForOthersToast"))
    expect(screen.getByText("Release review")).toBeInTheDocument()
    expect(within(screen.getByTestId("human-input-hir_1")).getByText("responded")).toBeVisible()
  })

  it("reloads for request and resolution lifecycle frames", async () => {
    render(<PendingHumanInputCard />)
    await screen.findByText("Release review")
    expect(subscriptions.has("workflow://human-input-request")).toBe(true)
    expect(subscriptions.has("workflow://human-input-resolved")).toBe(true)

    mockCall.mockResolvedValue({ requests: [] })
    subscriptions.get("workflow://human-input-resolved")?.({ requestId: "hir_1" })
    await waitFor(() => expect(screen.queryByText("Release review")).not.toBeInTheDocument())
  })

  it("surfaces upload and submission failures", async () => {
    const user = userEvent.setup()
    render(<PendingHumanInputCard />)
    await screen.findByText("Release review")
    uploadSessionAttachment.mockRejectedValueOnce(new Error("bad mime"))
    const file = new File([new Uint8Array([1])], "proof.png", { type: "image/png" })
    await user.upload(screen.getByLabelText("Evidence"), file)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("uploadFailedToast"))

    mockCall.mockImplementation(async (name: string) => {
      if (name === "workflow_human_input_list") return { requests: [request] }
      throw new Error("offline")
    })
    await user.type(screen.getByLabelText(/Summary/), "Ready")
    await user.click(screen.getByLabelText(/Confirmed/))
    await user.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("submitFailedToast"))
  })
})
