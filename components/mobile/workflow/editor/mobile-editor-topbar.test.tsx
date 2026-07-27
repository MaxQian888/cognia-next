/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { listByStatus, listAll } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import type { VisualWorkflow } from "@/types/workflow/visual"

const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
  },
}))

jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn(async () => ({ kind: "ok" })) }))

const persistEditorWorkflow = jest.fn(async (..._a: unknown[]) => ({
  issueCount: 0,
  publicationInvalidated: false,
}))
jest.mock("@/lib/workflow/editor/persist-workflow", () => ({
  persistEditorWorkflow: (...a: unknown[]) => persistEditorWorkflow(...a),
}))

const downloadWorkflowJson = jest.fn()
jest.mock("@/lib/workflow/editor/workflow-json", () => ({
  downloadWorkflowJson: (...a: unknown[]) => downloadWorkflowJson(...a),
  parseWorkflowImport: (t: string) => JSON.parse(t),
}))

jest.mock("@/lib/workflow/editor/auto-layout", () => ({
  autoLayout: jest.fn(async () => ({})),
  applyAutoLayoutPositions: (nodes: unknown) => nodes,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { MobileEditorTopbar } from "./mobile-editor-topbar"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_top",
    schemaVersion: 1,
    name: "Daily Digest",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "ai_a",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "AI", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

function renderTopbar(mode: "read" | "edit" = "read") {
  const store: EditorStore = createEditorStore(buildWorkflow())
  const onToggleMode = jest.fn()
  const onOpenCopilot = jest.fn()
  const onOpenWorkbench = jest.fn()
  render(
    <MobileEditorTopbar
      store={store}
      reactFlowInstance={null}
      mode={mode}
      onToggleMode={onToggleMode}
      onOpenCopilot={onOpenCopilot}
      onOpenWorkbench={onOpenWorkbench}
    />
  )
  return { store, onToggleMode, onOpenCopilot, onOpenWorkbench }
}

beforeEach(async () => {
  toastSuccess.mockReset()
  toastError.mockReset()
  toastWarning.mockReset()
  persistEditorWorkflow.mockClear()
  downloadWorkflowJson.mockClear()
  const all = await listAll()
  await Promise.all(all.map((r) => getDb().mobileOutboundQueue.delete(r.id)))
})

describe("<MobileEditorTopbar />", () => {
  it("shows the workflow name and a saved badge when clean", () => {
    renderTopbar()
    expect(screen.getByText("Daily Digest")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-editor-dirty")).toHaveTextContent("savedBadge")
  })

  it("fires onToggleMode when the mode toggle is tapped", async () => {
    const user = userEvent.setup()
    const { onToggleMode } = renderTopbar("read")
    await user.click(screen.getByTestId("mobile-editor-mode-toggle"))
    expect(onToggleMode).toHaveBeenCalledTimes(1)
  })

  it("fires onOpenCopilot when the copilot button is tapped (available in read mode)", async () => {
    const user = userEvent.setup()
    const { onOpenCopilot } = renderTopbar("read")
    await user.click(screen.getByTestId("mobile-editor-menu"))
    await user.click(screen.getByTestId("mobile-editor-copilot"))
    expect(onOpenCopilot).toHaveBeenCalledTimes(1)
  })

  it("opens the shared Context Workbench from the primary sidebar action", async () => {
    const user = userEvent.setup()
    const { onOpenWorkbench } = renderTopbar("read")
    await user.click(screen.getByTestId("mobile-editor-workbench"))
    expect(onOpenWorkbench).toHaveBeenCalledTimes(1)
  })

  it("disables Save when clean and persists once dirty", async () => {
    const user = userEvent.setup()
    const { store } = renderTopbar()
    expect(screen.getByTestId("mobile-editor-save")).toBeDisabled()

    act(() => store.getState().setName("Edited"))
    expect(screen.getByTestId("mobile-editor-dirty")).toHaveTextContent("dirty")

    await user.click(screen.getByTestId("mobile-editor-save"))
    await waitFor(() => expect(persistEditorWorkflow).toHaveBeenCalledTimes(1))
    expect(toastSuccess).toHaveBeenCalledWith("saved")
  })

  it("warns when saving invalidates a published callable contract", async () => {
    const user = userEvent.setup()
    const { store } = renderTopbar()
    act(() => store.getState().setName("Edited"))
    persistEditorWorkflow.mockResolvedValueOnce({
      issueCount: 0,
      publicationInvalidated: true,
    })

    await user.click(screen.getByTestId("mobile-editor-save"))

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith("publicationInvalidated"))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("enqueues a manual trigger for the paired desktop on Run", async () => {
    const user = userEvent.setup()
    renderTopbar()
    await user.click(screen.getByTestId("mobile-editor-run"))
    await waitFor(async () => {
      expect(await listByStatus("pending")).toHaveLength(1)
    })
    const queue = await listByStatus("pending")
    expect(queue[0].command).toBe("workflow_trigger_manual")
    expect(queue[0].payload).toEqual({ workflowId: "wf_top" })
    expect(toastSuccess).toHaveBeenCalledWith("runQueued")
    // Clean store → Run should not persist.
    expect(persistEditorWorkflow).not.toHaveBeenCalled()
  })

  it("persists imported JSON before queueing Run", async () => {
    const user = userEvent.setup()
    const { store } = renderTopbar()
    const imported = {
      name: "Imported mobile graph",
      nodes: buildWorkflow().nodes,
      edges: [],
    }

    await user.upload(
      screen.getByTestId("mobile-editor-import-input"),
      new File([JSON.stringify(imported)], "workflow.json", { type: "application/json" })
    )
    await waitFor(() => expect(store.getState().dirty).toBe(true))

    await user.click(screen.getByTestId("mobile-editor-run"))

    await waitFor(() => expect(persistEditorWorkflow).toHaveBeenCalledWith(store))
    expect(store.getState().baseWorkflow.id).toBe("wf_top")
    expect(store.getState().baseWorkflow.name).toBe("Imported mobile graph")
    expect(await listByStatus("pending")).toHaveLength(1)
  })

  it("exports JSON from the overflow menu", async () => {
    const user = userEvent.setup()
    renderTopbar()
    await user.click(screen.getByTestId("mobile-editor-menu"))
    await user.click(await screen.findByText("export"))
    expect(downloadWorkflowJson).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith("exported")
  })

  it("links to the run history from the overflow menu", async () => {
    const user = userEvent.setup()
    renderTopbar()
    await user.click(screen.getByTestId("mobile-editor-menu"))
    const item = await screen.findByTestId("mobile-editor-run-history")
    expect(item).toHaveAttribute("href", "/workflows/runs?id=wf_top")
  })

  it("toasts a failure when auto-layout yields no positions", async () => {
    const user = userEvent.setup()
    renderTopbar()
    await user.click(screen.getByTestId("mobile-editor-menu"))
    await user.click(await screen.findByText("autoLayout"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("autoLayoutFailed"))
  })
})
