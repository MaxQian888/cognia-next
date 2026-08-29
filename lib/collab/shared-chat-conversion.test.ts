import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { convertLocalSessionToShared } from "./shared-chat-conversion"

const dbFixture = createDbTestFixture()

describe("local-to-shared chat conversion", () => {
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
    await getDb().messages.bulkPut([
      {
        id: "message_1",
        sessionId: "local_1",
        projectId: "workspace_1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        createdAt: 3,
      },
      {
        id: "message_2",
        sessionId: "local_1",
        projectId: "workspace_1",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
        createdAt: 4,
      },
    ])
  })
  afterAll(dbFixture.dispose)

  it("binds the local session only after every event and activation succeed", async () => {
    let sequence = 0
    const client = {
      identity: jest.fn().mockResolvedValue({ userId: "user_1", orgId: "org_1" }),
      createSharedSession: jest.fn().mockResolvedValue({
        id: "shared_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        title: "Private history",
        status: "importing",
        createdBy: { kind: "human", id: "user_1" },
        createdAt: 10,
        updatedAt: 10,
        revision: 1,
        policyRevision: 1,
      }),
      appendSessionEvent: jest.fn(async (_orgId, sessionId, input) => ({
        id: `event_${++sequence}`,
        sessionId,
        sequence,
        kind: input.kind,
        actor: { kind: "human" as const, id: "user_1" },
        payload: input.payload,
        createdAt: 10 + sequence,
        operationId: input.operationId,
      })),
      updateSharedSession: jest.fn().mockImplementation(async (_orgId, _sessionId, input) => ({
        id: "shared_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        title: "Private history",
        status: input.status,
        createdBy: { kind: "human", id: "user_1" },
        createdAt: 10,
        updatedAt: 20,
        revision: 2,
        policyRevision: 2,
      })),
    }

    const result = await convertLocalSessionToShared(client, {
      localSessionId: "local_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
    })

    expect(client.createSharedSession).toHaveBeenCalledWith("org_1", "workspace_1", {
      title: "Private history",
      importing: true,
      operationId: "chat-import:local_1:create",
    })
    expect(client.appendSessionEvent).toHaveBeenCalledTimes(2)
    expect(client.updateSharedSession).toHaveBeenCalledWith("org_1", "shared_1", {
      status: "active",
      operationId: "chat-import:local_1:activate",
      baseRevision: 1,
    })
    expect(result.importedMessageCount).toBe(2)
    expect((await getDb().sessions.get("local_1"))?.collaboration).toEqual({
      orgId: "org_1",
      workspaceId: "workspace_1",
      sessionId: "shared_1",
      policyRevision: 2,
      syncCursor: 2,
    })
  })

  it("leaves the private session untouched when remote import fails", async () => {
    const client = {
      identity: jest.fn().mockResolvedValue({ userId: "user_1", orgId: "org_1" }),
      createSharedSession: jest.fn().mockResolvedValue({
        id: "shared_draft",
        orgId: "org_1",
        workspaceId: "workspace_1",
        title: "Private history",
        status: "importing",
        createdBy: { kind: "human", id: "user_1" },
        createdAt: 10,
        updatedAt: 10,
        revision: 1,
        policyRevision: 1,
      }),
      appendSessionEvent: jest.fn().mockRejectedValue(new Error("upload failed")),
      updateSharedSession: jest.fn(),
    }

    await expect(
      convertLocalSessionToShared(client, {
        localSessionId: "local_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      })
    ).rejects.toThrow("upload failed")

    expect((await getDb().sessions.get("local_1"))?.collaboration).toBeUndefined()
    expect(client.updateSharedSession).not.toHaveBeenCalled()
  })
})
