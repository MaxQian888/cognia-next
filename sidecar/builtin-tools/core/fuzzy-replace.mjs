// Multi-strategy string replacement for the core edit tools, modelled on
// opencode's replacer cascade. Strategies run in order; the first one that
// produces a UNIQUE match (or any matches with `replaceAll`) wins:
//   1. exact          — direct indexOf match
//   2. line-trimmed   — per-line comparison ignoring leading/trailing blanks
//   3. whitespace     — all whitespace runs collapsed to single spaces
//   4. indentation    — common leading indentation stripped per block
//   5. block-anchor   — first+last lines anchor, middle judged by Levenshtein
//                       similarity ≥ 0.65
//
// Weak models (the ai-sdk path's main population) routinely emit old_string
// with whitespace drift; the cascade turns those near-misses into successful
// edits instead of `not_found` loops.

const BLOCK_ANCHOR_THRESHOLD = 0.65

export class ReplaceError extends Error {
  /** @param {"not_found"|"not_unique"} code  @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Levenshtein similarity in [0,1]. Exported for tests. */
export function similarity(a, b) {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const m = a.length
  const n = b.length
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return 1 - prev[n] / Math.max(m, n)
}

/** Find every index where `needle` occurs in `haystack`. */
function allIndices(haystack, needle) {
  const out = []
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    out.push(i)
    i = haystack.indexOf(needle, i + 1)
  }
  return out
}

/**
 * Match on lines: returns char ranges in `content` whose trimmed lines equal
 * the trimmed lines of `needle` (same line count).
 */
function lineMatches(content, needle, normalize) {
  const contentLines = content.split("\n")
  const needleLines = needle.split("\n")
  // Trim trailing blank needle lines that often sneak in.
  while (needleLines.length > 1 && needleLines[needleLines.length - 1].trim() === "") {
    needleLines.pop()
  }
  if (needleLines.length === 0) return []
  const normNeedle = needleLines.map(normalize)
  const ranges = []
  // Precompute char offsets per line start.
  const offsets = new Array(contentLines.length)
  let acc = 0
  for (let i = 0; i < contentLines.length; i++) {
    offsets[i] = acc
    acc += contentLines[i].length + 1
  }
  outer: for (let i = 0; i + needleLines.length <= contentLines.length; i++) {
    for (let j = 0; j < needleLines.length; j++) {
      if (normalize(contentLines[i + j]) !== normNeedle[j]) continue outer
    }
    const start = offsets[i]
    const lastIdx = i + needleLines.length - 1
    const end = offsets[lastIdx] + contentLines[lastIdx].length
    ranges.push({ start, end })
  }
  return ranges
}

/** Strategy 4 normalizer factory: strip the block's minimum indentation. */
function stripMinIndent(lines) {
  let min = Infinity
  for (const l of lines) {
    if (l.trim().length === 0) continue
    const indent = l.match(/^[ \t]*/)[0].length
    if (indent < min) min = indent
  }
  if (!Number.isFinite(min) || min === 0) return lines
  return lines.map((l) => (l.trim().length === 0 ? l : l.slice(min)))
}

/** Strategy 5: anchor on first+last needle lines, score the middle. */
function blockAnchorMatches(content, needle) {
  const needleLines = needle.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""))
  if (needleLines.length < 3) return []
  const first = needleLines[0].trim()
  const last = needleLines[needleLines.length - 1].trim()
  const middle = needleLines
    .slice(1, -1)
    .map((l) => l.trim())
    .join("\n")
  const contentLines = content.split("\n")
  const offsets = new Array(contentLines.length)
  let acc = 0
  for (let i = 0; i < contentLines.length; i++) {
    offsets[i] = acc
    acc += contentLines[i].length + 1
  }
  const ranges = []
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== first) continue
    for (let k = i + 2; k < Math.min(contentLines.length, i + needleLines.length * 2 + 4); k++) {
      if (contentLines[k].trim() !== last) continue
      const candMiddle = contentLines
        .slice(i + 1, k)
        .map((l) => l.trim())
        .join("\n")
      if (similarity(candMiddle, middle) >= BLOCK_ANCHOR_THRESHOLD) {
        ranges.push({ start: offsets[i], end: offsets[k] + contentLines[k].length })
      }
      break // nearest closing anchor only
    }
  }
  return ranges
}

