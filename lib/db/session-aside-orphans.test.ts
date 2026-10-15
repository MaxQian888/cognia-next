import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { listMessages, persistMessages } from "./messages"
import { archiveSession, deleteSession } from "./sessions"
import { purgeOrphanedSessionSideChats } from "./session-aside-orphans"

// Session deletion dynamically imports the artifact store for a best-effort
// cleanup this suite does not exercise.
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: () => ({ clearSessionData: jest.fn() }),
  },
}))

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function conversation(id: string): ChatSession {
  return { id, title: id, kind: "direct", projectId: "p1", createdAt: 1, updatedAt: 1 }
}

function sideChat(id: string, parentId: string): ChatSession {
  return {
    id,
    title: "Side chat",
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: { kind: "session", sessionId: parentId },
    surfaceBindingKey: `session:${encodeURIComponent(parentId)}`,
    projectId: "p1",
    createdAt: 2,
    updatedAt: 2,
  }
}

function message(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] }
}

async function ids(): Promise<string[]> {
  return ((await getDb().sessions.toCollection().primaryKeys()) as string[]).sort()
}

describe("side chats follow their conversation", () => {
  it("deletes every side chat, and its messages, with the conversation", async () => {
    await getDb().sessions.bulkPut([
      conversation("main"),
      conversation("other"),
      sideChat("resource-workbench:session:main", "main"),
      sideChat("resource-workbench:session:main#extra", "main"),
      sideChat("resource-workbench:session:other", "other"),
    ])
    await persistMessages("resource-workbench:session:main#extra", [message("m1")])

    await deleteSession("main")

    expect(await ids()).toEqual(["other", "resource-workbench:session:other"])
    expect(await listMessages("resource-workbench:session:main#extra")).toEqual([])
  })

  it("finds side chats of a conversation whose id needs encoding", async () => {
    const parentId = "imported:a/b c"
    await getDb().sessions.bulkPut([conversation(parentId), sideChat("aside-x", parentId)])

    await deleteSession(parentId)

    expect(await ids()).toEqual([])
  })

  it("keeps side chats when the conversation is only archived", async () => {
    await getDb().sessions.bulkPut([conversation("main"), sideChat("aside-main", "main")])

    await archiveSession("main")

    expect(await ids()).toEqual(["aside-main", "main"])
  })
})

describe("purgeOrphanedSessionSideChats", () => {
  it("removes side chats whose conversation is gone and nothing else", async () => {
    await getDb().sessions.bulkPut([
      conversation("alive"),
      sideChat("aside-alive", "alive"),
      sideChat("aside-orphan", "deleted-long-ago"),
      {
        ...sideChat("canvas-aside", "x"),
        surfaceBinding: { kind: "canvas-document", documentId: "doc" },
        surfaceBindingKey: "canvas:doc",
      },
    ])
    await persistMessages("aside-orphan", [message("m1")])

    expect(await purgeOrphanedSessionSideChats()).toBe(1)

    expect(await ids()).toEqual(["alive", "aside-alive", "canvas-aside"])
    expect(await listMessages("aside-orphan")).toEqual([])
  })

  it("is a no-op when there are no side chats", async () => {
    await getDb().sessions.put(conversation("alive"))
    expect(await purgeOrphanedSessionSideChats()).toBe(0)
    expect(await ids()).toEqual(["alive"])
  })
})
