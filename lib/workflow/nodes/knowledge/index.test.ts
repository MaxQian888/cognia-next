jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "acct_a" }))
jest.mock("@/lib/db/knowledge-bases", () => ({
  createKnowledgeBaseSource: jest.fn(),
  getKnowledgeBasesByIds: jest.fn(),
  getKnowledgeBaseSourcesByIds: jest.fn(),
  updateKnowledgeBaseSource: jest.fn(),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/knowledge-base/ingest/persist", () => ({ persistKnowledgeBaseChunks: jest.fn() }))
jest.mock("@/lib/knowledge-base/revisions", () => ({
  assertKnowledgeBaseRevisionBindings: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/knowledge-base/runtime/apply-agent-knowledge-context", () => ({
  applyAgentKnowledgeContextFromDb: jest.fn(),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
jest.mock("@/lib/rag/safe-embedding", () => ({ generateSafeEmbedding: jest.fn() }))
jest.mock("@/lib/twin/runtime/build-deps", () => ({ tryBuildTwinDeps: jest.fn() }))
jest.mock("@/lib/workflow/knowledge/artifacts", () => ({
  openWorkflowKnowledgeArtifact: jest.fn(),
  storeWorkflowKnowledgeArtifact: jest.fn(),
}))

import { persistKnowledgeBaseChunks } from "@/lib/knowledge-base/ingest/persist"
import { getKnowledgeBasesByIds } from "@/lib/db/knowledge-bases"
import { getDb } from "@/lib/db/schema"
import { applyAgentKnowledgeContextFromDb } from "@/lib/knowledge-base/runtime/apply-agent-knowledge-context"
import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import {
  openWorkflowKnowledgeArtifact,
  storeWorkflowKnowledgeArtifact,
} from "@/lib/workflow/knowledge/artifacts"
import { getExecutor } from "../registry"
import {
  runKnowledgeEmbed,
  runKnowledgeIndex,
  runKnowledgePublish,
  runKnowledgeRetrieve,
} from "./index"

function context(params: Record<string, unknown>) {
  return {
    runId: "run_a",
    workflowId: "wf_a",
    stepId: "step_a",
    params,
    upstream: {},
    trigger: { workflowId: "wf_a", kind: "trigger.manual", payload: {}, originAt: 1 },
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn(),
  } as never
}

const chunk = {
  content: "Contact [REDACTED]",
  contentRedacted: "Contact [REDACTED]",
  charStart: 0,
  charEnd: 18,
  strategy: "paragraph",
  tokenCount: 4,
  metadata: {},
}

beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(storeWorkflowKnowledgeArtifact)
    .mockResolvedValue({ artifactId: "next", stage: "embedded" } as never)
  jest.mocked(tryBuildTwinDeps).mockResolvedValue({
    embedding: { provider: "openai", model: "text-embedding-3-small" },
    vectorBackend: "native",
    store: {},
  } as never)
})

it("registers every workflow-native knowledge stage", () => {
  for (const kind of [
    "source",
    "parse",
    "transform",
    "chunk",
    "embed",
    "index",
    "publish",
    "retrieve",
  ]) {
    expect(getExecutor(`knowledge.${kind}` as never, 1)).toBeDefined()
  }
})

it("retrieves only ACL-authorized chunks with stable revisions and answer citations", async () => {
  jest
    .mocked(getKnowledgeBasesByIds)
    .mockResolvedValue([{ id: "kb_1", name: "Docs", createdAt: 1, updatedAt: 1 }])
  jest.mocked(getDb).mockReturnValue({
    workflowRuns: {
      get: jest.fn().mockResolvedValue({
        triggeredBy: {
          source: "api",
          initiator: { authenticated: true, principalId: "member_1", groupIds: ["team_1"] },
        },
      }),
    },
  } as never)
  jest.mocked(applyAgentKnowledgeContextFromDb).mockImplementation(async (input) => {
    const allowed = input.authorizeChunk?.({
      chunk: {
        id: "chunk_1",
        knowledgeBaseId: "kb_1",
        sourceId: "source_1",
        generationId: "gen_1",
      } as never,
      source: {
        id: "source_1",
        acl: { visibility: "restricted", groupIds: ["team_1"] },
      } as never,
    })
    expect(allowed).toBe(true)
    return {
      systemPromptSection: "Allowed context",
      retrievedChunks: [
        {
          chunk: {
            id: "chunk_1",
            knowledgeBaseId: "kb_1",
            sourceId: "source_1",
            generationId: "gen_1",
            contentHash: "hash_1",
            content: "Approved text",
            charStart: 4,
            charEnd: 17,
          },
          score: 0.9,
        },
      ],
      citations: [
        {
          scope: "agent-knowledge-base",
          knowledgeBaseId: "kb_1",
          knowledgeBaseName: "Docs",
          sourceId: "source_1",
          sourceTitle: "Guide",
          chunkId: "chunk_1",
          charStart: 4,
          charEnd: 17,
          pageNumber: 2,
          score: 0.9,
        },
      ],
      failures: [],
      degraded: false,
      budget: { limit: 100, used: 4, truncated: false },
    } as never
  })

  await expect(
    runKnowledgeRetrieve({
      ...context({
        knowledgeBaseIds: ["kb_1"],
        query: "question",
        revisionBindings: { kb_1: "gen_1" },
      }),
      executionBinding: {
        entrypoint: "portal",
        dependencyLock: { workflows: {}, indexes: {} },
      },
    } as never)
  ).resolves.toMatchObject({
    output: {
      context: "Allowed context",
      results: [
        {
          revisionId: "gen_1",
          documentId: "source_1",
          acl: { allowed: true, reason: "group" },
        },
      ],
      citations: [{ revisionId: "gen_1", location: "page:2" }],
    },
  })
})

it("fails closed when a frozen revision no longer matches the active index", async () => {
  jest
    .mocked(getKnowledgeBasesByIds)
    .mockResolvedValue([{ id: "kb_1", name: "Docs", createdAt: 1, updatedAt: 1 }])
  jest.mocked(getDb).mockReturnValue({
    workflowRuns: { get: jest.fn().mockResolvedValue({ triggeredBy: { source: "api" } }) },
  } as never)
  jest.mocked(applyAgentKnowledgeContextFromDb).mockImplementation(async (input) => {
    input.authorizeChunk?.({
      chunk: {
        id: "chunk_1",
        knowledgeBaseId: "kb_1",
        sourceId: "source_1",
        generationId: "gen_new",
      } as never,
      source: { id: "source_1", acl: { visibility: "public" } } as never,
    })
    return {
      systemPromptSection: null,
      retrievedChunks: [],
      citations: [],
      failures: [],
      degraded: false,
      budget: { limit: 100, used: 0, truncated: false },
    }
  })

  await expect(
    runKnowledgeRetrieve(
      context({
        knowledgeBaseIds: ["kb_1"],
        query: "question",
        revisionBindings: { kb_1: "gen_old" },
      })
    )
  ).rejects.toThrow("Frozen Knowledge Base revisions are unavailable")
})

it("embeds every protected chunk through the mandatory safe gateway", async () => {
  jest.mocked(openWorkflowKnowledgeArtifact).mockResolvedValue({
    knowledgeBaseId: "kb_1",
    sourceId: "src_1",
    fingerprint: "hash",
    chunks: [chunk],
  })
  jest.mocked(generateSafeEmbedding).mockResolvedValue({ embedding: [0.1, 0.2] } as never)
  await expect(runKnowledgeEmbed(context({ artifactId: "chunked" }))).resolves.toMatchObject({
    output: { artifactId: "next", vectorCount: 1 },
  })
  expect(generateSafeEmbedding).toHaveBeenCalledWith(
    "Contact [REDACTED]",
    expect.objectContaining({ purpose: "document", vectorBackend: "native" })
  )
})

it("blocks an index artifact with inconsistent vector dimensions", async () => {
  jest.mocked(openWorkflowKnowledgeArtifact).mockResolvedValue({
    knowledgeBaseId: "kb_1",
    sourceId: "src_1",
    fingerprint: "hash",
    chunks: [chunk, chunk],
    embeddings: [[0.1], [0.2, 0.3]],
    vectorBackend: "native",
  })
  await expect(runKnowledgeIndex(context({ artifactId: "embedded" }))).rejects.toThrow(
    "inconsistent dimensions"
  )
  expect(storeWorkflowKnowledgeArtifact).not.toHaveBeenCalled()
})

it("publishes only validated artifacts through the generation swap repository", async () => {
  jest.mocked(openWorkflowKnowledgeArtifact).mockResolvedValue({
    knowledgeBaseId: "kb_1",
    sourceId: "src_1",
    fingerprint: "hash",
    chunks: [chunk],
    embeddings: [[0.1, 0.2]],
    vectorBackend: "native",
    dimensions: 2,
    validated: true,
  })
  jest.mocked(persistKnowledgeBaseChunks).mockResolvedValue({
    rows: [{ id: "row_1" }],
    vectorDocIds: ["doc_1"],
    generationId: "gen_1",
    cleanupPending: false,
  } as never)
  await expect(runKnowledgePublish(context({ artifactId: "indexed" }))).resolves.toMatchObject({
    output: { generationId: "gen_1", chunkCount: 1 },
  })
  expect(persistKnowledgeBaseChunks).toHaveBeenCalledWith(
    expect.objectContaining({ sourceId: "src_1", contentHash: "hash", embeddings: [[0.1, 0.2]] })
  )
})
