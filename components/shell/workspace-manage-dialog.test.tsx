/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const openDialogMock = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialogMock(...a) }))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: jest.fn() },
}))

jest.mock("@/lib/logging", () => ({
  loggers: { shell: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))

// Keep the store off Dexie — persistence is exercised in the store's own tests.
jest.mock("@/lib/db/projects", () => ({
  getAllProjects: jest.fn(async () => []),
  loadActiveProjectId: jest.fn(async () => null),
  putProject: jest.fn(async () => undefined),
  deleteProjectRow: jest.fn(async () => undefined),
  persistActiveProjectId: jest.fn(async () => undefined),
}))

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchProjectCreate: jest.fn(async () => undefined),
    dispatchProjectUpdate: jest.fn(async () => undefined),
    dispatchProjectDelete: jest.fn(async () => undefined),
    dispatchProjectSwitch: jest.fn(),
    dispatchKnowledgeFileAdd: jest.fn(async () => undefined),
    dispatchKnowledgeFileRemove: jest.fn(),
    dispatchSessionLinked: jest.fn(),
    dispatchSessionUnlinked: jest.fn(),
  }),
}))

import { WorkspaceManageDialog } from "./workspace-manage-dialog"
import { useProjectStore } from "@/stores/project/project-store"

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  openDialogMock.mockReset()
  toastSuccess.mockReset()
  act(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })
})

function renderDialog() {
  return render(<WorkspaceManageDialog open onOpenChange={jest.fn()} />)
}

describe("WorkspaceManageDialog", () => {
  it("creates a workspace via 'New' and opens it in the editor", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    expect(useProjectStore.getState().projects).toHaveLength(1)
    // Editor fields appear once a workspace is selected.
    expect(screen.getByLabelText("nameLabel")).toBeInTheDocument()
  })

  it("auto-creates and selects a workspace when opened with autoCreateOnOpen", () => {
    render(<WorkspaceManageDialog open autoCreateOnOpen onOpenChange={jest.fn()} />)
    expect(useProjectStore.getState().projects).toHaveLength(1)
    expect(screen.getByLabelText("nameLabel")).toBeInTheDocument()
  })

  it("renames + sets rootDir/additionalDirs and persists via updateProject on save", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Backend" } })
    fireEvent.change(screen.getByLabelText("rootDirLabel"), { target: { value: "/srv/api" } })

    // Add an additional dir via the manual input.
    const manual = screen.getByPlaceholderText("addDirManual")
    fireEvent.change(manual, { target: { value: "/srv/shared" } })
    fireEvent.keyDown(manual, { key: "Enter" })
    expect(screen.getByText("/srv/shared")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-save"))

    const p = useProjectStore.getState().projects[0]
    expect(p.name).toBe("Backend")
    expect(p.rootDir).toBe("/srv/api")
    expect(p.additionalDirs).toEqual(["/srv/shared"])
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("picks the primary directory via the native dialog on desktop", async () => {
    openDialogMock.mockResolvedValue("/picked/dir")
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    await act(async () => {
      fireEvent.click(screen.getByLabelText("pickDir"))
    })
    expect((screen.getByLabelText("rootDirLabel") as HTMLInputElement).value).toBe("/picked/dir")
  })

  it("hides the native picker on web (manual path entry still works)", () => {
    isTauriMock.mockReturnValue(false)
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    expect(screen.queryByLabelText("pickDir")).not.toBeInTheDocument()
    // Manual add still functions.
    const manual = screen.getByPlaceholderText("addDirManual")
    fireEvent.change(manual, { target: { value: "/web/dir" } })
    fireEvent.click(screen.getByText("addDir"))
    expect(screen.getByText("/web/dir")).toBeInTheDocument()
  })

  it("removes an additional directory", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    const manual = screen.getByPlaceholderText("addDirManual")
    fireEvent.change(manual, { target: { value: "/to/remove" } })
    fireEvent.keyDown(manual, { key: "Enter" })
    expect(screen.getByText("/to/remove")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("removeDir"))
    expect(screen.queryByText("/to/remove")).not.toBeInTheDocument()
  })

  it("deletes a workspace after a confirm click", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    expect(useProjectStore.getState().projects).toHaveLength(1)
    // First click arms the confirm, second deletes.
    fireEvent.click(screen.getByTestId("workspace-delete"))
    fireEvent.click(screen.getByTestId("workspace-delete"))
    expect(useProjectStore.getState().projects).toHaveLength(0)
  })

  it("sets the active workspace from the editor", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    const id = useProjectStore.getState().projects[0].id
    fireEvent.click(screen.getByText("setActive"))
    expect(useProjectStore.getState().activeProjectId).toBe(id)
  })
})
