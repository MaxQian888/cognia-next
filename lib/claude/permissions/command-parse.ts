/**
 * Shell command parser for the agent command-safety pipeline.
 *
 * A real shell grammar is overkill here — what the safety classifier
 * (`command-safety.ts`) and the Auto-mode orchestrator (`auto-mode.ts`)
 * actually need is: "what are the individual executables this command line
 * would run, and what are their arguments?". That mirrors how OpenCode's
 * `ShellTool.parse` breaks `echo foo && echo bar` into the patterns
 * `echo foo` / `echo bar` and evaluates each against the permission rules.
 *
 * `splitCommandSegments` walks the command once, quote- and depth-aware, and
 * splits on the top-level control operators (`&&`, `||`, `|`, `;`, `&`,
 * newlines). Command substitutions (`$(...)`, backticks) and subshell groups
 * (`(...)`) are recursively extracted as their own segments so a hidden
 * `echo $(rm -rf /)` still surfaces the `rm`. Pure: no I/O.
 */

export interface CommandSegment {
  /** Head executable, path-stripped + lowercased + `.exe`-stripped. */
  head: string
  /** The raw segment text (trimmed) before substitution extraction. */
  raw: string
  /** Argument tokens after the head (quote-aware, quotes removed). */
  args: string[]
}

/** `NAME=value` leading env-assignment prefix (skipped to find the head). */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

const MAX_DEPTH = 20

/**
 * Reduce a raw executable token to a comparable name: take the path
 * basename, lowercase it, and drop a trailing `.exe`. `/usr/bin/RM` → `rm`,
 * `C:\\Windows\\System32\\cmd.exe` → `cmd`.
 */
export function normalizeHead(token: string): string {
  let t = (token ?? "").trim()
  if (!t) return ""
  const parts = t.split(/[\\/]/)
  t = parts[parts.length - 1] ?? t
  return t.toLowerCase().replace(/\.exe$/i, "")
}

/** Split a command into top-level statements, respecting quotes + paren depth. */
function splitTopLevel(command: string): string[] {
  const out: string[] = []
  let cur = ""
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let depth = 0
  const flush = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ""
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]
    if (inSingle) {
      cur += c
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      cur += c
      if (c === '"') inDouble = false
      continue
    }
    if (inBacktick) {
      cur += c
      if (c === "`") inBacktick = false
      continue
    }
    if (c === "'") {
      inSingle = true
      cur += c
      continue
    }
    if (c === '"') {
      inDouble = true
      cur += c
      continue
    }
    if (c === "`") {
      inBacktick = true
      cur += c
      continue
    }
    if (c === "(") {
      depth++
      cur += c
      continue
    }
    if (c === ")") {
      if (depth > 0) depth--
      cur += c
      continue
    }
    if (depth > 0) {
      cur += c
      continue
    }
    // Top-level control operators.
    if (c === "&" && next === "&") {
      flush()
      i++
      continue
    }
    if (c === "|" && next === "|") {
      flush()
      i++
      continue
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      flush()
      continue
    }
    cur += c
  }
  flush()
  return out
}

/** Index of the `)` matching the `(` at `openIdx`, or -1. Quote-aware. */
function matchParen(text: string, openIdx: number): number {
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (c === '"') inDouble = false
      continue
    }
    if (c === "'") {
      inSingle = true
      continue
    }
    if (c === '"') {
      inDouble = true
      continue
    }
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Pull `$(...)`, backtick, and `(...)` spans out of `text`. Returns their
 * inner command strings (for recursive processing) plus a `stripped` copy
 * with each span replaced by a space so the outer head still tokenizes.
 */
function extractSubstitutions(text: string): { inner: string[]; stripped: string } {
  const inner: string[] = []
  let stripped = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inSingle) {
      stripped += c
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      stripped += c
      if (c === '"') inDouble = false
      continue
    }
    if (c === "'") {
      inSingle = true
      stripped += c
      continue
    }
    if (c === '"') {
      inDouble = true
      stripped += c
      continue
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1)
      if (end === -1) {
        stripped += c
        continue
      }
      inner.push(text.slice(i + 1, end))
      i = end
      stripped += " "
      continue
    }
    if (c === "$" && text[i + 1] === "(") {
      const close = matchParen(text, i + 1)
      if (close === -1) {
        stripped += c
        continue
      }
      inner.push(text.slice(i + 2, close))
      i = close
      stripped += " "
      continue
    }
    if (c === "(") {
      const close = matchParen(text, i)
      if (close === -1) {
        stripped += c
        continue
      }
      inner.push(text.slice(i + 1, close))
      i = close
      stripped += " "
      continue
    }
    stripped += c
  }
  return { inner, stripped }
}

/** Quote-aware whitespace tokenizer; quotes are consumed, contents kept. */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let cur = ""
  let has = false
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      else {
        cur += c
        has = true
      }
      continue
    }
    if (inDouble) {
      if (c === '"') inDouble = false
      else {
        cur += c
        has = true
      }
      continue
    }
    if (c === "'") {
      inSingle = true
      has = true
      continue
    }
    if (c === '"') {
      inDouble = true
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has) {
        tokens.push(cur)
        cur = ""
        has = false
      }
      continue
    }
    cur += c
    has = true
  }
  if (has) tokens.push(cur)
  return tokens
}

function collect(command: string, out: CommandSegment[], depth: number): void {
  if (depth > MAX_DEPTH) return
  for (const raw of splitTopLevel(command)) {
    const { inner, stripped } = extractSubstitutions(raw)
    const tokens = tokenize(stripped)
    let idx = 0
    while (idx < tokens.length && (tokens[idx] === "" || ENV_ASSIGN.test(tokens[idx]))) idx++
    const headToken = tokens[idx]
    if (headToken !== undefined) {
      const head = normalizeHead(headToken)
      if (head) out.push({ head, raw: raw.trim(), args: tokens.slice(idx + 1) })
    }
    for (const sub of inner) {
      if (sub.trim()) collect(sub, out, depth + 1)
    }
  }
}

/**
 * Break a command line into the individual executables it would run. Returns
 * one {@link CommandSegment} per head command, including those hidden inside
 * command substitutions and subshells. Empty / whitespace-only input → `[]`.
 */
export function splitCommandSegments(command: string): CommandSegment[] {
  if (!command || !command.trim()) return []
  const out: CommandSegment[] = []
  collect(command, out, 0)
  return out
}
