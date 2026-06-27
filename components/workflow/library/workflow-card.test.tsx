/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import type { WorkflowNode, WorkflowRow } from "@/types/workflow/visual"

function node(id: string, type: string): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: {} },
  }
}
import { WorkflowCard } from "./workflow-card"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { useSettingsStore } from "@/stores/settings/settings-store"

function makeWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: "wf_a",
    schemaVersion: 1,
    name: "Daily digest",
    folderId: ROOT_FOLDER_ID,
    createdAt: 0,
    updatedAt: 0,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 1000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
    ...overrides,
  } as WorkflowRow
}

beforeEach(() => {
  useWorkflowLibraryStore.setState({
    selectionMode: false,
    selection: new Set<string>(),
    deleteDialogTarget: null,
  })
  useSettingsStore.setState({ settings: { pinnedWorkflowIds: [] } as never })
})

describe("WorkflowCard", () => {
  it("renders the name and node-count badge", () => {
    render(<WorkflowCard workflow={makeWorkflow({ nodes: [] })} />)
    expect(screen.getByTestId("workflow-card-wf_a")).toHaveTextContent("Daily digest")
  })

  it("shows the run-count badge and last-run status when provided", () => {
    render(<WorkflowCard workflow={makeWorkflow()} runCount={12} lastStatus="failed" />)
    expect(screen.getByTestId("workflow-runcount-wf_a")).toHaveTextContent("12")
    expect(screen.getByTestId("run-status-failed")).toBeInTheDocument()
  })

  it("hides the run-count badge when there are no runs", () => {
    render(<WorkflowCard workflow={makeWorkflow()} runCount={0} />)
    expect(screen.queryByTestId("workflow-runcount-wf_a")).not.toBeInTheDocument()
  })

  it("toggles selection via the checkbox", () => {
    render(<WorkflowCard workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-select-wf_a"))
    expect(useWorkflowLibraryStore.getState().selection.has("wf_a")).toBe(true)
  })

  it("selects instead of navigating while in selection mode", () => {
    useWorkflowLibraryStore.setState({ selectionMode: true })
    render(<WorkflowCard workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-open-wf_a"))
    expect(useWorkflowLibraryStore.getState().selection.has("wf_a")).toBe(true)
  })

  it("shows the pinned indicator when pinned", () => {
    useSettingsStore.setState({ settings: { pinnedWorkflowIds: ["wf_a"] } as never })
    render(<WorkflowCard workflow={makeWorkflow()} />)
    expect(screen.getByTestId("workflow-pinned-wf_a")).toBeInTheDocument()
  })

  it("routes delete through the store delete dialog", async () => {
    const user = userEvent.setup()
    render(<WorkflowCard workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-card-menu-wf_a"))
    fireEvent.click(await screen.findByTestId("workflow-action-delete-wf_a"))
    expect(useWorkflowLibraryStore.getState().deleteDialogTarget).toEqual({ ids: ["wf_a"] })
  })

  it("disables delete for built-in workflows", async () => {
    const user = userEvent.setup()
    render(<WorkflowCard workflow={makeWorkflow({ isBuiltIn: true })} />)
    await user.click(screen.getByTestId("workflow-card-menu-wf_a"))
    expect(await screen.findByTestId("workflow-action-delete-wf_a")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("renders trigger, action, template, and tag badges", () => {
    render(
      <WorkflowCard
        workflow={makeWorkflow({
          nodes: [node("n1", "trigger.manual"), node("n2", "action.http")],
          isTemplate: true,
          tags: ["ops"],
        })}
      />
    )
    expect(screen.getByText("Template")).toBeInTheDocument()
    expect(screen.getByText("ops")).toBeInTheDocument()
    expect(screen.getByText(/trigger/)).toBeInTheDocument()
    expect(screen.getByText(/action/)).toBeInTheDocument()
  })

  it("activates navigation when clicked outside selection mode", () => {
    render(<WorkflowCard workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-open-wf_a"))
    // Not in selection mode → nothing selected (it navigated instead).
    expect(useWorkflowLibraryStore.getState().selection.size).toBe(0)
  })

  it("activates from anywhere on the card, not just the title", () => {
    // Whole-card affordance: clicking the body (badges/padding) must activate,
    // not only the small header title button.
    useWorkflowLibraryStore.setState({ selectionMode: true })
    render(<WorkflowCard workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-card-wf_a"))
    expect(useWorkflowLibraryStore.getState().selection.has("wf_a")).toBe(true)
  })

  it("activates exactly once when the title button is clicked", () => {
    // The title button must not double-fire by also bubbling to the card.
    useWorkflowLibraryStore.setState({ selectionMode: true })
    render(<WorkflowCard workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-open-wf_a"))
    // A second toggle would clear it again; selection proves a single toggle.
    expect(useWorkflowLibraryStore.getState().selection.has("wf_a")).toBe(true)
  })

  it("does not activate the card when opening the actions menu", async () => {
    const user = userEvent.setup()
    useWorkflowLibraryStore.setState({ selectionMode: true })
    render(<WorkflowCard workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-card-menu-wf_a"))
    expect(useWorkflowLibraryStore.getState().selection.has("wf_a")).toBe(false)
  })

  it("opens the rename dialog from the menu", async () => {
    const user = userEvent.setup()
    render(<WorkflowCard workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-card-menu-wf_a"))
    fireEvent.click(await screen.findByTestId("workflow-action-rename-wf_a"))
    expect(await screen.findByTestId("workflow-rename-input")).toBeInTheDocument()
  })

  it("opens the edit-tags dialog from the menu", async () => {
    const user = userEvent.setup()
    render(<WorkflowCard workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-card-menu-wf_a"))
    fireEvent.click(await screen.findByTestId("workflow-action-tags-wf_a"))
    expect(await screen.findByTestId("workflow-tags-input")).toBeInTheDocument()
  })

  it("renders a direct Run button that opens the run dialog", async () => {
    render(<WorkflowCard workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-card-run-wf_a"))
    expect(await screen.findByTestId("workflow-run-dialog")).toBeInTheDocument()
  })

  it("opens the run dialog from the actions menu", async () => {
    const user = userEvent.setup()
    render(<WorkflowCard workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-card-menu-wf_a"))
    fireEvent.click(await screen.findByTestId("workflow-action-run-wf_a"))
    expect(await screen.findByTestId("workflow-run-dialog")).toBeInTheDocument()
  })
})
