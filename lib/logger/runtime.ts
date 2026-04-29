import type { Logger, LogOrigin, LogRuntime } from "./types"

const VALID_RUNTIMES: ReadonlySet<LogRuntime> = new Set([
  "browser",
  "server",
  "tauri",
  "mcp",
  "plugin",
  "internal",
  "unknown",
])

const VALID_ORIGINS: ReadonlySet<LogOrigin> = new Set([
  "frontend",
  "web-runtime",
  "tauri",
  "mcp",
  "plugin",
  "diagnostic",
  "unknown",
])

export interface LogRuntimeContextOptions extends Record<string, unknown> {
  runtime: LogRuntime
  origin: LogOrigin
  tags?: string[]
}

export function normalizeLogRuntime(value: unknown): LogRuntime | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim().toLowerCase() as LogRuntime
  return VALID_RUNTIMES.has(normalized) ? normalized : "unknown"
}

export function normalizeLogOrigin(value: unknown): LogOrigin | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim().toLowerCase() as LogOrigin
  return VALID_ORIGINS.has(normalized) ? normalized : "unknown"
}

export function createLogRuntimeContext(
  options: LogRuntimeContextOptions
): Record<string, unknown> {
  const { runtime, origin, tags = [], ...rest } = options

  return {
    runtime,
    origin,
    tags: Array.from(new Set([`runtime:${runtime}`, `source:${origin}`, ...tags])),
    ...rest,
  }
}

export function withLogRuntimeContext(logger: Logger, options: LogRuntimeContextOptions): Logger {
  return logger.withContext(createLogRuntimeContext(options))
}
