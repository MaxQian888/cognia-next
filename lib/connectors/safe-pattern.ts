/**
 * RE2-subset validation + cached evaluation for user-supplied regexes.
 *
 * Connector trigger rules let an operator write a regular expression that then
 * runs against every inbound chat message. JavaScript's `RegExp` is a
 * backtracking engine, so an adversarial (or merely careless) pattern like
 * `(\w+\s?)*$` can take super-linear time and stall the dispatch loop. RE2 —
 * the syntax Devin's automation fields accept — avoids this by construction,
 * but there is no RE2 engine in this runtime.
 *
 * The approach here is a structural subset instead of a sandboxed evaluation:
 *
 *   1. The pattern must compile with `new RegExp` (syntax gate).
 *   2. Lookarounds and backreferences are rejected outright — neither exists
 *      in RE2, and both defeat a star-height argument.
 *   3. Star height must stay below 2: an unbounded quantifier (`*`, `+`,
 *      `{n,}`) may never apply to a group that itself contains an unbounded
 *      quantifier. Nested unbounded repetition is where the exponential
 *      backtracking cases live; sequential and singly-nested repetition stay
 *      polynomial on the input sizes chat produces.
 *   4. {@link REGEX_INPUT_CAP} bounds the text a pattern ever sees, which
 *      keeps even the residual ambiguous-alternation cases (`(a|aa)*$`-class)
 *      inside a small constant.
 *
 * Compiled patterns are cached so a saved rule costs one validation per
 * process, not one compile per inbound message. Rejected patterns cache `null`
 * and simply never match — a bad pattern fails the rule closed rather than
 * throwing into the bus.
 */

/** Longest pattern the editor accepts; real trigger patterns are tens of chars. */
export const REGEX_PATTERN_CAP = 512

/**
 * Longest message text a regex rule evaluates. Beyond this the evaluator sees
 * only the first `REGEX_INPUT_CAP` characters — patterns anchored to the very
 * end of an over-cap message do not fire, which is the conservative direction
 * (the rule under-matches rather than over-matching).
 */
export const REGEX_INPUT_CAP = 4000

export type SafePatternRejection =
  "too-long" | "invalid-syntax" | "lookaround" | "backreference" | "nested-quantifier"

/**
 * Returns `null` when `source` is inside the safe subset, else the reason it
 * is not. Never throws.
 */
