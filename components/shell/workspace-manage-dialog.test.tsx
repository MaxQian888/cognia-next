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

// The removal guard asks which of the workspace's conversations are running.
const listWorkspaceSessionsMock = jest.fn(
  async (_projectId: string) => [] as { id: string; projectId?: string }[]
)
jest.mock("@/lib/db/sessions", () => ({
  listWorkspaceSessions: (projectId: string) => listWorkspaceSessionsMock(projectId),
}))
const hasActiveSessionMock = jest.fn((_sessionId: string) => false)
jest.mock("@/lib/execution/broker", () => ({
  getExecutionBroker: () => ({
    hasActiveSession: (sessionId: string) => hasActiveSessionMock(sessionId),
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
  listWorkspaceSessionsMock.mockReset().mockResolvedValue([])
  hasActiveSessionMock.mockReset().mockReturnValue(false)
  act(() => {
    useProjectStore.setState({
      projects: [],
      activeProjectId: null,
      loaded: false,
      deleteProject: originalDeleteProject,
    })
  })
})

function renderDialog(props: { initialId?: string; onOpenChange?: (open: boolean) => void } = {}) {
  return render(
    <WorkspaceManageDialog
      open
      onOpenChange={props.onOpenChange ?? jest.fn()}
      initialId={props.initialId}
    />
  )
}

/** Seed stored workspaces; returns their ids in order. */
function seed(...names: string[]): string[] {
  let ids: string[] = []
  act(() => {
    ids = names.map((name) => useProjectStore.getState().createProject({ name }).id)
  })
  return ids
}

/** Open the dialog on one stored workspace. */
function renderEditing(name = "Stored") {
  const [id] = seed(name)
  const view = renderDialog({ initialId: id })
  return { id, ...view }
}

function addManualRoot(path: string) {
  const manual = screen.getByPlaceholderText("addRootManual")
  fireEvent.change(manual, { target: { value: path } })
  fireEvent.keyDown(manual, { key: "Enter" })
}

describe("WorkspaceManageDialog", () => {
  it("opens a draft on 'New' and writes the row only on Create", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    // A draft, not a row: abandoning it used to leave a rootless workspace behind.
    expect(useProjectStore.getState().projects).toHaveLength(0)
    expect(screen.getByLabelText("nameLabel")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-knowledge-after-create")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-delete")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-save"))

    const [created] = useProjectStore.getState().projects
    expect(created.name).toBe("defaultName")
    expect(toastSuccess).toHaveBeenCalledWith("created")
    // The editor stays on what it just created, now as a stored row.
    expect(screen.getByTestId(`workspace-row-${created.id}`)).toBeInTheDocument()
    expect(screen.getByTestId("workspace-save")).toHaveTextContent("save")
    expect(screen.queryByTestId("workspace-knowledge-after-create")).not.toBeInTheDocument()
  })

  it("opens on the workspace it was asked for, else on the active one", () => {
    const [a, b] = seed("Alpha", "Beta")
    act(() => useProjectStore.getState().setActiveProject(a))

    const { unmount } = renderDialog({ initialId: b })
    expect(screen.getByLabelText("nameLabel")).toHaveValue("Beta")
    unmount()

    renderDialog()
    expect(screen.getByLabelText("nameLabel")).toHaveValue("Alpha")
  })

  it("creates with name, description, tags, instructions and roots in one save", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Backend" } })
    fireEvent.change(screen.getByLabelText("descriptionLabel"), {
      target: { value: "  Billing API  " },
    })
    const tagInput = screen.getByLabelText("tagsLabel")
    fireEvent.change(tagInput, { target: { value: "api, billing" } })
    fireEvent.keyDown(tagInput, { key: "Enter" })
    fireEvent.change(screen.getByLabelText("instructionsLabel"), {
      target: { value: "Use pnpm." },
    })
    addManualRoot("/srv/api")
    addManualRoot("/srv/shared")
    expect(screen.getByText("/srv/api")).toBeInTheDocument()
    expect(screen.getByText("/srv/shared")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-save"))

    const p = useProjectStore.getState().projects[0]
    expect(p.name).toBe("Backend")
    expect(p.description).toBe("Billing API")
    expect(p.tags).toEqual(["api", "billing"])
    expect(p.customInstructions).toBe("Use pnpm.")
    expect(p.rootDir).toBe("/srv/api")
    expect(p.additionalDirs).toEqual(["/srv/shared"])
    expect(p.roots.map((r) => r.path)).toEqual(["/srv/api", "/srv/shared"])
  })

  it("edits a stored workspace's fields through updateProject", () => {
    const { id } = renderEditing("Stored")
    fireEvent.change(screen.getByLabelText("instructionsLabel"), {
      target: { value: "Never touch prod." },
    })
    const tagInput = screen.getByLabelText("tagsLabel")
    fireEvent.change(tagInput, { target: { value: "ops" } })
    fireEvent.keyDown(tagInput, { key: "," })
    fireEvent.click(screen.getByRole("button", { name: "removeTag" }))
    fireEvent.change(tagInput, { target: { value: "infra" } })
    fireEvent.blur(tagInput)

    fireEvent.click(screen.getByTestId("workspace-save"))

    const p = useProjectStore.getState().projects.find((q) => q.id === id)!
    expect(p.customInstructions).toBe("Never touch prod.")
    expect(p.tags).toEqual(["infra"])
    expect(toastSuccess).toHaveBeenCalledWith("saved")
  })

  /**
   * The send path refuses a prompt carrying an email or key, and these
   * instructions ride every turn. Saved, one pasted address would break every
   * conversation in the workspace far from its cause.
   */
  it("will not save instructions the send gate would refuse, and says why", () => {
    const { id } = renderEditing("Stored")
    const field = screen.getByLabelText("instructionsLabel")

    fireEvent.change(field, { target: { value: "Mail ops@example.com on failure." } })
    expect(screen.getByTestId("workspace-instructions-pii")).toHaveTextContent("instructionsPii")
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByTestId("workspace-save")).toBeDisabled()

    fireEvent.change(field, { target: { value: "Page the on-call channel on failure." } })
    expect(screen.queryByTestId("workspace-instructions-pii")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-save"))
    expect(useProjectStore.getState().projects.find((p) => p.id === id)?.customInstructions).toBe(
      "Page the on-call channel on failure."
    )
  })

  it("picks roots via the native multi-select dialog on desktop", async () => {
    openDialogMock.mockResolvedValue(["/picked/a", "/picked/b"])
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))

    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-manage-pick"))
    })
    expect(screen.getByText("/picked/a")).toBeInTheDocument()
    expect(screen.getByText("/picked/b")).toBeInTheDocument()
  })

  it("names the picker button by what it shows", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    // The accessible name used to be "Choose directory" on a button reading
    // "Add folder", so a screen reader and the screen disagreed.
    expect(screen.getByTestId("workspace-manage-pick")).toHaveAccessibleName("addRoot")
    expect(screen.getByRole("textbox", { name: "addRootManual" })).toBeInTheDocument()
  })

  it("hides the native picker on web (manual path entry still works)", () => {
    isTauriMock.mockReturnValue(false)
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    expect(screen.queryByTestId("workspace-manage-pick")).not.toBeInTheDocument()
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
    // rather than `get*`, which raced that render. A folder row is named by
    // its own path segment and expands under the same root, the way the
    // picker's own suite drives it.
    fireEvent.click(await screen.findByRole("button", { name: "projects" }))
    await waitFor(() => expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv", "projects"))
    fireEvent.click(screen.getByRole("button", { name: "chooseCurrent" }))

    await waitFor(() => expect(screen.getByText("/srv/projects")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("workspace-save"))
    expect(useProjectStore.getState().projects[0].rootDir).toBe("/srv/projects")
  })

  it("switches the primary root", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    addManualRoot("/a")
    addManualRoot("/b")

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
    addManualRoot("/to/remove")
    expect(screen.getByText("/to/remove")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("removeRoot"))
    expect(screen.queryByText("/to/remove")).not.toBeInTheDocument()
  })

  it("trusts a root via the per-folder button", async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("workspace-new"))
    addManualRoot("/trust/me")
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
    renderEditing()
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
    renderEditing()
    // The destructive option only appears once the confirm is armed.
    expect(screen.queryByTestId("workspace-delete-data")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-delete"))
    await act(async () => fireEvent.click(screen.getByTestId("workspace-delete-data")))
    expect(useProjectStore.getState().projects).toHaveLength(0)
    expect(removals.at(-1)?.[1]).toBe("delete-data")
  })

  it("refuses removal while one of the workspace's conversations is running", async () => {
    const remove = jest.fn(async () => undefined)
    useProjectStore.setState({ deleteProject: remove })
    const { id } = renderEditing()
    listWorkspaceSessionsMock.mockResolvedValue([
      { id: "s-other" },
      { id: "s-mine", projectId: id },
    ])
    hasActiveSessionMock.mockImplementation((sessionId) => sessionId === "s-mine")

    fireEvent.click(screen.getByTestId("workspace-delete"))
    await act(async () => fireEvent.click(screen.getByTestId("workspace-delete")))

    expect(remove).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("deleteRunning")
    // Still armed, so the reader can try again once the turn settles.
    expect(screen.getByTestId("workspace-delete-confirm")).toBeInTheDocument()
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
    renderEditing()
    fireEvent.click(screen.getByTestId("workspace-delete"))
    await act(async () => fireEvent.click(screen.getByTestId("workspace-delete-data")))
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
    const { id } = renderEditing()
    fireEvent.click(screen.getByText("setActive"))
    expect(useProjectStore.getState().activeProjectId).toBe(id)
  })

  it("offers neither archive nor removal for Default, and says why", () => {
    act(() => {
      useProjectStore.setState({
        projects: [
          {
            id: "project-default",
            name: "Default",
            roots: [],
            knowledgeBase: [],
            sessionIds: [],
            sessionCount: 0,
            messageCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastAccessedAt: new Date(),
          },
        ],
      })
    })
    renderDialog({ initialId: "project-default" })

    expect(screen.queryByTestId("workspace-delete")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-archive")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-default-locked")).toHaveTextContent("defaultLocked")
  })
})

