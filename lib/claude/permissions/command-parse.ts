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

/** Redirect operators that CREATE OR APPEND TO a file. */
const WRITE_OPS = new Set([">", ">>", ">|", "&>", "&>>"])

/** One `>`/`<`-family redirect pulled out of a segment. */
export interface CommandRedirect {
  /** The operator text, e.g. `>`, `>>`, `2>`'s `>`, `&>`, `<`, `<&`. */
  op: string
  /** Explicit file descriptor prefix (`2>` → `"2"`), when one was written. */
  fd?: string
  /**
   * Redirect target as written, quotes removed. `undefined` when the operator
   * ended the segment with nothing after it (a syntax error we do not judge).
   * For descriptor duplication (`2>&1`) this is the descriptor, e.g. `"1"`.
   */
  target?: string
  /** True for `>&`/`<&` — the target names a descriptor, not a path. */
  duplicatesDescriptor: boolean
  /** True when the operator writes (see {@link WRITE_OPS}). */
  writes: boolean
}

export interface CommandSegment {
  /** Head executable, path-stripped + lowercased + `.exe`-stripped. */
  head: string
  /** The raw segment text (trimmed) before substitution extraction. */
  raw: string
  /** Argument tokens after the head (quote-aware, quotes removed). */
  args: string[]
  /**
   * Redirects found in this segment, in written order. They are NOT in
   * `args` — before this existed a `curl x > /usr/local/bin/y` classified as
   * a read-only fetch, because the write was invisible to the classifier.
   */
  redirects: CommandRedirect[]
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
  // A backslash means one of two incompatible things, and guessing wrong is
  // exploitable in one direction and merely annoying in the other. In a POSIX
  // shell `r\m` is `rm` — an escape, and a way to slip past a head-name
  // classifier. On Windows `C:\Windows\System32\cmd.exe` is a path.
  // Decide by shape: it is a separator only when the token already looks like
  // a path (contains `/`, or starts with a drive letter). Otherwise it is an
  // escape and comes out, so `r\m`, `\rm` and `rm` all normalise alike.
  const looksLikePath = t.includes("/") || /^[A-Za-z]:[\\/]/.test(t)
  if (looksLikePath) {
    const parts = t.split(/[\\/]/)
    t = parts[parts.length - 1] ?? t
  } else {
    t = t.replace(/\\(.)/g, "$1")
  }
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
    // `&>` / `&>>` redirect both streams, and `>&` / `<&` duplicate a
    // descriptor. In all three the `&` belongs to the redirect, not to the
    // command list — splitting there invented a phantom segment, so plain
    // `echo hi 2>&1` used to parse as `echo hi` plus a command named `1`.
    if (c === "&" && (next === ">" || /[<>]$/.test(cur))) {
      cur += c
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

/** One lexical unit: a plain word, or a redirect operator. */
type ParsedToken = { kind: "word"; text: string } | { kind: "op"; op: string; fd?: string }

/** Decode one `$'...'` ANSI-C span starting at the `$`. */
function readAnsiCQuote(segment: string, start: number): { text: string; next: number } {
  let out = ""
  let i = start + 2 // skip `$'`
  while (i < segment.length && segment[i] !== "'") {
    if (segment[i] !== "\\") {
      out += segment[i]
      i++
      continue
    }
    const esc = segment[i + 1]
    i += 2
    switch (esc) {
      case "n":
        out += "\n"
        break
      case "t":
        out += "\t"
        break
      case "r":
        out += "\r"
        break
      case "a":
        out += "\x07"
        break
      case "b":
        out += "\b"
        break
      case "f":
        out += "\f"
        break
      case "v":
        out += "\v"
        break
      case "e":
        out += "\x1b"
        break
      case "\\":
        out += "\\"
        break
      case "'":
        out += "'"
        break
      case '"':
        out += '"'
        break
      case "x": {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(segment.slice(i))?.[0]
        if (hex) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += hex.length
        } else out += "x"
        break
      }
      case "u": {
        const hex = /^[0-9a-fA-F]{1,4}/.exec(segment.slice(i))?.[0]
        if (hex) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += hex.length
        } else out += "u"
        break
      }
      default: {
        if (esc !== undefined && esc >= "0" && esc <= "7") {
          const oct = /^[0-7]{0,2}/.exec(segment.slice(i))?.[0] ?? ""
          out += String.fromCharCode(parseInt(esc + oct, 8))
          i += oct.length
        } else if (esc !== undefined) {
          out += esc
        }
      }
    }
  }
  return { text: out, next: i + 1 } // skip the closing `'`
}

/** Longest redirect operator starting at `i`, or null. */
function readRedirectOp(segment: string, i: number): string | null {
  for (const op of ["&>>", "&>", "<<<", "<<", ">>", ">|", ">&", "<&", "<>", ">", "<"]) {
    if (segment.startsWith(op, i)) return op
  }
  return null
}

