/**
 * @jest-environment node
 */

import {
  buildCrashLogExportBundle,
  buildCrashLogItems,
  isCrashRelevantLogEntry,
  serializeCrashLogBundle,
  summarizeCrashLogItems,
  type CrashDiagnosticsSnapshot,
  type CrashLogItem,
  type CrashLogExportBundle,
} from "./crash-log"
import type { StructuredLogEntry, LogLevel } from "@/types/logging"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

function makeEntry(
  id: string,
  level: LogLevel,
  overrides: Partial<StructuredLogEntry> = {}
): StructuredLogEntry {
  return {
    id,
    timestamp: overrides.timestamp ?? "2026-04-29T00:00:00.000Z",
    level,
    message: `entry ${id}`,
    module: "test",
    runtime: "browser",
    origin: "frontend",
    ...overrides,
  }
}

function makeReadiness(
  status: NativeLoggingReadiness["status"],
  overrides: Partial<NativeLoggingReadiness> = {}
): NativeLoggingReadiness {
  return {
    runtime: "tauri",
    status,
    startupMode: status === "healthy" ? "full" : "fallback",
    startupHealth: status === "healthy" ? "healthy" : "degraded",
    activeTargets: ["stdout", "folder", "webview"],
    bridgeState: "active",
    platformLogging: {
      available: true,
      backend: "event_log",
      health: status === "healthy" ? "healthy" : "degraded",
      enabled: true,
      minLevel: "warn",
    },
    updatedAt: "2026-04-29T00:00:00.000Z",
    ...overrides,
  }
}

describe("isCrashRelevantLogEntry", () => {
  it("treats error and fatal as crash-relevant", () => {
    expect(isCrashRelevantLogEntry(makeEntry("a", "error"))).toBe(true)
    expect(isCrashRelevantLogEntry(makeEntry("b", "fatal"))).toBe(true)
  })

  it("ignores info / debug / trace", () => {
    expect(isCrashRelevantLogEntry(makeEntry("a", "info"))).toBe(false)
    expect(isCrashRelevantLogEntry(makeEntry("b", "debug"))).toBe(false)
    expect(isCrashRelevantLogEntry(makeEntry("c", "trace"))).toBe(false)
  })

  it("includes warn entries from diagnostic origin / logger.internal / transport reports", () => {
    expect(isCrashRelevantLogEntry(makeEntry("d", "warn", { origin: "diagnostic" }))).toBe(true)
    expect(isCrashRelevantLogEntry(makeEntry("e", "warn", { module: "logger.internal" }))).toBe(
      true
    )
    expect(
      isCrashRelevantLogEntry(makeEntry("f", "warn", { data: { sourceTransport: "remote" } }))
    ).toBe(true)
  })

  it("ignores plain warn entries that aren't from diagnostics", () => {
    expect(isCrashRelevantLogEntry(makeEntry("g", "warn"))).toBe(false)
  })
})

