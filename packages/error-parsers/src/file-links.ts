/** File locations shared by terminal link detection and structured error parsing. */

export interface FileLinkMatch {
  /** 0-based start index of the whole match within the line. */
  start: number
  /** Length of the matched substring (path + optional location). */
  length: number
  /** The file path portion (no `:line:col`). */
  path: string
  /** 1-based line number, or null when the match carried no location. */
  line: number | null
  /** 1-based column, or null. */
  column: number | null
}

// A path must contain at least one separator + a file extension. Requiring
// a separator keeps us from linkifying ordinary words like "version.1".
// Supported prefixes: drive (C:\), absolute (/), relative (./ ../), home
// (~/), or a bare segment that is followed by more separated segments.
const PATH = String.raw`(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/]|~[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)+\.[A-Za-z0-9]+`
// Location suffix: `:line[:col]` or tsc's `(line,col)`.
const LOC = String.raw`(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?`
const LINK_RE = new RegExp(PATH + LOC, "g")

/** Scan one terminal line for file links. Returns matches in order. */
export function matchFileLinks(line: string): FileLinkMatch[] {
  if (!line) return []
  const out: FileLinkMatch[] = []
  LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(line)) !== null) {
    const whole = m[0]
    // Group 1/2 = colon form line/col; group 3/4 = paren form line/col.
    const lineStr = m[1] ?? m[3] ?? null
    const colStr = m[2] ?? m[4] ?? null
    // Strip the location suffix from the path portion.
    let path = whole
    if (lineStr != null) {
      const cut = m[1] != null ? whole.lastIndexOf(":" + lineStr) : whole.lastIndexOf("(")
      if (cut > 0) path = whole.slice(0, cut)
    }
    out.push({
      start: m.index,
      length: whole.length,
      path,
      line: lineStr != null ? Number(lineStr) : null,
      column: colStr != null ? Number(colStr) : null,
    })
    // Guard against zero-length matches (shouldn't happen given the regex).
    if (LINK_RE.lastIndex === m.index) LINK_RE.lastIndex++
  }
  return out
}
