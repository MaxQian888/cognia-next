/**
 * Agent evaluation subsystem — shared model.
 *
 * The eval engine (`lib/ai/eval/*`) is TS-native and in-process: it runs an
 * agent against a versioned dataset of {@link EvalCase}s, captures each run as
 * an {@link EvalSample} (assembled from `agentTraces` spans), applies a set of
 * {@link Scorer}s across four dimensions, and aggregates into an
 * {@link EvalReport} (per-scorer means + pass@1 / pass^k reliability + cost).
 *
 * Design doc: `docs/superpowers/specs/2026-06-01-cognia-agent-eval-design.md`.
 *
 * Types live here (no runtime) so `lib/ai/eval/*` and `components/eval/*` share
 * one import surface; CRUD row types extend these in `lib/db/eval-*.ts`.
 */

/** One recorded tool call within an agent trajectory. */
export interface EvalToolCall {
  /** Tool name as the agent invoked it (e.g. `Read`, `mcp__x__y`). */
  name: string
  /**
   * Parsed arguments the agent passed. `{}` when content capture was off, so
   * argument-level scorers must treat an empty bag as "unknown", not "empty".
   */
  args: Record<string, unknown>
  /** 0-based invocation order within the trajectory. */
  index: number
  /** True when the tool call surfaced an error. */
  errored?: boolean
}

/** A retrieved RAG chunk surfaced during the run (from `retrieval` spans). */
export interface EvalRetrievedChunk {
  id?: string
  text: string
  /** Retrieval score when the retriever reported one. */
  score?: number
}

/** Token usage rolled up across the run. Mirrors `SpanUsage`. */
export interface EvalUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/**
 * The captured trajectory of one agent run against one {@link EvalCase}. This
 * is the unit every {@link Scorer} consumes — assembled from `AgentTraceSpan`s
 * by `lib/ai/eval/target.ts:assembleSampleFromSpans`.
 */
export interface EvalSample {
  /** Final assistant reply text. */
  output: string
  /** Tool calls in invocation order. */
  toolCalls: EvalToolCall[]
  /** Retrieved RAG chunks (empty when no retrieval happened). */
  retrievedChunks: EvalRetrievedChunk[]
  /** Rolled-up token usage. */
  usage: EvalUsage
  /** Estimated USD cost across the run. */
  costUsd: number
  /** Wall-clock latency in ms. */
  latencyMs: number
  /** Step count (tool calls + LLM turns) for efficiency scoring. */
  stepCount: number
  /** True when the run degraded to text-only (no sidecar/tools available). */
  degraded: boolean
  /** Set when the run itself failed (vs. a clean but low-quality answer). */
  error?: string
}

/** Reference values a case may carry for reference-based scoring. */
export interface EvalReference {
  /** Ideal set / sequence of tool names. */
  expectedTools?: string[]
  /** Per-tool expected args (subset match). Keyed by tool name. */
  expectedToolArgs?: Record<string, Record<string, unknown>>
  /** Golden final answer (for similarity / reference-based judging). */
  expectedOutput?: string
  /** Substrings the output must contain (assertion scorer). */
  expectedContains?: string[]
  /** Ground-truth context needed (RAG context recall). */
  expectedContext?: string[]
}

export type EvalCaseSource = "real-trace" | "synthetic" | "handwritten"

/** One conversation turn preceding the evaluated prompt. */
export interface EvalHistoryTurn {
  role: "user" | "assistant"
  content: string
}

/** One evaluation test item. */
export interface EvalCase {
  id: string
  datasetId: string
  /** The user prompt that drives the run. */
  input: string
  /** Optional prior conversation turns. */
  history?: EvalHistoryTurn[]
  reference?: EvalReference
  /** Capability tag, e.g. `chat.tool-use`. */
  capability: string
  source: EvalCaseSource
  /** Failure-mode label from error analysis (axial-coding cluster). */
  failureMode?: string
  /** When sourced from a real trace, the originating trace id. */
  sourceTraceId?: string
  notes?: string
  createdAt: number
  updatedAt: number
}

/** A versioned collection of {@link EvalCase}s, scoped to a capability. */
export interface EvalDataset {
  id: string
  name: string
  description?: string
  /** Capability tag, e.g. `chat.tool-use`. */
  capability: string
  /** Monotonic version, bumped on case add / edit / remove. */
  version: number
  createdAt: number
  updatedAt: number
}

/** The four evaluation dimensions. */
export type EvalDimension = "tool-use" | "response-quality" | "rag" | "cost"

/** Output of one scorer on one sample. */
export interface Score {
  scorerId: string
  dimension: EvalDimension
  /** Normalized score in [0,1]. */
  value: number
  /** Binary verdict derived from `value` and the scorer's threshold. */
  passed: boolean
  /** Human-readable explanation (esp. judge / RAG). */
  reasoning?: string
  /** Set when the scorer itself failed (NOT the agent). */
  error?: string
  /** Scorer-specific extra metadata. */
  metadata?: Record<string, unknown>
}

/**
 * A scorer grades a sample against a case. Pure where possible; async for
 * judge / RAG scorers that call an LLM. `requiresLlm` flags the ones the CI
 * deterministic tier must skip.
 */
export interface Scorer {
  id: string
  dimension: EvalDimension
  requiresLlm: boolean
  score(sample: EvalSample, evalCase: EvalCase): Promise<Score> | Score
}

/** Per-repetition result: the captured sample and every scorer's verdict. */
export interface EvalRepetition {
  sample: EvalSample
  scores: Score[]
}

/** Per-case result across k repetitions. */
export interface EvalCaseResult {
  caseId: string
  repetitions: EvalRepetition[]
}

/** Aggregate stats for one scorer across all case×rep pairs. */
export interface ScorerAggregate {
  scorerId: string
  dimension: EvalDimension
  /** Mean `value` across all case×rep. */
  meanValue: number
  /** Fraction passed across all case×rep. */
  passRate: number
  /** Count of scorer errors. */
  errorCount: number
  /** Total case×rep observations contributing. */
  observations: number
}

/** Aggregated result of one eval run. */
export interface EvalReport {
  runId: string
  datasetId: string
  datasetVersion: number
  /** Human label for the target config (model / character). */
  targetLabel: string
  /** Repetitions per case (pass^k reliability). */
  k: number
  caseCount: number
  scorers: Record<string, ScorerAggregate>
  /** Fraction of cases passing ALL scorers on the FIRST repetition. */
  passAt1: number
  /** Fraction of cases passing ALL scorers on ALL k repetitions (reliability). */
  passHatK: number
  totalCostUsd: number
  avgLatencyMs: number
  createdAt: number
}
