/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import type { WorkflowRow as WorkflowRowType } from "@/types/workflow/visual"
import { WorkflowRow } from "./workflow-row"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { useSettingsStore } from "@/stores/settings/settings-store"

function makeWorkflow(overrides: Partial<WorkflowRowType> = {}): WorkflowRowType {
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
  } as WorkflowRowType
}

beforeEach(() => {
  useWorkflowLibraryStore.setState({
    selectionMode: false,
    selection: new Set<string>(),
    deleteDialogTarget: null,
  })
  useSettingsStore.setState({ settings: { pinnedWorkflowIds: [] } as never })
})

describe("WorkflowRow", () => {
  it("renders the name and a checkbox", () => {
    render(<WorkflowRow workflow={makeWorkflow()} />)
    expect(screen.getByTestId("workflow-row-wf_a")).toHaveTextContent("Daily digest")
    expect(screen.getByTestId("workflow-select-wf_a")).toBeInTheDocument()
  })

  it("shows the run-count badge and last-run status when provided", () => {
    render(<WorkflowRow workflow={makeWorkflow()} runCount={5} lastStatus="succeeded" />)
    expect(screen.getByTestId("workflow-runcount-wf_a")).toHaveTextContent("5")
    expect(screen.getByTestId("run-status-succeeded")).toBeInTheDocument()
  })

  it("selects instead of navigating in selection mode", () => {
    useWorkflowLibraryStore.setState({ selectionMode: true })
    render(<WorkflowRow workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-open-wf_a"))
    expect(useWorkflowLibraryStore.getState().selection.has("wf_a")).toBe(true)
  })

  it("shows the pinned indicator when pinned", () => {
    useSettingsStore.setState({ settings: { pinnedWorkflowIds: ["wf_a"] } as never })
    render(<WorkflowRow workflow={makeWorkflow()} />)
    expect(screen.getByTestId("workflow-pinned-wf_a")).toBeInTheDocument()
  })

  it("activates navigation when clicked outside selection mode", () => {
    render(<WorkflowRow workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-open-wf_a"))
    expect(useWorkflowLibraryStore.getState().selection.size).toBe(0)
  })

  it("activates from anywhere on the row, not just the title", () => {
    useWorkflowLibraryStore.setState({ selectionMode: true })
    render(<WorkflowRow workflow={makeWorkflow()} />)
    fireEvent.click(screen.getByTestId("workflow-row-wf_a"))
    expect(useWorkflowLibraryStore.getState().selection.has("wf_a")).toBe(true)
  })

  it("does not activate the row when opening the actions menu", async () => {
    const user = userEvent.setup()
    useWorkflowLibraryStore.setState({ selectionMode: true })
    render(<WorkflowRow workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-row-menu-wf_a"))
    expect(useWorkflowLibraryStore.getState().selection.has("wf_a")).toBe(false)
  })

  it("routes delete through the store from the menu", async () => {
    const user = userEvent.setup()
    render(<WorkflowRow workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-row-menu-wf_a"))
    fireEvent.click(await screen.findByTestId("workflow-action-delete-wf_a"))
    expect(useWorkflowLibraryStore.getState().deleteDialogTarget).toEqual({ ids: ["wf_a"] })
  })

  it("opens the rename dialog from the menu", async () => {
    const user = userEvent.setup()
    render(<WorkflowRow workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-row-menu-wf_a"))
    fireEvent.click(await screen.findByTestId("workflow-action-rename-wf_a"))
    expect(await screen.findByTestId("workflow-rename-input")).toBeInTheDocument()
  })

  it("opens the run dialog from the menu", async () => {
    const user = userEvent.setup()
    render(<WorkflowRow workflow={makeWorkflow()} />)
    await user.click(screen.getByTestId("workflow-row-menu-wf_a"))
    fireEvent.click(await screen.findByTestId("workflow-action-run-wf_a"))
    expect(await screen.findByTestId("workflow-run-dialog")).toBeInTheDocument()
  })
})
