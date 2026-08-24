/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

jest.mock("@/lib/claude/ipc", () => ({
  defaultExportDir: jest.fn(),
}))

jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceDir: jest.fn(),
}))

const openDialogMock = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialogMock(...a) }))

const isTrustedMock = jest.fn(() => new Promise<boolean>(() => {}))
const trustMock = jest.fn(async () => undefined)
const revokeMock = jest.fn(async () => undefined)
jest.mock("@/lib/db/trusted-workspaces", () => ({
  isWorkspaceTrusted: (...a: unknown[]) => isTrustedMock(...(a as [])),
  trustWorkspace: (...a: unknown[]) => trustMock(...(a as [])),
  revokeWorkspaceTrust: (...a: unknown[]) => revokeMock(...(a as [])),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

jest.mock("@cognia/logging", () => ({
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

const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri
const defaultExportDirMock = (
  jest.requireMock("@/lib/claude/ipc") as { defaultExportDir: jest.Mock }
).defaultExportDir
const listWorkspaceDirMock = (
  jest.requireMock("@/lib/files/workspace-fs") as { listWorkspaceDir: jest.Mock }
).listWorkspaceDir

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  defaultExportDirMock.mockReset()
  listWorkspaceDirMock.mockReset()
  openDialogMock.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
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

  it("renames + adds roots and persists via updateProject on save", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Backend" } })

    // Add two roots via the manual input — the first becomes primary.
    const manual = screen.getByPlaceholderText("addRootManual")
    fireEvent.change(manual, { target: { value: "/srv/api" } })
    fireEvent.keyDown(manual, { key: "Enter" })
    fireEvent.change(manual, { target: { value: "/srv/shared" } })
    fireEvent.keyDown(manual, { key: "Enter" })
    expect(screen.getByText("/srv/api")).toBeInTheDocument()
    expect(screen.getByText("/srv/shared")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-save"))

    const p = useProjectStore.getState().projects[0]
    expect(p.name).toBe("Backend")
    expect(p.rootDir).toBe("/srv/api")
    expect(p.additionalDirs).toEqual(["/srv/shared"])
    expect(p.roots.map((r) => r.path)).toEqual(["/srv/api", "/srv/shared"])
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("picks roots via the native multi-select dialog on desktop", async () => {
    openDialogMock.mockResolvedValue(["/picked/a", "/picked/b"])
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    await act(async () => {
      fireEvent.click(screen.getByLabelText("pickDir"))
    })
    expect(screen.getByText("/picked/a")).toBeInTheDocument()
    expect(screen.getByText("/picked/b")).toBeInTheDocument()
  })

  it("hides the native picker on web (manual path entry still works)", () => {
    isTauriMock.mockReturnValue(false)
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    expect(screen.queryByLabelText("pickDir")).not.toBeInTheDocument()
    // Manual add still functions.
    const manual = screen.getByPlaceholderText("addRootManual")
    fireEvent.change(manual, { target: { value: "/web/dir" } })
    fireEvent.click(screen.getByText("addRoot"))
    expect(screen.getByText("/web/dir")).toBeInTheDocument()
  })

  it("opens the server folder picker on web before backend readiness is known", () => {
    isTauriMock.mockReturnValue(false)
    defaultExportDirMock.mockImplementation(() => new Promise<string>(() => {}))

    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    fireEvent.click(screen.getByRole("button", { name: "browseServer" }))

    expect(screen.getByRole("dialog", { name: "title" })).toBeInTheDocument()
    expect(toastError).not.toHaveBeenCalled()
  })

  it("browses the paired Headless filesystem and adds the selected folder on web", async () => {
    isTauriMock.mockReturnValue(false)
    defaultExportDirMock.mockResolvedValue("/srv")
    listWorkspaceDirMock
      .mockResolvedValueOnce([
        {
          relPath: "projects",
          absolutePath: "/srv/projects",
          isDir: true,
          size: 0,
          mtimeMs: null,
        },
      ])
      .mockResolvedValueOnce([])

    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    fireEvent.click(screen.getByRole("button", { name: "browseServer" }))

    await waitFor(() => expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv"))
    fireEvent.click(screen.getByRole("button", { name: "openFolder" }))
    await waitFor(() => expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv/projects"))
    await waitFor(() => expect(screen.getByLabelText("pathLabel")).toHaveValue("/srv/projects"))
    fireEvent.click(screen.getByRole("button", { name: "chooseCurrent" }))

    await waitFor(() => expect(screen.getByText("/srv/projects")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("workspace-save"))
    expect(useProjectStore.getState().projects[0].rootDir).toBe("/srv/projects")
  })

  it("switches the primary root", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    const manual = screen.getByPlaceholderText("addRootManual")
    fireEvent.change(manual, { target: { value: "/a" } })
    fireEvent.keyDown(manual, { key: "Enter" })
    fireEvent.change(manual, { target: { value: "/b" } })
    fireEvent.keyDown(manual, { key: "Enter" })

    // Make the second root primary, then save.
    const primaryButtons = screen.getAllByLabelText("setPrimary")
    fireEvent.click(primaryButtons[1])
    fireEvent.click(screen.getByTestId("workspace-save"))

    const p = useProjectStore.getState().projects[0]
    expect(p.rootDir).toBe("/b")
    expect(p.additionalDirs).toEqual(["/a"])
  })

  it("removes a root", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    const manual = screen.getByPlaceholderText("addRootManual")
    fireEvent.change(manual, { target: { value: "/to/remove" } })
    fireEvent.keyDown(manual, { key: "Enter" })
    expect(screen.getByText("/to/remove")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("removeRoot"))
    expect(screen.queryByText("/to/remove")).not.toBeInTheDocument()
  })

  it("trusts a root via the per-folder button", async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    const manual = screen.getByPlaceholderText("addRootManual")
    fireEvent.change(manual, { target: { value: "/trust/me" } })
    fireEvent.keyDown(manual, { key: "Enter" })
    await act(async () => {
      fireEvent.click(screen.getByText("trustRoot"))
    })
    expect(trustMock).toHaveBeenCalledWith("/trust/me")
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
