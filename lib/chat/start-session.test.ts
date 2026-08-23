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

const emitMock = emitSystemBusEvent as jest.MockedFunction<typeof emitSystemBusEvent>

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  jest.restoreAllMocks()
  await dbFixture.restore()
  emitMock.mockClear()
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

  it("skips workspace linking when no workspace is active", async () => {
    const addSessionToProject = jest.fn()
    jest.spyOn(useProjectStore, "getState").mockReturnValue({
      ...useProjectStore.getState(),
      activeProjectId: null,
      addSessionToProject,
    } as ReturnType<typeof useProjectStore.getState>)

    await startNewSession()

    expect(addSessionToProject).not.toHaveBeenCalled()
  })
})
