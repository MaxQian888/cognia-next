import { reciprocalRankFusion } from "./hybrid-search"
import { sha256Hex, type RetrievalProfileV1 } from "./retrieval-profile"
import { assessRetrievedContentTrust } from "./rag-guardrails"

export type RetrievalDomain = "memory" | "twin" | "project" | "kb" | "external"
export type RetrievalTrust = "trusted" | "untrusted" | "quarantined"

export interface RetrievalReaderScope {
  projectId?: string
  agentId?: string
  branch?: string
  path?: string
  workspaceTrusted?: boolean
}

export interface RetrievalRequest {
  query: string
  reader: RetrievalReaderScope
  domains: RetrievalDomain[]
  topK?: number
  tokenBudget?: number
  precomputedEmbedding?: QueryEmbedding
  signal?: AbortSignal
}

export interface QueryEmbedding {
  embedding: number[]
  safeTextHash: string
}

export interface RetrievalCandidate {
  id: string
  sourceId: string
  domain: RetrievalDomain
  score: number
  metadata?: Record<string, unknown>
}

export interface RetrievalCitation {
  sourceRevision: string
  startOffset: number
  endOffset: number
  evidenceHash?: string
}

export interface RetrievalContent extends Omit<RetrievalCandidate, "score"> {
  content: string
  tokenCount: number
  trust: RetrievalTrust
  citation: RetrievalCitation
  metadata?: Record<string, unknown>
}

export interface RetrievalHit extends RetrievalContent {
  score: number
  lexicalScore?: number
  vectorScore?: number
  rerankScore?: number
}

export type RetrievalDegradeCode =
  | "embedding_unavailable"
  | "vector_not_configured"
  | "vector_unavailable"
  | "vector_dimension_mismatch"
  | "retrieval_timeout"
  | "token_budget_exhausted"
  | "content_missing"
  | "content_quarantined"
  | "kill_switch_active"

export interface RetrievalDegradeReason {
  code: RetrievalDegradeCode
  stage: "query" | "lexical" | "vector" | "eligibility" | "content" | "budget"
  retryable: boolean
}

/**
 * Whether a reason means the answer is worse than the corpus allows, rather
 * than merely narrower than requested.
 *
 * `token_budget_exhausted`, `content_missing` and `content_quarantined` are
 * deliberately absent: dropping a quarantined chunk or one that did not fit the
 * budget is the system working, not failing. Exported so every domain that
 * produces control-plane artifacts answers this the same way instead of
 * restating the list.
 */
export function isDegradingRetrievalReason(code: RetrievalDegradeCode): boolean {
  return DEGRADING_RETRIEVAL_CODES.includes(code)
}

const DEGRADING_RETRIEVAL_CODES: readonly RetrievalDegradeCode[] = [
  "embedding_unavailable",
  "vector_not_configured",
  "vector_unavailable",
  "vector_dimension_mismatch",
  "retrieval_timeout",
  "kill_switch_active",
]

export interface RetrievalTraceV1 {
  schemaVersion: 1
  traceId: string
  queryHash: string
  profileFingerprint: string
  generationId: string
  candidateIds: string[]
  hitIds: string[]
  scores: Array<{
    id: string
    lexical?: number
    vector?: number
    fused: number
    rerank?: number
  }>
  exclusions: Array<{ id: string; reason: string }>
  cacheHit: boolean
  budget: { topK: number; tokenLimit: number; tokensUsed: number }
  latencyMs: number
  grounding?: { supportedClaims: number; unsupportedClaims: number; blocked: boolean }
}

export interface RetrievalResult {
  hits: RetrievalHit[]
  citations: Array<RetrievalCitation & { hitId: string; sourceId: string }>
  partial: boolean
  degraded: boolean
  reasons: RetrievalDegradeReason[]
  trace: RetrievalTraceV1
}

export interface EligibilityDecision {
  eligible: boolean
  reason?: string
}

