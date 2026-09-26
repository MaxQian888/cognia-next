// Quote- and paren-aware shell command segmentation, shared by the
// permission resolver and the interactive-command detector. Mirrors
// `splitCommandSegments` and its helpers in
// `lib/claude/permissions/command-parse.ts`; the sidecar cannot import `lib/`,
// so `lib/claude/permissions/ruleset.sidecar-parity.test.ts` pins the two.
//
// Kept free of `node:` imports and `import.meta`: the app's Jest suites
// compile it through the resolver.

/** Split a command into top-level statements, respecting quotes + paren depth. */
export function splitTopLevel(command: string): string[] {
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
export function matchParen(text: string, openIdx: number): number {
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
 * Pull `$(...)`, backtick, and `(...)` spans out of `text`. Returns their inner
 * command strings (for recursive processing) plus a `stripped` copy with each
 * span replaced by a space.
 */
export function extractSubstitutions(text: string): { inner: string[]; stripped: string } {
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
