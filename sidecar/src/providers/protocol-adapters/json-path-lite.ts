// Minimal JSON-path getter for declarative protocol adapters: dot segments
// and numeric brackets only (`choices[0].delta.content`). No wildcards, no
// filters, no eval — specs are plugin-supplied DATA and must stay inert.

/** Segments of a path like "choices[0].delta.content"; null when malformed. */
export function parsePath(path: unknown): (string | number)[] | null {
  if (typeof path !== "string" || path.length === 0) return null
  const segments: (string | number)[] = []
  // Split "a.b[0].c" into identifiers and bracket indices.
  const re = /([^.[\]]+)|\[(\d+)\]/g
  let consumed = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(path)) !== null) {
    if (m.index > consumed && path.slice(consumed, m.index) !== ".") return null
    if (m[1] !== undefined) segments.push(m[1])
    else segments.push(Number(m[2]))
    consumed = re.lastIndex
  }
  if (consumed !== path.length || segments.length === 0) return null
  return segments
}

/** Resolve `path` against `obj`; returns undefined on any miss. */
export function getPath(obj: unknown, path: string): unknown {
  const segments = parsePath(path)
  if (!segments) return undefined
  let cur: unknown = obj
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined
      cur = (cur as unknown[])[seg]
    } else {
      if (typeof cur !== "object") return undefined
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return cur
}
