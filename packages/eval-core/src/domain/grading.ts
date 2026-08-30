/**
 * How a case's golden answer is compared against what the agent said.
 *
 * Real benchmarks all ship a reference answer, but each encodes it its own
 * way — GSM8K puts the number after `#### `, MMLU gives a letter, TriviaQA
 * gives a set of acceptable aliases. Before this existed, `EvalReference.
 * expectedOutput` had NO deterministic consumer at all: only the LLM judge read
 * it (as prompt context), so importing a real test set and running the
 * deterministic tier graded nothing.
 *
 * The spec lives on the CASE ({@link import("./eval").EvalReference.grading}),
 * not the dataset or the run config, for one reason: `Scorer.score(sample,
 * evalCase)` already receives the case, so per-case rules need no change to the
 * scorer-construction pipeline (`browser-deps.ts` builds the scorer list once,
 * `scorer-select.ts` filters it by id). It also makes a case self-describing,
 * so export → import round-trips without losing how it is judged, and lets one
 * dataset mix multiple-choice and free-text items.
 *
 * The import wizard picks a mode once and stamps it onto every imported case;
 * `EvalDataset.defaultGrading` remembers that choice for the NEXT import and
 * for newly added cases. It is a UI convenience only and is never read while
 * scoring.
 */

/**
 * How to compare the agent's answer against the reference.
 *
 *  - `exact`        — normalized full-string equality against `expectedOutput`.
 *  - `contains-any` — passes if ANY of `expectedContains` appears (alias sets).
 *                     Distinct from the `assertion` scorer, which requires ALL.
 *  - `regex`        — `pattern` must match the answer.
 *  - `numeric`      — extract a number from both sides and compare within
 *                     `tolerance`. Handles "the answer is 42." vs "42".
 *  - `choice`       — extract a multiple-choice selection (letter or 1-based
 *                     index) from both sides and compare.
 */
export type GradingMode = "exact" | "contains-any" | "regex" | "numeric" | "choice"

/**
 * Text normalization applied before comparison. Defaults follow the SQuAD /
 * open-domain-QA convention: case- and whitespace-insensitive, punctuation and
 * articles kept unless asked for, because dropping them changes meaning in some
 * languages and the caller should opt in.
 */
export interface GradingNormalize {
  /** Lowercase both sides. Default `true`. */
  caseInsensitive?: boolean
  /** Strip punctuation. Default `false`. */
  stripPunctuation?: boolean
  /** Strip leading English articles (a / an / the). Default `false`. */
  stripArticles?: boolean
  /** Collapse runs of whitespace and trim. Default `true`. */
  collapseWhitespace?: boolean
}

export interface GradingSpec {
  mode: GradingMode
  normalize?: GradingNormalize
  /**
   * `regex`: the pattern the answer must match.
   * `numeric`: how to find the number — e.g. `####\\s*(-?[\\d.,]+)` for GSM8K.
   *   Capture group 1 is used when present, else the whole match. Omitted →
   *   the LAST number in the text, which is where models put their answer.
   * Always applied with the `i` flag; other flags are not accepted (a spec is
   * data, not code, and `g` would make matching stateful).
   */
  pattern?: string
  /**
   * `numeric`: allowed absolute difference. Default `0` (exact). Use a small
   * value for float-valued benchmarks; integer benchmarks want the default.
   */
  tolerance?: number
  /**
   * `choice`: the option letters in order. Default `"ABCDEFGHIJ"`. A 1-based
   * index ("2") is accepted as an alias for the corresponding letter ("B").
   */
  alphabet?: string
}

/** Every mode, for UI pickers. Order is the order the wizard presents them. */
export const GRADING_MODES: readonly GradingMode[] = [
  "exact",
  "contains-any",
  "numeric",
  "choice",
  "regex",
]

/** The GSM8K convention: the final answer follows a `####` marker. */
export const GSM8K_ANSWER_PATTERN = "####\\s*(-?[\\d.,]+)"
