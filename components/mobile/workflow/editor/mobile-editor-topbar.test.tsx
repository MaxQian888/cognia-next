/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { listByStatus, listAll } from "@/lib/db/mobile-outbound-queue"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { getDb } from "@/lib/db/schema"
import type { VisualWorkflow } from "@/types/workflow/visual"

const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastWarning = jest.fn()
const toastMessage = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    message: (...a: unknown[]) => toastMessage(...a),
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
  const onOpenSearch = jest.fn()
  const onOpenWorkbench = jest.fn()
  render(
    <MobileEditorTopbar
      store={store}
      reactFlowInstance={null}
      mode={mode}
      onToggleMode={onToggleMode}
      onOpenCopilot={onOpenCopilot}
      onOpenSearch={onOpenSearch}
      onOpenWorkbench={onOpenWorkbench}
      orientationLocked={true}
      onToggleOrientationLock={jest.fn()}
      onToggleSelectMode={jest.fn()}
    />
  )
  return { store, onToggleMode, onOpenCopilot, onOpenSearch, onOpenWorkbench }
}

// Run hands the workflow to the paired desktop through the outbound queue, and
// every job there is addressed to one account and one runtime target. `enqueue`
// refuses to write a row it cannot address, so with no active scope the click
// toasts a failure instead of queueing. A phone whose Run reaches a desktop is
// paired by definition, so stand a scope up rather than mocking the queue.
beforeEach(async () => {
  toastSuccess.mockReset()
  toastError.mockReset()
  toastWarning.mockReset()
  toastMessage.mockReset()
  persistEditorWorkflow.mockClear()
  downloadWorkflowJson.mockClear()
  setActiveRuntimeTargetContext("local_acct_a", "host-1")
  const all = await listAll()
  await Promise.all(all.map((r) => getDb().mobileOutboundQueue.delete(r.id)))
})

afterEach(() => {
  clearActiveRuntimeTargetContext()
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

  // Ctrl/Cmd+F is how the desktop reaches canvas search, and a phone has no
  // keyboard to press it with, so the control is in the bar rather than buried
  // in the overflow menu.
  it("opens canvas node search from the top bar in either mode", async () => {
    const user = userEvent.setup()
    const { onOpenSearch } = renderTopbar("read")
    await user.click(screen.getByTestId("mobile-editor-search"))
    expect(onOpenSearch).toHaveBeenCalledTimes(1)
  })

  // A phone-width bar holds more 44px targets than the screen is wide. The name
  // column is the only thing that may shrink, so the status badge lives inside
  // it (a `shrink-0` sibling overflowed onto the mode toggle once the column
  // hit 0px), and the lower-priority buttons hand over to the overflow menu.
  describe("phone-width layout", () => {
    it("keeps the status badge inside the shrinkable name column", () => {
      renderTopbar()
      const column = screen.getByRole("heading", { name: "Daily Digest" }).parentElement
      expect(column).toHaveClass("min-w-0", "flex-1")
      expect(column).toContainElement(screen.getByTestId("mobile-editor-dirty"))
      expect(screen.getByTestId("mobile-editor-dirty")).toHaveClass("max-w-full", "truncate")
    })

    it("collapses the mode toggle to an icon but keeps its accessible name", () => {
      renderTopbar("edit")
      const toggle = screen.getByTestId("mobile-editor-mode-toggle")
      expect(toggle).toHaveClass("max-sm:size-11")
      expect(screen.getByText("modeEdit")).toHaveClass("max-sm:sr-only")
      expect(toggle).toHaveAccessibleName("modeEdit")
    })

    it("hides select mode and Workbench from the bar below sm", () => {
      renderTopbar("edit")
      expect(screen.getByTestId("mobile-editor-select-mode")).toHaveClass("max-sm:hidden")
      expect(screen.getByTestId("mobile-editor-workbench")).toHaveClass("max-sm:hidden")
    })

    it("offers Workbench and select mode from the overflow menu instead", async () => {
      const user = userEvent.setup()
      const store: EditorStore = createEditorStore(buildWorkflow())
      const onOpenWorkbench = jest.fn()
      const onToggleSelectMode = jest.fn()
      render(
        <MobileEditorTopbar
          store={store}
          reactFlowInstance={null}
          mode="select"
          onToggleMode={jest.fn()}
          onOpenCopilot={jest.fn()}
          onOpenSearch={jest.fn()}
          onOpenWorkbench={onOpenWorkbench}
          orientationLocked={true}
          onToggleOrientationLock={jest.fn()}
          onToggleSelectMode={onToggleSelectMode}
        />
      )
      await user.click(screen.getByTestId("mobile-editor-menu"))
      const selectItem = await screen.findByTestId("mobile-editor-menu-select-mode")
      expect(selectItem).toHaveClass("sm:hidden")
      await user.click(selectItem)
      expect(onToggleSelectMode).toHaveBeenCalledTimes(1)

      await user.click(screen.getByTestId("mobile-editor-menu"))
      const workbenchItem = await screen.findByTestId("mobile-editor-menu-workbench")
      expect(workbenchItem).toHaveClass("sm:hidden")
      await user.click(workbenchItem)
      expect(onOpenWorkbench).toHaveBeenCalledTimes(1)
    })

    it("does not offer select mode in the menu while reading", async () => {
      const user = userEvent.setup()
      renderTopbar("read")
      await user.click(screen.getByTestId("mobile-editor-menu"))
      await screen.findByTestId("mobile-editor-menu-workbench")
      expect(screen.queryByTestId("mobile-editor-menu-select-mode")).not.toBeInTheDocument()
    })
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

  it("does not queue a second run while the first is still waiting", async () => {
    const user = userEvent.setup()
    renderTopbar()
    await user.click(screen.getByTestId("mobile-editor-run"))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("runQueued"))
    await waitFor(() => expect(screen.getByTestId("mobile-editor-run")).not.toBeDisabled())
    await user.click(screen.getByTestId("mobile-editor-run"))
    await waitFor(() => expect(toastMessage).toHaveBeenCalledWith("runAlreadyQueued"))
    expect(await listByStatus("pending")).toHaveLength(1)
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
