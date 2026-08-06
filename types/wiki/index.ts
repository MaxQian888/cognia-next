/**
 * LLM Wiki — type model for the External Bridge.
 *
 * Four Dexie tables back the wiki subsystem (see `lib/db/schema.ts` v17):
 *
 *   • `wikiArticles` — generated module-level articles (Markdown + sections + sourceRefs)
 *   • `wikiSections` — split-out section bodies for partial updates / per-section RAG
 *   • `wikiManifest` — Merkle table of file SHA-256s + per-scope build metadata
 *   • `mcpAuditLog` — capped log (5000 newest) of every MCP call routed through the bridge
 *
 * Wiki articles are produced by `lib/wiki/orchestrator.ts` which drives:
 *   1. file-walker → enumerate code files in a scope
 *   2. merkle diff vs `wikiManifest.fileHashes`
 *   3. Twin ingest pipeline (chunk + embed) using a synthetic `twinId = "repo:<scope>"`
 *   4. wiki agents (RepoMap → ModuleArticle → CrossRef → IndexPage)
 *   5. write to `wikiArticles` + `wikiSections`, update `wikiManifest`
 *
 * The MCP server (`lib/external-bridge/mcp-server`) consumes wiki rows via the
 * `wiki_search` / `wiki_read` handlers; its calls are recorded in `mcpAuditLog`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Scope — drives indexing target + permission gate.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A wiki scope identifies WHAT is being indexed. Phase 1 ships only
 * `cognia-self`; `user-repo` lands in Phase 3 and `runtime` in Phase 4.
 */
export type WikiScope = "cognia-self" | "user-repo" | "runtime"

/**
 * Permission scope for the MCP bridge — one knob per (capability × content)
 * combination, default OFF except `wiki:cognia` and `rag:cognia`. The Settings
 * UI renders one toggle per value here.
 */
export type BridgeScope =
  | "wiki:cognia"
  | "wiki:user-repo"
  | "rag:cognia"
  | "rag:user-repo"
  /**
   * RAG over the user's digital twin chunks. Default OFF; users must opt in
   * explicitly because twin data is significantly more sensitive than the
   * generated wiki (it can contain personal documents, chat history, etc.).
   */
  | "rag:twin"
  | "runtime:skills"
  | "runtime:characters"
  | "runtime:twins"
  | "runtime:plugins"
  | "runtime:agent-teams"
  /**
   * `computer_use` MCP tool — drives the local desktop (screenshot, click,
   * type, scroll, drag, etc.) for external coding agents. Default OFF; goes
   * through the same automation `PerCall` consent path as native chat
   * Computer Use calls.
   */
  | "mcp:computer-use"
  /**
   * Read-only inbox introspection — list adapters, conversations, drafts,
   * audit. Default OFF; mirrors the `rag:twin` sensitivity-split precedent
   * because inbox metadata may include conversation handles, channel ids,
   * and recent message snippets.
   */
  | "inbox:connectors:read"
  /**
   * Write-side inbox — `connectors_send_message` enqueues an AI reply via
   * the same `runConnectorDigestTurn` pipeline used by the in-app chat (PII
   * gate, policy eval, idempotency, outbound runner all stay in path).
   * Split from `read` so an operator can grant introspection without
   * accidentally enabling automated replies.
   */
  | "inbox:connectors:send"
  /**
   * Run a built-in / plugin subagent or character headlessly via
   * `agent_dispatch`. Default OFF — this executes Cognia's own agent runtime
   * (tool loop, model calls) on behalf of an external agent, and the returned
   * text is PII-gated on the way out.
   */
  | "agent:dispatch"
  /**
   * Start an Agent Team headlessly via `team_run`. Default OFF — drives a
   * multi-agent orchestration the external caller cannot otherwise reach.
   */
  | "agent:team"
  /**
   * Invoke a plugin-registered tool via `plugin_tool_invoke`. Default OFF —
   * the plugin's own consent gate + ownership check still apply per call.
   */
  | "plugin:tools"
  /**
   * Inbound write — `record_lesson` / `save_skill_draft` / `ingest_note` let
   * an external agent contribute back to Cognia. Default OFF. Nothing mutates
   * live state: submissions land in the `inboundDrafts` review queue as
   * pending, untrusted-wrapped drafts for the operator to accept/discard
   * (ADR-0008 Phase 4).
   */
  | "inbound:write"
  /**
   * Read the user's long-term memory (`memory_search` / `memory_list`).
   * Default OFF — mirrors the `rag:twin` sensitivity split: memories are
   * distilled personal facts about the user.
   */
  | "memory:read"
  /**
   * Write the user's long-term memory (`memory_store` / `memory_update` /
   * `memory_forget`). Default OFF. Writes carry `external` provenance, pass
   * the PII block gate, and can never create `procedural` rules (an external
   * agent may not rewrite the assistant's working instructions — ADR-0069).
   */
  | "memory:write"
  /**
   * Discover and execute immutable workflow deployments through External
   * Bridge MCP lifecycle and dynamically typed tools. Default OFF.
   */
  | "workflow:run"