export interface RetrievalKernelDependencies {
  profile: RetrievalProfileV1
  profileFingerprint: string
  generationId: string
  embedQuery?: (query: string, signal?: AbortSignal) => Promise<QueryEmbedding>
  lexicalSearch: (
    query: string,
    request: RetrievalRequest,
    limit: number
  ) => Promise<RetrievalCandidate[]>
  vectorSearch?: (
    embedding: number[],
    request: RetrievalRequest,
    limit: number
  ) => Promise<RetrievalCandidate[]>
  checkEligibility: (
    candidate: RetrievalCandidate,
    request: RetrievalRequest
  ) => Promise<EligibilityDecision> | EligibilityDecision
  resolveContent: (
    candidates: RetrievalCandidate[],
    request: RetrievalRequest
  ) => Promise<RetrievalContent[]>
  rerank?: (
    query: string,
    hits: RetrievalHit[],
    request: RetrievalRequest
  ) => Promise<Array<{ id: string; score: number }>>
  now?: () => number
  createTraceId?: () => string
  /** Rollout kill switch: keep safe lexical reads, stop embedding/vector work. */
  killSwitchEngaged?: () => boolean | Promise<boolean>
}

function uniqueCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false
    seen.add(candidate.id)
    return true
  })
}

function addReason(reasons: RetrievalDegradeReason[], reason: RetrievalDegradeReason): void {
  if (!reasons.some((current) => current.code === reason.code && current.stage === reason.stage)) {
    reasons.push(reason)
  }
}

function isValidEmbedding(embedding: number[], dimensions?: number): boolean {
  return (
    embedding.length > 0 &&
    embedding.every(Number.isFinite) &&
    (dimensions === undefined || embedding.length === dimensions)
  )
}

