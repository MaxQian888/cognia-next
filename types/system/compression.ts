/**
 * Compression type definitions for chat context management
 *
 * Provides types for:
 * - Compression strategies (summary, sliding-window, selective, hybrid)
 * - Compression settings (global and per-session)
 * - Compression state and metadata
 * - Compression triggers (manual and automatic)
 */

/**
 * Available compression strategies
 * - summary: Summarize older messages into a concise summary
 * - sliding-window: Keep only the most recent N messages
 * - selective: Keep important messages (system, key exchanges) and summarize others
 * - hybrid: Combination of sliding window for recent + summary for older
 * - recursive: Chunk-based recursive summarization for very long conversations
 */
export type CompressionStrategy =
  | "summary"
  | "sliding-window"
  | "selective"
  | "hybrid"
  | "recursive"

/**
 * Trigger modes for automatic compression
 * - token-threshold: Trigger when total tokens exceed threshold percentage
 * - message-count: Trigger when message count exceeds threshold
 * - manual: Only compress when user explicitly requests
 */
export type CompressionTrigger = "token-threshold" | "message-count" | "manual"

/**
 * Model configuration for compression summarization
 */
export interface CompressionModelConfig {
  /** Provider to use for summarization (defaults to current session provider) */
  provider?: string
  /** Model to use for summarization (defaults to fast tier model) */
  model?: string
  /** Max tokens for summary output */
  maxSummaryTokens?: number
}

/**
 * Global compression settings stored in settings store
 */
export interface CompressionSettings {
  /** Enable/disable compression globally */
  enabled: boolean
  /** Compression strategy to use */
  strategy: CompressionStrategy
  /** Trigger mode for automatic compression */
  trigger: CompressionTrigger
  /** Token threshold percentage (0-100) to trigger compression */
  tokenThreshold: number
  /** Message count threshold to trigger compression */
  messageCountThreshold: number
  /** Number of recent messages to always preserve uncompressed */
  preserveRecentMessages: number
  /** Always preserve system messages */
  preserveSystemMessages: boolean
  /** Target compression ratio (0.1 to 0.9) for summary strategy */
  compressionRatio: number
  /** Model configuration for summarization */
  compressionModel: CompressionModelConfig
  /** Show notification when compression is triggered */
  showCompressionNotification: boolean
  /** Allow user to undo/restore compressed messages */
  enableUndo: boolean
  /** Minimum importance score (0-1) to keep a message during selective compression */
  importanceThreshold: number
  /** Use AI-powered summarization when provider is available */
  useAISummarization: boolean
  /** Preserve tool call metadata (name, args, status) when compressing tool results */
  preserveToolCallMetadata: boolean
  /** Maximum tokens for individual tool call results before truncation */
  maxToolResultTokens: number
  /** Number of messages per chunk for recursive compression */
  recursiveChunkSize: number
  /** Retained threshold percentage (0-100) — the "drain line" after compression (dual-threshold) */
  retainedThreshold: number
  /** Enable prefix stability mode to preserve KV cache across turns */
  prefixStabilityMode: boolean
  /**
   * Active compaction-strategy id. `undefined` → the built-in strategy.
   * Plugin-contributed strategies register as `${pluginId}:${id}` (see the
   * `compaction-strategy` plugin capability). Resolved at `resolveSendOptions`
   * time into the summary prompt / keepRecent / fraction sent to the sidecar.
   */
  strategyId?: string
  /**
   * Free-form "compact instructions" (Claude Code's `# Compact instructions`
   * parity). Merged into the summarization prompt so the user can steer what a
   * compaction preserves (e.g. "focus on the API changes"). Also seeds the
   * default focus for a manual `/compact` with no explicit argument.
   */
  focus?: string
}

/**
 * Per-session compression overrides
 */
export interface SessionCompressionOverrides {
  /** Override global compression enabled setting */
  compressionEnabled?: boolean
  /** Override compression strategy for this session */
  compressionStrategy?: CompressionStrategy
  /** Override trigger mode */
  compressionTrigger?: CompressionTrigger
  /** Override token threshold */
  tokenThreshold?: number
  /** Override message count threshold */
  messageCountThreshold?: number
  /** Override preserve recent messages count */
  preserveRecentMessages?: number
}

/**
 * Compression state for a message
 */
export interface MessageCompressionState {
  /** Whether this message is a compression summary */
  isSummary: boolean
  /** IDs of messages that were summarized into this one */
  summarizedMessageIds?: string[]
  /** Original message count before compression */
  originalMessageCount?: number
  /** Original token count before compression */
  originalTokenCount?: number
  /** Compression timestamp */
  compressedAt?: Date
  /** Compression strategy used */
  strategyUsed?: CompressionStrategy
  /** Frozen summary decision metadata for prefix-stability lifecycle */
  frozenSummaryDecision?: "reused" | "regenerated"
}