export const ALL_BRIDGE_SCOPES: readonly BridgeScope[] = [
  "wiki:cognia",
  "wiki:user-repo",
  "rag:cognia",
  "rag:user-repo",
  "rag:twin",
  "runtime:skills",
  "runtime:characters",
  "runtime:twins",
  "runtime:plugins",
  "runtime:agent-teams",
  "mcp:computer-use",
  "inbox:connectors:read",
  "inbox:connectors:send",
  "agent:dispatch",
  "agent:team",
  "plugin:tools",
  "inbound:write",
  "memory:read",
  "memory:write",
  "workflow:run",
] as const

export const WORKFLOW_MCP_LIFECYCLE_TOOL_NAMES = [
  "workflow_list",
  "workflow_status",
  "workflow_events",
  "workflow_cancel",
] as const

/** Scopes enabled by default for a fresh install. Public-code wiki + RAG only. */
export const DEFAULT_ENABLED_SCOPES: readonly BridgeScope[] = ["wiki:cognia", "rag:cognia"] as const

// ─────────────────────────────────────────────────────────────────────────────
// External Bridge settings — persisted on AppSettings.externalBridge.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persisted configuration for the External Bridge MCP server. Lives on
 * `AppSettings.externalBridge`. When the parent field is `undefined`, the
 * server is treated as OFF — there is no implicit "enable on first use".
 */
export interface ExternalBridgeSettings {
  /** Master switch — when false, neither stdio nor HTTP transports are spawned. */
  enabled: boolean
  /**
   * Bearer token for the HTTP transport. 64-char hex (32 random bytes).
   * Always overwritten in full on rotation; old token never lingers.
   * Stored as plaintext because IndexedDB is already user-local and we don't
   * have a key-management story for v1; revisit when the bridge supports
   * remote network access.
   */
  bearerToken?: string
  /**
   * Whitelisted scopes — every MCP call's tool/handler maps to exactly one
   * scope, and the call is denied if the scope is not present here.
   */
  enabledScopes: BridgeScope[]
  /** Last-assigned localhost port for the HTTP transport. */
  httpPort?: number
  /** ISO timestamp of the most recent token rotation, for audit. */
  tokenRotatedAt?: number
  /**
   * Optional automatic wiki-rebuild schedule. When `mode === "off"` the
   * scheduler row is deleted; otherwise the bridge maintains a single
   * `wiki-rebuild` scheduled task. Custom mode takes a raw cron expression.
   */
  wikiSchedule?: WikiScheduleSettings
  /**
   * Optional automatic wiki-lint schedule (orphan / broken-link health check).
   * Same shape + reconciliation as {@link wikiSchedule}; `mode === "off"`
   * deletes the `wiki-lint::singleton` scheduler row.
   */
  wikiLintSchedule?: WikiScheduleSettings
}

export type WikiScheduleMode = "off" | "daily" | "weekly" | "custom"

export interface WikiScheduleSettings {
  mode: WikiScheduleMode
  /** Required when `mode === "custom"`. Standard 5-field cron expression. */
  customCron?: string
  /** When true, the scheduled rebuild ignores cached hashes (full rebuild). */
  force?: boolean
  /** Optional IANA timezone for the cron (defaults to local). */
  timezone?: string
}

