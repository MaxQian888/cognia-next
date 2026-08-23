import type { KnowledgeBase, KnowledgeBaseChunk, KnowledgeBaseSource } from "@/types/knowledge-base"
import { getKnowledgeBasesByIds, getKnowledgeBaseSourcesByIds } from "@/lib/db/knowledge-bases"
import { retrieveKnowledgeBaseChunks, type KnowledgeBaseRuntimeDeps } from "./retrieve"

export interface RetrievedAgentKnowledgeChunk {
  chunk: KnowledgeBaseChunk
  score: number
}

export interface AgentKnowledgeLibraryResult {
  chunks: RetrievedAgentKnowledgeChunk[]
  degraded: boolean
  degradedReason?: string
}

export interface AgentKnowledgeFailure {
  knowledgeBaseId: string
  reason: string
  rebuildRequired: boolean
}

export interface AgentKnowledgeCitation {
  scope: "agent-knowledge-base"
  knowledgeBaseId: string
  knowledgeBaseName: string
  sourceId: string
  sourceTitle: string
  chunkId: string
  charStart: number
  charEnd: number
  pageNumber?: number
  filePath?: string
  score: number
}

export interface ApplyAgentKnowledgeContextDeps {
  retrieveLibrary: (input: {
    knowledgeBaseId: string
    userMessage: string
    topK: number
  }) => Promise<AgentKnowledgeLibraryResult>
  loadLibraries: (ids: readonly string[]) => Promise<KnowledgeBase[]>
  loadSources: (ids: readonly string[]) => Promise<KnowledgeBaseSource[]>
}

export interface ApplyAgentKnowledgeContextInput {
  knowledgeBaseIds: readonly string[]
  userMessage: string
  topKPerBase: number
  tokenBudget: number
  minScore?: number
  revisionBindings?: Readonly<Record<string, readonly string[]>>
  /** Optional document-level authorization applied before content enters the prompt. */
  authorizeChunk?: (input: {
    chunk: KnowledgeBaseChunk
    source: KnowledgeBaseSource | undefined
  }) => boolean
  deps: ApplyAgentKnowledgeContextDeps
}

export interface ApplyAgentKnowledgeContextFromDbInput extends Omit<
  ApplyAgentKnowledgeContextInput,
  "deps"
> {
  runtimeDeps: KnowledgeBaseRuntimeDeps
  precomputedQueryEmbedding?: number[]
}

export interface ApplyAgentKnowledgeContextResult {
  systemPromptSection: string | null
  retrievedChunks: RetrievedAgentKnowledgeChunk[]
  citations: AgentKnowledgeCitation[]
  failures: AgentKnowledgeFailure[]
  degraded: boolean
  budget: { limit: number; used: number; truncated: boolean }
}

function normalizeForDedupe(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll(/\s+/g, " ")
}

function failureFor(knowledgeBaseId: string, reason: string): AgentKnowledgeFailure {
  return {
    knowledgeBaseId,
    reason,
    rebuildRequired: reason.startsWith("dimension-mismatch"),
  }
}

/**
 * Retrieve every Agent-bound library in parallel and fold the results into one
 * bounded prompt section. A failed library is isolated and reported by id;
 * successful libraries continue to contribute context.
 */
