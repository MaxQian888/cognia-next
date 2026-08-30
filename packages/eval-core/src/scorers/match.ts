/**
 * Reference-answer matching scorers (L1 tier — no LLM).
 *
 * These are what makes a real test set gradable without a judge. Every public
 * benchmark ships a golden answer, but until now nothing deterministic
 * consumed `reference.expectedOutput` — only the LLM judge read it, as prompt
 * context. Import GSM8K, run the deterministic tier, and not one case was
 * graded.
 *
 * Each scorer reads `reference.grading` to decide HOW to compare (see
 * `types/eval/grading.ts` for why the rule lives on the case). A scorer whose
 * mode the case did not select reports `not-applicable`, so selecting all five
 * costs nothing: exactly the one the dataset declares produces a verdict.
 *
 * Extraction, not equality, is the hard part. A model answering GSM8K writes
 * "…so she has 18 eggs left." while the golden answer is "…\n#### 18"; a model
 * answering MMLU writes "The answer is (B)." while the golden answer is "B".
 * {@link extractNumber} and {@link extractChoice} are the two normalizers that
 * bridge that gap, and they are exported so the import wizard can preview what
 * a rule would extract before the user commits to it.
 */

import type { EvalCase, EvalSample, Score, Scorer } from "../domain/eval"
import type { GradingMode, GradingNormalize, GradingSpec } from "../domain/grading"

const DEFAULT_ALPHABET = "ABCDEFGHIJ"

function notApplicable(scorerId: string, reason: string): Score {
  return {
    scorerId,
    dimension: "response-quality",
    status: "not-applicable",
    value: 0,
    passed: false,
    error: `not-applicable: ${reason}`,
  }
}

function verdict(scorerId: string, ok: boolean, metadata?: Record<string, unknown>): Score {
  return {
    scorerId,
    dimension: "response-quality",
    status: "scored",
    value: ok ? 1 : 0,
    passed: ok,
    ...(metadata ? { metadata } : {}),
  }
}

/**
 * Apply a {@link GradingNormalize} to one side of a comparison. Defaults are
 * case-insensitive + whitespace-collapsing; punctuation and articles are kept
 * unless asked for, because stripping them changes meaning in some languages.
 */
export function normalizeAnswer(text: string, options: GradingNormalize = {}): string {
  let out = text
  if (options.caseInsensitive !== false) out = out.toLowerCase()
  if (options.stripPunctuation) {
    // Unicode punctuation, so CJK full-width marks go too.
    out = out.replace(/[\p{P}\p{S}]/gu, " ")
  }
  if (options.stripArticles) out = out.replace(/\b(?:a|an|the)\b/gi, " ")
  if (options.collapseWhitespace !== false) out = out.replace(/\s+/g, " ").trim()
  return out
}

/** Compile a spec pattern. Always case-insensitive; never global (see the type). */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i")
  } catch {
    return null
  }
}

/**
 * Pull the answer number out of free text.
 *
 * With a `pattern`, capture group 1 wins (falling back to the whole match) —
 * that is how `####\s*(-?[\d.,]+)` picks GSM8K's marked answer out of a chain
 * of thought full of other numbers. Without one, the LAST number in the text is
 * taken, because that is where a model puts its conclusion.
 *
 * Thousands separators are dropped and a trailing period (sentence punctuation,
 * not a decimal point) is ignored. Returns `null` when there is no number.
 */
export function extractNumber(text: string, pattern?: string): number | null {
  if (pattern) {
    const re = compile(pattern)
    if (!re) return null
    const m = re.exec(text)
    if (!m) return null
    return parseNumber(m[1] ?? m[0])
  }
  const matches = text.match(/-?\d[\d,]*(?:\.\d+)?/g)
  if (!matches || matches.length === 0) return null
  return parseNumber(matches[matches.length - 1])
}

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").replace(/\.$/, "")
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Pull a multiple-choice selection out of free text, as an uppercase letter.
 *
 * Accepts the bare letter, a letter wrapped in the usual decorations
 * (`(B)`, `B)`, `B.`, `**B**`), the phrase "answer is B", and a 1-based index
 * ("2" → "B") so datasets that store the option ORDINAL still work. Scans from
 * the end, because a model's final sentence carries the verdict while its
 * reasoning may mention every option.
 */
export function extractChoice(text: string, alphabet = DEFAULT_ALPHABET): string | null {
  const letters = alphabet.toUpperCase()
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  // Bare letter or bare index — the shape a golden answer usually has.
  const bare = trimmed.replace(/[^\p{L}\p{N}]/gu, "")
  if (bare.length === 1) {
    const asLetter = bare.toUpperCase()
    if (letters.includes(asLetter)) return asLetter
  }
  const asIndex = Number(bare)
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= letters.length) {
    return letters[asIndex - 1]
  }

  // Decorated letter inside prose. Scan all matches, keep the last.
  const re = new RegExp(`(?:^|[^\\p{L}])\\(?([${letters}])\\)?(?=[^\\p{L}]|$)`, "giu")
  let found: string | null = null
  for (const m of trimmed.matchAll(re)) found = m[1].toUpperCase()
  return found
}