/**
 * Quote-aware tokenizer. Quotes are consumed and their contents kept;
 * `$'...'` is ANSI-C decoded (so `$'\x72\x6d'` is the word `rm`, not the
 * literal `$\x72\x6d`); redirect operators become their own tokens so the
 * caller can tell `curl x > file` from `curl x file`.
 *
 * Backslashes are deliberately LEFT IN the token text. Whether `\` escapes
 * the next character or separates a Windows path depends on the shell, and
 * only the head has enough shape to decide — see {@link normalizeHead}.
 */
function tokenize(segment: string): ParsedToken[] {
  const tokens: ParsedToken[] = []
  let cur = ""
  let has = false
  let inSingle = false
  let inDouble = false
  const flushWord = () => {
    if (has) tokens.push({ kind: "word", text: cur })
    cur = ""
    has = false
  }
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
    if (c === "$" && segment[i + 1] === "'") {
      const { text, next } = readAnsiCQuote(segment, i)
      cur += text
      has = true
      i = next - 1
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
    const op = readRedirectOp(segment, i)
    if (op) {
      // A bare numeric prefix is the descriptor being redirected (`2>`), not
      // a word of its own — but only for `<`/`>` forms, never for `&>`.
      let fd: string | undefined
      if (!op.startsWith("&") && has && /^\d+$/.test(cur)) {
        fd = cur
        cur = ""
        has = false
      }
      flushWord()
      tokens.push({ kind: "op", op, ...(fd ? { fd } : {}) })
      i += op.length - 1
      continue
    }
    if (/\s/.test(c)) {
      flushWord()
      continue
    }
    cur += c
    has = true
  }
  flushWord()
  return tokens
}

/**
 * Rewrite a command into the single spelling the shell would actually run:
 * quotes removed, `$'...'` decoded, backslash escapes applied, whitespace
 * runs collapsed. `r\\m  -rf  /x`, `"rm" -rf /x` and `$'\\x72\\x6d' -rf /x`
 * all canonicalise to `rm -rf /x`.
 *
 * This exists so a user-authored DENY rule cannot be sidestepped by respelling
 * the command. It is only ever safe as a deny probe, never as an allow one:
 * an unquoted Windows path (`type C:\\a\\b`) canonicalises to nonsense
 * (`type C:ab`), which can fail to match a rule but must never be allowed to
 * satisfy one. See `resolveBashPermission`, and its sidecar mirror in
 * `sidecar/dispatch/permission-resolver.mjs`, which must stay identical —
 * `ruleset.sidecar-parity.test.ts` pins that.
 */
export function canonicalizeCommand(command: string): string {
  const text = command ?? ""
  let out = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      else out += c
      continue
    }
    if (inDouble) {
      if (c === "\\" && text[i + 1] !== undefined && '$`"\\'.includes(text[i + 1])) {
        out += text[i + 1]
        i++
      } else if (c === '"') inDouble = false
      else out += c
      continue
    }
    if (c === "$" && text[i + 1] === "'") {
      const { text: decoded, next } = readAnsiCQuote(text, i)
      out += decoded
      i = next - 1
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
    if (c === "\\" && text[i + 1] !== undefined) {
      out += text[i + 1]
      i++
      continue
    }
    out += c
  }
  return out.replace(/\s+/g, " ").trim()
}

function collect(command: string, out: CommandSegment[], depth: number): void {
  if (depth > MAX_DEPTH) return
  for (const raw of splitTopLevel(command)) {
    const { inner, stripped } = extractSubstitutions(raw)
    const tokens = tokenize(stripped)

    // Split the stream into words and redirects. A redirect takes the next
    // WORD as its target, so it is consumed here and never reaches `args`.
    const words: string[] = []
    const redirects: CommandRedirect[] = []
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.kind === "word") {
        words.push(token.text)
        continue
      }
      const next = tokens[i + 1]
      const target = next?.kind === "word" ? next.text : undefined
      if (target !== undefined) i++
      redirects.push({
        op: token.op,
        ...(token.fd ? { fd: token.fd } : {}),
        ...(target !== undefined ? { target } : {}),
        duplicatesDescriptor: token.op === ">&" || token.op === "<&",
        writes: WRITE_OPS.has(token.op),
      })
    }

    let idx = 0
    while (idx < words.length && (words[idx] === "" || ENV_ASSIGN.test(words[idx]))) idx++
    const headToken = words[idx]
    if (headToken !== undefined) {
      const head = normalizeHead(headToken)
      if (head) out.push({ head, raw: raw.trim(), args: words.slice(idx + 1), redirects })
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
