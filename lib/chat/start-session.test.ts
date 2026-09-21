import { startNewSession } from "./start-session"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"

jest.mock("@/lib/plugin/messaging/message-bus", () => ({
  emitSystemBusEvent: jest.fn(),
  SystemEvents: { SESSION_CREATED: "session:created" },
}))

// An ES module namespace is non-configurable, so `jest.spyOn` cannot replace an
// export on it. `mock`-prefixed so the hoisted factory may close over it.
const mockLoadDeclaredWorkspace = jest.fn(async () => null as unknown)
jest.mock("@/lib/workspace/repo-declared", () => ({
  loadDeclaredWorkspace: (...args: unknown[]) => mockLoadDeclaredWorkspace(...(args as [])),
}))

const mockEnsureDefaultWorkspace = jest.fn(async () => ({
  kind: "unavailable" as const,
  reason: "no-local-filesystem" as const,
}))
jest.mock("@/lib/workspace/ensure-default-workspace", () => ({
  ensureDefaultWorkspace: (...args: unknown[]) => mockEnsureDefaultWorkspace(...(args as [])),
  defaultEnsureDefaultWorkspaceDeps: () => ({}),
}))

const mockDispatchDiagnostic = jest.fn()
jest.mock("@/lib/diagnostics/bus", () => ({
  dispatchDiagnostic: (...args: unknown[]) => mockDispatchDiagnostic(...(args as [])),
}))

// Only the one predicate is replaced. The module is a leaf that other imports
// in this graph still read, so a wholesale factory would strip them.
const mockHasHostRuntime = jest.fn(() => true)
jest.mock("@/lib/platform/capabilities", () => ({
  ...jest.requireActual("@/lib/platform/capabilities"),
  hasHostRuntime: () => mockHasHostRuntime(),
}))

const emitMock = emitSystemBusEvent as jest.MockedFunction<typeof emitSystemBusEvent>

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  jest.restoreAllMocks()
  await dbFixture.restore()
  emitMock.mockClear()
  mockDispatchDiagnostic.mockClear()
  mockHasHostRuntime.mockReset().mockReturnValue(true)
  mockLoadDeclaredWorkspace.mockReset().mockResolvedValue(null)
  mockEnsureDefaultWorkspace
    .mockReset()
    .mockResolvedValue({ kind: "unavailable", reason: "no-local-filesystem" })
  useChatStore.getState().clear()
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
})

afterAll(dbFixture.dispose)

