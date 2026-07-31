/**
 * What kind of thing did the user just select?
 *
 * Drives two distinct consumers, and conflating them is the mistake to avoid:
 *
 *  1. **Which buttons appear.** `url` mints "Open link", `email` mints
 *     "Email", `measurement` mints "Convert", `term` gates "Search".
 *  2. **How a prompt is worded.** `code` and `foreignLanguage` mint no button
 *     at all — they sharpen actions that are already there ("explain this
 *     code", translate with a sensible default target).
 *
 * Lives in `lib/` rather than beside the toolbar because both windows need it:
 * the overlay to decide what to render, the main window to shape the prompt it
 * stages. It is pure and imports nothing, because it runs on the critical path
 * of every single selection, in a least-privilege overlay shell.
 *
 * Deliberately heuristic. Every one of these decisions is reversible by the
 * user in the next click, so a false positive costs one unwanted button — not
 * a wrong answer. That budget is what allows regexes here instead of a parser
 * and a language-detection dependency.
 */

export type SelectionContentType =
  "url" | "email" | "code" | "measurement" | "foreignLanguage" | "term"

export interface SelectionClassification {
  /** Highest-confidence first, deduped, at most {@link MAX_MATCHED_TYPES}. */
  types: SelectionContentType[]
  /** Present only with `url`. Already normalized and scheme-checked. */
  url?: string
  /** Present only with `email`. */
  email?: string
  /** Dominant Unicode script when `foreignLanguage` matched, e.g. `"Han"`. */
  script?: string
}

/**
 * A capsule can show at most a couple of contextual buttons before it stops
 * being a capsule, and beyond two the extra matches are always the weak ones.
 */
export const MAX_MATCHED_TYPES = 2

/** Above this, a "measurement" is really a paragraph that mentions a number. */
const MEASUREMENT_MAX_CHARS = 40
/**
 * `term` gates the search action, and search is the weakest match in the set:
 * almost any short selection is *plausibly* something to look up. Since a
 * contextual action costs a generic one its slot, these bounds are deliberately
 * tight — a lookup target (a name, a phrase, an error code), not a sentence.
 * Sentence punctuation disqualifies outright: prose is something to explain or
 * translate, not to search for verbatim.
 */
const TERM_MAX_CHARS = 40
const TERM_MAX_WORDS = 4
const SENTENCE_PUNCTUATION = /[.!?;:,。！？；：，]/
/** Share of letters that must belong to one script before it counts. */
const DOMINANT_SCRIPT_RATIO = 0.6

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/
/**
 * Two shapes, because units and currencies sit on opposite sides of the
 * number: `12.5 km` but `$4,000`. Longer unit names are listed before their
 * prefixes (`km/h` before `km`, `km` before `m`) so alternation does not match
 * the short one first and leave a stray letter behind.
 */
const MEASUREMENT_RE = new RegExp(
  [
    // Prefixed currency: $4,000 · €19.99
    String.raw`[$€¥£]\s*-?\d[\d,]*(?:\.\d+)?`,
    // Suffixed unit: 38°C · 12.5 km · 180 lbs · 20 USD
    String.raw`-?\d+(?:[.,]\d+)?\s*(?:°?[CF]|km\/h|km|cm|mm|mi|ft|in|kg|lbs?|oz|ml|gal|mph|USD|EUR|CNY|JPY|GBP|[mgl])\b`,
  ].join("|"),
  "i"
)

const CODE_SIGNALS: readonly RegExp[] = [
  /[{};]/,
  /=>|->|::/,
  /\b(?:function|const|let|var|def|fn|class|import|export|return|public|private)\s/,
  /\w+\([^)]*\)/,
  /^\s{2,}\S/m,
]

/**
 * Unicode script blocks we can tell apart cheaply. Not a language list — the
 * only thing this drives is *promoting* an action that is already visible, so
 * script granularity is enough and a real detector would be a dependency, a
 * bundle, and an async API on a synchronous path.
 *
 * Known limitation, stated rather than hidden: French text in an English UI is
 * not detected, because both are Latin. `translate` is visible by default, so
 * the cost is a missed promotion, never a missing action.
 */
