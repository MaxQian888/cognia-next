import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  createKnowledgeBaseSource,
  getKnowledgeBasesByIds,
  getKnowledgeBaseSourcesByIds,
  updateKnowledgeBaseSource,
} from "@/lib/db/knowledge-bases"
import { getDb } from "@/lib/db/schema"
import { persistKnowledgeBaseChunks } from "@/lib/knowledge-base/ingest/persist"
import { assertKnowledgeBaseRevisionBindings } from "@/lib/knowledge-base/revisions"
import { applyAgentKnowledgeContextFromDb } from "@/lib/knowledge-base/runtime/apply-agent-knowledge-context"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import { prepareChunks } from "@/lib/twin/ingest/chunk"
import { parseSource, type ParsedSource } from "@/lib/twin/ingest/parse"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { redactText, translateOffsetsThroughRedaction, unredactText } from "@cognia/redact"
import type { TwinSourceFormat, TwinSourceKind } from "@/types/twin"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  openWorkflowKnowledgeArtifact,
  storeWorkflowKnowledgeArtifact,
} from "@/lib/workflow/knowledge/artifacts"
import { authorizeKnowledgeSource } from "@/lib/workflow/knowledge/access"
import { registerNodeExecutor } from "../registry"
import { nonRetryable, sha256Hex } from "../shared/executor-support"

const MAX_SOURCE_BYTES = 20 * 1024 * 1024

type RedactionMap = ReturnType<typeof redactText>["map"]

interface ParsedArtifact {
  knowledgeBaseId: string
  sourceId: string
  fingerprint: string
  document: ParsedSource
}

interface TransformedArtifact extends Omit<ParsedArtifact, "document"> {
  format: TwinSourceFormat
  originalText: string
  redactedText: string
  redactionMap: RedactionMap
  baseMetadata: ParsedSource["baseMetadata"]
  pageMap?: ParsedSource["pageMap"]
}

interface ChunkArtifact extends Pick<
  TransformedArtifact,
  "knowledgeBaseId" | "sourceId" | "fingerprint"
> {
  chunks: Array<ReturnType<typeof prepareChunks>[number] & { contentRedacted: string }>
}

interface EmbeddedArtifact extends ChunkArtifact {
  vectorBackend: "native" | "qdrant" | "pinecone" | "weaviate" | "milvus" | "chroma"
  embeddings: number[][]
}

interface IndexedArtifact extends EmbeddedArtifact {
  dimensions?: number
  validated: true
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw nonRetryable(`${field} is required`)
  return value.trim()
}

function sourceKind(format: TwinSourceFormat): TwinSourceKind {
  if (format === "code" || format === "git-repo") return "code"
  if (format === "mbox" || format === "eml") return "email"
  if (format.endsWith("-export")) return "chat"
  return "document"
}

function isFormat(value: string): value is TwinSourceFormat {
  return [
    "markdown",
    "pdf",
    "docx",
    "xlsx",
    "pptx",
    "odt",
    "odp",
    "html",
    "csv",
    "epub",
    "rtf",
    "code",
    "chatgpt-export",
    "claude-export",
    "gemini-export",
    "slack-export",
    "lark-export",
    "dingtalk-export",
    "wechat-export",
    "mbox",
    "eml",
    "git-repo",
  ].includes(value)
}

function artifactScope(ctx: StepExecutionContext) {
  return { accountId: getActiveAccountId(), runId: ctx.runId }
}

