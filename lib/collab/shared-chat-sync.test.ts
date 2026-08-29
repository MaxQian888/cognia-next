import type { SessionEvent, SharedSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { CollabError } from "./client"
import { syncSharedSession } from "./shared-chat-sync"

const dbFixture = createDbTestFixture()

const session: SharedSession = {
  id: "shared_1",
  orgId: "org_1",
  workspaceId: "workspace_1",
  title: "Shared thread",
  status: "active",
  createdBy: { kind: "human", id: "user_1" },
  createdAt: 1,
  updatedAt: 2,
  revision: 1,
  policyRevision: 3,
}

const messageEvent: SessionEvent = {
  id: "event_1",
  sessionId: session.id,
  sequence: 1,
  kind: "message.created",
  actor: { kind: "human", id: "user_1", displayName: "Ada" },
  payload: {
    messageId: "message_1",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
    createdAt: 10,
  },
  createdAt: 10,
  operationId: "operation_1",
}

describe("shared chat synchronization", () => {
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
  })
  afterAll(dbFixture.dispose)

  it("projects server events once and advances the durable cursor", async () => {
    const client = {
      getSharedSession: jest.fn().mockResolvedValue(session),
      listSessionMembers: jest.fn().mockResolvedValue([
        {
          sessionId: session.id,
          userId: "user_1",
          role: "owner",
          approver: true,
          guest: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      listSessionEvents: jest.fn().mockResolvedValue([messageEvent]),
    }

    const first = await syncSharedSession(client, session.orgId, session.id)
    await syncSharedSession(client, session.orgId, session.id)

    expect(first.localSessionId).toBe("shared:shared_1")
    expect(client.listSessionEvents).toHaveBeenNthCalledWith(1, session.orgId, session.id, 0)
    expect(client.listSessionEvents).toHaveBeenNthCalledWith(2, session.orgId, session.id, 1)
    expect(await getDb().messages.get("message_1")).toMatchObject({
      sessionId: "shared:shared_1",
      collaboration: { sourceEventId: "event_1", eventSequence: 1, version: 1 },
    })
    expect((await getDb().collabChatSyncStates.get(session.id))?.lastSequence).toBe(1)
  })

  it("purges the local projection when the server hides a revoked session", async () => {
    await getDb().sessions.put({
      id: "shared:shared_1",
      projectId: session.workspaceId,
      title: session.title,
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
      collaboration: {
        orgId: session.orgId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        policyRevision: 1,
        syncCursor: 1,
      },
    })
    await getDb().messages.put({
      id: "message_1",
      sessionId: "shared:shared_1",
      projectId: session.workspaceId,
      role: "user",
      parts: [{ type: "text", text: "private" }],
      createdAt: 1,
    })
    await getDb().collabChatSessions.put({ ...session, fetchedAt: 1 })

    const client = {
      getSharedSession: jest.fn().mockRejectedValue(new CollabError(404, "not found")),
      listSessionMembers: jest.fn(),
      listSessionEvents: jest.fn(),
    }

    await expect(syncSharedSession(client, session.orgId, session.id)).rejects.toMatchObject({
      status: 404,
    })
    expect(await getDb().sessions.get("shared:shared_1")).toBeUndefined()
    expect(await getDb().messages.get("message_1")).toBeUndefined()
    expect(await getDb().collabChatSessions.get(session.id)).toBeUndefined()
  })
})
