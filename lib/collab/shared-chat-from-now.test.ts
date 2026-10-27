import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { SharedChatTeamSessionUnsupportedError } from "./shared-chat-conversion"
import { shareConversationFromNow } from "./shared-chat-from-now"

jest.mock("@/lib/db/schema", () => {
  const actual = jest.requireActual("@/lib/db/schema")
  return { ...actual, getDb: jest.fn(actual.getDb) }
})
jest.mock("./shared-chat-feature", () => ({ assertSharedChatClientEnabled: jest.fn() }))
jest.mock("./shared-chat-sync", () => ({
  syncSharedSession: jest.fn(async (_client, orgId: string, sessionId: string) => {
    const { getDb: db } = jest.requireActual("@/lib/db/schema")
    const id = `shared:${orgId}:${sessionId}`
    await db().sessions.put({
      id,
      projectId: "workspace_1",
      title: "Private history",
      kind: "direct",
      createdAt: 10,
      updatedAt: 10,
      collaboration: {
        orgId,
        workspaceId: "workspace_1",
        sessionId,
        policyRevision: 1,
        syncCursor: 0,
      },
    })
    return { session: { id: sessionId }, members: [], events: [], localSessionId: id, cursor: 0 }
  }),
}))

const dbFixture = createDbTestFixture()

function activeSession(patch = {}) {
  return {
    id: "shared_1",
    orgId: "org_1",
    workspaceId: "workspace_1",
    title: "Private history",
    status: "active",
    createdBy: { kind: "human", id: "user_1" },
    createdAt: 10,
    updatedAt: 10,
    revision: 1,
    policyRevision: 1,
    ...patch,
  }
}

function fakeClient(session = activeSession()) {
  return {
    createSharedSession: jest.fn().mockResolvedValue(session),
    appendSessionEvent: jest.fn().mockResolvedValue({ id: "event_1", sequence: 1 }),
    getSharedSession: jest.fn(),
    listSessionMembers: jest.fn(),
    listSessionEvents: jest.fn(),
  }
}

const input = {
  localSessionId: "local_1",
  orgId: "org_1",
  workspaceId: "workspace_1",
  attemptId: "attempt_1",
}

describe("share a conversation from now on", () => {
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().sessions.put({
      id: "local_1",
      projectId: "workspace_1",
      title: "Private history",
      kind: "direct",
      createdAt: 1,
      updatedAt: 2,
    })
    await getDb().messages.put({
      id: "message_1",
      sessionId: "local_1",
      projectId: "workspace_1",
      role: "user",
      parts: [{ type: "text", text: "private earlier turn" }],
      createdAt: 3,
    })
  })
  afterAll(dbFixture.dispose)

  it("creates an empty active session and uploads nothing from the private history", async () => {
    const client = fakeClient()
    const result = await shareConversationFromNow(client as never, input)

    expect(client.createSharedSession).toHaveBeenCalledWith("org_1", "workspace_1", {
      title: "Private history",
      importing: false,
      operationId: "chat-share-from-now:local_1:attempt_1:create",
    })
    expect(client.appendSessionEvent).not.toHaveBeenCalled()
    expect(JSON.stringify(client.createSharedSession.mock.calls)).not.toContain("private earlier")
    expect(result.localSessionId).toBe("shared:org_1:shared_1")
  })

  it("leaves the private conversation untouched and links the branch to it", async () => {
    const before = await getDb().sessions.get("local_1")
    const result = await shareConversationFromNow(fakeClient() as never, input)

    expect(await getDb().sessions.get("local_1")).toEqual(before)
    expect(await getDb().messages.where("sessionId").equals("local_1").count()).toBe(1)
    expect((await getDb().sessions.get(result.localSessionId))?.parentSessionId).toBe("local_1")
  })

  it("posts the confirmed background as the owner's first message, content-addressed", async () => {
    const client = fakeClient()
    await shareConversationFromNow(client as never, {
      ...input,
      background: "  Background\n\nWe chose Postgres.  ",
    })

    expect(client.appendSessionEvent).toHaveBeenCalledTimes(1)
    const event = client.appendSessionEvent.mock.calls[0][2]
    expect(event.operationId).toMatch(
      /^chat-share-from-now:local_1:attempt_1:background:[0-9a-f]{64}$/
    )
    expect(event.payload).toEqual({
      messageId: event.operationId,
      role: "user",
      parts: [{ type: "text", text: "Background\n\nWe chose Postgres." }],
    })
  })

  it("replays the identical background on a retry after a lost response", async () => {
    const client = fakeClient()
    client.appendSessionEvent.mockRejectedValueOnce(new Error("socket hang up"))
    const retryInput = { ...input, background: "We chose Postgres." }
    await expect(shareConversationFromNow(client as never, retryInput)).rejects.toThrow()
    await shareConversationFromNow(client as never, retryInput)

    const [first, second] = client.appendSessionEvent.mock.calls.map((call) => call[2])
    expect(second).toEqual(first)
    expect(client.createSharedSession.mock.calls[1]).toEqual(
      client.createSharedSession.mock.calls[0]
    )
  })

  it("posts nothing for a blank background", async () => {
    const client = fakeClient()
    await shareConversationFromNow(client as never, { ...input, background: "   " })
    expect(client.appendSessionEvent).not.toHaveBeenCalled()
  })

  it("refuses a team conversation and an already shared one", async () => {
    await getDb().sessions.update("local_1", { kind: "team" })
    await expect(shareConversationFromNow(fakeClient() as never, input)).rejects.toBeInstanceOf(
      SharedChatTeamSessionUnsupportedError
    )
    await getDb().sessions.update("local_1", {
      kind: "direct",
      collaboration: {
        orgId: "org_1",
        workspaceId: "workspace_1",
        sessionId: "x",
        policyRevision: 1,
        syncCursor: 0,
      },
    })
    await expect(shareConversationFromNow(fakeClient() as never, input)).rejects.toThrow(
      "already shared"
    )
  })

  it("stops when the server did not open an active session", async () => {
    const client = fakeClient(activeSession({ status: "importing" }))
    await expect(shareConversationFromNow(client as never, input)).rejects.toThrow("did not open")
    expect(client.appendSessionEvent).not.toHaveBeenCalled()
  })
})