export function createRetrievalKernel(dependencies: RetrievalKernelDependencies) {
  return {
    async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
      if (!request.query.trim()) {
        throw new Error("Retrieval query must not be empty")
      }
      if (request.signal?.aborted) {
        throw request.signal.reason ?? new DOMException("Retrieval aborted", "AbortError")
      }

      const startedAt = (dependencies.now ?? Date.now)()
      const topK = request.topK ?? dependencies.profile.budgets.topK
      const tokenBudget = request.tokenBudget ?? dependencies.profile.budgets.tokenBudget
      const candidateLimit = Math.max(topK * 4, topK)
      const reasons: RetrievalDegradeReason[] = []
      const exclusions: RetrievalTraceV1["exclusions"] = []
      const killSwitchEngaged = (await dependencies.killSwitchEngaged?.()) ?? false

      const lexicalCandidates = await dependencies.lexicalSearch(
        request.query,
        request,
        candidateLimit
      )

      let queryEmbedding = request.precomputedEmbedding
      if (killSwitchEngaged) {
        addReason(reasons, {
          code: "kill_switch_active",
          stage: "vector",
          retryable: false,
        })
      } else if (!queryEmbedding && dependencies.embedQuery) {
        try {
          queryEmbedding = await dependencies.embedQuery(request.query, request.signal)
        } catch {
          addReason(reasons, {
            code: "embedding_unavailable",
            stage: "query",
            retryable: true,
          })
        }
      }

      let vectorCandidates: RetrievalCandidate[] = []
      if (killSwitchEngaged) {
        // Safe BM25-only mode is intentional while the rollout is stopped.
      } else if (!dependencies.vectorSearch) {
        addReason(reasons, {
          code: "vector_not_configured",
          stage: "vector",
          retryable: false,
        })
      } else if (!queryEmbedding) {
        addReason(reasons, {
          code: "embedding_unavailable",
          stage: "query",
          retryable: true,
        })
      } else if (
        !isValidEmbedding(queryEmbedding.embedding, dependencies.profile.embedding.dimensions)
      ) {
        addReason(reasons, {
          code: "vector_dimension_mismatch",
          stage: "vector",
          retryable: false,
        })
      } else {
        try {
          vectorCandidates = await dependencies.vectorSearch(
            queryEmbedding.embedding,
            request,
            candidateLimit
          )
        } catch {
          addReason(reasons, {
            code: "vector_unavailable",
            stage: "vector",
            retryable: true,
          })
        }
      }

      const lexicalRanking = lexicalCandidates.map(({ id, score }) => ({ id, score }))
      const vectorRanking = vectorCandidates.map(({ id, score }) => ({ id, score }))
      const fused =
        vectorRanking.length > 0
          ? reciprocalRankFusion([lexicalRanking, vectorRanking], [0.4, 0.6])
          : lexicalRanking
      const candidateById = new Map(
        [...lexicalCandidates, ...vectorCandidates].map((candidate) => [candidate.id, candidate])
      )
      const candidateOrder = uniqueCandidates([...lexicalCandidates, ...vectorCandidates])
      const eligible: RetrievalCandidate[] = []

      for (const candidate of candidateOrder) {
        const decision = await dependencies.checkEligibility(candidate, request)
        if (!decision.eligible) {
          exclusions.push({ id: candidate.id, reason: decision.reason ?? "ineligible" })
          continue
        }
        eligible.push(candidate)
      }

      const eligibleIds = new Set(eligible.map(({ id }) => id))
      const rankedCandidates = fused
        .filter(({ id }) => eligibleIds.has(id))
        .slice(0, candidateLimit)
        .map(({ id, score }) => ({ ...candidateById.get(id)!, score }))
      const contents = await dependencies.resolveContent(rankedCandidates, request)
      const contentById = new Map(contents.map((content) => [content.id, content]))
      let hits: RetrievalHit[] = []

      for (const candidate of rankedCandidates) {
        const content = contentById.get(candidate.id)
        if (!content) {
          exclusions.push({ id: candidate.id, reason: "content_missing" })
          addReason(reasons, { code: "content_missing", stage: "content", retryable: true })
          continue
        }
        const trustAssessment = assessRetrievedContentTrust(content.content)
        if (content.trust === "quarantined" || trustAssessment.trust === "quarantined") {
          exclusions.push({ id: candidate.id, reason: "content_quarantined" })
          addReason(reasons, {
            code: "content_quarantined",
            stage: "content",
            retryable: false,
          })
          continue
        }
        hits.push({
          ...content,
          score: candidate.score,
          lexicalScore: lexicalCandidates.find(({ id }) => id === candidate.id)?.score,
          vectorScore: vectorCandidates.find(({ id }) => id === candidate.id)?.score,
        })
      }

      if (dependencies.rerank && hits.length > 1) {
        const reranked = await dependencies.rerank(request.query, hits, request)
        const rerankById = new Map(reranked.map(({ id, score }) => [id, score]))
        hits = hits
          .map((hit) => ({ ...hit, rerankScore: rerankById.get(hit.id) }))
          .sort(
            (left, right) => (right.rerankScore ?? right.score) - (left.rerankScore ?? left.score)
          )
      }

      const budgetedHits: RetrievalHit[] = []
      let tokensUsed = 0
      for (const hit of hits.slice(0, topK)) {
        if (tokensUsed + hit.tokenCount > tokenBudget) {
          addReason(reasons, {
            code: "token_budget_exhausted",
            stage: "budget",
            retryable: false,
          })
          continue
        }
        budgetedHits.push(hit)
        tokensUsed += hit.tokenCount
      }

      const endedAt = (dependencies.now ?? Date.now)()
      const queryHash = queryEmbedding?.safeTextHash ?? (await sha256Hex(request.query))
      const scoreTrace = fused.map(({ id, score }) => ({
        id,
        lexical: lexicalCandidates.find((candidate) => candidate.id === id)?.score,
        vector: vectorCandidates.find((candidate) => candidate.id === id)?.score,
        fused: score,
        rerank: hits.find((hit) => hit.id === id)?.rerankScore,
      }))

      return {
        hits: budgetedHits,
        citations: budgetedHits.map((hit) => ({
          hitId: hit.id,
          sourceId: hit.sourceId,
          ...hit.citation,
        })),
        partial: reasons.length > 0,
        degraded: reasons.some((reason) => isDegradingRetrievalReason(reason.code)),
        reasons,
        trace: {
          schemaVersion: 1,
          traceId: dependencies.createTraceId?.() ?? crypto.randomUUID(),
          queryHash,
          profileFingerprint: dependencies.profileFingerprint,
          generationId: dependencies.generationId,
          candidateIds: candidateOrder.map(({ id }) => id),
          hitIds: budgetedHits.map(({ id }) => id),
          scores: scoreTrace,
          exclusions,
          cacheHit: false,
          budget: { topK, tokenLimit: tokenBudget, tokensUsed },
          latencyMs: Math.max(0, endedAt - startedAt),
        },
      }
    },
  }
}
