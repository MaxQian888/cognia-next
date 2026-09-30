/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TriggerButton } from "./trigger-button"
import { listAll, listByStatus } from "@/lib/db/mobile-outbound-queue"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { getDb } from "@/lib/db/schema"

const toastSuccess = jest.fn()
const toastMessage = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    message: (...a: unknown[]) => toastMessage(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

jest.mock("@/lib/capacitor/haptics", () => ({
  impact: jest.fn(async () => ({ kind: "ok" })),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (key === "runQueued") return "Queued"
    if (key === "runAlreadyQueued") return "Already queued"
    if (key === "runFailed") return `Failed: ${(vars?.message as string) ?? ""}`
    if (key === "runButton") return "Run"
    return key
  },
}))

// Every outbound job is addressed to one account and one runtime target, and
// `enqueue` refuses to write a row it cannot address. `TriggerButton` passes
// neither and reads the active scope instead, so without one the click lands in
// the catch arm, toasts the failure, and leaves the queue empty. A phone that
// can run a workflow on the desktop is paired by definition, so stand a scope
// up here rather than mocking the queue.
beforeEach(async () => {
  toastSuccess.mockReset()
  toastMessage.mockReset()
  toastError.mockReset()
  setActiveRuntimeTargetContext("local_acct_a", "host-1")
  const all = await listAll()
  await Promise.all(all.map((r) => getDb().mobileOutboundQueue.delete(r.id)))
})

afterEach(() => {
  clearActiveRuntimeTargetContext()
})

describe("<TriggerButton />", () => {
  it("enqueues a workflow_trigger_manual job and toasts success", async () => {
    const user = userEvent.setup()
    render(<TriggerButton workflowId="wf-1" workflowName="Daily Digest" />)
    await user.click(screen.getByTestId("workflow-trigger-wf-1"))
    await waitFor(async () => {
      const queue = await listByStatus("pending")
      expect(queue).toHaveLength(1)
    })
    const queue = await listByStatus("pending")
    expect(queue[0].command).toBe("workflow_trigger_manual")
    expect(queue[0].payload).toEqual({ workflowId: "wf-1" })
    expect(queue[0].label).toBe("Daily Digest")
    expect(toastSuccess).toHaveBeenCalledWith("Queued")
  })

  it("uses an explicit queueLabel override when provided", async () => {
    const user = userEvent.setup()
    render(<TriggerButton workflowId="wf-2" workflowName="Daily Digest" queueLabel="cron-fired" />)
    await user.click(screen.getByTestId("workflow-trigger-wf-2"))
    await waitFor(async () => {
      const q = await listByStatus("pending")
      expect(q.find((r) => r.command === "workflow_trigger_manual")?.label).toBe("cron-fired")
    })
  })

  /**
   * Each tap used to queue another run with a fresh idempotency key, so a Run
   * pressed three times while the desktop was away fired three times on
   * reconnect and the banner read "3 queued".
   */
  it("does not stack a second run of a workflow that is still queued", async () => {
    const user = userEvent.setup()
    render(<TriggerButton workflowId="wf-3" workflowName="Daily Digest" />)
    const button = screen.getByTestId("workflow-trigger-wf-3")
    await user.click(button)
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Queued"))
    await waitFor(() => expect(button).not.toBeDisabled())
    await user.click(button)
    await waitFor(() => expect(toastMessage).toHaveBeenCalledWith("Already queued"))
    expect(await listByStatus("pending")).toHaveLength(1)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })
})