describe("WorkspaceManageDialog archive", () => {
  it("archives into its own group and restores from there", () => {
    const [keep, shelve] = seed("Keep", "Shelve")
    act(() => useProjectStore.getState().setActiveProject(keep))
    renderDialog({ initialId: shelve })

    fireEvent.click(screen.getByTestId("workspace-archive"))

    expect(useProjectStore.getState().projects.find((p) => p.id === shelve)?.isArchived).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith("archived")
    const group = screen.getByTestId("workspace-manage-archived")
    expect(group).toContainElement(screen.getByTestId(`workspace-row-${shelve}`))
    expect(screen.getByTestId("workspace-archived-note")).toBeInTheDocument()
    // An archived workspace cannot be made the working one without restoring it.
    expect(screen.queryByText("setActive")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-archive"))
    expect(useProjectStore.getState().projects.find((p) => p.id === shelve)?.isArchived).toBe(false)
    expect(screen.queryByTestId("workspace-manage-archived")).not.toBeInTheDocument()
  })

  it("hands the active pointer to the most recent other workspace first", () => {
    const [older, newer, active] = seed("Older", "Newer", "Active")
    act(() => {
      useProjectStore.setState((state) => ({
        projects: state.projects.map((p) => ({
          ...p,
          lastAccessedAt: new Date(p.id === older ? 1_000 : p.id === newer ? 2_000 : 3_000),
        })),
        activeProjectId: active,
      }))
    })
    renderDialog()

    fireEvent.click(screen.getByTestId("workspace-archive"))

    expect(useProjectStore.getState().activeProjectId).toBe(newer)
    expect(useProjectStore.getState().projects.find((p) => p.id === active)?.isArchived).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith("archivedSwitched")
  })

  it("cannot archive the only workspace while it is active", () => {
    const [only] = seed("Only")
    act(() => useProjectStore.getState().setActiveProject(only))
    renderDialog()
    expect(screen.getByTestId("workspace-archive")).toBeDisabled()
  })
})

describe("WorkspaceManageDialog draft state", () => {
  it("keeps Save inert until the draft differs from what is stored", () => {
    renderEditing()

    // Nothing edited yet — offering Save here is an enabled button that does
    // nothing.
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
   * Knowledge files and trust are written straight to the row from inside this
   * editor, which replaces the row object. The form used to reload on that and
   * threw away an edited name.
   */
  it("keeps an edit when the stored row changes underneath it", () => {
    const { id } = renderEditing("Stored")
    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Edited" } })

    act(() => useProjectStore.getState().updateProject(id, { pinned: true }))

    expect(screen.getByLabelText("nameLabel")).toHaveValue("Edited")
  })

  /**
   * The draft used to be thrown away in silence: the selection effect reset the
   * form and nothing said an edited name had just been lost.
   */
  it("asks before a selection change throws an edited draft away", () => {
    const [first, second] = seed("First", "Second")
    renderDialog({ initialId: second })

    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Edited" } })
    fireEvent.click(screen.getByTestId(`workspace-row-${first}`))

    // Still on the edited one, with the question in front of the reader.
    expect(screen.getByTestId("workspace-discard-confirm")).toBeInTheDocument()
    expect(screen.getByLabelText("nameLabel")).toHaveValue("Edited")

    fireEvent.click(screen.getByTestId("workspace-discard-confirm"))
    expect(screen.getByLabelText("nameLabel")).toHaveValue("First")
    expect(useProjectStore.getState().projects.find((p) => p.id === second)?.name).toBe("Second")
  })

  it("keeps the draft, and the selection, when the reader keeps editing", () => {
    const [first, second] = seed("First", "Second")
    renderDialog({ initialId: second })
    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Edited" } })
    // The row being edited says so where the reader is about to click away.
    expect(screen.getByTestId("workspace-row-dirty")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId(`workspace-row-${first}`))
    fireEvent.click(screen.getByRole("button", { name: "discardCancel" }))

    expect(screen.queryByTestId("workspace-discard-confirm")).not.toBeInTheDocument()
    expect(screen.getByLabelText("nameLabel")).toHaveValue("Edited")
    expect(screen.getByTestId("workspace-row-dirty")).toBeInTheDocument()
  })

  it("drops the last tag on Backspace in an empty tag field", () => {
    const [id] = seed("Tagged")
    act(() => useProjectStore.getState().updateProject(id, { tags: ["api", "ops"] }))
    renderDialog({ initialId: id })

    fireEvent.keyDown(screen.getByLabelText("tagsLabel"), { key: "Backspace" })
    fireEvent.click(screen.getByTestId("workspace-save"))

    expect(useProjectStore.getState().projects.find((p) => p.id === id)?.tags).toEqual(["api"])
  })

  it("switches straight through when the draft is clean", () => {
    const [first, second] = seed("First", "Second")
    renderDialog({ initialId: second })

    fireEvent.click(screen.getByTestId(`workspace-row-${first}`))
    expect(screen.queryByTestId("workspace-discard-confirm")).not.toBeInTheDocument()
    expect(screen.getByLabelText("nameLabel")).toHaveValue("First")
  })

  it("asks before closing over an edited draft, and closes on discard", () => {
    const onOpenChange = jest.fn()
    const [id] = seed("Stored")
    const { rerender } = renderDialog({ initialId: id, onOpenChange })
    fireEvent.change(screen.getByLabelText("nameLabel"), { target: { value: "Edited" } })

    fireEvent.keyDown(screen.getByLabelText("nameLabel"), { key: "Escape" })
    expect(onOpenChange).not.toHaveBeenCalled()
    // Worded for closing, not for switching.
    expect(screen.getByText("discardCloseDescription")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-discard-confirm")).toHaveTextContent("discardCloseConfirm")
    fireEvent.click(screen.getByTestId("workspace-discard-confirm"))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // Closed and reopened, it shows what is stored, not the discarded draft.
    rerender(<WorkspaceManageDialog open={false} onOpenChange={onOpenChange} initialId={id} />)
    rerender(<WorkspaceManageDialog open onOpenChange={onOpenChange} initialId={id} />)
    expect(screen.getByLabelText("nameLabel")).toHaveValue("Stored")
  })

  it("closes straight through when nothing was edited", () => {
    const onOpenChange = jest.fn()
    const [id] = seed("Stored")
    renderDialog({ initialId: id, onOpenChange })

    fireEvent.keyDown(screen.getByLabelText("nameLabel"), { key: "Escape" })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("WorkspaceManageDialog delete confirmation", () => {
  /**
   * Armed, the footer used to hold two destructive buttons and no way out, so
   * the only exit from a mis-clicked Delete was to pick one of them.
   */
  it("offers a way out of the armed state", () => {
    renderEditing()

    fireEvent.click(screen.getByTestId("workspace-delete"))
    expect(screen.getByTestId("workspace-delete-confirm")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-delete-cancel"))
    expect(screen.queryByTestId("workspace-delete-confirm")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-delete-data")).not.toBeInTheDocument()
    expect(useProjectStore.getState().projects).toHaveLength(1)
  })
})

describe("WorkspaceManageDialog list filtering", () => {
  it("withholds the filter field until the roster is worth filtering", () => {
    seed("Alpha", "Beta")
    renderDialog()
    expect(screen.queryByTestId("workspace-manage-search")).not.toBeInTheDocument()
  })

  it("filters the roster by name, and by tag, and says so when nothing matches", () => {
    seed("Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta")
    const ids = Object.fromEntries(
      useProjectStore.getState().projects.map((p) => [p.name, p.id] as const)
    )
    act(() => useProjectStore.getState().updateProject(ids.Gamma, { tags: ["billing"] }))
    renderDialog()

    fireEvent.change(screen.getByTestId("workspace-manage-search"), { target: { value: "eta" } })
    expect(screen.getByTestId(`workspace-row-${ids.Beta}`)).toBeInTheDocument()
    expect(screen.getByTestId(`workspace-row-${ids.Zeta}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`workspace-row-${ids.Alpha}`)).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId("workspace-manage-search"), { target: { value: "bill" } })
    expect(screen.getByTestId(`workspace-row-${ids.Gamma}`)).toBeInTheDocument()

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