/**
 * Replace `oldString` with `newString` in `content`.
 *
 * @param {string} content
 * @param {string} oldString
 * @param {string} newString
 * @param {boolean} [replaceAll=false]
 * @returns {{ content: string, matched: string, count: number }}
 * @throws {ReplaceError} `not_found` when no strategy matches; `not_unique`
 *   when multiple matches exist and `replaceAll` is false.
 */
export function replaceWithFallback(content, oldString, newString, replaceAll = false) {
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new ReplaceError("not_found", "old_string must be a non-empty string")
  }
  if (oldString === newString) {
    throw new ReplaceError("not_found", "old_string and new_string are identical")
  }

  // Strategy 1: exact.
  {
    const idx = allIndices(content, oldString)
    if (idx.length === 1 || (replaceAll && idx.length > 0)) {
      return applyAtIndices(content, idx, oldString.length, newString, "exact", replaceAll)
    }
    if (idx.length > 1) {
      throw new ReplaceError(
        "not_unique",
        `old_string matches ${idx.length} locations. Provide more surrounding context to make it unique, or pass replace_all=true.`
      )
    }
  }

  // Line-based strategies (2–4). Only a UNIQUE match is trusted; fuzzy
  // replace-all would be reckless.
  const strategies = [
    ["line-trimmed", (l) => l.trim()],
    ["whitespace-normalized", (l) => l.replace(/\s+/g, " ").trim()],
  ]
  for (const [name, normalize] of strategies) {
    const ranges = lineMatches(content, oldString, normalize)
    if (ranges.length === 1) {
      return applyAtRanges(content, ranges, newString, name)
    }
    if (ranges.length > 1 && !replaceAll) {
      throw new ReplaceError(
        "not_unique",
        `old_string fuzzy-matches ${ranges.length} locations (${name}). Provide more surrounding context.`
      )
    }
  }

  // Strategy 4: indentation-flexible — compare with min-indent stripped on
  // both sides.
  {
    const needleLines = stripMinIndent(oldString.split("\n"))
    const needle = needleLines.join("\n")
    const ranges = lineMatches(content, needle, (l) => l)
      .concat(lineMatches(content, needle, (l) => l.trimEnd()))
      .filter((r, i, arr) => arr.findIndex((x) => x.start === r.start) === i)
    let unique = ranges
    if (ranges.length === 0) {
      // Strip indent from content lines too, via the trimmed comparison above
      // — already covered by line-trimmed; nothing further here.
      unique = []
    }
    if (unique.length === 1) {
      return applyAtRanges(content, unique, newString, "indentation-flexible")
    }
  }

  // Strategy 5: block anchor.
  {
    const ranges = blockAnchorMatches(content, oldString)
    if (ranges.length === 1) {
      return applyAtRanges(content, ranges, newString, "block-anchor")
    }
    if (ranges.length > 1) {
      throw new ReplaceError(
        "not_unique",
        `old_string anchor-matches ${ranges.length} blocks. Provide more surrounding context.`
      )
    }
  }

  throw new ReplaceError(
    "not_found",
    "old_string was not found in the file (after exact and fuzzy matching). Re-read the file and copy the text exactly."
  )
}

function applyAtIndices(content, indices, oldLen, newString, matched, replaceAll) {
  const targets = replaceAll ? indices : indices.slice(0, 1)
  let out = ""
  let prev = 0
  for (const idx of targets) {
    out += content.slice(prev, idx) + newString
    prev = idx + oldLen
  }
  out += content.slice(prev)
  return { content: out, matched, count: targets.length }
}

function applyAtRanges(content, ranges, newString, matched) {
  // Ranges from a single strategy never overlap; apply in order.
  let out = ""
  let prev = 0
  for (const r of ranges) {
    out += content.slice(prev, r.start) + newString
    prev = r.end
  }
  out += content.slice(prev)
  return { content: out, matched, count: ranges.length }
}