describe("buildCrashLogItems", () => {
  it("merges recent + persisted entries by id and tracks both sources", () => {
    const shared = makeEntry("dup", "error")
    const items = buildCrashLogItems({
      recentErrors: [shared, makeEntry("recent-only", "fatal")],
      persistedLogs: [shared, makeEntry("persisted-only", "error"), makeEntry("ignored", "info")],
      diagnostics: null,
    })
    const ids = items.map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(["dup", "recent-only", "persisted-only"]))
    expect(ids).not.toContain("ignored")
    const dup = items.find((i) => i.id === "dup")!
    expect(dup.sources).toEqual(["recent", "persisted"])
  })

  it("sorts newest-first; ties break by level severity", () => {
    const items = buildCrashLogItems({
      recentErrors: [
        makeEntry("a", "warn", {
          timestamp: "2026-04-29T00:00:01.000Z",
          origin: "diagnostic",
        }),
        makeEntry("b", "fatal", { timestamp: "2026-04-29T00:00:01.000Z" }),
        makeEntry("c", "error", { timestamp: "2026-04-30T00:00:00.000Z" }),
      ],
      persistedLogs: [],
      diagnostics: null,
    })
    expect(items.map((i) => i.id)).toEqual(["c", "b", "a"])
  })

  it("appends a 'diagnostic snapshot' item when native logging is degraded", () => {
    const diagnostics: CrashDiagnosticsSnapshot = {
      capturedAt: "2026-04-29T00:00:00.000Z",
      nativeLogging: makeReadiness("degraded", {
        fallbackReason: { code: "x", message: "stdout-only" },
      }),
      windowDiagnostics: null,
      localRuntimeDiagnostics: null,
      logDirectoryPath: null,
      diagnosticsError: null,
    }
    const items = buildCrashLogItems({
      recentErrors: [],
      persistedLogs: [],
      diagnostics,
    })
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("crash:diagnostic-snapshot")
    expect(items[0].sources).toEqual(["diagnostic"])
    expect(items[0].level).toBe("warn")
    expect(items[0].summary).toBe("stdout-only")
  })

  it("skips the diagnostic snapshot when everything is healthy", () => {
    const diagnostics: CrashDiagnosticsSnapshot = {
      capturedAt: "2026-04-29T00:00:00.000Z",
      nativeLogging: makeReadiness("healthy"),
      windowDiagnostics: null,
      localRuntimeDiagnostics: null,
      logDirectoryPath: null,
      diagnosticsError: null,
    }
    const items = buildCrashLogItems({
      recentErrors: [],
      persistedLogs: [],
      diagnostics,
    })
    expect(items).toHaveLength(0)
  })

  it("derives summary from stack trace first line, then errorMessage, then message", () => {
    const items = buildCrashLogItems({
      recentErrors: [
        makeEntry("withStack", "error", {
          message: "Boom",
          stack: "Error: deep boom\n    at fn",
        }),
        makeEntry("withErrorMessage", "error", {
          message: "Wrapped",
          data: { errorMessage: "Underlying cause" },
        }),
        makeEntry("plain", "error", { message: "Just a message" }),
      ],
      persistedLogs: [],
      diagnostics: null,
    })
    const byId = Object.fromEntries(items.map((i) => [i.id, i.summary]))
    expect(byId.withStack).toBe("Error: deep boom")
    expect(byId.withErrorMessage).toBe("Underlying cause")
    expect(byId.plain).toBe("Just a message")
  })
})

describe("summarizeCrashLogItems", () => {
  it("aggregates per-level + per-source counts and surfaces native status", () => {
    const items: CrashLogItem[] = [
      {
        id: "a",
        title: "x",
        summary: "x",
        timestamp: "2026-04-29T00:00:00.000Z",
        level: "error",
        module: "auth",
        sources: ["recent"],
      },
      {
        id: "b",
        title: "x",
        summary: "x",
        timestamp: "2026-04-29T00:00:00.000Z",
        level: "fatal",
        module: "auth",
        sources: ["recent", "persisted"],
      },
      {
        id: "c",
        title: "x",
        summary: "x",
        timestamp: "2026-04-29T00:00:00.000Z",
        level: "warn",
        module: "ui",
        sources: ["diagnostic"],
      },
    ]
    const summary = summarizeCrashLogItems(items, {
      capturedAt: "now",
      nativeLogging: makeReadiness("degraded"),
      windowDiagnostics: null,
      localRuntimeDiagnostics: null,
      logDirectoryPath: null,
      diagnosticsError: null,
    })
    expect(summary.total).toBe(3)
    expect(summary.byLevel.error).toBe(1)
    expect(summary.byLevel.fatal).toBe(1)
    expect(summary.byLevel.warn).toBe(1)
    expect(summary.bySource).toEqual({ recent: 2, persisted: 1, diagnostic: 1 })
    expect(summary.nativeLoggingStatus).toBe("degraded")
  })

  it("falls back to 'unavailable' when there are no diagnostics", () => {
    expect(summarizeCrashLogItems([], null).nativeLoggingStatus).toBe("unavailable")
  })
})