/**
 * Compression history entry for undo support
 */
export interface CompressionHistoryEntry {
  id: string
  sessionId: string
  timestamp: Date
  /** Strategy used for this compression */
  strategy: CompressionStrategy
  /** Messages that were compressed */
  compressedMessages: Array<{
    id: string
    role: string
    content: string
    createdAt: Date
  }>
  /** Summary message ID created */
  summaryMessageId: string
  /** Token count before compression */
  tokensBefore: number
  /** Token count after compression */
  tokensAfter: number
}

/**
 * Compression result returned by compression functions
 */
export interface CompressionResult {
  /** Whether compression was successful */
  success: boolean
  /** Summary text generated (for summary/hybrid strategies) */
  summaryText?: string
  /** Number of messages compressed */
  messagesCompressed: number
  /** Token count before compression */
  tokensBefore: number
  /** Token count after compression */
  tokensAfter: number
  /** Compression ratio achieved */
  compressionRatio: number
  /** IDs of messages that were compressed */
  compressedMessageIds: string[]
  /** Error message if compression failed */
  error?: string
}

/**
 * Context state for compression decision making
 */
export interface ContextState {
  /** Total tokens in current context */
  totalTokens: number
  /** Maximum tokens for current model */
  maxTokens: number
  /** Current utilization percentage */
  utilizationPercent: number
  /** Number of messages in context */
  messageCount: number
  /** Compression status */
  status: "healthy" | "warning" | "danger"
  /** Whether compression is recommended */
  compressionRecommended: boolean
  /** Recommended compression strategy based on context */
  recommendedStrategy?: CompressionStrategy
}

/**
 * Importance signal types detected in messages
 */
export type ImportanceSignal =
  | "code"
  | "decision"
  | "error"
  | "tool-call"
  | "question"
  | "system"
  | "recency"
  | "artifact"
  | "url"
  | "structured-data"

/**
 * Importance score for a message with contributing signals
 */
export interface MessageImportanceScore {
  /** Overall importance score (0-1) */
  score: number
  /** Signals that contributed to the score */
  signals: ImportanceSignal[]
}

/**
 * AI configuration for compression summarization
 */
export interface CompressionAIConfig {
  provider: string
  model: string
  apiKey: string
  baseURL?: string
}

// NOTE: the provider cache-capability profile that used to live here was an
// orphan (zero importers). The canonical implementation is
// `packages/provider-embedding/src/provider-cache-profile.ts`
// (`ProviderCacheProfile` / `ProviderCacheType`) — import it from there.

/**
 * Frozen compression summary persisted per session
 * Once generated, a frozen summary is reused across turns to maintain prefix stability
 */
export interface FrozenCompressionSummary {
  /** The frozen summary text */
  summaryText: string
  /** When this summary was frozen */
  frozenAt: Date
  /** IDs of messages that were summarized into this frozen summary */
  summarizedMessageIds: string[]
  /** Original token count of the summarized messages */
  originalTokenCount: number
  /** Token count of the summary itself */
  summaryTokenCount: number
  /** Version number, incremented each time the summary is re-frozen */
  version: number
}

/**
 * Default compression settings.
 *
 * Reconciled with the LIVE runtime: the generic (AI-SDK) path already
 * auto-compacts unconditionally at `AUTO_COMPACT_FRACTION` (0.835 ≈ 83%) and
 * keeps the last 6 turns (`sidecar/dispatch/compaction.mjs`). These defaults
 * therefore start `enabled: true` (turning it off opts into manual-only) and
 * mirror that threshold / keep-count so the settings UI reflects reality
 * instead of the earlier orphaned 70%/disabled placeholder values.
 */
export const DEFAULT_COMPRESSION_SETTINGS: CompressionSettings = {
  enabled: true,
  strategy: "hybrid",
  trigger: "token-threshold",
  tokenThreshold: 83, // ≈ AUTO_COMPACT_FRACTION (lib/claude/usage.ts) — keep in sync
  messageCountThreshold: 50,
  preserveRecentMessages: 6, // mirrors COMPACT_KEEP_RECENT_MESSAGES in the sidecar
  preserveSystemMessages: true,
  compressionRatio: 0.3, // Target 30% of original size
  compressionModel: {
    maxSummaryTokens: 500,
  },
  showCompressionNotification: true,
  enableUndo: true,
  importanceThreshold: 0.4,
  useAISummarization: true,
  preserveToolCallMetadata: true,
  maxToolResultTokens: 500,
  recursiveChunkSize: 20,
  retainedThreshold: 40, // Compress down to 40% — creates a buffer below the trigger
  prefixStabilityMode: true, // Enable by default for cache-friendly compression
}
