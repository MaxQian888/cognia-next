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

const emitMock = emitSystemBusEvent as jest.MockedFunction<typeof emitSystemBusEvent>

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  jest.restoreAllMocks()
  await dbFixture.restore()
  emitMock.mockClear()
  mockLoadDeclaredWorkspace.mockReset().mockResolvedValue(null)
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
    })

    expect(session).toMatchObject({
      title: "Chat with Ada",
      kind: "direct",
      characterId: "c_ada",
      sdkSessionId: "sdk-ada",
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
