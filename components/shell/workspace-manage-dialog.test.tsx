/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

/**
 * "Browse server" walks the paired host, so the button is gated on that host
 * publishing `fs_list_workspace_dir`. The gate reads a runtime snapshot the
 * suite has no reason to assemble, so it is driven directly. Default: paired
 * and able, which is what every pre-existing web case here assumes.
 */
const browseAvailable = { value: true }
jest.mock("@/hooks/workspace/use-workspace-command-gate", () => ({
  useWorkspaceCommandGate: () => () =>
    browseAvailable.value
      ? { available: true, reason: null }
      : { available: false, reason: "pair a desktop first" },
}))

jest.mock("@/lib/claude/ipc", () => ({
  defaultExportDir: jest.fn(),
}))

jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceDir: jest.fn(),
  // The picker asks the host which roots it will even admit to before it lists
  // anything. Absent from this mock, every web case died on "not a function"
  // inside the picker rather than on anything this suite is about.
  listWorkspaceRoots: jest.fn(async () => []),
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
const originalDeleteProject = useProjectStore.getState().deleteProject

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
    useProjectStore.setState({
      projects: [],
      activeProjectId: null,
      loaded: false,
      deleteProject: originalDeleteProject,
    })
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

    // The picker passes `(root, relPath)`. Only the root is this test's subject,
    // so match on it rather than pinning an arity that is the picker's business.
    await waitFor(() => expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv", undefined))
    // The picker asks the host for its roots before it lists anything, so the
    // first entry appears a tick after the listing call resolves. `find*`
    // rather than `get*`, which raced that render.
    fireEvent.click(await screen.findByRole("button", { name: "openFolder" }))
    await waitFor(() =>
      expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv/projects", undefined)
    )
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

  it("removes a workspace after a confirm click, keeping its conversations", async () => {
    const removals: unknown[][] = []
    const original = useProjectStore.getState().deleteProject
    useProjectStore.setState({
      deleteProject: (...args: Parameters<typeof original>) => {
        removals.push(args)
        return original(...args)
      },
    })
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    expect(useProjectStore.getState().projects).toHaveLength(1)
    // First click arms the confirm, second removes.
    fireEvent.click(screen.getByTestId("workspace-delete"))
    await act(async () => fireEvent.click(screen.getByTestId("workspace-delete")))
    expect(useProjectStore.getState().projects).toHaveLength(0)
    // Removing a workspace is not the same decision as destroying what was in
    // it, so the plain confirm must not take the destructive reading.
    expect(removals.at(-1)?.[1]).toBe("detach")
  })

  it("offers destroying the contents as a separate, explicit action", async () => {
    const removals: unknown[][] = []
    const original = useProjectStore.getState().deleteProject
    useProjectStore.setState({
      deleteProject: (...args: Parameters<typeof original>) => {
        removals.push(args)
        return original(...args)
      },
    })
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    // The destructive option only appears once the confirm is armed.
    expect(screen.queryByTestId("workspace-delete-data")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-delete"))
    await act(async () => fireEvent.click(screen.getByTestId("workspace-delete-data")))
    expect(useProjectStore.getState().projects).toHaveLength(0)
    expect(removals.at(-1)?.[1]).toBe("delete-data")
  })

  it("waits for cleanup and retains the editor for retry after a failure", async () => {
    let fail!: (error: Error) => void
    const remove = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        })
    )
    useProjectStore.setState({ deleteProject: remove })
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    fireEvent.click(screen.getByTestId("workspace-delete"))
    fireEvent.click(screen.getByTestId("workspace-delete-data"))
    expect(screen.getByTestId("workspace-delete")).toBeDisabled()
    expect(screen.getByTestId("workspace-delete-data")).toBeDisabled()
    expect(toastSuccess).not.toHaveBeenCalled()
    await act(async () => fail(new Error("External task is still active")))
    expect(toastError).toHaveBeenCalledWith("deleteFailed")
    expect(useProjectStore.getState().projects).toHaveLength(1)
    expect(screen.getByLabelText("nameLabel")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-delete-data")).toBeEnabled()
  })

  it("sets the active workspace from the editor", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    const id = useProjectStore.getState().projects[0].id
    fireEvent.click(screen.getByText("setActive"))
    expect(useProjectStore.getState().activeProjectId).toBe(id)
  })
})

