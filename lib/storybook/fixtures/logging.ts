// Fixture builders for logging-component stories.
//
// `makeLogEntry` produces a realistic `StructuredLogEntry`; `makeLogStream`
// returns a connected, time-spread batch that exercises every level, a couple
// of trace groups, and entries with `data` / `stack` / `source` so the panel,
// timeline, dashboard, trace-view, and detail components all render meaningful
// content. Times are relative to an injectable `now`.
import type { StructuredLogEntry } from "@cognia/logging"
import type { LogLevel } from "@cognia/logging/types/log-level"

const MIN = 60_000

const MODULES = ["network:lark", "agent:team", "workflow", "plugin:web-tools", "ui:chat"] as const
const LEVELS: readonly LogLevel[] = ["info", "debug", "warn", "error", "trace"]

let logSeq = 0

/** A single valid log entry with realistic defaults; spread `over` to vary. */
export function makeLogEntry(over: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  logSeq += 1
  const id = over.id ?? `log-${logSeq}`
  return {
    id,
    timestamp: over.timestamp ?? new Date(Date.now() - 2 * MIN).toISOString(),
    level: "info",
    message: "Request completed in 142ms",
    module: "network:lark",
    ...over,
  }
}

/**
 * A batch of `count` entries spread across the last ~30 minutes, cycling
 * through levels and modules, with two trace groups, plus an error entry that
 * carries a stack trace and a debug entry that carries structured `data`.
 */
export function makeLogStream(count = 40, now: number = Date.now()): StructuredLogEntry[] {
  logSeq = 0
  const entries: StructuredLogEntry[] = []
  for (let i = 0; i < count; i++) {
    const level = LEVELS[i % LEVELS.length]
    const mod = MODULES[i % MODULES.length]
    const traceId =
      i % 4 === 0 ? `trace-${String(Math.floor(i / 4) % 3).padStart(2, "0")}aa11bb` : undefined
    entries.push(
      makeLogEntry({
        id: `log-${i + 1}`,
        timestamp: new Date(now - (count - i) * 45_000).toISOString(),
        level,
        module: mod,
        message:
          level === "error"
            ? `Failed to deliver message to channel #${i}`
            : level === "warn"
              ? `Retrying request (attempt ${1 + (i % 3)})`
              : `Handled event ${i} on ${mod}`,
        traceId,
        sessionId: i % 5 === 0 ? "story-session" : undefined,
        ...(level === "error"
          ? {
              stack:
                "Error: Sandbox timed out after 30s\n    at execute (lib/sandbox.ts:88:12)\n    at runTool (lib/agent/run.ts:142:7)",
            }
          : {}),
        ...(level === "debug"
          ? { data: { latencyMs: 120 + i, retries: i % 3, endpoint: "/v1/messages" } }
          : {}),
      })
    )
  }
  return entries
}
