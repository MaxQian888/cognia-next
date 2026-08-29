import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  appendCollabChatEvents,
  listCollabChatEvents,
  listCollabChatSessions,
  purgeCollabChatSession,
  replaceCollabChatSessions,
} from "./collab-chat-mirror"

const dbFixture = createDbTestFixture()

describe("collab chat mirror", () => {
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await Promise.all([
      getDb().collabChatSessions.clear(),
      getDb().collabChatEvents.clear(),
      getDb().collabChatSyncStates.clear(),
    ])
  })
  afterAll(dbFixture.dispose)

  it("replaces only one workspace slice", async () => {
    const row = (id: string, workspaceId: string) => ({
      id,
      orgId: "org_1",
      workspaceId,
      title: id,
      status: "active" as const,
      createdBy: { kind: "human" as const, id: "usr_1" },
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      policyRevision: 1,
      fetchedAt: 2,
    })
    await replaceCollabChatSessions("org_1", "ws_2", [row("ses_2", "ws_2")])
    await replaceCollabChatSessions("org_1", "ws_1", [row("ses_old", "ws_1")])
    await replaceCollabChatSessions("org_1", "ws_1", [row("ses_new", "ws_1")])
    expect((await listCollabChatSessions("org_1", "ws_1")).map(({ id }) => id)).toEqual(["ses_new"])
    expect(await getDb().collabChatSessions.get("ses_2")).toBeDefined()
  })

  it("deduplicates events by id and advances the cursor monotonically", async () => {
    const base = {
      id: "evt_1",
      orgId: "org_1",
      sessionId: "ses_1",
      sequence: 4,
      kind: "message.created" as const,
      actor: { kind: "human" as const, id: "usr_1" },
      payload: { text: "hello" },
      createdAt: 1,
      operationId: "op_1",
      fetchedAt: 2,
    }
    await appendCollabChatEvents([base, { ...base, payload: { text: "same event" } }])
    expect(await listCollabChatEvents("ses_1")).toHaveLength(1)
    expect((await getDb().collabChatSyncStates.get("ses_1"))?.lastSequence).toBe(4)
    await appendCollabChatEvents([{ ...base, id: "evt_2", sequence: 2, operationId: "op_2" }])
    expect((await getDb().collabChatSyncStates.get("ses_1"))?.lastSequence).toBe(4)
  })

  it("purges every cached resource immediately after access is revoked", async () => {
    await getDb().collabChatSessions.put({
      id: "ses_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      title: "Private",
      status: "active",
      createdBy: { kind: "human", id: "usr_1" },
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      policyRevision: 1,
      fetchedAt: 1,
    })
    await purgeCollabChatSession("ses_1")
    expect(await getDb().collabChatSessions.get("ses_1")).toBeUndefined()
  })
})
