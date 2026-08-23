jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))
jest.mock("./app-execution", () => ({
  executePublishedWorkflowApp: jest.fn(),
}))
jest.mock("@/lib/workflow/quality/quality-service", () => ({
  matchWorkflowAnnotation: jest.fn(),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { executePublishedWorkflowApp } from "./app-execution"
import { matchWorkflowAnnotation } from "@/lib/workflow/quality/quality-service"
import { sendChatflowMessage, WorkflowChatflowError } from "./chatflow-service"
import type { WorkflowApp, WorkflowAppRelease } from "@/types/workflow/app"
import type { WorkflowVersion } from "@/types/workflow/deployment"

const dbFixture = createDbTestFixture()
const execute = executePublishedWorkflowApp as jest.MockedFunction<
  typeof executePublishedWorkflowApp
>
const matchAnnotation = matchWorkflowAnnotation as jest.MockedFunction<
  typeof matchWorkflowAnnotation
>

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowConversationReleaseEvents.clear()
  await getDb().workflowConversationSummaries.clear()
  await getDb().workflowConversationMessages.clear()
  await getDb().workflowConversations.clear()
  await getDb().workflowAppReleases.clear()
  await getDb().workflowApps.clear()
  await getDb().workflowVersions.clear()
  execute.mockReset().mockResolvedValue({
    runId: "run_1",
    result: {
      runId: "run_1",
      status: "succeeded",
      output: {
        answer: {
          text: "Hello from Chatflow",
          citations: [],
          files: [],
          suggestions: ["Continue"],
        },
      },
    },
  } as never)
  matchAnnotation.mockReset().mockResolvedValue(undefined)
  await seedApp()
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
    snapshot: {
      blocks: [],
      theme: { colorMode: "system", primaryColor: "#000000" },
      localized: {},
      access: { mode: "anonymous", oidcGroupIds: [] },
      embed: { enabled: false, allowedOrigins: [] },
      resultSharing: { enabled: false },
      mcp: { enabled: false },
      quota: {},
      contentPolicy: { inputModeration: true, outputModeration: true },
      legal: { requireConsent: false },
      reviewGate: {
        enabled: false,
        requiredApprovals: 1,
        reviewerSubjectIds: [],
        reviewerGroupIds: [],
        requireNoBlockingComments: true,
      },
      annotationReply: { enabled: false, threshold: 0.85 },
      knowledgeBindings: {},
    },
    createdAt: sequence,
  }
}

function version(sequence: number): WorkflowVersion {
  return {
    id: `wfv_${sequence}`,
    accountId: "account_1",
    workflowId: "wf_1",
    sequence,
    definition: {} as never,
    interface: {},
    dependencyManifest: { nodeTypes: [], workflows: [], credentials: [] },
    configDefinition: { constants: {}, secretRefs: [] },
    digest: `wfv1:${String(sequence).padStart(32, "0")}`,
    name: "Chatflow",
    createdAt: sequence,
  }
}

async function seedApp() {
  await getDb().workflowApps.put(app())
  await getDb().workflowAppReleases.bulkPut([release("wfar_1", 1), release("wfar_2", 2)])
  await getDb().workflowVersions.bulkPut([version(1), version(2)])
}

const actor = { authenticated: false, externalSubjectKey: "visitor-1" }

describe("Chatflow service", () => {
  it("creates a release-pinned conversation and persists the user/answer turn", async () => {
    const result = await sendChatflowMessage({
      accountId: "account_1",
      appSlug: "support",
      actor,
      idempotencyKey: "turn-1",
      content: { text: "Hello" },
      now: 1_000,
    })

    expect(result.answer.text).toBe("Hello from Chatflow")
    expect(result.conversation.appReleaseId).toBe("wfar_1")
    expect(result.conversation.revision).toBe(3)
    expect(await getDb().workflowConversationMessages.toArray()).toEqual([
      expect.objectContaining({ role: "user", idempotencyKey: "turn-1:user" }),
      expect.objectContaining({ role: "assistant", idempotencyKey: "turn-1:assistant" }),
    ])
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: expect.objectContaining({ release: expect.objectContaining({ id: "wfar_1" }) }),
        idempotencyKey: "turn-1",
        input: expect.objectContaining({
          conversation: expect.objectContaining({ id: result.conversation.id }),
        }),
      })
    )
  })

  it("keeps an existing conversation on its release after the app pointer moves", async () => {
    const first = await sendChatflowMessage({
      accountId: "account_1",
      appSlug: "support",
      actor,
      idempotencyKey: "turn-1",
      content: { text: "First" },
      now: 1_000,
    })
    await getDb().workflowApps.put(app("wfar_2"))
    execute.mockClear()

    await sendChatflowMessage({
      accountId: "account_1",
      appSlug: "support",
      conversationId: first.conversation.id,
      expectedRevision: first.conversation.revision,
      actor,
      idempotencyKey: "turn-2",
      content: { text: "Second" },
      now: 2_000,
    })
    expect(execute.mock.calls[0]?.[0].resolved.release.id).toBe("wfar_1")
  })

  it("returns the persisted assistant message for an idempotent retry", async () => {
    const first = await sendChatflowMessage({
      accountId: "account_1",
      appSlug: "support",
      actor,
      idempotencyKey: "turn-1",
      content: { text: "Hello" },
      now: 1_000,
    })
    execute.mockClear()
    const retried = await sendChatflowMessage({
      accountId: "account_1",
      appSlug: "support",
      conversationId: first.conversation.id,
      expectedRevision: 1,
      actor,
      idempotencyKey: "turn-1",
      content: { text: "Hello" },
      now: 2_000,
    })

    expect(retried.reused).toBe(true)
    expect(retried.runId).toBe("run_1")
    expect(execute).not.toHaveBeenCalled()
    expect(await getDb().workflowConversationMessages.count()).toBe(2)
  })

  it("rejects cross-subject access and a successful run without io.answer", async () => {
    const first = await sendChatflowMessage({
      accountId: "account_1",
      appSlug: "support",
      actor,
      idempotencyKey: "turn-1",
      content: { text: "Hello" },
      now: 1_000,
    })
    await expect(
      sendChatflowMessage({
        accountId: "account_1",
        appSlug: "support",
        conversationId: first.conversation.id,
        expectedRevision: first.conversation.revision,
        actor: { authenticated: false, externalSubjectKey: "visitor-2" },
        idempotencyKey: "turn-2",
        content: { text: "Steal" },
        now: 2_000,
      })
    ).rejects.toMatchObject({ code: "conversation_not_found" })

    execute.mockResolvedValueOnce({
      runId: "run_2",
      result: { runId: "run_2", status: "succeeded", output: { value: "not an answer" } },
    } as never)
    await expect(
      sendChatflowMessage({
        accountId: "account_1",
        appSlug: "support",
        actor,
        idempotencyKey: "turn-missing-answer",
        content: { text: "Hello" },
        now: 3_000,
      })
    ).rejects.toBeInstanceOf(WorkflowChatflowError)
  })

  it("returns a cited reviewed annotation without executing the graph", async () => {
    const annotated = release("wfar_1", 1)
    annotated.annotationRevisionId = "annotation_revision_1"
    annotated.snapshot.annotationReply = {
      enabled: true,
      setId: "annotation_set_1",
      threshold: 0.9,
      embeddingProfileId: "support",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorBackend: "native",
    }
    await getDb().workflowAppReleases.put(annotated)
    matchAnnotation.mockResolvedValue({
      revisionId: "annotation_revision_1",
      setId: "annotation_set_1",
      entryId: "reset",
      answer: "Use the reviewed reset page.",
      tags: ["account"],
      score: 0.98,
    })

    const result = await sendChatflowMessage({
      accountId: "account_1",
      appSlug: "support",
      actor,
      idempotencyKey: "turn-annotation",
      content: { text: "How do I reset my password?" },
    })
    expect(result).toMatchObject({
      runId: "annotation:annotation_revision_1:reset",
      answer: {
        text: "Use the reviewed reset page.",
        citations: [
          {
            sourceId: "annotation-set:annotation_set_1",
            documentId: "reset",
            revisionId: "annotation_revision_1",
          },
        ],
      },
    })
    expect(execute).not.toHaveBeenCalled()
  })
})
