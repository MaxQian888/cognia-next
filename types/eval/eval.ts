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
 * by `lib/ai/eval/targets/chat.ts:assembleSampleFromSpans`.
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
  /**
   * How {@link expectedOutput} / {@link expectedContains} should be compared
   * against the answer — see {@link import("./grading").GradingSpec}. Without
   * it the match scorers report `not-applicable`: a golden answer with no
   * stated comparison rule is not something to guess at.
   */
  grading?: import("./grading").GradingSpec
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
  /** Free-form labels for filtering / grouping. */
  tags?: string[]
  /** Subset selector, e.g. "train" | "test" | a custom split name. */
  split?: string
  /** Arbitrary structured metadata carried from import. */
  metadata?: Record<string, unknown>
  /**
   * Structured trigger inputs for workflow / team targets. Chat ignores this
   * and drives from {@link EvalCase.input}.
   */
  inputVars?: Record<string, unknown>
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
  /** Optional pass/fail thresholds applied to this dataset's runs. */
  gate?: import("./gate").GateThresholds
  /**
   * The grading rule last used when importing into / adding cases to this
   * dataset, pre-filling the next one. A UI convenience ONLY — scoring reads
   * `EvalCase.reference.grading`, never this, so a case always says how it is
   * judged even after the dataset default changes.
   */
  defaultGrading?: import("./grading").GradingSpec
  createdAt: number
  updatedAt: number
}

/** The four evaluation dimensions. */
export type EvalDimension = "tool-use" | "response-quality" | "rag" | "cost"

/**
 * What a {@link Score} actually means. Before this existed, `error` was a
 * single string that had to express three different things at once — and
 * "measurement-only" could not be expressed at all, so the cost and redundancy
 * scorers faked it with `passed: true`. That is what made a run over a plain
 * question/answer dataset report 100%: every reference-based scorer was
 * excluded as errored, and the two fakes carried the verdict.
 *
 *  - `scored`         — a real verdict. The ONLY status that decides pass/fail.
 *  - `not-applicable` — the case carries no reference this scorer can use.
 *  - `errored`        — the scorer itself failed (provider down, parse error).
 *                       Never counted as an agent failure; surfaced separately
 *                       so "the judge died on every case" is visible.
 *  - `measurement`    — reported for information only (unbudgeted cost, zero
 *                       tool calls). Never decides pass/fail.
 */
export type ScoreStatus = "scored" | "not-applicable" | "errored" | "measurement"

/** Output of one scorer on one sample. */
export interface Score {
  scorerId: string
  dimension: EvalDimension
  /** What this score means — see {@link ScoreStatus}. */
  status: ScoreStatus
  /** Normalized score in [0,1]. Meaningful for `scored` / `measurement`. */
  value: number
  /** Binary verdict derived from `value` and the scorer's threshold. */
  passed: boolean
  /** Human-readable explanation (esp. judge / RAG). */
  reasoning?: string
  /** Why the score is not `scored`. Set for `errored` and `not-applicable`. */
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
  /**
   * True when this scorer can produce a `scored` verdict that decides pass/fail.
   * False for measurement-only wirings (the unbudgeted `costScorer`), which
   * always emit `measurement`. Declarative counterpart to
   * {@link Score.status} — the report keys off the status, this documents the
   * scorer's contract and is pinned by `scorers/catalog.test.ts`.
   */
  gating: boolean
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

/** Per-repetition verdict derived from its `scored` observations. */
export type RepetitionVerdict = "pass" | "fail" | "ungraded"

/** Lifecycle of a persisted run. See {@link EvalReport.status}. */
export type EvalRunStatus = "running" | "completed" | "aborted" | "failed"

/** Aggregate stats for one scorer across all case×rep pairs. */
export interface ScorerAggregate {
  scorerId: string
  dimension: EvalDimension
  /** Mean `value` across the `scored` observations only. */
  meanValue: number
  /** Fraction passed across the `scored` observations only. */
  passRate: number
  /**
   * Observations that produced a real verdict — the denominator of
   * {@link meanValue} / {@link passRate}. Zero means this scorer graded
   * nothing, so its 0% pass rate says nothing about the agent and gates must
   * skip it. Absent on rows written before the scoring-status change.
   */
  scoredCount: number
  /** Observations excluded because the case carried no matching reference. */
  notApplicableCount: number
  /** Observations where the SCORER failed (provider down, parse error). */
  erroredCount: number
  /** Observations reported for information only (no verdict). */
  measurementCount: number
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
  /**
   * Cases that produced at least one `scored` observation on repetition 1 —
   * the DENOMINATOR of {@link passAt1} / {@link passHatK}. A case no selected
   * scorer could grade is neither a pass nor a failure; counting it either way
   * is a lie, so it is excluded here and reported in {@link ungradedCaseCount}.
   */
  gradedCaseCount: number
  /** Cases no selected scorer could grade. `caseCount - gradedCaseCount`. */
  ungradedCaseCount: number
  scorers: Record<string, ScorerAggregate>
  /** Fraction of GRADED cases passing every scored scorer on the FIRST repetition. */
  passAt1: number
  /** Fraction of GRADED cases passing on ALL k repetitions (reliability). */
  passHatK: number
  totalCostUsd: number
  avgLatencyMs: number
  createdAt: number
  /**
   * Scoring-semantics version. `2` = the {@link ScoreStatus} model (only
   * `scored` observations decide a verdict, ungraded cases leave the
   * denominator). Absent on rows written before that change, whose `passAt1`
   * is inflated and NOT comparable — the UI badges those as legacy and
   * withholds their gate verdict.
   */
  scoringVersion?: 2
  /**
   * How far the run got. Written as `"running"` BEFORE the first case, then
   * overwritten when it settles.
   *
   * Two problems this fixes. A run cancelled after 10 of 500 cases used to be
   * indistinguishable from a complete one — same row shape, a pass rate over
   * the handful that finished, and a gate verdict computed from it. And because
   * the parent row was only written at the very end, an interrupted run left
   * `evalRunCaseResults` rows whose `runId` had no owner: invisible to every
   * view and never reclaimed, since deletion cascades from the run.
   *
   * Absent on rows written before this existed; treat those as `"completed"`.
   */
  status?: EvalRunStatus
  /** Immutable dataset version snapshot this run executed against. */
  datasetVersionId?: string
  /** Compact echo of the run configuration that produced this report. */
  config?: import("./run-config").EvalRunConfigSummary
}