describe("startNewSession", () => {
  it("persists the session and makes it the active one", async () => {
    const session = await startNewSession()

    await expect(getSession(session.id)).resolves.toMatchObject({ id: session.id })
    expect(useChatStore.getState().activeSessionId).toBe(session.id)
  })

  it("announces the new session on the plugin bus", async () => {
    const session = await startNewSession()

    expect(emitMock).toHaveBeenCalledWith(SystemEvents.SESSION_CREATED, {
      sessionId: session.id,
    })
  })

  it("leaves the user where they are when the caller has nobody to move", async () => {
    // A workflow step at 3am, or a run on the cloud brain where there is no UI
    // at all. The row and its announcement still happen, so a conversation a
    // machine started is the same kind of object as one a person started.
    useChatStore.getState().clear()
    useUIStore.setState({ pendingConversationReveal: null })

    const session = await startNewSession({ activate: false })

    await expect(getSession(session.id)).resolves.toMatchObject({ id: session.id })
    expect(useChatStore.getState().activeSessionId).not.toBe(session.id)
    expect(useUIStore.getState().pendingConversationReveal).toBeNull()
    expect(emitMock).toHaveBeenCalledWith(SystemEvents.SESSION_CREATED, {
      sessionId: session.id,
    })
  })

  it("asks the conversation list to reveal the new row", async () => {
    // The list's narrowing state is persisted (archived view, a search, a quick
    // filter), so a new conversation can be created, selected and invisible.
    useUIStore.setState({ pendingConversationReveal: null })
    const session = await startNewSession()

    expect(useUIStore.getState().pendingConversationReveal).toBe(session.id)
  })

  it("seeds the session from the caller's input", async () => {
    const session = await startNewSession({
      title: "Chat with Ada",
      kind: "direct",
      characterId: "c_ada",
      sdkSessionId: "sdk-ada",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
    })

    expect(session).toMatchObject({
      title: "Chat with Ada",
      kind: "direct",
      characterId: "c_ada",
      sdkSessionId: "sdk-ada",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
    })
  })

  it("seeds all three identity columns, executor included", async () => {
    // `squadId` is the executor axis (ADR-0140) and was absent from the seed,
    // so "start a conversation configured like that one" could name the persona
    // and the conversation shape but never what it actually runs on.
    const session = await startNewSession({
      title: "Ship it",
      characterId: "c_reviewer",
      squadId: "sq_release",
    })

    expect(session).toMatchObject({ characterId: "c_reviewer", squadId: "sq_release" })
    await expect(getSession(session.id)).resolves.toMatchObject({ squadId: "sq_release" })
  })

  it("files the conversation in an explicitly named workspace, over the active one", async () => {
    const addSessionToProject = jest.fn()
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      activeProjectId: "p_active",
      addSessionToProject,
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession({ title: "Elsewhere", projectId: "p_named" })

    expect(session.projectId).toBe("p_named")
    expect(addSessionToProject).toHaveBeenCalledWith("p_named", session.id)
  })

  it("links the session to the active workspace", async () => {
    const addSessionToProject = jest.fn()
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      activeProjectId: "p_1",
      addSessionToProject,
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession()

    expect(addSessionToProject).toHaveBeenCalledWith("p_1", session.id)
  })

  it("creates Quick Chat as a normal persisted task with project defaults", async () => {
    const project = {
      id: "p_quick",
      name: "Quick",
      roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      pinned: true,
      defaultEnvironmentId: "env-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    }
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      projects: [project],
      activeProjectId: project.id,
      addSessionToProject: jest.fn(),
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession()

    expect(session.executionContext).toEqual(
      expect.objectContaining({
        location: "managedWorktree",
        execution: expect.objectContaining({ mode: "managed" }),
        workspaceBinding: { kind: "project", projectId: "p_quick" },
        projectRoot: "/repo",
        environmentId: "env-1",
        taskWorkspace: expect.objectContaining({ workspaceKey: session.id }),
      })
    )
    await expect(getSession(session.id)).resolves.toMatchObject({
      executionContext: session.executionContext,
    })
  })

  it("remembers an explicit Local or Worktree choice on the active Project", async () => {
    const updateProject = jest.fn()
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      activeProjectId: "p_1",
      addSessionToProject: jest.fn(),
      updateProject,
    } as ReturnType<typeof useProjectStore.getState>)

    await startNewSession({
      executionContext: {
        location: "local",
        projectId: "p_1",
        projectRoot: "/repo",
        taskWorkspace: { taskId: "task-1", workspaceKey: "workspace-1" },
      },
    })

    expect(updateProject).toHaveBeenCalledWith("p_1", { defaultExecutionLocation: "local" })
  })

  it("creates a new chat from the picker location and base, then remembers the choice", async () => {
    const updateProject = jest.fn()
    const project = {
      id: "p_picker",
      name: "Picker",
      roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      pinned: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    }
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      projects: [project],
      activeProjectId: project.id,
      addSessionToProject: jest.fn(),
      updateProject,
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession({
      executionLocation: "managedWorktree",
      executionBase: { kind: "remoteDefault" },
    })

    expect(session.executionContext).toMatchObject({
      location: "managedWorktree",
      execution: { mode: "managed", base: { kind: "remoteDefault" } },
    })
    expect(updateProject).toHaveBeenCalledWith(project.id, {
      defaultExecutionLocation: "managedWorktree",
    })
  })

  it("binds a per-chat environment, root and worktree name into the context", async () => {
    const updateProject = jest.fn()
    const project = {
      id: "p_ctx",
      name: "Ctx",
      roots: [
        { id: "root-1", path: "/repo/app", isPrimary: true },
        { id: "root-2", path: "/repo/api" },
      ],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      pinned: true,
      defaultEnvironmentId: "env-default",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    }
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      projects: [project],
      activeProjectId: project.id,
      addSessionToProject: jest.fn(),
      updateProject,
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession({
      executionLocation: "managedWorktree",
      environmentId: "env-picked",
      rootId: "root-2",
      worktreeName: "feat/login",
    })

    expect(session.executionContext).toMatchObject({
      location: "managedWorktree",
      environmentId: "env-picked",
      rootId: "root-2",
      projectRoot: "/repo/api",
      requestedWorktreeName: "feat/login",
      execution: expect.objectContaining({
        roots: [expect.objectContaining({ logicalRootId: "root-2", aliasPath: "/repo/api" })],
      }),
    })
    // The env pick is remembered as the workspace default, same as location.
    expect(updateProject).toHaveBeenCalledWith(project.id, {
      defaultEnvironmentId: "env-picked",
    })
  })

  it('treats "" environmentId as an explicit none that clears the default', async () => {
    const updateProject = jest.fn()
    const project = {
      id: "p_envclear",
      name: "EnvClear",
      roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      pinned: true,
      defaultEnvironmentId: "env-default",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    }
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      projects: [project],
      activeProjectId: project.id,
      addSessionToProject: jest.fn(),
      updateProject,
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession({ environmentId: "" })

    expect(session.executionContext?.environmentId).toBeUndefined()
    expect(updateProject).toHaveBeenCalledWith(project.id, {
      defaultEnvironmentId: undefined,
    })
  })

  it("falls back to the primary root for an unknown rootId", async () => {
    const project = {
      id: "p_rootfb",
      name: "RootFb",
      roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      pinned: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    }
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      projects: [project],
      activeProjectId: project.id,
      addSessionToProject: jest.fn(),
      updateProject: jest.fn(),
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession({
      executionLocation: "local",
      rootId: "root-does-not-exist",
    })

    expect(session.executionContext).toMatchObject({
      rootId: "root-1",
      projectRoot: "/repo",
    })
  })

  it("drops the worktree name for local execution", async () => {
    const project = {
      id: "p_namelocal",
      name: "NameLocal",
      roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      pinned: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    }
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      projects: [project],
      activeProjectId: project.id,
      addSessionToProject: jest.fn(),
      updateProject: jest.fn(),
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession({
      executionLocation: "local",
      worktreeName: "feat/x",
    })

    expect(session.executionContext?.requestedWorktreeName).toBeUndefined()
  })

  describe("what the repository declares", () => {
    const project = {
      id: "p_declared",
      name: "Declared",
      roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      pinned: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    }

    function mountProject(over: Record<string, unknown> = {}) {
      jest.spyOn(useProjectStore, "getState").mockReturnValue({
        ...useProjectStore.getState(),
        projects: [{ ...project, ...over }],
        activeProjectId: project.id,
        addSessionToProject: jest.fn(),
        updateProject: jest.fn(),
      } as ReturnType<typeof useProjectStore.getState>)
    }

    function declares(config: Record<string, unknown> | null) {
      mockLoadDeclaredWorkspace.mockResolvedValue(config as never)
    }

    it("uses the declared execution default when the workspace has none of its own", async () => {
      // The thing a new contributor should not have to be told out of band.
      mountProject()
      declares({
        executionLocation: "managedWorktree",
        base: { kind: "remoteDefault" },
        roots: [],
        capabilities: {},
      })

      const session = await startNewSession()
      expect(session.executionContext).toMatchObject({
        location: "managedWorktree",
        execution: { base: { kind: "remoteDefault" } },
      })
    })

    it("loses to the workspace's own remembered default", async () => {
      // The file changes on every pull; a setting that silently reverts is
      // worse than one that was never offered.
      mountProject({ defaultExecutionLocation: "local" })
      declares({
        executionLocation: "managedWorktree",
        base: { kind: "remoteDefault" },
        roots: [],
        capabilities: {},
      })

      const session = await startNewSession()
      expect(session.executionContext).toMatchObject({ location: "local" })
    })

    it("loses to the choice made in the new-chat picker", async () => {
      mountProject()
      declares({
        executionLocation: "local",
        base: { kind: "workingState" },
        roots: [],
        capabilities: {},
      })

      const session = await startNewSession({ executionLocation: "managedWorktree" })
      expect(session.executionContext).toMatchObject({ location: "managedWorktree" })
    })

    it("keeps the hardcoded default when nothing is declared", async () => {
      mountProject()
      declares(null)

      const session = await startNewSession()
      expect(session.executionContext).toMatchObject({ location: "managedWorktree" })
    })

    it("does not take the turn down when the declaration cannot be read", async () => {
      mountProject()
      mockLoadDeclaredWorkspace.mockRejectedValue(new Error("filesystem unavailable"))

      await expect(startNewSession()).resolves.toMatchObject({ id: expect.any(String) })
    })
  })

  it("automatically gives a projectless chat a durable managed workspace identity", async () => {
    const session = await startNewSession()

    expect(session.executionContext).toEqual(
      expect.objectContaining({
        location: "managedWorktree",
        workspaceBinding: {
          kind: "managed",
          workspaceId: `managed-workspace:${session.id}`,
        },
        managedWorkspace: { availability: "missing-on-device" },
        taskWorkspace: {
          taskId: `task-workspace:${session.id}`,
          workspaceKey: `managed-workspace:${session.id}`,
        },
      })
    )
    await expect(getSession(session.id)).resolves.toMatchObject({
      executionContext: session.executionContext,
    })
  })

  it("names the owning workspace on a rootless chat's managed context", async () => {
    // The binding says "there is no checkout here"; the project id says which
    // workspace the chat is attributable to. The send path looks the project up
    // by that id before opening a bundle, so stamping "" refused every rootless
    // chat as managed_project_unavailable before its first turn.
    const session = await startNewSession()

    expect(session.executionContext?.workspaceBinding?.kind).toBe("managed")
    expect(session.executionContext?.projectId).toBe(session.projectId)
    expect(session.executionContext?.projectId).toBeTruthy()
  })

  describe("when nothing on this device has a directory yet", () => {
    function provisioned() {
      const project = useProjectStore.getState().createProject({
        name: "Cognia",
        roots: [{ id: "root-auto", path: "/home/u/Projects/Cognia", isPrimary: true }],
      })
      mockEnsureDefaultWorkspace.mockResolvedValue({
        kind: "created",
        project,
        path: "/home/u/Projects/Cognia",
      } as never)
      return project
    }

    it("binds the chat to the provisioned root instead of a managed identity", async () => {
      const project = provisioned()
      const session = await startNewSession()

      expect(session.executionContext?.workspaceBinding).toEqual({
        kind: "project",
        projectId: project.id,
      })
      expect(session.executionContext?.projectId).toBe(project.id)
      expect(session.executionContext?.execution?.roots?.[0]?.aliasPath).toBe(
        "/home/u/Projects/Cognia"
      )
    })

    it("re-attributes the conversation to the workspace it will run in", async () => {
      // ADR-0144: the row's workspace and the workspace's session list must
      // agree from the first turn, in both directions.
      const project = provisioned()
      const session = await startNewSession()

      await expect(getSession(session.id)).resolves.toMatchObject({ projectId: project.id })
      expect(
        useProjectStore.getState().projects.find((p) => p.id === project.id)?.sessionIds
      ).toContain(session.id)
    })

    it("remembers an explicit location on the provisioned workspace, not the old one", async () => {
      const project = provisioned()
      await startNewSession({ executionLocation: "local" })

      expect(
        useProjectStore.getState().projects.find((p) => p.id === project.id)
          ?.defaultExecutionLocation
      ).toBe("local")
    })

    it("records the refusal when there is no local filesystem, keeping the managed identity", async () => {
      // A browser with no paired host: provisioning answers `unavailable` and
      // the durable managed identity is still the right answer.
      const session = await startNewSession()
      expect(session.executionContext?.workspaceBinding?.kind).toBe("managed")
      // ...but the refusal has to be RECORDED, not swallowed. An empty catch
      // left this undefined, which reads downstream as "never attempted", so
      // the failure only resurfaced one step later on the first turn, as
      // `ensureSessionExecutionBundle` throwing the name of an internal object
      // behind a Retry that re-ran the same refusal.
      expect(session.executionContext?.managedWorkspace?.availability).toBe("missing-on-device")
    })

    // The same exception carries two different situations, and only one of them
    // is about the workspace.
    it("names the missing HOST, not the workspace, when nothing is paired", async () => {
      // A plain browser tab: no Tauri, no Capacitor, no pairing. EVERY
      // host-owned call rejects, so "bind this workspace to a folder" is advice
      // the user cannot act on. This is the state a tab is in even while a Host
      // runs on the same machine, because pairing is a manual step.
      mockHasHostRuntime.mockReturnValue(false)

      await startNewSession()

      const codes = mockDispatchDiagnostic.mock.calls.map(
        ([diagnostic]) => (diagnostic as { code: string }).code
      )
      expect(codes).toContain("hostUnavailable")
      expect(codes).not.toContain("workspaceUnavailable")
    })

    it("names the workspace when a host exists but the workspace cannot be built", async () => {
      mockHasHostRuntime.mockReturnValue(true)

      await startNewSession()

      const codes = mockDispatchDiagnostic.mock.calls.map(
        ([diagnostic]) => (diagnostic as { code: string }).code
      )
      expect(codes).toContain("workspaceUnavailable")
      expect(codes).not.toContain("hostUnavailable")
    })
  })

  it("attributes a chat started with no active workspace to Default", async () => {
    // `createSession` resolves the owning workspace through
    // `resolveScopeProjectId`, which never returns null — it adopts (or
    // creates) Default. Leaving the reverse link unwritten made the row's
    // workspace and the workspace's session list disagree from the first turn.
    const addSessionToProject = jest.fn()
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      activeProjectId: null,
      addSessionToProject,
    } as ReturnType<typeof useProjectStore.getState>)

    const session = await startNewSession()

    expect(session.projectId).toBe("project-default")
    expect(addSessionToProject).toHaveBeenCalledWith("project-default", session.id)
  })
})