export function validateSafePattern(source: string): SafePatternRejection | null {
  if (source.length > REGEX_PATTERN_CAP) return "too-long"
  try {
    // Syntax gate first: everything below can assume a pattern that parsed.
    // Compiled without the `u`/`v` flags, so Annex-B literals (`a{`) behave
    // the same way here as they will at match time.
    new RegExp(source)
  } catch {
    return "invalid-syntax"
  }

  // `innerMax` — the highest star height contributed by anything directly
  // inside this frame (atoms with unbounded quantifiers score 1; child groups
  // score their own computed height). `stack[0]` is the whole pattern.
  const stack: { innerMax: number }[] = [{ innerMax: 0 }]
  const top = () => stack[stack.length - 1]
  const n = source.length
  let i = 0

  /**
   * Quantifier immediately after the atom/group that ends at `i`. Returns the
   * height contribution and consumes the quantifier (plus a lazy `?`).
   */
  const readQuantifier = (): 0 | 1 => {
    let q: 0 | 1 = 0
    let isQuantifier = false
    const c = source[i]
    if (c === "*" || c === "+") {
      q = 1
      isQuantifier = true
      i++
    } else if (c === "?") {
      isQuantifier = true
      i++
    } else if (c === "{") {
      // `{n}` `{n,}` `{n,m}` — anything else is an Annex-B literal `{`.
      const m = /^\{\d+(?:,\d*)?\}/.exec(source.slice(i))
      if (m) {
        isQuantifier = true
        // `{n,}` has no upper bound — unbounded. `{n}`/`{n,m}` are bounded.
        if (m[0].endsWith(",}")) q = 1
        i += m[0].length
      }
    }
    // Lazy suffix — `*?`, `+?`, `??`, `{n,m}?` all ride on any quantifier.
    if (isQuantifier && source[i] === "?") i++
    return q
  }

  /** Consume a `\`-escape starting at `i`. Assumes `source[i] === "\\"`. */
  const readEscape = (): SafePatternRejection | null => {
    const c = source[i + 1]
    if (c === undefined) return null // trailing `\` — compile already failed
    if (c >= "1" && c <= "9") return "backreference"
    i += 2
    if (c === "k" && source[i] === "<") return "backreference"
    if (c === "k" || c === "p" || c === "P") {
      // `\p{…}` property escapes and `\k<name>` (unreachable here — rejected
      // above) end at their own bracket; consume it so a `]` or `*` inside
      // the name is not mistaken for syntax.
      const open = source[i]
      if (open === "<" || open === "{") {
        const close = open === "<" ? ">" : "}"
        const end = source.indexOf(close, i + 1)
        i = end === -1 ? n : end + 1
      }
    } else if (c === "x") {
      // \xNN — Annex-B falls back to a literal `x` without the digits.
      if (/^[0-9a-fA-F]{2}/.test(source.slice(i))) i += 2
    } else if (c === "u") {
      if (source[i] === "{") {
        const end = source.indexOf("}", i + 1)
        i = end === -1 ? n : end + 1
      } else if (/^[0-9a-fA-F]{4}/.test(source.slice(i))) {
        i += 4
      }
    }
    return null
  }

  /** Consume a `[` character class starting at `i`. */
  const readClass = (): void => {
    i++ // `[`
    if (source[i] === "^") i++
    if (source[i] === "]") i++ // a leading `]` is a literal member
    while (i < n && source[i] !== "]") {
      i += source[i] === "\\" ? 2 : 1
    }
    if (i < n) i++ // closing `]`
  }

  while (i < n) {
    const c = source[i]

    if (c === "\\") {
      const rejection = readEscape()
      if (rejection) return rejection
      top().innerMax = Math.max(top().innerMax, readQuantifier())
      continue
    }

    if (c === "[") {
      readClass()
      top().innerMax = Math.max(top().innerMax, readQuantifier())
      continue
    }

    if (c === "(") {
      if (
        source.startsWith("(?=", i) ||
        source.startsWith("(?!", i) ||
        source.startsWith("(?<=", i) ||
        source.startsWith("(?<!", i)
      ) {
        return "lookaround"
      }
      if (source.startsWith("(?<", i)) {
        // Named group `(?<name>…)` — the name ends at `>`.
        const end = source.indexOf(">", i + 3)
        i = end === -1 ? n : end + 1
        stack.push({ innerMax: 0 })
        continue
      }
      if (source.startsWith("(?:", i)) {
        i += 3
        stack.push({ innerMax: 0 })
        continue
      }
      if (source.startsWith("(?", i)) {
        // Inline-flag form `(?ims:…)` (a group) or `(?ims)` (a directive).
        let j = i + 2
        while (j < n && /[a-z-]/.test(source[j])) j++
        if (source[j] === ")") {
          i = j + 1
          continue // flag directive — an annotation, not a group
        }
        // `(?flags:…)` — the `:` is guaranteed by the earlier compile.
        i = j + 1
        stack.push({ innerMax: 0 })
        continue
      }
      i++
      stack.push({ innerMax: 0 })
      continue
    }

    if (c === ")") {
      i++
      const frame = stack.pop() ?? { innerMax: 0 }
      const height = frame.innerMax + readQuantifier()
      if (height >= 2) return "nested-quantifier"
      top().innerMax = Math.max(top().innerMax, height)
      continue
    }

    if (c === "|") {
      i++
      continue
    }

    // Ordinary atom: literal char, `.`, `^`, `$`.
    i++
    top().innerMax = Math.max(top().innerMax, readQuantifier())
  }

  return stack[0].innerMax >= 2 ? "nested-quantifier" : null
}

/**
 * Compiled-pattern cache keyed by source+flag. Rejected or uncompilable
 * patterns cache `null`, so a bad saved rule costs one validation per
 * process rather than one throw per inbound message (same contract as the
 * dispatch-rules cache).
 */
const patternCache = new Map<string, RegExp | null>()

export function compileSafePattern(source: string, caseInsensitive: boolean): RegExp | null {
  const key = `${caseInsensitive ? "i" : ""}${source}`
  const cached = patternCache.get(key)
  if (cached !== undefined) return cached
  let compiled: RegExp | null = null
  if (validateSafePattern(source) === null) {
    try {
      compiled = new RegExp(source, caseInsensitive ? "i" : "")
    } catch {
      compiled = null
    }
  }
  patternCache.set(key, compiled)
  return compiled
}

/**
 * Test `text` against a user-supplied pattern. Rejected patterns and over-cap
 * edge cases fail closed (`false` — the rule does not fire).
 */
export function safePatternTest(source: string, caseInsensitive: boolean, text: string): boolean {
  const re = compileSafePattern(source, caseInsensitive)
  if (!re) return false
  return re.test(text.length > REGEX_INPUT_CAP ? text.slice(0, REGEX_INPUT_CAP) : text)
}