describe("buildCrashLogExportBundle", () => {
  it("redacts file-system paths, URLs, and key-hint values in the bundle", () => {
    const items = buildCrashLogItems({
      recentErrors: [
        makeEntry("with-path", "error", {
          message: "open failed at C:\\Users\\alice\\app\\config.json with Bearer abcdefghijklmnop",
          stack: "Error: ENOENT\n    at open (/Users/alice/app/index.js:10)",
          data: {
            path: "C:\\Users\\alice\\app",
            url: "https://example.com/keys",
            user: "alice",
          },
        }),
      ],
      persistedLogs: [],
      diagnostics: null,
    })
    const bundle = buildCrashLogExportBundle({
      items,
      diagnostics: null,
      exportedAt: "2026-04-29T00:00:00.000Z",
      filters: { source: "all", level: "all", search: "" },
    })
    const exported = bundle.items[0]
    expect(exported.title).not.toContain("alice")
    expect(exported.title).not.toContain("Bearer abcdefghijklmnop")
    expect(exported.summary).not.toContain("alice")
    const data = exported.logEntry?.data as Record<string, unknown>
    expect(data.path).toBe("[REDACTED]")
    expect(data.url).toBe("[REDACTED]")
    expect(data.user).toBe("alice") // 'user' is not in SAFE_KEY_HINTS
  })
})

describe("serializeCrashLogBundle", () => {
  function makeBundle(items: CrashLogItem[] = []): CrashLogExportBundle {
    return {
      exportedAt: "2026-04-29T00:00:00.000Z",
      filters: { source: "all", level: "all", search: "" },
      diagnostics: null,
      items,
    }
  }

  const sampleItem: CrashLogItem = {
    id: "x",
    title: "Boom",
    summary: "Boom at fn",
    timestamp: "2026-04-29T01:02:03.000Z",
    level: "error",
    module: "test",
    sources: ["recent"],
    logEntry: makeEntry("x", "error", { message: "Boom" }),
  }

  it("defaults to the 'bundle' format with cognia-crash-bundle filename + full JSON payload", () => {
    const result = serializeCrashLogBundle(makeBundle([sampleItem]))
    expect(result.filename).toMatch(/^cognia-crash-bundle-\d{4}-\d{2}-\d{2}\.json$/)
    expect(result.mimeType).toBe("application/json")
    const parsed = JSON.parse(result.content)
    expect(parsed.items[0].id).toBe("x")
    expect(parsed.exportedAt).toBe("2026-04-29T00:00:00.000Z")
  })

  it("'json' format emits cognia-crash-logs JSON with logEntry payloads only", () => {
    const result = serializeCrashLogBundle(makeBundle([sampleItem]), "json")
    expect(result.filename).toMatch(/^cognia-crash-logs-\d{4}-\d{2}-\d{2}\.json$/)
    expect(result.mimeType).toBe("application/json")
    const parsed = JSON.parse(result.content) as Array<Record<string, unknown>>
    expect(parsed[0].id).toBe("x")
    expect(parsed[0].message).toBe("Boom")
    expect(parsed[0]).not.toHaveProperty("sources")
  })

  it("'text' format emits a plain log-line summary", () => {
    const result = serializeCrashLogBundle(makeBundle([sampleItem]), "text")
    expect(result.filename).toMatch(/^cognia-crash-logs-\d{4}-\d{2}-\d{2}\.txt$/)
    expect(result.mimeType).toBe("text/plain")
    expect(result.content).toContain("[ERROR]")
    expect(result.content).toContain("test")
    expect(result.content).toContain("Boom")
  })

  it("handles items without a logEntry by falling back to the item itself in 'json'", () => {
    const noLogEntryItem: CrashLogItem = { ...sampleItem, logEntry: undefined }
    const result = serializeCrashLogBundle(makeBundle([noLogEntryItem]), "json")
    const parsed = JSON.parse(result.content) as Array<Record<string, unknown>>
    expect(parsed[0].id).toBe("x")
    expect(parsed[0].title).toBe("Boom")
  })
})