const SCRIPTS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Han", re: /\p{Script=Han}/u },
  { name: "Hiragana", re: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
  { name: "Hangul", re: /\p{Script=Hangul}/u },
  { name: "Cyrillic", re: /\p{Script=Cyrillic}/u },
  { name: "Arabic", re: /\p{Script=Arabic}/u },
  { name: "Latin", re: /\p{Script=Latin}/u },
]

/** Which script a UI locale implies, so "foreign" means foreign *to the user*. */
function scriptForLocale(locale: string): string {
  const lower = locale.toLowerCase()
  if (lower.startsWith("zh")) return "Han"
  if (lower.startsWith("ja")) return "Hiragana"
  if (lower.startsWith("ko")) return "Hangul"
  if (lower.startsWith("ru") || lower.startsWith("uk")) return "Cyrillic"
  if (lower.startsWith("ar") || lower.startsWith("fa")) return "Arabic"
  return "Latin"
}

/**
 * Parse only when the *entire* selection is a link.
 *
 * Whole-text-only on purpose: a link buried in a paragraph is not what someone
 * selected in order to open, and offering "Open link" there would be a
 * mis-fire on the most destructive contextual action in the set.
 *
 * The scheme allowlist is the first of two gates that keep `file:`,
 * `javascript:` and `data:` away from the OS opener. The second is in Rust,
 * which re-parses rather than trusting this — see `selection_toolbar.rs`.
 */
function detectUrl(text: string): string | undefined {
  if (/\s/.test(text)) return undefined
  const candidate = /^www\./i.test(text) ? `https://${text}` : text
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

function detectCode(text: string): boolean {
  return CODE_SIGNALS.filter((signal) => signal.test(text)).length >= 2
}

function detectForeignScript(text: string, uiLocale: string): string | undefined {
  const letters = Array.from(text).filter((char) => /\p{L}/u.test(char))
  if (letters.length === 0) return undefined
  const home = scriptForLocale(uiLocale)
  for (const { name, re } of SCRIPTS) {
    const count = letters.filter((char) => re.test(char)).length
    if (count / letters.length >= DOMINANT_SCRIPT_RATIO) {
      return name === home ? undefined : name
    }
  }
  return undefined
}

function detectTerm(text: string): boolean {
  if (text.includes("\n") || text.length > TERM_MAX_CHARS) return false
  if (SENTENCE_PUNCTUATION.test(text)) return false
  return text.split(/\s+/).filter(Boolean).length <= TERM_MAX_WORDS
}

export function classifySelection(
  text: string,
  options: { uiLocale: string }
): SelectionClassification {
  const trimmed = text.trim()
  if (!trimmed) return { types: [] }

  const types: SelectionContentType[] = []
  const result: SelectionClassification = { types }

  const url = detectUrl(trimmed)
  if (url) {
    types.push("url")
    result.url = url
  } else if (EMAIL_RE.test(trimmed)) {
    types.push("email")
    result.email = trimmed
  }

  if (detectCode(trimmed)) types.push("code")

  // The length cap is load-bearing, not tidiness: without it every paragraph
  // containing "5 m" or "$20" would offer a unit conversion.
  if (trimmed.length <= MEASUREMENT_MAX_CHARS && MEASUREMENT_RE.test(trimmed)) {
    types.push("measurement")
  }

  const script = detectForeignScript(trimmed, options.uiLocale)
  if (script) {
    types.push("foreignLanguage")
    result.script = script
  }

  // `term` is the fallback that gates web search, so it must not fire for
  // things that already have a better-matched action.
  if (
    !types.includes("url") &&
    !types.includes("email") &&
    !types.includes("code") &&
    detectTerm(trimmed)
  ) {
    types.push("term")
  }

  result.types = types.slice(0, MAX_MATCHED_TYPES)
  return result
}
