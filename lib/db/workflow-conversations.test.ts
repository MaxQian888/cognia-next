jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))

import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  appendWorkflowConversationMessage,
  createWorkflowConversation,
  deleteWorkflowConversation,
  exportWorkflowConversation,
  getWorkflowConversationRuntimeContext,
  listWorkflowConversationMessages,
  listWorkflowConversations,
  migrateWorkflowConversationRelease,
  pruneExpiredWorkflowConversations,
  renameWorkflowConversation,
  setWorkflowConversationFavorite,
  summarizeWorkflowConversation,
  WorkflowConversationConflictError,
} from "./workflow-conversations"
import type { WorkflowApp, WorkflowAppRelease } from "@/types/workflow/app"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowConversationReleaseEvents.clear()
  await getDb().workflowConversationSummaries.clear()
  await getDb().workflowConversationMessages.clear()
  await getDb().workflowConversations.clear()
  await getDb().workflowAppReleases.clear()
  await getDb().workflowApps.clear()
})
afterAll(dbFixture.dispose)

function app(currentReleaseId = "wfar_1"): WorkflowApp {
  return {
    id: "wfa_1",
    accountId: "account_1",
    workflowId: "wf_1",
    kind: "chatflow",
    slug: "support",
    draft: {} as never,
    draftRevision: 1,
    currentReleaseId,
    publicationRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function release(id: string, sequence: number): WorkflowAppRelease {
  return {
    id,
    appId: "wfa_1",
    accountId: "account_1",
    workflowId: "wf_1",
    appKind: "chatflow",
    sequence,
    appDraftRevision: 1,
    versionId: `wfv_${sequence}`,
    versionDigest: `wfv1:${String(sequence).padStart(32, "0")}`,
    deploymentId: "wfd_1",
    deploymentRevision: sequence,
    workflowInterface: {},
    dependencyLock: { workflows: {}, indexes: {} },
    snapshot: {} as never,
    createdAt: sequence,
  }
}

async function seedReleases() {
  await getDb().workflowApps.put(app())
  await getDb().workflowAppReleases.bulkPut([release("wfar_1", 1), release("wfar_2", 2)])
}

describe("WorkflowConversation", () => {
  it("pins a new conversation to the selected immutable app release", async () => {
    await seedReleases()
    const conversation = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "visitor-1" },
      now: 1_000,
    })
    await getDb().workflowApps.put(app("wfar_2"))

    expect(conversation.appReleaseId).toBe("wfar_1")
    expect(conversation.versionId).toBe("wfv_1")
    expect(conversation.expiresAt).toBe(1_000 + 30 * 24 * 60 * 60 * 1_000)
    expect((await getDb().workflowConversations.get(conversation.id))?.appReleaseId).toBe("wfar_1")
  })

  it("appends ordered messages with optimistic revision protection", async () => {
    await seedReleases()
    const conversation = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "member", subjectId: "alice", externalSubjectKey: "alice" },
      now: 1_000,
    })
    const first = await appendWorkflowConversationMessage({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: 1,
      role: "user",
      content: { text: "Hello" },
      now: 2_000,
    })
    const second = await appendWorkflowConversationMessage({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: 2,
      role: "assistant",
      content: { answer: { text: "Hi", citations: [], files: [], suggestions: [] } },
      runId: "run_1",
      now: 3_000,
    })

    expect(first.message.sequence).toBe(1)
    expect(second.message.sequence).toBe(2)
    expect(second.conversation.revision).toBe(3)
    await expect(
      appendWorkflowConversationMessage({
        conversationId: conversation.id,
        accountId: "account_1",
        expectedRevision: 1,
        role: "user",
        content: { text: "stale" },
        now: 4_000,
      })
    ).rejects.toBeInstanceOf(WorkflowConversationConflictError)
  })

  it("deduplicates a retried app message before applying the stale revision check", async () => {
    await seedReleases()
    const conversation = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "visitor-1" },
      now: 1_000,
    })
    const first = await appendWorkflowConversationMessage({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: 1,
      idempotencyKey: "turn-1:user",
      role: "user",
      content: { text: "Hello" },
      now: 2_000,
    })
    const retried = await appendWorkflowConversationMessage({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: 1,
      idempotencyKey: "turn-1:user",
      role: "user",
      content: { text: "Hello" },
      now: 3_000,
    })

    expect(first.reused).toBe(false)
    expect(retried.reused).toBe(true)
    expect(retried.message.id).toBe(first.message.id)
    expect(await getDb().workflowConversationMessages.count()).toBe(1)
  })

  it("stores immutable versioned summaries and returns summary plus a recent window", async () => {
    await seedReleases()
    let conversation = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "visitor-1" },
      now: 1_000,
    })
    for (const text of ["one", "two", "three", "four"]) {
      const appended = await appendWorkflowConversationMessage({
        conversationId: conversation.id,
        accountId: "account_1",
        expectedRevision: conversation.revision,
        role: "user",
        content: { text },
        now: conversation.updatedAt + 1,
      })
      conversation = appended.conversation
    }
    const summary = await summarizeWorkflowConversation({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: conversation.revision,
      throughSequence: 2,
      content: "The user said one and two.",
      model: "local:test",
      now: 5_000,
    })
    const context = await getWorkflowConversationRuntimeContext({
      conversationId: conversation.id,
      accountId: "account_1",
      recentMessageLimit: 2,
    })

    expect(summary.summary.revision).toBe(1)
    expect(context.summary?.content).toBe("The user said one and two.")
    expect(context.messages.map((message) => message.content)).toEqual([
      { text: "three" },
      { text: "four" },
    ])
  })

  it("migrates only through an explicit audited release event", async () => {
    await seedReleases()
    const conversation = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "member", subjectId: "alice", externalSubjectKey: "alice" },
      now: 1_000,
    })
    const migrated = await migrateWorkflowConversationRelease({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: 1,
      targetReleaseId: "wfar_2",
      operatedBy: "member:alice",
      reason: "Validated migration",
      now: 2_000,
    })

    expect(migrated.appReleaseId).toBe("wfar_2")
    expect(migrated.versionId).toBe("wfv_2")
    expect(await getDb().workflowConversationReleaseEvents.toArray()).toEqual([
      expect.objectContaining({
        fromReleaseId: "wfar_1",
        toReleaseId: "wfar_2",
        operatedBy: "member:alice",
        reason: "Validated migration",
      }),
    ])
  })

  it("favorites indefinitely and deletes content immediately", async () => {
    await seedReleases()
    const conversation = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "visitor-1" },
      now: 1_000,
    })
    const appended = await appendWorkflowConversationMessage({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: 1,
      role: "user",
      content: { text: "Export me" },
      now: 2_000,
    })
    const favorite = await setWorkflowConversationFavorite({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: appended.conversation.revision,
      favorite: true,
      now: 3_000,
    })
    expect(favorite.expiresAt).toBeUndefined()
    expect((await exportWorkflowConversation("account_1", conversation.id))?.messages).toHaveLength(
      1
    )

    await deleteWorkflowConversation({
      conversationId: conversation.id,
      accountId: "account_1",
      expectedRevision: favorite.revision,
      now: 4_000,
    })
    expect(await exportWorkflowConversation("account_1", conversation.id)).toBeUndefined()
    expect(await getDb().workflowConversationMessages.toArray()).toEqual([])
    expect((await getDb().workflowConversations.get(conversation.id))?.status).toBe("deleted")
  })

  it("prunes expired sessions while keeping favorites and removes delete markers after 24 hours", async () => {
    await seedReleases()
    const expired = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "expired" },
      now: 1_000,
    })
    const favorite = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "favorite" },
      now: 1_000,
    })
    await setWorkflowConversationFavorite({
      conversationId: favorite.id,
      accountId: "account_1",
      expectedRevision: 1,
      favorite: true,
      now: 2_000,
    })
    const deleted = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "deleted" },
      now: 1_000,
    })
    await deleteWorkflowConversation({
      conversationId: deleted.id,
      accountId: "account_1",
      expectedRevision: 1,
      now: 10_000,
    })
    await expect(
      pruneExpiredWorkflowConversations(10_000 + 24 * 60 * 60 * 1_000 - 1)
    ).resolves.toBe(0)
    expect(await getDb().workflowConversations.get(deleted.id)).toMatchObject({
      status: "deleted",
    })

    const afterDefaultRetention = 1_000 + 30 * 24 * 60 * 60 * 1_000 + 1
    await expect(pruneExpiredWorkflowConversations(afterDefaultRetention)).resolves.toBe(2)
    expect(await getDb().workflowConversations.get(expired.id)).toBeUndefined()
    expect(await getDb().workflowConversations.get(deleted.id)).toBeUndefined()
    expect(await getDb().workflowConversations.get(favorite.id)).toMatchObject({ favorite: true })
  })

  it("lists, paginates, and renames only conversations owned by the app-local subject", async () => {
    await seedReleases()
    const owned = await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "visitor-1" },
      now: 1_000,
    })
    await createWorkflowConversation({
      accountId: "account_1",
      appId: "wfa_1",
      releaseId: "wfar_1",
      owner: { kind: "anonymous", externalSubjectKey: "visitor-2" },
      now: 2_000,
    })
    const appended = await appendWorkflowConversationMessage({
      conversationId: owned.id,
      accountId: "account_1",
      expectedRevision: 1,
      role: "user",
      content: { text: "Hello" },
      now: 3_000,
    })
    const owner = { kind: "anonymous" as const, externalSubjectKey: "visitor-1" }

    await expect(
      listWorkflowConversations({ accountId: "account_1", appId: "wfa_1", owner })
    ).resolves.toEqual([expect.objectContaining({ id: owned.id })])
    await expect(
      listWorkflowConversationMessages({
        accountId: "account_1",
        conversationId: owned.id,
        owner,
      })
    ).resolves.toEqual([expect.objectContaining({ content: { text: "Hello" } })])
    await expect(
      renameWorkflowConversation({
        accountId: "account_1",
        conversationId: owned.id,
        owner,
        expectedRevision: appended.conversation.revision,
        title: "  Release review  ",
        now: 4_000,
      })
    ).resolves.toMatchObject({ title: "Release review" })
  })
})