describe("WorkspaceManageDialog draft state", () => {
  it("keeps Save inert until the draft differs from what is stored", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    // A freshly created workspace is already saved — offering Save here is an
    // enabled button that does nothing.
    expect(screen.getByTestId("workspace-save")).toBeDisabled()
    expect(screen.queryByTestId("workspace-unsaved")).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Backend" } })
    expect(screen.getByTestId("workspace-save")).toBeEnabled()
    expect(screen.getByTestId("workspace-unsaved")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-save"))
    expect(screen.getByTestId("workspace-save")).toBeDisabled()
    expect(screen.queryByTestId("workspace-unsaved")).not.toBeInTheDocument()
  })

  /**
   * The draft used to be thrown away in silence: the selection effect reset the
   * form and nothing said an edited name had just been lost.
   */
  it("asks before a selection change throws an edited draft away", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    const first = useProjectStore.getState().projects[0].id
    fireEvent.click(screen.getByTestId("workspace-new"))
    const second = useProjectStore.getState().projects[1].id

    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Edited" } })
    fireEvent.click(screen.getByTestId(`workspace-row-${first}`))

    // Still on the edited one, with the question in front of the reader.
    expect(screen.getByTestId("workspace-discard-confirm")).toBeInTheDocument()
    expect(screen.getByLabelText("nameLabel")).toHaveValue("Edited")

    fireEvent.click(screen.getByTestId("workspace-discard-confirm"))
    expect(screen.getByLabelText("nameLabel")).toHaveValue("defaultName")
    expect(useProjectStore.getState().projects.find((p) => p.id === second)?.name).toBe(
      "defaultName"
    )
  })

  it("switches straight through when the draft is clean", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    const first = useProjectStore.getState().projects[0].id
    fireEvent.click(screen.getByTestId("workspace-new"))

    fireEvent.click(screen.getByTestId(`workspace-row-${first}`))
    expect(screen.queryByTestId("workspace-discard-confirm")).not.toBeInTheDocument()
  })
})

describe("WorkspaceManageDialog delete confirmation", () => {
  /**
   * Armed, the footer used to hold two destructive buttons and no way out, so
   * the only exit from a mis-clicked Delete was to pick one of them.
   */
  it("offers a way out of the armed state", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    fireEvent.click(screen.getByTestId("workspace-delete"))
    expect(screen.getByTestId("workspace-delete-confirm")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-delete-cancel"))
    expect(screen.queryByTestId("workspace-delete-confirm")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-delete-data")).not.toBeInTheDocument()
    expect(useProjectStore.getState().projects).toHaveLength(1)
  })
})

describe("WorkspaceManageDialog list filtering", () => {
  function seed(names: string[]) {
    act(() => {
      for (const name of names) useProjectStore.getState().createProject({ name })
    })
  }

  it("withholds the filter field until the roster is worth filtering", () => {
    seed(["Alpha", "Beta"])
    renderDialog()
    expect(screen.queryByTestId("workspace-manage-search")).not.toBeInTheDocument()
  })

  it("filters the roster by name and says so when nothing matches", () => {
    seed(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"])
    renderDialog()

    const ids = Object.fromEntries(
      useProjectStore.getState().projects.map((p) => [p.name, p.id] as const)
    )
    fireEvent.change(screen.getByTestId("workspace-manage-search"), { target: { value: "eta" } })
    expect(screen.getByTestId(`workspace-row-${ids.Beta}`)).toBeInTheDocument()
    expect(screen.getByTestId(`workspace-row-${ids.Zeta}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`workspace-row-${ids.Alpha}`)).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId("workspace-manage-search"), {
      target: { value: "nothing-matches" },
    })
    expect(screen.getByTestId("workspace-manage-no-matches")).toBeInTheDocument()
  })
})

describe("WorkspaceManageDialog browse gating", () => {
  afterEach(() => {
    browseAvailable.value = true
  })

  it("says why browsing is unavailable instead of opening a picker with nothing to list", () => {
    isTauriMock.mockReturnValue(false)
    browseAvailable.value = false

    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    expect(screen.getByTestId("workspace-manage-browse")).toBeDisabled()
    // Stated, not only hovered: a disabled button has no hover on a phone.
    expect(screen.getByTestId("workspace-manage-browse-reason")).toHaveTextContent(
      "pair a desktop first"
    )
  })

  it("still lets a path be typed by hand with no host at all", () => {
    isTauriMock.mockReturnValue(false)
    browseAvailable.value = false

    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    fireEvent.change(screen.getByPlaceholderText("addRootManual"), {
      target: { value: "/srv/typed" },
    })

    // Typing needs no host. Only browsing does, which is why the button
    // reactivates the moment there is something to add.
    expect(screen.getByTestId("workspace-manage-browse")).not.toBeDisabled()
  })
})
