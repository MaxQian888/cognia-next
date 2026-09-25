/**
 * Guard for the model-supplied regular expression `workspace_search` runs.
 *
 * JavaScript regexes backtrack, and `RegExp.prototype.test` is synchronous: a
 * pattern such as `(a+)+$` against a long run of `a`s never returns, and no
 * deadline or AbortSignal can interrupt it — the renderer thread just hangs.
 * Since the pattern arrives from a model (and so, potentially, from a prompt
 * injection), the tool bounds the work in three places:
 *
 *   1. {@link checkSearchPattern} refuses the pattern shapes that backtrack
 *      exponentially or steeply polynomially — a repeated group whose body is
 *      itself unboundedly quantified, an unboundedly repeated alternation,
 *      more than two unbounded wildcards, and backreferences — before anything
 *      is compiled;
 *   2. each line is tested only up to {@link SEARCH_MAX_TESTED_LINE_CHARS};
 *   3. the caller keeps an overall time budget between lines and files.
 *
 * (1) is a conservative syntactic check, not a proof: it rejects some patterns
 * that would have been fine (`(ab+)+`), which is the right side to err on for
 * a tool the model can call freely.
 */

/** Longest pattern accepted. */
export const SEARCH_MAX_PATTERN_LENGTH = 500
/** Characters of each line the regex is run against. */
export const SEARCH_MAX_TESTED_LINE_CHARS = 1_000
/** `{n,m}` repeats with a span above this count as unbounded. */
const LARGE_REPEAT_SPAN = 10
/**
 * Most unboundedly quantified broad atoms (`.`, `\w`, `\W`, `\S`, `\D`, `[^…]`)
 * one pattern may hold. Each one that can match the same characters as another
 * multiplies the backtracking: `.*a.*b` is fine on a 1,000-char line,
 * `.*a.*b.*z` takes seconds, `\w*\w*\w*!` never returns.
 */
const MAX_BROAD_UNBOUNDED = 2

export type PatternCheck = { ok: true } | { ok: false; error: string }

interface Quantifier {
  /** Characters the quantifier token occupies (including a lazy `?`). */
  length: number
  unbounded: boolean
  /** The quantified atom can match more than once (`*`, `+`, `{2}`, `{1,3}`…). */
  repeats: boolean
}

/** Read a quantifier starting at `index`, or `null` when there is none. */
function readQuantifier(pattern: string, index: number): Quantifier | null {
  const c = pattern[index]
  let length = 0
  let unbounded = false
  let repeats = false
  if (c === "*" || c === "+") {
    length = 1
    unbounded = true
    repeats = true
  } else if (c === "?") {
    length = 1
  } else if (c === "{") {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index))
    if (!match) return null
    length = match[0].length
    const min = Number(match[1])
    if (match[2] === undefined) {
      unbounded = false
      repeats = min > 1
    } else if (match[3] === "") {
      unbounded = true
      repeats = true
    } else {
      unbounded = Number(match[3]) - min > LARGE_REPEAT_SPAN
      repeats = Number(match[3]) > 1
    }
  } else {
    return null
  }
  // A trailing `?` makes the quantifier lazy; it is part of the same token.
  if (pattern[index + length] === "?") length += 1
  return { length, unbounded, repeats }
}

/** Index just past the `]` closing the character class that opens at `start`. */
function skipCharacterClass(pattern: string, start: number): number {
  let i = start + 1
  if (pattern[i] === "^") i += 1
  if (pattern[i] === "]") i += 1 // a leading `]` is a literal
  while (i < pattern.length && pattern[i] !== "]") {
    i += pattern[i] === "\\" ? 2 : 1
  }
  return i + 1
}

/** Length of a group-opening prefix after `(`: `?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>`. */
function groupPrefixLength(pattern: string, index: number): number {
  if (pattern[index] !== "?") return 0
  const next = pattern[index + 1]
  if (next === ":" || next === "=" || next === "!") return 2
  if (next === "<") {
    const after = pattern[index + 2]
    if (after === "=" || after === "!") return 3
    const close = pattern.indexOf(">", index + 2)
    return close === -1 ? 2 : close - index + 1
  }
  return 0
}

