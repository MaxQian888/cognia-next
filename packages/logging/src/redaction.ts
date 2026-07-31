import type { LoggerRedactionConfig, StructuredLogEntry } from "./types"

const compiledPatternCache = new WeakMap<LoggerRedactionConfig, RegExp[]>()

function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
}

function shouldRedactKey(key: string, config: LoggerRedactionConfig): boolean {
  const normalized = normalizeKey(key)
  return config.redactKeys.some((candidate) => {
    const target = normalizeKey(candidate)
    return normalized === target || normalized.includes(target)
  })
}

function buildPatterns(config: LoggerRedactionConfig): RegExp[] {
  const cached = compiledPatternCache.get(config)
  if (cached) {
    return cached
  }

  const patterns = config.redactPatterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, "gi")
      } catch {
        return null
      }
    })
    .filter((pattern): pattern is RegExp => pattern instanceof RegExp)
  compiledPatternCache.set(config, patterns)
  return patterns
}

function redactText(value: string, config: LoggerRedactionConfig, patterns: RegExp[]): string {
  return patterns.reduce((current, pattern) => current.replace(pattern, config.replacement), value)
}

function redactValue(
  value: unknown,
  config: LoggerRedactionConfig,
  patterns: RegExp[],
  depth: number,
  seen: WeakSet<object>,
  keyHint?: string
): unknown {
  if (keyHint && shouldRedactKey(keyHint, config)) {
    return config.replacement
  }

  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === "string") {
    return redactText(value, config, patterns)
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (depth >= config.maxDepth) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, config, patterns, depth + 1, seen))
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) {
      return config.replacement
    }
    seen.add(value as object)

    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(nested, config, patterns, depth + 1, seen, key)
    }
    return out
  }

  return value
}

export function redactStructuredLogEntry(
  entry: StructuredLogEntry,
  config: LoggerRedactionConfig
): StructuredLogEntry {
  if (!config.enabled) {
    return entry
  }

  const patterns = buildPatterns(config)
  const seen = new WeakSet<object>()

  return {
    ...entry,
    message: redactText(entry.message, config, patterns),
    stack: entry.stack ? redactText(entry.stack, config, patterns) : entry.stack,
    data:
      entry.data === undefined
        ? undefined
        : (redactValue(entry.data, config, patterns, 0, seen) as Record<string, unknown>),
  }
}
