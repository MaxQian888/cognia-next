/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { WorkflowListToolbar } from "./workflow-list-toolbar"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { DEFAULT_WORKFLOW_FILTERS, useWorkflowLibraryStore } from "@/stores/workflow"
import { useSettingsStore } from "@/stores/settings/settings-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async () => {})

beforeEach(() => {
  saveMock.mockClear()
  useWorkflowLibraryStore.setState({
    currentFolderId: ROOT_FOLDER_ID,
    query: "",
    sort: "updated",
    filters: DEFAULT_WORKFLOW_FILTERS,
    createFolderParentId: null,
  })
  useSettingsStore.setState({
    settings: { mobileWorkflowView: "comfortable" } as never,
    save: saveMock as never,
  })
})

describe("WorkflowListToolbar", () => {
  it("renders search, sort, filter, density and create controls", () => {
    render(<WorkflowListToolbar onNewWorkflow={jest.fn()} />)
    expect(screen.getByTestId("mobile-workflow-search")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-sort-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-filter-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-workflow-density")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-workflow-new-folder")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-workflow-new")).toBeInTheDocument()
  })

  it("debounces the search into the store query", async () => {
    render(<WorkflowListToolbar onNewWorkflow={jest.fn()} />)
    fireEvent.change(screen.getByTestId("mobile-workflow-search"), { target: { value: "digest" } })
    await waitFor(() => expect(useWorkflowLibraryStore.getState().query).toBe("digest"))
  })

  it("toggles density via the settings store", () => {
    render(<WorkflowListToolbar onNewWorkflow={jest.fn()} />)
    fireEvent.click(screen.getByTestId("mobile-workflow-density"))
    expect(saveMock).toHaveBeenCalledWith({ mobileWorkflowView: "compact" })
  })

  it("opens create-folder for the current folder", () => {
    useWorkflowLibraryStore.setState({ currentFolderId: "f1" })
    render(<WorkflowListToolbar onNewWorkflow={jest.fn()} />)
    fireEvent.click(screen.getByTestId("mobile-workflow-new-folder"))
    expect(useWorkflowLibraryStore.getState().createFolderParentId).toBe("f1")
  })

  it("fires onNewWorkflow", () => {
    const onNew = jest.fn()
    render(<WorkflowListToolbar onNewWorkflow={onNew} />)
    fireEvent.click(screen.getByTestId("mobile-workflow-new"))
    expect(onNew).toHaveBeenCalled()
  })
})
