/**
 * Shared parser for the `tauri::generate_handler![...]` registration block in
 * `src-tauri/src/lib.rs`.
 *
 * Extracted from check-silent-failure-flags.mjs so every gate that needs the
 * registered-command set (silent-failure flags, invoke↔handler parity) parses
 * it the same way. Regex + bracket-counting, no full Rust parser: the block
 * extractor tracks strings, line comments, and block comments so a `)`/`]`
 * inside a comment (e.g. `(ADR-0022)`) can't truncate the block.
 */

/**
 * Return the raw text between the opening and closing bracket of the
 * `generate_handler!` macro invocation. Throws when the macro is absent or
 * the brackets never balance — both mean the caller's source assumptions are
 * stale and the gate must fail loudly rather than pass on an empty set.
 */
export function extractGenerateHandlerBlock(src) {
  const markerRe = /generate_handler!\s*(\[|\()/g
  const marker = markerRe.exec(src)
  if (!marker) {
    throw new Error(
      "Could not locate generate_handler!(...) — the script's source assumptions are stale."
    )
  }
  const open = marker[1]
  const close = open === "[" ? "]" : ")"
  let depth = 1
  let cursor = marker.index + marker[0].length
  // Track quotes/line-comments/block-comments so bracket-counting isn't fooled
  // by a `)` or `]` inside a string or comment.
  let inStr = false
  let strQuote = ""
  let inLine = false
  let inBlock = false
  while (cursor < src.length && depth > 0) {
    const ch = src[cursor]
    const next = src[cursor + 1]
    if (inLine) {
      if (ch === "\n") inLine = false
    } else if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        cursor += 1
      }
    } else if (inStr) {
      if (ch === "\\") {
        cursor += 1
      } else if (ch === strQuote) {
        inStr = false
      }
    } else if (ch === "/" && next === "/") {
      inLine = true
      cursor += 1
    } else if (ch === "/" && next === "*") {
      inBlock = true
      cursor += 1
    } else if (ch === '"' || ch === "'") {
      inStr = true
      strQuote = ch
    } else if (ch === open) {
      depth += 1
    } else if (ch === close) {
      depth -= 1
      if (depth === 0) break
    }
    cursor += 1
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced ${open}…${close} in generate_handler! starting at ${marker.index}`)
  }
  return src.slice(marker.index + marker[0].length, cursor)
}

/** Strip `//` line comments and `/* *\/` block comments from macro-entry text. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

/**
 * All command names registered through `generate_handler!`: entries may be
 * bare identifiers (`claude_set_api_key`) or path-qualified
 * (`claude::commands::claude_send`) — the registered name is always the last
 * `::` segment.
 */
export function parseRegisteredCommands(src) {
  const block = stripComments(extractGenerateHandlerBlock(src))
  const commands = new Set()
  for (const raw of block.split(",")) {
    const entry = raw.trim()
    if (entry === "") continue
    const m = entry.match(/^(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)$/)
    if (m) commands.add(m[1])
  }
  return commands
}
