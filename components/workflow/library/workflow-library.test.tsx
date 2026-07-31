/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { WorkflowLibrary } from "./workflow-library"
import { createFolder } from "@/lib/db/workflow-folders"
import { createWorkflow, listWorkflows } from "@/lib/db/workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { DEFAULT_WORKFLOW_FILTERS, useWorkflowLibraryStore } from "@/stores/workflow"
import { useSettingsStore } from "@/stores/settings/settings-store"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  await getDb().workflowFolders.clear()
  useSettingsStore.setState({ settings: { pinnedWorkflowIds: [] } as never })
  useWorkflowLibraryStore.setState({
    viewMode: "grid",
    sort: "updated",
    filters: { ...DEFAULT_WORKFLOW_FILTERS },
    query: "",
    currentFolderId: ROOT_FOLDER_ID,
    selection: new Set<string>(),
    selectionMode: false,
    moveDialogTarget: null,
    deleteDialogTarget: null,
    tagDialogTarget: null,
    createFolderParentId: null,
    renameFolderTarget: null,
  })
})

describe("WorkflowLibrary", () => {
  it("groups the library identity, search, and actions without a redundant root breadcrumb", async () => {
    const folder = await createFolder({ name: "Reports" })
    const wf = await createWorkflow({ name: "Daily digest" })
    render(<WorkflowLibrary />)

    const header = screen.getByRole("banner")
    expect(within(header).getByRole("heading", { name: "Workflows" })).toBeInTheDocument()
    expect(within(header).queryByTestId("workflow-breadcrumb-root")).not.toBeInTheDocument()
    expect(within(header).getByTestId("workflow-library-search")).toBeInTheDocument()
    expect(within(header).getByTestId("workflow-new")).toBeInTheDocument()
    expect(await screen.findByTestId(`workflow-folder-card-${folder.id}`)).toBeInTheDocument()
    expect(await screen.findByTestId(`workflow-card-${wf.id}`)).toBeInTheDocument()
  })

  it("shows the empty root state when the library is empty", async () => {
    render(<WorkflowLibrary />)
    expect(await screen.findByTestId("workflow-empty-root")).toBeInTheDocument()
  })

  it("renders the list layout when the view mode is list", async () => {
    useWorkflowLibraryStore.setState({ viewMode: "list" })
    await createWorkflow({ name: "WF" })
    render(<WorkflowLibrary />)
    expect(await screen.findByTestId("workflow-library-list")).toBeInTheDocument()
  })

  it("shows the filtered empty state when a search matches nothing", async () => {
    await createWorkflow({ name: "Alpha" })
    useWorkflowLibraryStore.setState({ query: "zzzznomatch" })
    render(<WorkflowLibrary />)
    expect(await screen.findByTestId("workflow-empty-filtered")).toBeInTheDocument()
  })

  it("shows the empty-folder state inside an empty folder", async () => {
    const folder = await createFolder({ name: "Empty" })
    useWorkflowLibraryStore.setState({ currentFolderId: folder.id })
    render(<WorkflowLibrary />)
    expect(await screen.findByTestId("workflow-empty-folder")).toBeInTheDocument()
    const header = screen.getByRole("banner")
    expect(within(header).getByTestId("workflow-breadcrumb-root")).toBeInTheDocument()
    expect(within(header).getByTestId(`workflow-breadcrumb-${folder.id}`)).toBeInTheDocument()
  })

  it("applies the recently-failed filter and runCount sort without error", async () => {
    await createWorkflow({ name: "WF" })
    useWorkflowLibraryStore.setState({
      sort: "runCount",
      filters: { type: "all", hasTrigger: false, recentlyFailed: true },
    })
    render(<WorkflowLibrary />)
    // With the filter on and no failed runs, the filtered empty state shows.
    expect(await screen.findByTestId("workflow-empty-filtered")).toBeInTheDocument()
  })

  it("imports workflows from a picked JSON file into the current folder", async () => {
    render(<WorkflowLibrary />)
    await screen.findByTestId("workflow-empty-root")
    const json = JSON.stringify({
      name: "Imported WF",
      nodes: [],
      edges: [],
      complexity: "advanced",
      variables: { REGION: "eu" },
      pinData: { preview: { value: 1 } },
      staticData: { cursor: 4 },
      interface: { inputSchema: { type: "object" } },
      published: { at: 1, toolName: "source_tool" },
    })
    const file = new File([json], "imported.json", { type: "application/json" })
    fireEvent.change(screen.getByTestId("workflow-import-input"), { target: { files: [file] } })
    await waitFor(async () => {
      const all = await listWorkflows()
      const imported = all.find((w) => w.name === "Imported WF")
      expect(imported).toMatchObject({
        complexity: "advanced",
        variables: { REGION: "eu" },
        pinData: { preview: { value: 1 } },
        staticData: { cursor: 4 },
        interface: { inputSchema: { type: "object" } },
      })
      expect(imported?.published).toBeUndefined()
    })
  })

  it("returns to root when the current folder no longer exists", async () => {
    useWorkflowLibraryStore.setState({ currentFolderId: "wff_ghost" })
    render(<WorkflowLibrary />)
    await waitFor(() => {
      expect(useWorkflowLibraryStore.getState().currentFolderId).toBe(ROOT_FOLDER_ID)
    })
  })
})