interface MatchOutcome {
  /** `null` when this scorer's mode was not selected / its reference is absent. */
  applicable: boolean
  reason?: string
  ok?: boolean
  metadata?: Record<string, unknown>
}

function evaluate(mode: GradingMode, sample: EvalSample, evalCase: EvalCase): MatchOutcome {
  const spec: GradingSpec | undefined = evalCase.reference?.grading
  if (!spec) return { applicable: false, reason: "no reference.grading on this case" }
  if (spec.mode !== mode) return { applicable: false, reason: `grading mode is "${spec.mode}"` }

  const norm = spec.normalize ?? {}
  const answer = sample.output

  if (mode === "contains-any") {
    const expected = evalCase.reference?.expectedContains
    if (!expected || expected.length === 0) {
      return { applicable: false, reason: "no expectedContains reference" }
    }
    const hay = normalizeAnswer(answer, norm)
    const matched = expected.filter((e) => hay.includes(normalizeAnswer(e, norm)))
    return {
      applicable: true,
      ok: matched.length > 0,
      metadata: { matched, total: expected.length },
    }
  }

  if (mode === "regex") {
    if (!spec.pattern) return { applicable: false, reason: "grading.pattern is required for regex" }
    const re = compile(spec.pattern)
    if (!re) return { applicable: false, reason: `invalid grading.pattern: ${spec.pattern}` }
    return { applicable: true, ok: re.test(answer), metadata: { pattern: spec.pattern } }
  }

  // The remaining modes compare against a golden answer.
  const gold = evalCase.reference?.expectedOutput
  if (gold === undefined || gold.trim() === "") {
    return { applicable: false, reason: "no expectedOutput reference" }
  }

  if (mode === "exact") {
    const a = normalizeAnswer(answer, norm)
    const b = normalizeAnswer(gold, norm)
    return { applicable: true, ok: a === b, metadata: { expected: b, actual: a } }
  }

  if (mode === "numeric") {
    const expected = extractNumber(gold, spec.pattern)
    // The pattern describes the GOLD encoding (e.g. GSM8K's `####`), which the
    // model's own answer will not repeat — so the answer is scanned generically.
    const actual = extractNumber(answer)
    if (expected === null) {
      return { applicable: false, reason: "no number found in expectedOutput" }
    }
    if (actual === null) {
      return { applicable: true, ok: false, metadata: { expected, actual: null } }
    }
    const tolerance = spec.tolerance ?? 0
    return {
      applicable: true,
      ok: Math.abs(actual - expected) <= tolerance,
      metadata: { expected, actual, tolerance },
    }
  }

  // choice
  const alphabet = spec.alphabet ?? DEFAULT_ALPHABET
  const expectedChoice = extractChoice(gold, alphabet)
  const actualChoice = extractChoice(answer, alphabet)
  if (expectedChoice === null) {
    return { applicable: false, reason: "no choice found in expectedOutput" }
  }
  return {
    applicable: true,
    ok: actualChoice === expectedChoice,
    metadata: { expected: expectedChoice, actual: actualChoice },
  }
}

function makeMatchScorer(id: string, mode: GradingMode): Scorer {
  return {
    id,
    dimension: "response-quality",
    requiresLlm: false,
    gating: true,
    score(sample: EvalSample, evalCase: EvalCase): Score {
      const out = evaluate(mode, sample, evalCase)
      if (!out.applicable) return notApplicable(id, out.reason ?? "not selected")
      return verdict(id, out.ok === true, out.metadata)
    },
  }
}

/** Normalized full-string equality against `expectedOutput`. */
export const exactMatchScorer = makeMatchScorer("exact-match", "exact")
/** Passes when ANY listed alias appears (vs. `assertion`, which needs all). */
export const containsAnyScorer = makeMatchScorer("contains-any", "contains-any")
/** `grading.pattern` must match the answer. */
export const regexMatchScorer = makeMatchScorer("regex-match", "regex")
/** Extract a number from both sides and compare within `grading.tolerance`. */
export const numericMatchScorer = makeMatchScorer("numeric-match", "numeric")
/** Extract a multiple-choice selection from both sides and compare. */
export const choiceMatchScorer = makeMatchScorer("choice-match", "choice")

/** All five, in catalog order. */
export const matchScorers: readonly Scorer[] = [
  exactMatchScorer,
  containsAnyScorer,
  regexMatchScorer,
  numericMatchScorer,
  choiceMatchScorer,
]