export const DEFAULT_EXTERNAL_BRIDGE_SETTINGS: ExternalBridgeSettings = {
  enabled: false,
  enabledScopes: [...DEFAULT_ENABLED_SCOPES],
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiki article — the user-facing knowledge unit.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provenance pointer — what source file/range a wiki article (or section) was
 * derived from. Mirrors `TwinChunkMetadata.{filePath,lineStart,lineEnd}` so
 * downstream UIs can render "jump to source" breadcrumbs without a second
 * lookup.
 */
export interface WikiSourceRef {
  filePath: string
  lineStart: number
  lineEnd: number
  /** SHA-256 of the source file at the moment the article was generated. */
  sha: string
}

/**
 * One section of a wiki article — a heading-rooted Markdown subtree. Stored
 * separately in `wikiSections` so the orchestrator can do partial regeneration
 * without rewriting the whole article.
 */
export interface WikiSection {
  id: string
  /**
   * Owning corpus (v142). Denormalized from the parent article so a corpus
   * teardown is a single indexed range delete instead of an article join.
   */
  corpusId: string
  /** FK → wikiArticles.id */
  articleId: string
  /** 0-based ordering within the article. */
  sectionIndex: number
  /** Heading breadcrumb, e.g. ["ingest", "chunk"]. */
  headingPath: string[]
  /** Markdown body — raw, no front-matter. */
  bodyMd: string
  /** Sources cited in this section (subset of article-level sourceRefs). */
  sourceRefs: WikiSourceRef[]
}

/**
 * A wiki article — one per "module" (file or directory). The exporter writes
 * the full `contentMd` to `docs/content/docs/wiki/<scope>/<slug>.mdx`; the MCP
 * `wiki_read` tool returns the same content.
 */
export interface WikiArticle {
  id: string
  /**
   * Owning corpus (v142) — `"cognia-self"` for the built-in tree, otherwise a
   * `WikiCorpus.id`. `[corpusId+slug]` is the unique key: two repos may both
   * contain a `lib/utils` module, and before v142 the bare `&slug` unique
   * index made that a write collision.
   */
  corpusId: string
  /** URL-safe identifier, e.g. "lib-twin-ingest-chunk". Unique within corpus. */
  slug: string
  /** Human-readable title, e.g. "lib/twin/ingest/chunk.ts — Format-aware chunking". */
  title: string
  /** Module path the article describes, e.g. "lib/twin/ingest". */
  module: string
  scope: WikiScope
  /**
   * PageRank score from RepoMapAgent. 0..1, used as a tie-breaker in
   * wiki_search; the bulk of search ranking comes from semantic similarity
   * against `embedding` plus BM25 over `title + summary`.
   */
  pageRank: number
  /** 1–2 paragraph summary returned by `wiki_search` (no need to fetch full body). */
  summary: string
  /** Section ids in render order (FK → wikiSections.id[]). */
  sectionIds: string[]
  /** Article-level cited sources (union of all section sourceRefs). */
  sourceRefs: WikiSourceRef[]
  /** Full Markdown body (heading + summary + sections concatenated). */
  contentMd: string
  /**
   * Article-level embedding for `wiki_search`. Stored as `number[]` because
   * Dexie/IndexedDB can't reliably round-trip TypedArrays across browsers.
   */
  embedding: number[]
  generatedAt: number
  /**
   * Stamps the orchestrator version that produced this article. The
   * orchestrator uses this to invalidate articles produced by older versions
   * during a rebuild.
   */
  generatorVersion: string
  /**
   * Hashes of every source file that contributed to this article. Used by
   * the Merkle differ: an article is considered "fresh" iff every entry here
   * still matches the current on-disk SHA-256.
   */
  fileHashes: Record<string, string>
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiki lint — orphan-page + broken-link health check (no-AI, local).
// ─────────────────────────────────────────────────────────────────────────────

/** One flagged article in a lint run. */
export interface WikiLintFinding {
  /** The offending article's slug. */
  slug: string
  /** The article title, for display. */
  title: string
  /** For broken-link findings: the dangling `[[slug]]` targets that resolve to no article. */
  deadLinks?: string[]
}

/**
 * Result of a wiki lint pass — one singleton row per scope (Dexie table
 * `wikiLintResults`, keyed by `&scope`, mirroring `wikiManifest`).
 */
export interface WikiLintResult {
  scope: WikiScope
  /** Epoch ms of the lint run. */
  lastRunAt: number
  /** Total articles examined. */
  articleCount: number
  /** Articles containing dangling `[[slug]]` links (target article missing). */
  brokenLinks: WikiLintFinding[]
  /** Articles with zero inbound `[[slug]]` links from any other article. */
  orphans: WikiLintFinding[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiki manifest — per-scope build metadata + Merkle table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row per scope. Stores the full Merkle map (file path → SHA-256 at last
 * build) plus aggregate metadata for the Settings UI status panel.
 */
export interface WikiManifest {
  /** Primary key — one of the `WikiScope` values. */
  scope: WikiScope
  /** Map of filePath → sha256 at the time of the last successful build. */
  fileHashes: Record<string, string>
  /** Epoch ms of the last successful (full or incremental) build completion. */
  lastBuildAt: number
  /** Total `wikiArticles` rows currently associated with this scope. */
  articleCount: number
  /** Generator version stamp — same value lands on each `wikiArticles.generatorVersion`. */
  generatorVersion: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpora (v142) — one indexed body of source per repo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Corpus id for Cognia's own tree. Pre-v142 rows carried no `corpusId`; the
 * v142 upgrade backfills every one of them to this value, which is why it is a
 * reserved id that repo CRUD refuses to hand out.
 */
export const SELF_CORPUS_ID = "cognia-self"

export type WikiCorpusKind = "cognia-self" | "user-repo"

/**
 * What to do with a symlink encountered during the walk. `skip` is the default
 * because following one is how a walk escapes `rootPath` — the target is
 * resolved and re-checked against the root even under `follow-within-root`.
 */
export type WikiSymlinkPolicy = "skip" | "follow-within-root"

/**
 * A registered corpus. `cognia-self` exists implicitly and is not stored as a
 * row until the user edits its defaults; every other row is a user repo whose
 * `rootPath` was granted through the Tauri directory picker.
 */
export interface WikiCorpus {
  /** Stable id. `SELF_CORPUS_ID` for the built-in tree, else a generated repo id. */
  id: string
  kind: WikiCorpusKind
  displayName: string
  /**
   * Absolute, normalized repo root. The walker rejects any resolved path that
   * does not stay under this prefix, so this is a security boundary and not a
   * convenience default.
   */
  rootPath: string
  /** Glob patterns; empty `include` means "everything not excluded". */
  include: string[]
  exclude: string[]
  /** Files larger than this are skipped whole — bounds one hostile file. */
  maxFileBytes: number
  symlinkPolicy: WikiSymlinkPolicy
  /** Disabled corpora keep their rows but are skipped by refresh and by search. */
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Per-corpus Merkle map + build metadata. Supersedes the scope-keyed `WikiManifest`. */
export interface WikiCorpusManifest {
  /** Primary key. */
  corpusId: string
  /** Retained so legacy scope-filtered queries keep working. */
  scope: WikiScope
  /** filePath → sha256 at the last successful build. */
  fileHashes: Record<string, string>
  lastBuildAt: number
  articleCount: number
  generatorVersion: string
  /**
   * Hash over the sorted `fileHashes` entries. A full-rebuild confirmation is
   * bound to this value, so a corpus that changed on disk between the estimate
   * and the confirm must be re-confirmed rather than silently rebuilt at a
   * cost the user never saw.
   */
  manifestHash: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Build jobs — cancellable, resumable, staging-backed rebuilds.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `cancelling` is distinct from `cancelled`: cancellation is cooperative and
 * only takes effect at a scan / LLM-call / persist boundary, so a job that has
 * been asked to stop is still running until it reaches one.
 */
export type WikiBuildJobStatus =
  "queued" | "running" | "cancelling" | "cancelled" | "paused" | "completed" | "failed"

export type WikiBuildMode = "incremental" | "full"

/**
 * Durable resume point. Persisted at each module boundary so a job resumed
 * after a crash re-does at most one module's LLM work rather than the corpus.
 */
export interface WikiBuildCursor {
  /** Modules already written to staging, in completion order. */
  completedModules: string[]
  processedFiles: number
  /** Set when the job stopped mid-corpus; the next run starts here. */
  nextModule?: string
}

/**
 * Estimate shown before a full rebuild. `estimatedCostUsd` is `null` whenever
 * the selected model has no known price — the UI then renders the token and
 * byte figures and states that the monetary cost is unknown, rather than
 * inventing a number.
 */
export interface WikiBuildCostEstimate {
  fileCount: number
  byteCount: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCostUsd: number | null
  modelId: string
  /** Binds this estimate to the exact corpus state it was computed from. */
  manifestHash: string
  computedAt: number
}

export interface WikiBuildJob {
  id: string
  corpusId: string
  mode: WikiBuildMode
  status: WikiBuildJobStatus
  /** Staging rows for this build are keyed by `buildId === id`. */
  cursor: WikiBuildCursor
  /** Present for `mode: "full"` — the estimate the user confirmed against. */
  estimate?: WikiBuildCostEstimate
  queuedAt: number
  startedAt?: number
  finishedAt?: number
  /** Set for `failed`; a resumable failure keeps `cursor` populated. */
  error?: string
}

/**
 * A staged article. Identical to the live row plus the owning `buildId`, so a
 * cancelled or failed build is torn down by one indexed range delete and the
 * live corpus is never pre-emptively emptied to make room for a rebuild.
 */
export type WikiStagedArticle = WikiArticle & { buildId: string }
export type WikiStagedSection = WikiSection & { buildId: string }

// ─────────────────────────────────────────────────────────────────────────────
// MCP audit log — capped 5000-row record of every bridge call.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row per MCP request the bridge processes. The Settings UI renders the
 * newest 50 in a table; the `mcpAuditLog.ts` CRUD module enforces the 5000-row
 * cap by trimming the oldest when a write would exceed it.
 */
export interface McpAuditLogRow {
  id: string
  /** Epoch ms when the request was received. */
  ts: number
  /** Tool or method name, e.g. "wiki_search" / "tools/list" / "resources/read". */
  tool: string
  /** Permission scope checked for this call (or "n/a" for protocol-level methods). */
  scope: BridgeScope | "n/a"
  /** Whether the permission gate allowed the call. */
  allowed: boolean
  /** Wall-clock latency in milliseconds (handler dispatch → response written). */
  latencyMs: number
  /** Optional human-readable reason for `allowed=false` (e.g. "scope OFF"). */
  reason?: string
  /** Optional error message (when allowed=true but handler threw). */
  errorMessage?: string
}
