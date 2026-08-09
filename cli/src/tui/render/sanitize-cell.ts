import type { Cell } from "../state/types"
import { sanitizeTerminalText } from "./terminal-block"

const cache = new WeakMap<object, Cell>()

function sanitizeValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return sanitizeTerminalText(value)
  if (value === null || typeof value !== "object") return value
  const cached = seen.get(value)
  if (cached) return cached
  if (Array.isArray(value)) {
    const next: unknown[] = []
    seen.set(value, next)
    for (const item of value) next.push(sanitizeValue(item, seen))
    return next
  }
  const next: Record<string, unknown> = {}
  seen.set(value, next)
  for (const [key, item] of Object.entries(value)) next[key] = sanitizeValue(item, seen)
  return next
}

/** Sanitize every untrusted string before Ink receives it. Cell objects are
 * immutable reducer values, so a WeakMap avoids repeating the deep walk. */
export function sanitizeCell(cell: Cell): Cell {
  const existing = cache.get(cell)
  if (existing) return existing
  const sanitized = sanitizeValue(cell, new WeakMap()) as Cell
  cache.set(cell, sanitized)
  return sanitized
}
