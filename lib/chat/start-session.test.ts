import { startNewSession } from "./start-session"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"

jest.mock("@/lib/plugin/messaging/message-bus", () => ({
  emitSystemBusEvent: jest.fn(),
  SystemEvents: { SESSION_CREATED: "session:created" },
}))

const emitMock = emitSystemBusEvent as jest.MockedFunction<typeof emitSystemBusEvent>

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  emitMock.mockClear()
  useChatStore.getState().clear()
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

  it("seeds the session from the caller's input", async () => {
    const session = await startNewSession({
      title: "Chat with Ada",
      kind: "direct",
      characterId: "c_ada",
    })

    expect(session).toMatchObject({
      title: "Chat with Ada",
      kind: "direct",
      characterId: "c_ada",
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