/**
 * Refuse a pattern that can backtrack exponentially, or is too long to be a
 * search. `ok: true` does not mean the pattern compiles — the caller still
 * reports a `SyntaxError` from `new RegExp` as its own error.
 */
export function checkSearchPattern(pattern: string): PatternCheck {
  if (pattern.length > SEARCH_MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      error: `pattern is ${pattern.length} characters; the limit is ${SEARCH_MAX_PATTERN_LENGTH}`,
    }
  }
  // Each open group records whether its body holds an unbounded quantifier,
  // and how each top-level branch starts: a literal (lower-cased), or "*" for
  // anything that can match many characters (class, escape, `.`, group), or ""
  // for an empty branch. Branches that can start alike overlap.
  const groups: Array<{ quantifiedBody: boolean; branchStarts: string[]; atBranchStart: boolean }> =
    []
  let broadUnbounded = 0
  let i = 0
  // Account for the quantifier (if any) after an atom; `broad` atoms can
  // overlap each other, so their unbounded repeats multiply.
  const afterAtom = (broad: boolean): PatternCheck | null => {
    const quantifier = readQuantifier(pattern, i)
    if (!quantifier) return null
    i += quantifier.length
    if (!quantifier.unbounded) return null
    markQuantified(groups)
    if (broad && ++broadUnbounded > MAX_BROAD_UNBOUNDED) {
      return {
        ok: false,
        error:
          `more than ${MAX_BROAD_UNBOUNDED} unbounded wildcards such as .* or \\w+ are not ` +
          "supported: they make the search backtrack polynomially — anchor them with literals",
      }
    }
    return null
  }
  while (i < pattern.length) {
    const c = pattern[i]
    const open = groups[groups.length - 1]
    if (open?.atBranchStart) {
      open.atBranchStart = false
      open.branchStarts.push(
        c === "|" || c === ")" ? "" : "\\[.(".includes(c) ? "*" : c.toLowerCase()
      )
    }
    if (c === "\\") {
      const next = pattern[i + 1]
      if ((next !== undefined && /[1-9]/.test(next)) || (next === "k" && pattern[i + 2] === "<")) {
        return {
          ok: false,
          error: "backreferences are not supported: they make the search backtrack exponentially",
        }
      }
      i += 2
      const refused = afterAtom(next !== undefined && "wWSD".includes(next))
      if (refused) return refused
      continue
    }
    if (c === "[") {
      const negated = pattern[i + 1] === "^"
      i = skipCharacterClass(pattern, i)
      const refused = afterAtom(negated)
      if (refused) return refused
      continue
    }
    if (c === "(") {
      groups.push({ quantifiedBody: false, branchStarts: [], atBranchStart: true })
      i += 1 + groupPrefixLength(pattern, i + 1)
      continue
    }
    if (c === "|") {
      if (open) open.atBranchStart = true
      i += 1
      continue
    }
    if (c === ")") {
      const group = groups.pop()
      i += 1
      const quantifier = readQuantifier(pattern, i)
      if (quantifier) i += quantifier.length
      if (group?.quantifiedBody && quantifier?.repeats) {
        return {
          ok: false,
          error:
            "nested quantifiers such as (a+)+, (\\w*)* or (a+){2,5} are not supported: they make " +
            "the search backtrack exponentially — quantify the inner part only",
        }
      }
      if (group && quantifier?.unbounded && branchesOverlap(group.branchStarts)) {
        return {
          ok: false,
          error:
            "a repeated alternation such as (a|aa)+ is not supported: overlapping branches make " +
            "the search backtrack exponentially — use a character class like [ab]+ instead",
        }
      }
      if (group?.quantifiedBody || quantifier?.unbounded) markQuantified(groups)
      continue
    }
    i += 1
    const refused = afterAtom(c === ".")
    if (refused) return refused
  }
  return { ok: true }
}

/** An alternation whose branches can start matching the same text. */
function branchesOverlap(starts: string[]): boolean {
  if (starts.length < 2) return false
  return starts.some((s) => s === "" || s === "*") || new Set(starts).size < starts.length
}

function markQuantified(groups: Array<{ quantifiedBody: boolean }>): void {
  const top = groups[groups.length - 1]
  if (top) top.quantifiedBody = true
}
