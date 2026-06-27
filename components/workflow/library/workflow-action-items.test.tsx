/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import type { WorkflowRow } from "@/types/workflow/visual"
import { WorkflowActionItems } from "./workflow-action-items"
import { createWorkflow, listWorkflows } from "@/lib/db/workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { useSettingsStore } from "@/stores/settings/settings-store"

const saveMock = jest.fn(async () => {})

function makeWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: "wf_a",
    schemaVersion: 1,
    name: "WF",
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

function renderItems(workflow: WorkflowRow) {
  const onRun = jest.fn()
  const onRename = jest.fn()
  const onEditTags = jest.fn()
  const onDelete = jest.fn()
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <WorkflowActionItems
          workflow={workflow}
          Item={DropdownMenuItem}
          Separator={DropdownMenuSeparator}
          onRun={onRun}
          onRename={onRename}
          onEditTags={onEditTags}
          onDelete={onDelete}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return { onRun, onRename, onEditTags, onDelete }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  saveMock.mockClear()
  useWorkflowLibraryStore.setState({ moveDialogTarget: null })
  useSettingsStore.setState({
    settings: { pinnedWorkflowIds: [] } as never,
    save: saveMock as never,
  })
})

describe("WorkflowActionItems", () => {
  it("opens the move dialog for the workflow", async () => {
    renderItems(makeWorkflow())
    fireEvent.click(await screen.findByTestId("workflow-action-move-wf_a"))
    expect(useWorkflowLibraryStore.getState().moveDialogTarget).toEqual({ ids: ["wf_a"] })
  })

  it("fires the rename callback", async () => {
    const { onRename } = renderItems(makeWorkflow())
    fireEvent.click(await screen.findByTestId("workflow-action-rename-wf_a"))
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it("fires the edit-tags callback", async () => {
    const { onEditTags } = renderItems(makeWorkflow())
    fireEvent.click(await screen.findByTestId("workflow-action-tags-wf_a"))
    expect(onEditTags).toHaveBeenCalledTimes(1)
  })

  it("pins the workflow through settings", async () => {
    renderItems(makeWorkflow())
    fireEvent.click(await screen.findByTestId("workflow-action-pin-wf_a"))
    expect(saveMock).toHaveBeenCalledWith({ pinnedWorkflowIds: ["wf_a"] })
  })

  it("fires the delete callback", async () => {
    const { onDelete } = renderItems(makeWorkflow())
    fireEvent.click(await screen.findByTestId("workflow-action-delete-wf_a"))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it("duplicates the workflow", async () => {
    const wf = await createWorkflow({ name: "Original" })
    renderItems(wf as WorkflowRow)
    fireEvent.click(await screen.findByText("Duplicate"))
    await waitFor(async () => {
      expect((await listWorkflows()).length).toBe(2)
    })
  })

  it("saves the workflow as a template", async () => {
    const wf = await createWorkflow({ name: "Original" })
    renderItems(wf as WorkflowRow)
    fireEvent.click(await screen.findByTestId(`workflow-action-save-template-${wf.id}`))
    await waitFor(async () => {
      const all = await listWorkflows()
      expect(all.some((w) => w.isTemplate && w.name === "Original (template)")).toBe(true)
    })
  })

  it("shows Unpin for an already-pinned workflow", async () => {
    useSettingsStore.setState({ settings: { pinnedWorkflowIds: ["wf_a"] } as never })
    renderItems(makeWorkflow())
    expect(await screen.findByTestId("workflow-action-pin-wf_a")).toHaveTextContent("Unpin")
  })
})