function base64Bytes(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

export async function runKnowledgeSource(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as {
    knowledgeBaseId?: string
    sourceMode?: "text" | "web" | "existing"
    sourceId?: string
    sourceKey?: string
    title?: string
    format?: string
    content?: string
    url?: string
  }
  const knowledgeBaseId = required(params.knowledgeBaseId, "knowledgeBaseId")
  const mode = params.sourceMode ?? "text"
  if (mode === "existing") {
    const sourceId = required(params.sourceId, "sourceId")
    const [source] = await getKnowledgeBaseSourcesByIds([sourceId])
    if (!source || source.knowledgeBaseId !== knowledgeBaseId) {
      throw nonRetryable("Existing Knowledge Base source was not found")
    }
    return {
      output: { knowledgeBaseId, sourceId, fingerprint: source.fingerprint, changed: false },
    }
  }

  let content: string
  let originalLocation: string | undefined
  if (mode === "web") {
    const url = required(params.url, "url")
    const response = await proxyFetch(url, { signal: ctx.signal })
    if (!response.ok) throw new Error(`Knowledge source fetch failed with ${response.status}`)
    const announced = Number(response.headers.get("content-length") ?? 0)
    if (announced > MAX_SOURCE_BYTES) throw nonRetryable("Knowledge source exceeds 20 MiB")
    content = await response.text()
    originalLocation = url
  } else {
    content = required(params.content, "content")
  }
  const bytes = new TextEncoder().encode(content).byteLength
  if (bytes > MAX_SOURCE_BYTES) throw nonRetryable("Knowledge source exceeds 20 MiB")
  const formatValue = params.format ?? (mode === "web" ? "html" : "markdown")
  if (!isFormat(formatValue)) throw nonRetryable("Knowledge source format is unsupported")
  const fingerprint = await sha256Hex(content)
  const stableKey = params.sourceKey?.trim() || originalLocation || params.title?.trim()
  const sourceId =
    params.sourceId?.trim() ||
    (stableKey
      ? `kbs_sync_${(await sha256Hex(`${knowledgeBaseId}:${stableKey}`)).slice(0, 32)}`
      : undefined)
  const existing = sourceId ? await getDb().knowledgeBaseSources.get(sourceId) : undefined
  if (existing && existing.knowledgeBaseId !== knowledgeBaseId) {
    throw nonRetryable("Stable Knowledge Base source key belongs to another Knowledge Base")
  }
  if (existing?.fingerprint === fingerprint) {
    return { output: { knowledgeBaseId, sourceId: existing.id, fingerprint, changed: false } }
  }
  const title = params.title?.trim() || originalLocation || `Workflow source ${ctx.stepId}`
  const now = Date.now()
  if (existing) {
    await getDb().knowledgeBaseSources.put({
      ...existing,
      kind: sourceKind(formatValue),
      format: formatValue,
      title,
      content,
      contentEncoding: "utf8",
      originalLocation,
      bytes,
      fingerprint,
      status: "pending",
      chunkCount: 0,
      errorCode: undefined,
      updatedAt: now,
    })
    await getDb().knowledgeBases.update(knowledgeBaseId, { updatedAt: now })
    return { output: { knowledgeBaseId, sourceId: existing.id, fingerprint, changed: true } }
  }
  const source = await createKnowledgeBaseSource({
    ...(sourceId ? { id: sourceId } : {}),
    knowledgeBaseId,
    kind: sourceKind(formatValue),
    format: formatValue,
    title,
    content,
    contentEncoding: "utf8",
    originalLocation,
    bytes,
    fingerprint,
  })
  return { output: { knowledgeBaseId, sourceId: source.id, fingerprint, changed: true } }
}

export async function runKnowledgeParse(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const sourceId = required((ctx.params as { sourceId?: string }).sourceId, "sourceId")
  const [source] = await getKnowledgeBaseSourcesByIds([sourceId])
  if (!source) throw nonRetryable("Knowledge Base source was not found")
  const document = await parseSource({
    id: source.id,
    filename: source.originalLocation ?? source.title,
    format: source.format,
    ...(source.contentEncoding === "base64"
      ? { binary: base64Bytes(source.content) }
      : { text: source.content }),
  })
  const ref = await storeWorkflowKnowledgeArtifact({
    ...artifactScope(ctx),
    stepId: ctx.stepId,
    stage: "parsed",
    value: {
      knowledgeBaseId: source.knowledgeBaseId,
      sourceId,
      fingerprint: source.fingerprint,
      document,
    },
  })
  return { output: { ...ref, sourceId, characters: document.embeddableText.length } }
}

export async function runKnowledgeTransform(
  ctx: StepExecutionContext
): Promise<StepExecutionResult> {
  const artifactId = required((ctx.params as { artifactId?: string }).artifactId, "artifactId")
  const parsed = await openWorkflowKnowledgeArtifact<ParsedArtifact>({
    ...artifactScope(ctx),
    artifactId,
    expectedStage: "parsed",
  })
  const redaction = redactText(
    parsed.document.embeddableText,
    parsed.document.baseMetadata.speakers ?? []
  )
  const pageMap = parsed.document.pageMap
    ? translateOffsetsThroughRedaction(parsed.document.pageMap, redaction.redacted, redaction.map)
    : undefined
  const ref = await storeWorkflowKnowledgeArtifact({
    ...artifactScope(ctx),
    stepId: ctx.stepId,
    stage: "transformed",
    value: {
      knowledgeBaseId: parsed.knowledgeBaseId,
      sourceId: parsed.sourceId,
      fingerprint: parsed.fingerprint,
      format: parsed.document.format,
      originalText: parsed.document.originalText,
      redactedText: redaction.redacted,
      redactionMap: redaction.map,
      baseMetadata: parsed.document.baseMetadata,
      pageMap,
    } satisfies TransformedArtifact,
  })
  return {
    output: {
      ...ref,
      sourceId: parsed.sourceId,
      piiRedacted: Object.keys(redaction.map).length > 0,
    },
  }
}

export async function runKnowledgeChunk(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const artifactId = required((ctx.params as { artifactId?: string }).artifactId, "artifactId")
  const transformed = await openWorkflowKnowledgeArtifact<TransformedArtifact>({
    ...artifactScope(ctx),
    artifactId,
    expectedStage: "transformed",
  })
  const chunks = prepareChunks({
    redactedText: transformed.redactedText,
    originalText: transformed.originalText,
    format: transformed.format,
    baseMetadata: transformed.baseMetadata,
    ...(transformed.pageMap ? { pageMap: transformed.pageMap } : {}),
  }).map((chunk) => ({
    ...chunk,
    contentRedacted: chunk.content,
    content: unredactText(chunk.content, transformed.redactionMap),
  }))
  const ref = await storeWorkflowKnowledgeArtifact({
    ...artifactScope(ctx),
    stepId: ctx.stepId,
    stage: "chunked",
    value: {
      knowledgeBaseId: transformed.knowledgeBaseId,
      sourceId: transformed.sourceId,
      fingerprint: transformed.fingerprint,
      chunks,
    } satisfies ChunkArtifact,
  })
  return { output: { ...ref, sourceId: transformed.sourceId, chunkCount: chunks.length } }
}

export async function runKnowledgeEmbed(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const artifactId = required((ctx.params as { artifactId?: string }).artifactId, "artifactId")
  const chunked = await openWorkflowKnowledgeArtifact<ChunkArtifact>({
    ...artifactScope(ctx),
    artifactId,
    expectedStage: "chunked",
  })
  const deps = await tryBuildTwinDeps()
  if (!deps) throw nonRetryable("Knowledge embedding runtime is not configured")
  const embeddings: number[][] = []
  for (const chunk of chunked.chunks) {
    if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError")
    const result = await generateSafeEmbedding(chunk.contentRedacted, {
      profileId: `workflow-knowledge:${chunked.knowledgeBaseId}`,
      purpose: "document",
      embedding: deps.embedding,
      vectorBackend: deps.vectorBackend ?? "native",
      traceId: ctx.traceId,
    })
    embeddings.push(result.embedding)
  }
  const ref = await storeWorkflowKnowledgeArtifact({
    ...artifactScope(ctx),
    stepId: ctx.stepId,
    stage: "embedded",
    value: {
      ...chunked,
      embeddings,
      vectorBackend: deps.vectorBackend ?? "native",
    } satisfies EmbeddedArtifact,
  })
  return { output: { ...ref, sourceId: chunked.sourceId, vectorCount: embeddings.length } }
}

export async function runKnowledgeIndex(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const artifactId = required((ctx.params as { artifactId?: string }).artifactId, "artifactId")
  const embedded = await openWorkflowKnowledgeArtifact<EmbeddedArtifact>({
    ...artifactScope(ctx),
    artifactId,
    expectedStage: "embedded",
  })
  if (embedded.chunks.length !== embedded.embeddings.length) {
    throw nonRetryable("Knowledge index chunk/vector count mismatch")
  }
  const dimensions = new Set(embedded.embeddings.map((vector) => vector.length))
  if (dimensions.size > 1 || embedded.embeddings.some((vector) => vector.length === 0)) {
    throw nonRetryable("Knowledge index vectors have inconsistent dimensions")
  }
  const dimension = dimensions.size === 1 ? [...dimensions][0] : undefined
  const ref = await storeWorkflowKnowledgeArtifact({
    ...artifactScope(ctx),
    stepId: ctx.stepId,
    stage: "indexed",
    value: { ...embedded, dimensions: dimension, validated: true } satisfies IndexedArtifact,
  })
  return {
    output: {
      ...ref,
      sourceId: embedded.sourceId,
      vectorCount: embedded.embeddings.length,
      dimensions: dimension,
    },
  }
}

export async function runKnowledgePublish(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const artifactId = required((ctx.params as { artifactId?: string }).artifactId, "artifactId")
  const indexed = await openWorkflowKnowledgeArtifact<IndexedArtifact>({
    ...artifactScope(ctx),
    artifactId,
    expectedStage: "indexed",
  })
  const deps = await tryBuildTwinDeps()
  if (!deps) throw nonRetryable("Knowledge vector runtime is not configured")
  const result = await persistKnowledgeBaseChunks({
    knowledgeBaseId: indexed.knowledgeBaseId,
    sourceId: indexed.sourceId,
    vectorBackend: indexed.vectorBackend,
    store: deps.store,
    contentHash: indexed.fingerprint,
    profileFingerprint: `workflow:${indexed.vectorBackend}:${indexed.dimensions ?? "none"}`,
    chunks: indexed.chunks,
    embeddings: indexed.embeddings,
  })
  await updateKnowledgeBaseSource(indexed.sourceId, {
    status: "ready",
    chunkCount: result.rows.length,
    errorCode: undefined,
  })
  return {
    output: {
      knowledgeBaseId: indexed.knowledgeBaseId,
      sourceId: indexed.sourceId,
      generationId: result.generationId,
      chunkCount: result.rows.length,
      cleanupPending: result.cleanupPending ?? false,
    },
  }
}

export async function runKnowledgeRetrieve(
  ctx: StepExecutionContext
): Promise<StepExecutionResult> {
  const params = ctx.params as {
    knowledgeBaseIds?: string[]
    query?: string
    topKPerBase?: number
    scoreThreshold?: number
    tokenBudget?: number
    revisionBindings?: Record<string, string | string[]>
  }
  const knowledgeBaseIds = [...new Set((params.knowledgeBaseIds ?? []).map((id) => id.trim()))]
  if (knowledgeBaseIds.length === 0 || knowledgeBaseIds.some((id) => !id)) {
    throw nonRetryable("knowledgeBaseIds must contain at least one Knowledge Base ID")
  }
  const query = required(params.query, "query")
  const libraries = await getKnowledgeBasesByIds(knowledgeBaseIds)
  const foundIds = new Set(libraries.map((library) => library.id))
  const missing = knowledgeBaseIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) {
    throw nonRetryable(`Knowledge Bases were not found: ${missing.join(", ")}`)
  }
  const deps = await tryBuildTwinDeps()
  if (!deps) throw nonRetryable("Knowledge retrieval runtime is not configured")

  const run = await getDb().workflowRuns.get(ctx.runId)
  const accessBySourceId = new Map<string, ReturnType<typeof authorizeKnowledgeSource>>()
  const revisionMismatches = new Set<string>()
  const lockedIndexes = ctx.executionBinding?.dependencyLock?.indexes ?? {}
  const revisionBindings = Object.fromEntries(
    knowledgeBaseIds.flatMap((knowledgeBaseId) => {
      const authored = params.revisionBindings?.[knowledgeBaseId]
      const locked = authored
        ? []
        : Object.entries(lockedIndexes)
            .filter(
              ([key]) =>
                key === knowledgeBaseId ||
                key === `knowledge:${knowledgeBaseId}` ||
                key.startsWith(`knowledge:${knowledgeBaseId}:`)
            )
            .map(([, generationId]) => generationId)
      const values = [
        ...new Set([
          ...(Array.isArray(authored) ? authored : authored ? [authored] : []),
          ...locked,
        ]),
      ]
      return values.length > 0 ? [[knowledgeBaseId, values] as const] : []
    })
  )
  await Promise.all(
    Object.entries(revisionBindings).map(([knowledgeBaseId, generationIds]) =>
      assertKnowledgeBaseRevisionBindings(knowledgeBaseId, generationIds)
    )
  )
  const result = await applyAgentKnowledgeContextFromDb({
    knowledgeBaseIds,
    userMessage: query,
    topKPerBase: Math.floor(params.topKPerBase ?? 4),
    ...(params.scoreThreshold !== undefined ? { minScore: params.scoreThreshold } : {}),
    tokenBudget: Math.floor(params.tokenBudget ?? 4000),
    runtimeDeps: {
      store: deps.store,
      embedding: deps.embedding,
      vectorBackend: deps.vectorBackend ?? "native",
    },
    revisionBindings,
    authorizeChunk: ({ chunk, source }) => {
      if (!source) return false
      const expectedRevisions = revisionBindings[chunk.knowledgeBaseId]
      if (
        expectedRevisions &&
        (!chunk.generationId || !expectedRevisions.includes(chunk.generationId))
      ) {
        revisionMismatches.add(`${chunk.knowledgeBaseId}:${expectedRevisions.join("|")}`)
        return false
      }
      const decision = authorizeKnowledgeSource({
        source,
        entrypoint: ctx.executionBinding?.entrypoint,
        triggeredBy: run?.triggeredBy,
      })
      accessBySourceId.set(source.id, decision)
      return decision.allowed
    },
  })
  if (revisionMismatches.size > 0) {
    throw nonRetryable(
      `Frozen Knowledge Base revisions are unavailable: ${[...revisionMismatches].join(", ")}`
    )
  }

  const citationByChunkId = new Map(
    result.citations.map((citation) => [citation.chunkId, citation])
  )
  return {
    output: {
      context: result.systemPromptSection,
      results: result.retrievedChunks.map(({ chunk, score }) => {
        const citation = citationByChunkId.get(chunk.id)
        const access = accessBySourceId.get(chunk.sourceId)
        return {
          knowledgeBaseId: chunk.knowledgeBaseId,
          sourceId: chunk.sourceId,
          documentId: chunk.sourceId,
          revisionId: chunk.generationId ?? chunk.contentHash,
          chunkId: chunk.id,
          content: chunk.content,
          score,
          position: {
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
            ...(citation?.pageNumber !== undefined ? { pageNumber: citation.pageNumber } : {}),
            ...(citation?.filePath ? { filePath: citation.filePath } : {}),
          },
          acl: {
            allowed: true,
            visibility: access?.visibility ?? "private",
            reason: access?.reason ?? "trusted-local",
          },
        }
      }),
      citations: result.citations.map((citation) => ({
        sourceId: citation.sourceId,
        documentId: citation.sourceId,
        revisionId:
          result.retrievedChunks.find((item) => item.chunk.id === citation.chunkId)?.chunk
            .generationId ??
          result.retrievedChunks.find((item) => item.chunk.id === citation.chunkId)?.chunk
            .contentHash ??
          citation.chunkId,
        chunkId: citation.chunkId,
        label: `${citation.knowledgeBaseName} / ${citation.sourceTitle}`,
        location:
          citation.filePath ??
          (citation.pageNumber !== undefined ? `page:${citation.pageNumber}` : undefined),
      })),
      failures: result.failures,
      degraded: result.degraded,
      budget: result.budget,
    },
  }
}

for (const registration of [
  { kind: "knowledge.source" as const, execute: runKnowledgeSource, retryable: false },
  { kind: "knowledge.parse" as const, execute: runKnowledgeParse, retryable: true },
  { kind: "knowledge.transform" as const, execute: runKnowledgeTransform, retryable: true },
  { kind: "knowledge.chunk" as const, execute: runKnowledgeChunk, retryable: true },
  { kind: "knowledge.embed" as const, execute: runKnowledgeEmbed, retryable: true },
  { kind: "knowledge.index" as const, execute: runKnowledgeIndex, retryable: true },
  { kind: "knowledge.publish" as const, execute: runKnowledgePublish, retryable: false },
  { kind: "knowledge.retrieve" as const, execute: runKnowledgeRetrieve, retryable: true },
]) {
  registerNodeExecutor({ ...registration, typeVersion: 1 })
}
