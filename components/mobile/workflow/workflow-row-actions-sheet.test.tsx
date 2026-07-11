/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { WorkflowRowActionsSheet } from "./workflow-row-actions-sheet"
import type { WorkflowRow } from "@/types/workflow/visual"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const name = vars?.name ?? ""
    const map: Record<string, string> = {
      run: "Run now",
      pause: "Pause schedule",
      favorite: "Pin",
      unpin: "Unpin",
      graph: "View graph",
      graphSheetTitle: `Flow of ${name}`,
      graphViewerEmpty: "This workflow has no nodes yet.",
      delete: "Delete",
      runQueued: `Triggered ${name} — queued for desktop.`,
      resume: "Resume schedule",
      pauseQueued: `Pausing schedule of ${name}.`,
      resumeQueued: `Resuming schedule of ${name}.`,
      pinned: "Pinned.",
      unpinned: "Unpinned.",
    }
    return map[key] ?? key
  },
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}))

jest.mock("@/hooks/ui/use-back-dismiss", () => ({ useBackDismiss: jest.fn() }))

const enqueueMock = jest.fn(async (..._a: unknown[]) => ({}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (...a: unknown[]) => enqueueMock(...a),
}))

const saveMock = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { pinnedWorkflowIds: [] }, save: saveMock }),
}))

jest.mock("./workflow-delete-confirm", () => ({
  WorkflowDeleteConfirm: () => <div data-testid="workflow-delete-confirm-mock" />,
}))

function makeWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  const now = Date.now()
  return {
    id: "wf-1",
    name: "Daily Digest",
    nodes: [
      {
        id: "n_send",
        type: "action.character.send",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Send message", params: {} },
      },
      {
        id: "n_trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Manual trigger", params: {}, notes: "Kick off by hand" },
      },
    ],
    edges: [{ id: "e1", source: "n_trigger", target: "n_send" }],
    createdAt: now,
    updatedAt: now,
    ...(overrides as object),
  } as unknown as WorkflowRow
}

beforeEach(() => {
  enqueueMock.mockClear()
  saveMock.mockClear()
})

describe("<WorkflowRowActionsSheet />", () => {
  it("opens the vertical graph viewer sheet on 'View graph' (no desktop-editor redirect)", async () => {
    const user = userEvent.setup()
    render(<WorkflowRowActionsSheet workflow={makeWorkflow()} onOpenChange={jest.fn()} />)

    await user.click(screen.getByTestId("workflow-action-graph"))

    expect(await screen.findByTestId("workflow-graph-sheet")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-graph-viewer")).toBeInTheDocument()
    // Topo order: trigger first even though it is second in source order.
    const nodes = screen.getAllByTestId(/^workflow-node-/)
    expect(nodes[0]).toHaveAttribute("data-testid", "workflow-node-n_trigger")
    expect(nodes[1]).toHaveAttribute("data-testid", "workflow-node-n_send")
    expect(screen.getByText("Kick off by hand")).toBeInTheDocument()
  })

  it("closing the graph sheet also closes the actions surface", async () => {
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<WorkflowRowActionsSheet workflow={makeWorkflow()} onOpenChange={onOpenChange} />)

    await user.click(screen.getByTestId("workflow-action-graph"))
    await screen.findByTestId("workflow-graph-sheet")
    await user.keyboard("{Escape}")

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("renders the graph empty state for a node-less workflow", async () => {
    const user = userEvent.setup()
    render(
      <WorkflowRowActionsSheet
        workflow={makeWorkflow({ nodes: [], edges: [] })}
        onOpenChange={jest.fn()}
      />
    )

    await user.click(screen.getByTestId("workflow-action-graph"))

    expect(await screen.findByText("This workflow has no nodes yet.")).toBeInTheDocument()
  })

  it("hides the schedule action when the workflow has no cron trigger", () => {
    render(<WorkflowRowActionsSheet workflow={makeWorkflow()} onOpenChange={jest.fn()} />)
    expect(screen.queryByTestId("workflow-action-pause")).toBeNull()
  })

  it("enqueues workflow_schedule_pause per active cron trigger", async () => {
    const user = userEvent.setup()
    const workflow = makeWorkflow({
      nodes: [
        {
          id: "n_cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Every day", params: { cron: "0 9 * * *" } },
        },
      ],
      edges: [],
    } as unknown as Partial<WorkflowRow>)
    render(<WorkflowRowActionsSheet workflow={workflow} onOpenChange={jest.fn()} />)

    expect(screen.getByText("Pause schedule")).toBeInTheDocument()
    await user.click(screen.getByTestId("workflow-action-pause"))

    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "workflow_schedule_pause",
          payload: { triggerId: "n_cron" },
        })
      )
    )
  })

  it("offers Resume and enqueues workflow_schedule_resume when every cron trigger is disabled", async () => {
    const user = userEvent.setup()
    const workflow = makeWorkflow({
      nodes: [
        {
          id: "n_cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Every day", params: { cron: "0 9 * * *" }, disabled: true },
        },
      ],
      edges: [],
    } as unknown as Partial<WorkflowRow>)
    render(<WorkflowRowActionsSheet workflow={workflow} onOpenChange={jest.fn()} />)

    expect(screen.getByText("Resume schedule")).toBeInTheDocument()
    await user.click(screen.getByTestId("workflow-action-pause"))

    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "workflow_schedule_resume",
          payload: { triggerId: "n_cron" },
        })
      )
    )
  })

  it("enqueues workflow_trigger_manual on Run now", async () => {
    const user = userEvent.setup()
    render(<WorkflowRowActionsSheet workflow={makeWorkflow()} onOpenChange={jest.fn()} />)

    await user.click(screen.getByTestId("workflow-action-run"))

    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "workflow_trigger_manual",
          payload: { workflowId: "wf-1" },
        })
      )
    )
  })
})
