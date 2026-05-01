/**
 * Employee Digital Twin — type model.
 *
 * Five Dexie tables back the twin subsystem (see `lib/db/schema.ts` v14):
 *
 *   • `twinSources`  — registry of every raw artifact (file/chat/repo) ingested
 *   • `twinChunks`   — sliced chunks with vector-store pointers + provenance
 *   • `twinProfile`  — distilled per-twin profile (style / playbook / entity / decision)
 *   • `twinDrafts`   — character / skill drafts produced by the distill pipeline
 *   • `twinJobs`     — durable job state for ingest + distill workflows
 *
 * The shapes are designed for **multi-twin coexistence**: every row carries
 * a `twinId` so the same Dexie database can host multiple twins (self,
 * mentor, predecessor) without UI gymnastics.
 *
 * Implementation phases (see `~/.claude/plans/superpowers-deep-penguin.md`):
 *  - Phase 3 (this file) — schema + CRUD scaffolding
 *  - Phase 4 — ingest pipeline writes `twinSources` + `twinChunks` + `twinJobs`
 *  - Phase 5 — distill pipeline writes `twinProfile` + `twinDrafts` + `twinJobs`
 *  - Phase 6 — runtime reads `twinProfile` + `twinChunks` for RAG injection
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sources — original ingested artifacts.
// ─────────────────────────────────────────────────────────────────────────────

/** Top-level kind groups; routes to a parser/importer family in `lib/twin/ingest`. */
export type TwinSourceKind = "document" | "chat" | "code" | "email"

/**
 * Concrete file/format identifiers. Document formats line up with
 * `lib/document/document-processor.ts`'s `processDocument` dispatch.
 */
export type TwinSourceFormat =
  // Document family
  | "markdown"
  | "pdf"
  | "docx"
  | "pptx"
  | "odt"
  | "odp"
  | "html"
  | "csv"
  | "epub"
  | "rtf"
  | "code"
  // Chat family — built-in importers
  | "chatgpt-export"
  | "claude-export"
  | "gemini-export"
  // Chat family — external IM exports (Phase 4 stretch goals)
  | "slack-export"
  | "lark-export"
  | "dingtalk-export"
  | "wechat-export"
  // Email family
  | "mbox"
  | "eml"
  // Code family
  | "git-repo"

export type TwinSourceStatus = "pending" | "parsing" | "parsed" | "failed" | "deleted"

export interface TwinSource {
  /** nanoid */
  id: string
  /** FK → logical twin id (independent from any character.id; see plan §2.6 A) */
  twinId: string

  kind: TwinSourceKind
  format: TwinSourceFormat

  /** Path / URL / repo URL / "manual"; opaque to the runtime. */
  source: string
  /** Display title — extracted from content when possible, else user-supplied. */
  title: string
  /** Raw byte length of the original artifact. */
  bytes: number
  /** sha256 of original content. Used as a per-twin dedupe key. */
  fingerprint: string

  /** Backfilled by ingest after chunking completes. */
  chunkCount: number

  status: TwinSourceStatus
  /** Populated when `status === "failed"`. */
  errorMessage?: string

  importedAt: number
  parsedAt?: number

  /** Optional user tags (search/scoring side-channel). */
  tags?: string[]

  /** Whether PII redaction has run on this source. */
  redacted: boolean
  /**
   * Encrypted PII↔placeholder map. Encrypted with the user's stronghold key
   * before being written here so the Dexie row never holds raw originals.
   * Stored as base64-encoded ciphertext + nonce + tag (format owned by
   * `lib/twin/ingest/redact.ts`).
   */
  redactionMapEnc?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunks — slice + vector-store pointer + provenance.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors the chunking strategies in `lib/ai/embedding/chunking.ts`. */
export type ChunkingStrategyId =
  | "fixed"
  | "sentence"
  | "paragraph"
  | "semantic"
  | "heading"
  | "smart"
  | "recursive"
  | "sliding_window"
  | "code"

/** Vector backend identifier — must match the readiness registry. */
export type VectorBackend = "qdrant" | "pinecone" | "milvus" | "weaviate" | "chroma"

/**
 * Format-specific chunk metadata. Optional fields appear only when the
 * underlying source kind populated them; downstream UI uses the present
 * fields to render provenance breadcrumbs.
 */
export interface TwinChunkMetadata {
  // PDF
  pageNumber?: number
  // Markdown / docx
  headingPath?: string[]
  // Chat / IM exports
  speakers?: string[]
  /** ms-since-epoch — chat / email timestamp. */
  timestamp?: number
  // Code
  commitSha?: string
  filePath?: string
  lineStart?: number
  lineEnd?: number
  // Open extension point — importers may add custom keys here.
  [key: string]: unknown
}

export interface TwinChunk {
  id: string
  twinId: string
  /** FK → twinSources.id */
  sourceId: string

