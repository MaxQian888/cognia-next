/**
 * Operator-aware lexer for the shell lines typed in the chat composer's `!`
 * mode (ADR-0039, composer surface).
 *
 * `lib/terminal/completion/tokenize.ts` splits a line on whitespace only —
 * enough for the ghost-text providers, which always complete at the end of a
 * single command. The composer needs more: `cat foo | gre` has TWO commands in
 * it, and completing `gre` as an *argument of cat* is the wrong answer. So this
 * module adds the structure that whitespace-splitting drops — pipelines,
 * boolean operators, separators, redirects, substitutions, and subshells —
 * while keeping the same quoting rules.
 *
 * Deliberately NOT a shell grammar: there is no parse tree, no expansion, and
 * no evaluation. It answers exactly two questions — "where does each token
 * start and end?" and "which of them opens a new command?" — because those are
 * the only two completion and diagnostics need. Anything it cannot classify
 * degrades to a plain word, which costs a suggestion, never a wrong execution.
 *
 * Pure + synchronous, so every case below is unit-testable without React.
 */

/** What a lexed token is, structurally. */
export type LexTokenKind =
  /** A plain word: a command name, an argument, a redirect target. */
  | "word"
  /** A command separator: `|`, `||`, `&&`, `;`, `&`, `|&`, or a newline. */
  | "operator"
  /** A redirection operator: `>`, `>>`, `<`, `2>`, `&>`, `<<<`, … */
  | "redirect"
  /** Opens a nested command context: `$(`, `` ` ``, `(`, `<(`, `>(`. */
  | "open"
  /** Closes one: `)` or a closing backtick. */
  | "close"

/** How a token's quoting ended — `null` when it closed properly. */
export type UnterminatedQuote = "'" | '"' | "\\" | null

export interface LexToken {
  kind: LexTokenKind
  /** The token exactly as typed (quotes and escapes preserved). */
  raw: string
  /** The unquoted/unescaped value. Equal to `raw` for non-word tokens. */
  value: string
  /** Offset of the first character of `raw` within the line. */
  start: number
  /** End offset (exclusive). */
  end: number
  /** Substitution/subshell nesting depth this token sits at (0 = top level). */
  depth: number
  /**
   * Set on a word whose quoting never closed — the normal state while the user
   * is still typing the opening quote, and the source of the
   * `incomplete-syntax` diagnostic once the line is committed.
   */
  unterminated?: UnterminatedQuote
}

export interface LexOptions {
  /** POSIX-style `\ ` escaping. Off for `cmd` / PowerShell, where `\` is a path separator. */
  backslashEscapes?: boolean
}

/** Separator operators, longest first so `&&` is never read as two `&`. */
const OPERATORS = ["&&", "||", "|&", ";;", "|", ";", "&", "\n"] as const

/** Redirection operators, longest first for the same reason. */
const REDIRECTS = ["<<<", "<<", ">>", ">&", "&>", ">", "<"] as const

/** Characters that end an unquoted word because they begin something else. */
const WORD_BREAK = new Set(["|", "&", ";", "<", ">", "(", ")", "\n", " ", "\t"])

/** Match one of `candidates` at `i`, returning the matched text. */
function matchAt(line: string, i: number, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (line.startsWith(candidate, i)) return candidate
  }
  return null
}

/**
 * A redirect may carry a leading file-descriptor digit (`2>`, `1>>`). The digit
 * belongs to the operator, not to the word before it, so it is consumed here
 * rather than left to become a bogus command head.
 */
function matchRedirect(line: string, i: number): string | null {
  let j = i
  while (j < line.length && line[j] >= "0" && line[j] <= "9") j++
  const op = matchAt(line, j, REDIRECTS)
  if (!op) return null
  // A bare digit run with no operator after it is a word (`echo 2`), and `&>`
  // must not be stolen from the `&` separator unless a `>` really follows.
  return line.slice(i, j) + op
}

/**
 * Lex a (partial) command line.
 *
 * Every character of the input lands in exactly one token or in inter-token
 * whitespace, so the returned ranges can be used directly as diagnostic and
 * replacement spans.
 */
