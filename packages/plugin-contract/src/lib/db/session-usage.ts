/**
 * The plugin contract's share of `lib/db/session-usage.ts`, which re-exports these.
 */
/**
 * Which surface produced a usage row. Lets the Subscription → Usage tab show
 * total spend across every LLM-driven surface — not just interactive chat.
 * Legacy rows have no `surface`; readers treat `undefined` as `"chat"`.
 *
 * The second group are surfaces that spend real money and reported none of it:
 * an embed-heavy ingest, a twin distillation, an OCR batch or a TTS render
 * could run all day and the Usage tab stayed at the same number. Metering them
 * is what makes the tab's total the app's actual spend rather than only its
 * conversational spend.
 */
export type UsageSurface =
  | "chat"
  | "workflow"
  | "agent-team"
  | "connector"
  | "goal"
  | "embedding"
  | "twin"
  | "memory"
  | "eval"
  | "subagent"
  | "plugin"
  | "ocr"
  | "tts"
  | "web-search"
  /** Inbound traffic served through the local gateway (ADR-0165). */
  | "gateway"
  | "imported"
  /** Harness Evolution probes, editor sessions and judges (ADR-0237). */
  | "harness-evolution"

/**
 * Where a persisted row's `costUsd` came from. Frozen at write time (v172) so
 * the figure never silently changes when a price table is updated.
 */
export type UsageCostSource =
  /** Priced by the usage ledger without preserving the resolver layer. */
  | "derived"
  /** The provider/SDK reported the cost directly — the most authoritative. */
  | "sdk"
  /** Priced locally against the synced models.dev catalog. */
  | "catalog"
  /** Priced locally against the built-in fallback price table. */
  | "static"
  /** Priced locally against a user-supplied custom/discovered rate. */
  | "custom"
  /**
   * Booked by the Router + Fusion ledger (ADR-0188) from the call's usage and
   * the run's pinned rate card — or its conservative reservation when no bill
   * was reported. Only ever written while Router + Fusion is switched on.
   */
  | "ledger"
  /** Written before v172; provenance cannot be recovered retroactively. */
  | "backfilled"
  /** No pricing layer knew the model — `costUsd` is 0 but means "unknown". */
  | "unknown"

/**
 * The per-1M rates a row was actually priced against, captured at write time.
 * Lets a stored cost be re-derived and audited later even after the catalog has
 * moved on; absent on `sdk` rows (the provider did the arithmetic) and on
 * legacy rows.
 */
/**
 * How the TOKEN figures on a row were obtained. Deliberately separate from
 * `costSource`: a provider can report exact tokens while the money is still
 * priced locally, and collapsing the two made "provider-reported" mean two
 * different things depending on which field you read.
 */
export type UsageBasis =
  /** Tokens came from the provider/SDK payload for this exact turn. */
  | "provider-reported"
  /** Tokens were derived from a transcript the provider wrote (external scan). */
  | "derived"
  /** Tokens were estimated locally (tokenizer or heuristic). */
  | "estimated"

export interface UsagePriceSnapshot {
  promptPer1M?: number
  completionPer1M?: number
  cachedInputPer1M?: number
  cacheCreationPer1M?: number
  /** Multiplier applied for fast mode / data residency, when either was in play. */
  rateMultiplier?: number
  currency?: "USD"
}

/**
 * Non-token billable quantities for a turn (server tools, OCR pages, TTS
 * characters, container time). Keyed by unit so a single pricing resolver can
 * price them alongside tokens.
 */
export interface UsageUnitBreakdown {
  /** Server-tool invocations, e.g. `{ "web_search": 3 }`. */
  requests?: Record<string, number>
  pages?: number
  characters?: number
  containerHours?: number
}