  /**
   * Original chunk text (UI display, citation snippets). Kept alongside
   * `contentRedacted` so the workbench shows the user's own data while
   * embeddings/LLM calls always use the scrubbed version.
   */
  content: string
  /** PII-stripped version — fed to embed() and any LLM call. */
  contentRedacted: string
  charStart: number
  charEnd: number

  /** Backend the vector lives on; lets us route updates to the right client. */
  vectorBackend: VectorBackend
  /** Collection / namespace name on the remote vector store. */
  vectorCollection: string
  /** Remote doc id; used to resolve a search hit back to this chunk. */
  vectorDocId: string

  strategy: ChunkingStrategyId
  /** Token count (js-tiktoken approximation). */
  tokenCount: number

  metadata: TwinChunkMetadata

  /** Backfilled by `KnowledgeAgent` (Phase 5) — entity names mentioned. */
  entityTags?: string[]

  createdAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile — distilled per-twin structured data.
// ─────────────────────────────────────────────────────────────────────────────

export interface StyleSample {
  id: string
  /** Human-readable label, e.g. "客户邮件 - 拒绝需求" or "PR description". */
  contextLabel: string
  /** Verbatim original text used as a few-shot example. */
  original: string
  /** Compressed restatement used as a retrieval key. */
  summary: string
  /** FK → twinChunks.id */
  sourceChunkId: string
  /** Free-form tone descriptors, e.g. ["professional", "concise"]. */
  tone: string[]
  addedAt: number
  addedBy: "distill" | "manual"
}

export interface PlaybookStep {
  order: number
  action: string
  rationale?: string
}

export interface PlaybookExample {
  /** FK → twinChunks.id[] */
  sourceChunkIds: string[]
  outcome: string
}

export interface Playbook {
  id: string
  title: string
  /** Natural-language trigger condition. */
  trigger: string
  steps: PlaybookStep[]
  examples: PlaybookExample[]
  /** 0..1; product of frequency and step-similarity from PlaybookAgent. */
  confidence: number
  /** Set when this playbook has been adopted into a Skill — FK → skills.id */
  promotedToSkillId?: string
}

export type EntityRole = "person" | "team" | "project" | "system" | "concept"

export interface ProfileEntity {
  name: string
  aliases: string[]
  role: EntityRole
  /** Free-form relation (e.g. "我的同事 / 我做过的项目"). */
  relation?: string
  /** FK → twinChunks.id */
  firstSeenChunkId: string
}

export interface DecisionRecord {
  id: string
  context: string
  choice: string
  rationale: string
  /** FK → twinChunks.id[] */
  sourceChunkIds: string[]
  /** ms-since-epoch — when the decision happened, if datable. */
  timestamp?: number
}

export interface TwinProfile {
  /** Always equal to twinId (1:1). */
  id: string
  twinId: string

  styleSamples: StyleSample[]
  playbooks: Playbook[]
  entities: ProfileEntity[]
  decisions: DecisionRecord[]

  /** Short prose summary fed into the runtime system prompt. */
  voiceSummary: string

  updatedAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafts — distill output awaiting human review.
// ─────────────────────────────────────────────────────────────────────────────

export type TwinDraftKind = "character" | "skill"
export type TwinDraftStatus = "pending" | "accepted" | "rejected" | "edited"

/**
 * Distill output — uses the same shape as the official `Character` and
 * `Skill` records but lives in a separate table so unaccepted drafts never
 * pollute the live picker. The `payload.data` field is `Partial<…>` because
 * the distill pipeline may not produce every authoring-time field; the
 * workbench fills in defaults at acceptance time.
 */
export type TwinDraftPayload =
  | {
      kind: "character"
      /** Imported as `Partial<Character>` to avoid forking the canonical type. */
      data: Record<string, unknown>
    }
  | {
      kind: "skill"
      data: Record<string, unknown>
      sourcePlaybookId?: string
    }

export interface TwinDraftProvenance {
  /** FK → twinChunks.id[] */
  chunkIds: string[]
  /** FK → twinProfile.playbooks[].id[] */
  playbookIds?: string[]
  /** Distiller's natural-language explanation of why this draft exists. */
  rationale: string
}

export interface TwinDraftEvaluation {
  /** 0..1 — set by EvaluatorAgent (Phase 5). Lower = more reviewer attention. */
  qualityScore: number
  /** Specific concerns flagged by the evaluator (dedup before display). */
  concerns: string[]
  /** Concrete suggestions a reviewer can act on. */
  suggestions: string[]
}

export interface TwinDraft {
  id: string
  twinId: string
  /** FK → twinJobs.id */
  jobId: string

