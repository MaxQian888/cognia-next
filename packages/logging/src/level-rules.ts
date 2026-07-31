/**
 * Per-module log-level resolution.
 *
 * A module name is a `:`-separated hierarchy (e.g. `network:lark:handshake`,
 * produced by `logger.child(...)`). A rule set maps a module prefix to a minimum
 * level; the most specific (longest) matching prefix wins, otherwise the global
 * minimum level applies.
 *
 * Resolution is memoized per module name. The cache auto-invalidates when either
 * the rules object reference or the global fallback changes, so callers normally
 * don't need to clear it; `clearLevelRuleCache()` exists for explicit resets
 * (e.g. when rules are mutated in place).
 */
import type { LogLevel } from "./types"

const HIERARCHY_SEPARATOR = ":"

let cachedRules: Record<string, LogLevel> | null = null
let cachedGlobal: LogLevel | null = null
const cache = new Map<string, LogLevel>()

export function clearLevelRuleCache(): void {
  cache.clear()
  cachedRules = null
  cachedGlobal = null
}

/**
 * Resolve the effective minimum level for `module` given `rules` and the
 * `globalMinLevel` fallback.
 */
export function resolveMinLevel(
  module: string,
  rules: Record<string, LogLevel>,
  globalMinLevel: LogLevel
): LogLevel {
  if (rules !== cachedRules || globalMinLevel !== cachedGlobal) {
    cache.clear()
    cachedRules = rules
    cachedGlobal = globalMinLevel
  }

  const cached = cache.get(module)
  if (cached !== undefined) {
    return cached
  }

  const resolved = computeMinLevel(module, rules, globalMinLevel)
  cache.set(module, resolved)
  return resolved
}

function computeMinLevel(
  module: string,
  rules: Record<string, LogLevel>,
  globalMinLevel: LogLevel
): LogLevel {
  const segments = module.split(HIERARCHY_SEPARATOR)
  // Walk from the most specific prefix to the least specific.
  for (let end = segments.length; end > 0; end--) {
    const prefix = segments.slice(0, end).join(HIERARCHY_SEPARATOR)
    if (prefix.trim().length === 0) {
      continue
    }
    const level = rules[prefix]
    if (level !== undefined) {
      return level
    }
  }
  return globalMinLevel
}
