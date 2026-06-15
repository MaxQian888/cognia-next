/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { WorkflowDeleteConfirm } from "./workflow-delete-confirm"
import type { WorkflowRow } from "@/types/workflow/visual"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const name = vars?.name ?? ""
    const map: Record<string, string> = {
      title: `Delete ${name}?`,
      body: "Removes the workflow here and on the paired desktop.",
      cancel: "Cancel",
      confirm: "Delete",
      queueLabel: `Delete workflow ${name}`,
      toast: `Deleted ${name}.`,
    }
    return map[key] ?? key
  },
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const deleteWorkflowMock = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/workflows", () => ({
  deleteWorkflow: (...a: unknown[]) => deleteWorkflowMock(...a),
}))

const enqueueMock = jest.fn(async (..._a: unknown[]) => ({}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (...a: unknown[]) => enqueueMock(...a),
}))

function makeWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  const now = Date.now()
  return {
    id: "wf-1",
    name: "Daily Digest",
    description: "",
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
    ...(overrides as object),
  } as unknown as WorkflowRow
}

beforeEach(() => {
  deleteWorkflowMock.mockClear()
  enqueueMock.mockClear()
})

describe("<WorkflowDeleteConfirm />", () => {
  it("deletes locally AND enqueues a workflow_delete mirror on confirm", async () => {
    const wf = makeWorkflow()
    const onOpenChange = jest.fn()
    const user = userEvent.setup()

    render(<WorkflowDeleteConfirm workflow={wf} open onOpenChange={onOpenChange} />)
    await user.click(screen.getByTestId("workflow-delete-confirm-button"))

    await waitFor(() => expect(deleteWorkflowMock).toHaveBeenCalledWith(wf.id))
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "workflow_delete", payload: { id: wf.id } })
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("renders the confirm dialog shell even when workflow is null", () => {
    render(<WorkflowDeleteConfirm workflow={null} open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("workflow-delete-confirm")).toBeInTheDocument()
  })
})