/** Persisted per-turn usage. All token fields default to 0 when missing. */
export interface SessionUsageRow {
  /**
   * Primary key, unique across sessions. For chat this is the Anthropic
   * assistant message id; shadow rows use a synthetic deterministic id
   * (`wf:<runId>:<stepId>`, `team:<runId>:<teammateId>:<taskId>`) so retries
   * overwrite in place exactly like the chat path.
   */
  messageId: string
  /**
   * Grouping key for "Top sessions". Chat = ChatSession id; workflow runs use
   * `wf:<runId>`, agent-team runs use `team:<runId>`.
   */
  sessionId: string
  /** Speaking character (team chats only). */
  characterId?: string
  /** Wall-clock ms when the result was recorded. */
  at: number
  /** Resolved model id reported by the SDK on this turn (best-effort). */
  model?: string
  /** Provider that served the turn — drives provider-scoped pricing lookup. */
  providerId?: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  /** USD cost the SDK estimated for this turn. May be 0 when missing. */
  costUsd: number
  /** SDK-reported turn duration. May be 0 when missing. */
  durationMs: number
  /**
   * Extended-thinking output tokens (subset of `outputTokens`). Only present
   * when the turn actually reasoned — absent means "no reasoning", not 0.
   */
  reasoningTokens?: number
  /**
   * Effective context size the SDK reported for the turn (prompt incl. cache
   * tiers). Optional — legacy rows and providers that don't report it omit it.
   */
  contextInputTokens?: number
  /** Producing surface. Absent on legacy rows ⇒ treated as `"chat"`. */
  surface?: UsageSurface

  /* ── v172: ADR-0090 execution identity ─────────────────────────────────── */
  /** Owning workspace/project — mirrors `agentTraces.projectId`. */
  projectId?: string
  /** Canonical run this turn belongs to (`session→run→turn→attempt`). */
  runId?: string
  /** Canonical turn id within the run. */
  turnId?: string
  /** Attempt id — a retry produces a new attempt under the same turn. */
  attemptId?: string

  /* ── v172: frozen cost ─────────────────────────────────────────────────── */
  /**
   * Provenance of `costUsd`. Absent on rows written before v172 that the
   * upgrade has not yet visited; readers treat absent as `"backfilled"`.
   */
  costSource?: UsageCostSource
  /**
   * `false` when no pricing layer knew the model, so `costUsd: 0` means
   * "unknown", not "free". Renderers must show "—" rather than "$0.00".
   */
  costKnown?: boolean
  /** Rates the cost was computed against; absent for `sdk`-sourced rows. */
  priceSnapshot?: UsagePriceSnapshot
  /**
   * Cache-creation tokens split by TTL. Anthropic bills 5-minute writes at
   * 1.25× base input and 1-hour writes at 2×, so the two cannot share a
   * bucket. `cacheCreationTokens` remains the un-split total for legacy rows
   * and providers that report only one figure.
   */
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
  /** `"fast"` when the turn ran in fast mode (premium rates). */
  speed?: "fast" | "normal"
  /** Inference geography — `"us"` carries a 1.1× multiplier on all classes. */
  inferenceGeo?: "us" | "global"
  /** True when the turn was served through a batch API (50% discount). */
  batch?: boolean
  /** Non-token billable quantities (server tools, pages, characters, hours). */
  unitBreakdown?: UsageUnitBreakdown
  /**
   * True when the row was reconstructed from an IMPORTED transcript rather than
   * observed locally.
   *
   * Imported spend was paid on another machine, often by another account, and
   * blending it into local totals would silently inflate "what this install
   * cost me" — and, through the daily rollup, misfire the budget. Readers that
   * report local spend must exclude these rows; readers that report a session's
   * history include them and label them.
   */
  imported?: boolean

  /* ── v218: ADR-0165 external usage index ───────────────────────────────── */
  /**
   * Which `AgentSessionSourceAdapter` produced this row. Absent means the row
   * was observed locally by Cognia itself, which is what every legacy row is.
   * Rows carrying a `sourceId` are ALWAYS `imported: true` as well, so the
   * budget predicate needs no new case.
   */
  sourceId?: string
  /** The upstream session id inside that source, for per-session rollups. */
  sourceSessionId?: string
  /**
   * Content revision of the locator the row was parsed from. A changed
   * revision is what lets an incremental re-scan replace exactly the rows a
   * grown file produced without re-reading the whole corpus.
   */
  sourceRevision?: string
  /** Provenance of the TOKEN figures. Absent on legacy rows. */
  usageBasis?: UsageBasis
  /**
   * Version of the analyzer that last classified this row. Lets a detector
   * bump invalidate its own derived verdicts without touching the money.
   */
  analysisVersion?: number
}
