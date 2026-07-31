/**
 * Convert a 1-based line / 0-based column pair (the shape Babel reports in
 * `error.loc`) into a 0-based document offset. Clamps to the document bounds so
 * a bad position can never produce an out-of-range CM range.
 */
export function lineColToOffset(text: string, line: number, column: number): number {
  if (line <= 1) return clamp(column, text.length)
  let offset = 0
  let remaining = line - 1
  for (let i = 0; i < text.length && remaining > 0; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      remaining--
      offset = i + 1
    }
  }
  // If we ran out of lines before reaching `line`, `offset` sits at the last
  // line start we found; adding the column still clamps to the doc end.
  return clamp(offset + Math.max(0, column), text.length)
}

function clamp(value: number, max: number): number {
  if (value < 0) return 0
  if (value > max) return max
  return value
}
