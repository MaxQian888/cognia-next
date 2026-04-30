import {
  DEFAULT_LOGGER_CONFIG,
  DEFAULT_UNIFIED_CONFIG,
  LEVEL_PRIORITY,
  LOG_LEVEL_PRIORITY,
  type AppLogLevel,
  type LogLevel,
  type LogOrigin,
  type LogRuntime,
  type Logger,
  type LoggerRedactionConfig,
  type StructuredLogEntry,
  type Transport,
  type TransportHealthSnapshot,
} from "./types"

describe("lib/logger/types", () => {
  it("LOG_LEVEL_PRIORITY orders levels from trace=0 to fatal=5", () => {
    const expected: Record<AppLogLevel, number> = {
      trace: 0,
      debug: 1,
      info: 2,
      warn: 3,
      error: 4,
      fatal: 5,
    }
    expect(LOG_LEVEL_PRIORITY).toEqual(expected)
  })

  it("LEVEL_PRIORITY mirrors LOG_LEVEL_PRIORITY for the extended LogLevel", () => {
    const levels: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"]
    for (const l of levels) {
      expect(LEVEL_PRIORITY[l]).toBe(LOG_LEVEL_PRIORITY[l])
    }
  })

  it("DEFAULT_LOGGER_CONFIG has safe production defaults", () => {
    expect(DEFAULT_LOGGER_CONFIG.minLevel).toBe("info")
    expect(DEFAULT_LOGGER_CONFIG.enableConsole).toBe(true)
    expect(DEFAULT_LOGGER_CONFIG.enableStorage).toBe(false)
    expect(DEFAULT_LOGGER_CONFIG.enableRemote).toBe(false)
    expect(DEFAULT_LOGGER_CONFIG.maxStorageEntries).toBe(1000)
    expect(DEFAULT_LOGGER_CONFIG.includeStackTrace).toBe(true)
  })

  it("DEFAULT_UNIFIED_CONFIG includes redaction and sensible queue limits", () => {
    expect(["info", "debug"]).toContain(DEFAULT_UNIFIED_CONFIG.minLevel)
    expect(DEFAULT_UNIFIED_CONFIG.bufferSize).toBe(100)
    expect(DEFAULT_UNIFIED_CONFIG.flushInterval).toBe(1000)
    expect(DEFAULT_UNIFIED_CONFIG.remoteQueueMaxEntries).toBe(5000)
    expect(DEFAULT_UNIFIED_CONFIG.remoteQueueMaxBytes).toBe(10 * 1024 * 1024)
    expect(DEFAULT_UNIFIED_CONFIG.diagnosticRateLimitMs).toBe(2000)
  })

  it("DEFAULT_UNIFIED_CONFIG.redaction lists common secret keys + patterns", () => {
    const r: LoggerRedactionConfig = DEFAULT_UNIFIED_CONFIG.redaction
    expect(r.enabled).toBe(true)
    expect(r.replacement).toBe("[REDACTED]")
    expect(r.maxDepth).toBe(8)
    for (const key of [
      "password",
      "token",
      "secret",
      "api_key",
      "authorization",
      "cookie",
      "bearer",
    ]) {
      expect(r.redactKeys).toContain(key)
    }
    expect(r.redactPatterns.length).toBeGreaterThan(0)
    for (const pattern of r.redactPatterns) {
      // Each redact pattern must be a valid regex
      expect(() => new RegExp(pattern, "i")).not.toThrow()
    }
  })

  it("LogRuntime / LogOrigin unions accept the expected values", () => {
    const runtimes: LogRuntime[] = [
      "browser",
      "server",
      "tauri",
      "mcp",
      "plugin",
      "internal",
      "unknown",
    ]
    const origins: LogOrigin[] = [
      "frontend",
      "web-runtime",
      "tauri",
      "mcp",
      "plugin",
      "diagnostic",
      "unknown",
    ]
    expect(new Set(runtimes).size).toBe(runtimes.length)
    expect(new Set(origins).size).toBe(origins.length)
  })

  it("StructuredLogEntry type allows minimal-required + extended fields", () => {
    const entry: StructuredLogEntry = {
      id: "abc",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "ok",
      module: "test",
      tags: ["unit"],
      data: { k: "v" },
    }
    expect(entry.module).toBe("test")
  })

  it("Transport contract: log() returns void or Promise; getHealth optional", () => {
    let count = 0
    const health: TransportHealthSnapshot = {
      transport: "memory",
      status: "healthy",
      queueDepth: 0,
      retryCount: 0,
      droppedEntries: 0,
      updatedAt: new Date().toISOString(),
    }
    const t: Transport = {
      name: "memory",
      log() {
        count += 1
      },
      getHealth: () => health,
      getPendingCount: () => 0,
    }
    t.log({
      id: "1",
      timestamp: "now",
      level: "info",
      message: "x",
      module: "m",
    } as StructuredLogEntry)
    expect(count).toBe(1)
    expect(t.getHealth?.().status).toBe("healthy")
    expect(t.getPendingCount?.()).toBe(0)
  })

  it("Logger interface composes via child / withContext / setTraceId", () => {
    const buffered: string[] = []
    const make = (prefix: string): Logger => ({
      trace: (m) => buffered.push(`${prefix}:trace:${m}`),
      debug: (m) => buffered.push(`${prefix}:debug:${m}`),
      info: (m) => buffered.push(`${prefix}:info:${m}`),
      warn: (m) => buffered.push(`${prefix}:warn:${m}`),
      error: (m) => buffered.push(`${prefix}:error:${m}`),
      fatal: (m) => buffered.push(`${prefix}:fatal:${m}`),
      child: (mod) => make(`${prefix}.${mod}`),
      withContext: () => make(prefix),
      setTraceId: () => {},
    })
    const root = make("root")
    root.info("hi")
    root.child("sub").warn("oops")
    expect(buffered).toEqual(["root:info:hi", "root.sub:warn:oops"])
  })
})