export async function applyAgentKnowledgeContext(
  input: ApplyAgentKnowledgeContextInput
): Promise<ApplyAgentKnowledgeContextResult> {
  const knowledgeBaseIds = [...new Set(input.knowledgeBaseIds.filter(Boolean))]
  const query = input.userMessage.trim()
  const tokenLimit = Math.max(0, Math.floor(input.tokenBudget))
  const empty: ApplyAgentKnowledgeContextResult = {
    systemPromptSection: null,
    retrievedChunks: [],
    citations: [],
    failures: [],
    degraded: false,
    budget: { limit: tokenLimit, used: 0, truncated: false },
  }
  if (!query || knowledgeBaseIds.length === 0 || input.topKPerBase <= 0 || tokenLimit <= 0) {
    return empty
  }

  const retrievals = knowledgeBaseIds.map(async (knowledgeBaseId) => {
    try {
      const result = await input.deps.retrieveLibrary({
        knowledgeBaseId,
        userMessage: query,
        topK: Math.floor(input.topKPerBase),
      })
      return { knowledgeBaseId, result }
    } catch {
      return {
        knowledgeBaseId,
        result: {
          chunks: [],
          degraded: true,
          degradedReason: "retrieve-failed",
        } satisfies AgentKnowledgeLibraryResult,
      }
    }
  })

  const [settled, libraries] = await Promise.all([
    Promise.all(retrievals),
    input.deps.loadLibraries(knowledgeBaseIds),
  ])

  const failures: AgentKnowledgeFailure[] = []
  const candidates: RetrievedAgentKnowledgeChunk[] = []
  for (const { knowledgeBaseId, result } of settled) {
    candidates.push(...result.chunks)
    if (result.degraded) {
      failures.push(failureFor(knowledgeBaseId, result.degradedReason ?? "retrieve-failed"))
    }
  }

  const candidateSourceIds = [...new Set(candidates.map((item) => item.chunk.sourceId))]
  const candidateSources =
    candidateSourceIds.length > 0 ? await input.deps.loadSources(candidateSourceIds) : []
  const candidateSourceById = new Map(candidateSources.map((row) => [row.id, row]))
  const scoredCandidates = candidates.filter(
    (candidate) => input.minScore === undefined || candidate.score >= input.minScore
  )
  const authorizedCandidates = input.authorizeChunk
    ? scoredCandidates.filter(({ chunk }) =>
        input.authorizeChunk?.({ chunk, source: candidateSourceById.get(chunk.sourceId) })
      )
    : scoredCandidates

  authorizedCandidates.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
  const seenContent = new Set<string>()
  const retrievedChunks: RetrievedAgentKnowledgeChunk[] = []
  let used = 0
  let truncated = false
  for (const candidate of authorizedCandidates) {
    const key = normalizeForDedupe(candidate.chunk.content)
    if (!key || seenContent.has(key)) {
      truncated = true
      continue
    }
    seenContent.add(key)
    const tokens = Math.max(0, Math.floor(candidate.chunk.tokenCount))
    if (used + tokens > tokenLimit) {
      truncated = true
      continue
    }
    used += tokens
    retrievedChunks.push(candidate)
  }

  const libraryById = new Map(libraries.map((row) => [row.id, row]))
  const sourceById = candidateSourceById
  const citations = retrievedChunks.map(({ chunk, score }) => {
    const knowledgeBaseName = libraryById.get(chunk.knowledgeBaseId)?.name ?? chunk.knowledgeBaseId
    const sourceTitle = sourceById.get(chunk.sourceId)?.title ?? chunk.sourceId
    return {
      scope: "agent-knowledge-base" as const,
      knowledgeBaseId: chunk.knowledgeBaseId,
      knowledgeBaseName,
      sourceId: chunk.sourceId,
      sourceTitle,
      chunkId: chunk.id,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      pageNumber:
        typeof chunk.metadata.pageNumber === "number" ? chunk.metadata.pageNumber : undefined,
      filePath: typeof chunk.metadata.filePath === "string" ? chunk.metadata.filePath : undefined,
      score,
    }
  })

  if (retrievedChunks.length === 0) {
    return {
      ...empty,
      failures,
      degraded: failures.length > 0,
      budget: { limit: tokenLimit, used, truncated },
    }
  }

  const body = retrievedChunks
    .map(({ chunk }) => {
      const knowledgeBaseName =
        libraryById.get(chunk.knowledgeBaseId)?.name ?? chunk.knowledgeBaseId
      const sourceTitle = sourceById.get(chunk.sourceId)?.title ?? chunk.sourceId
      return `[${knowledgeBaseName} / ${sourceTitle}]\n${chunk.content}`
    })
    .join("\n\n")

  return {
    systemPromptSection:
      "## Agent knowledge bases\n" +
      "Use the following retrieved excerpts when relevant and cite the library and source names.\n\n" +
      body,
    retrievedChunks,
    citations,
    failures,
    degraded: failures.length > 0,
    budget: { limit: tokenLimit, used, truncated },
  }
}

/** Production adapter over the tested merge seam and canonical Dexie tables. */
export function applyAgentKnowledgeContextFromDb(
  input: ApplyAgentKnowledgeContextFromDbInput
): Promise<ApplyAgentKnowledgeContextResult> {
  return applyAgentKnowledgeContext({
    ...input,
    deps: {
      retrieveLibrary: ({ knowledgeBaseId, userMessage, topK }) =>
        retrieveKnowledgeBaseChunks({
          knowledgeBaseId,
          userMessage,
          topK,
          precomputedQueryEmbedding: input.precomputedQueryEmbedding,
          generationIds: input.revisionBindings?.[knowledgeBaseId],
          deps: input.runtimeDeps,
        }),
      loadLibraries: getKnowledgeBasesByIds,
      loadSources: getKnowledgeBaseSourcesByIds,
    },
  })
}