  kind: TwinDraftKind
  payload: TwinDraftPayload

  provenance: TwinDraftProvenance
  /** Optional — only produced when EvaluatorAgent has run. */
  evaluation?: TwinDraftEvaluation

  status: TwinDraftStatus
  reviewedAt?: number
  reviewerNote?: string
  /** Set when status === "accepted" — FK → characters.id or skills.id */
  acceptedAsId?: string

  createdAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs — ingest / distill workflow tracking.
// ─────────────────────────────────────────────────────────────────────────────

export type TwinJobKind = "ingest" | "distill" | "re-distill"

export type TwinJobStatus = "queued" | "running" | "paused" | "completed" | "failed"

/**
 * Phase identifier — free-form so phase-level UI can reflect the active
 * stage of the pipeline ("parsing" / "embedding" / "style-agent" / …).
 * Phase 4 + 5 own the canonical phase names; this type stays open-ended
 * to avoid coupling the schema to one pipeline shape.
 */
export type TwinJobPhase = string

export interface TwinJob {
  id: string
  twinId: string
  kind: TwinJobKind

  /**
   * For `ingest`: the source ids to process.
   * For `distill`: the chunk-source ids the run was scoped over (empty for
   * a full-twin distill).
   */
  sourceIds: string[]

  status: TwinJobStatus
  phase: TwinJobPhase
  /** 0..100 */
  progress: number

  queuedAt: number
  startedAt?: number
  completedAt?: number

  errorMessage?: string
  retryCount: number

  /** FK → twinDrafts.id[] — produced by `distill` runs. */
  outputDraftIds?: string[]

  /** Resource-accounting fields, populated by the executors. */
  llmTokensUsed?: number
  embeddingTokensUsed?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Character extension — runtime-side soft binding.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-character twin runtime preferences. All fields are optional with sane
 * defaults (`enableRag = true`, `ragTopK = 6`, `enableStyleFewShot = true`,
 * `styleSamplesK = 3`). Apply via `runtime/apply-twin-context.ts` (Phase 6).
 */
export interface TwinSettings {
  enableRag: boolean
  ragTopK: number
  enableStyleFewShot: boolean
  styleSamplesK: number
}

export const DEFAULT_TWIN_SETTINGS: TwinSettings = {
  enableRag: true,
  ragTopK: 6,
  enableStyleFewShot: true,
  styleSamplesK: 3,
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime settings — vector store + embedding + distill LLM configuration.
// Stored as a single Dexie row under id "twin-runtime"; see
// `lib/db/twin-runtime-settings.ts`.
// ─────────────────────────────────────────────────────────────────────────────

export interface TwinRuntimeStorageConfig {
  vectorBackend: VectorBackend
  qdrant?: { url: string; apiKey?: string }
  pinecone?: { apiKey: string; indexName: string; namespace?: string }
  weaviate?: { url: string; apiKey?: string }
  milvus?: { address: string; token?: string; ssl?: boolean }
  chroma?: { mode: "embedded" | "server"; serverUrl?: string }
}

export interface TwinRuntimeEmbeddingSettings {
  provider: "openai" | "google" | "cohere" | "mistral" | "transformersjs"
  model: string
  apiKey: string
  baseURL?: string
}

export interface TwinRuntimeLlmSettings {
  /** Currently only "anthropic" is wired through to a real client. */
  provider: "anthropic"
  model: string
  apiKey: string
  baseURL?: string
}

export interface TwinRuntimeSettings {
  /** When false, the workbench does not auto-start its job-worker even if
   *  jobs are queued. */
  workerEnabled: boolean
  storage: TwinRuntimeStorageConfig
  embedding: TwinRuntimeEmbeddingSettings
  llm: TwinRuntimeLlmSettings
}

export const DEFAULT_TWIN_RUNTIME_SETTINGS: TwinRuntimeSettings = {
  workerEnabled: false,
  storage: {
    vectorBackend: "qdrant",
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: "",
  },
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "",
  },
}