export function lexCommandLine(line: string, opts: LexOptions = {}): LexToken[] {
  const escapes = opts.backslashEscapes ?? true
  const tokens: LexToken[] = []
  const n = line.length
  let i = 0
  // What opened each nesting level, innermost last. A depth COUNTER is not
  // enough: the same character opens and closes a backtick substitution, so
  // deciding which one a backtick is means knowing what the current level was
  // opened by.
  type Quote = '"' | "'"
  interface OpenFrame {
    kind: "backtick" | "paren"
    /** A double quote suspended while its nested command is lexed. */
    resumeQuote: Quote | null
  }
  const openStack: OpenFrame[] = []
  let resumedQuote: Quote | null = null
  const depthOf = () => openStack.length

  const push = (token: LexToken) => tokens.push(token)

  while (i < n) {
    const ch = line[i]

    // Inter-token whitespace (newline is an operator, handled below).
    if (resumedQuote === null && (ch === " " || ch === "\t" || ch === "\r")) {
      i++
      continue
    }

    // ── Structure that is never part of a word ──────────────────────────
    if (ch === "`") {
      if (openStack[openStack.length - 1]?.kind === "backtick") {
        const frame = openStack.pop()
        resumedQuote = frame?.resumeQuote ?? null
        push({ kind: "close", raw: "`", value: "`", start: i, end: i + 1, depth: depthOf() })
      } else {
        push({ kind: "open", raw: "`", value: "`", start: i, end: i + 1, depth: depthOf() })
        openStack.push({ kind: "backtick", resumeQuote: resumedQuote })
        resumedQuote = null
      }
      i++
      continue
    }
    // `$(` is ONE opening token. Splitting it (a `$` word, then a `(` open)
    // means the word branch below breaks on `$` without consuming it, and the
    // outer loop hands it straight back — a spin on every `$(` typed.
    if (ch === "$" && line[i + 1] === "(") {
      push({ kind: "open", raw: "$(", value: "$(", start: i, end: i + 2, depth: depthOf() })
      openStack.push({ kind: "paren", resumeQuote: resumedQuote })
      resumedQuote = null
      i += 2
      continue
    }
    if (resumedQuote === null && ch === "(") {
      push({ kind: "open", raw: "(", value: "(", start: i, end: i + 1, depth: depthOf() })
      openStack.push({ kind: "paren", resumeQuote: null })
      i++
      continue
    }
    if (resumedQuote === null && ch === ")") {
      // An unbalanced `)` closes nothing rather than driving the depth negative
      // — the user is mid-edit far more often than they are wrong.
      const frame = openStack[openStack.length - 1]?.kind === "paren" ? openStack.pop() : undefined
      resumedQuote = frame?.resumeQuote ?? null
      push({ kind: "close", raw: ")", value: ")", start: i, end: i + 1, depth: depthOf() })
      i++
      continue
    }

    // Redirects are checked before separators so `&>` and `2>` win over `&`.
    const redirect = resumedQuote === null ? matchRedirect(line, i) : null
    if (redirect) {
      push({
        kind: "redirect",
        raw: redirect,
        value: redirect,
        start: i,
        end: i + redirect.length,
        depth: depthOf(),
      })
      i += redirect.length
      continue
    }

    const operator = resumedQuote === null ? matchAt(line, i, OPERATORS) : null
    if (operator) {
      push({
        kind: "operator",
        raw: operator,
        value: operator,
        start: i,
        end: i + operator.length,
        depth: depthOf(),
      })
      i += operator.length
      continue
    }

    // ── A word ──────────────────────────────────────────────────────────
    const start = i
    let value = ""
    let quote: Quote | null = resumedQuote
    resumedQuote = null
    let unterminated: UnterminatedQuote = null

    while (i < n) {
      const c = line[i]

      if (quote) {
        if (c === quote) {
          quote = null
          i++
          continue
        }
        if (escapes && quote === '"' && c === "\\" && i + 1 < n) {
          const next = line[i + 1]
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            value += next
            i += 2
            continue
          }
        }
        // `$(` and a backtick are live inside double quotes, and the composer
        // has to see the command they open — `echo "$(gre"` still completes.
        if (quote === '"' && ((c === "$" && line[i + 1] === "(") || c === "`")) {
          resumedQuote = quote
          quote = null
          break
        }
        value += c
        i++
        continue
      }

      if (c === '"' || c === "'") {
        quote = c
        i++
        continue
      }
      if (escapes && c === "\\") {
        if (i + 1 >= n) {
          // A trailing backslash escapes the line end — nothing followed it.
          unterminated = "\\"
          i++
          break
        }
        value += line[i + 1]
        i += 2
        continue
      }
      // A substitution starting mid-word (`foo$(bar)`) ends the word here so
      // the nested command gets its own head token. A backtick ends it for the
      // same reason, and it is also how a substitution CLOSES — leaving it in
      // the word swallows the terminator and the nesting never unwinds.
      if (c === "`") break
      if (c === "$" && line[i + 1] === "(") {
        break
      }
      if (WORD_BREAK.has(c)) break
      value += c
      i++
    }

    if (quote) unterminated = quote
    const end = i
    if (end > start) {
      push({
        kind: "word",
        raw: line.slice(start, end),
        value,
        start,
        end,
        depth: depthOf(),
        ...(unterminated ? { unterminated } : {}),
      })
    }
    // Termination guard. Every character the word branch refuses is consumed by
    // a structural branch above, so this is unreachable today — but "the lexer
    // spins on one keystroke" is a bad failure to leave one edit away, and
    // emitting the character keeps the guard lossless.
    if (end === start) {
      push({
        kind: "word",
        raw: line[start],
        value: line[start],
        start,
        end: start + 1,
        depth: depthOf(),
      })
      i = start + 1
    }
  }

  return tokens
}

/**
 * Whether a token's text names a PATH rather than a command NAME.
 *
 * One rule, two consumers that must not drift: completion offers filesystem
 * candidates for a path-shaped head (`./script.sh`), and diagnostics decline to
 * call one unknown. Widen it in one place only and the two disagree about the
 * same token — completion offering files under a word still underlined red.
 */
export function isPathLikeToken(value: string): boolean {
  return (
    value.includes("/") || value.includes("\\") || value.startsWith(".") || value.startsWith("~")
  )
}

/**
 * Whether a word is a leading environment assignment (`FOO=bar cmd`) rather
 * than the command itself. Checked against the RAW text: `"FOO=bar"` typed in
 * quotes is an argument, not an assignment.
 */
export function isEnvAssignment(token: LexToken): boolean {
  if (token.kind !== "word") return false
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.raw)
}
