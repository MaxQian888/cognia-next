const mockSync = jest.fn()
const mockSetActiveProject = jest.fn()
const mockSetActiveSession = jest.fn()

jest.mock("@/lib/collab/shared-chat-sync", () => ({
  syncSharedSession: (...args: unknown[]) => mockSync(...args),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setActiveSession: mockSetActiveSession }) },
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ setActiveProject: mockSetActiveProject }) },
}))

import { openAcceptedSharedSession } from "./open-shared-session"

type Client = Parameters<typeof openAcceptedSharedSession>[0]["client"]
const client = { baseUrl: "https://collab.test" } as unknown as Client

beforeEach(() => {
  jest.clearAllMocks()
})

describe("openAcceptedSharedSession", () => {
  it("mirrors the shared session, then opens it where the sidebar would", async () => {
    const order: string[] = []
    const synced = { localSessionId: "local-1", session: { workspaceId: "ws-1" } }
    mockSync.mockImplementation(async () => {
      order.push("sync")
      return synced
    })
    mockSetActiveProject.mockImplementation(() => order.push("project"))
    mockSetActiveSession.mockImplementation(() => order.push("session"))
    const switchToDm = jest.fn(() => order.push("dm"))

    await expect(
      openAcceptedSharedSession({ client, orgId: "org_1", sharedSessionId: "ses_1", switchToDm })
    ).resolves.toBe(synced)

    expect(mockSync).toHaveBeenCalledWith(client, "org_1", "ses_1")
    expect(mockSetActiveProject).toHaveBeenCalledWith("ws-1")
    expect(mockSetActiveSession).toHaveBeenCalledWith("local-1")
    // The workspace first: activating a session outside the active project
    // would be overwritten by the project switch.
    expect(order).toEqual(["sync", "project", "session", "dm"])
  })

  it("opens nothing when the pull fails, and lets the caller report it", async () => {
    mockSync.mockRejectedValue(new Error("offline"))
    const switchToDm = jest.fn()

    await expect(
      openAcceptedSharedSession({ client, orgId: "org_1", sharedSessionId: "ses_1", switchToDm })
    ).rejects.toThrow("offline")

    expect(mockSetActiveProject).not.toHaveBeenCalled()
    expect(mockSetActiveSession).not.toHaveBeenCalled()
    expect(switchToDm).not.toHaveBeenCalled()
  })
})
