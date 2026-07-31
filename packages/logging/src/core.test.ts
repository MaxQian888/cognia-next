/**
 * @jest-environment jsdom
 */

import type { Transport, StructuredLogEntry, TransportHealthSnapshot } from "./types"

interface MemoryTransport extends Transport {
  entries: StructuredLogEntry[]
}

function makeMemoryTransport(name = "memory", overrides: Partial<Transport> = {}): MemoryTransport {
  const entries: StructuredLogEntry[] = []
  const t: MemoryTransport = {
    name,
    log: (entry) => {
      entries.push(entry)
    },
    entries,
    ...overrides,
  }
  return t
}

beforeEach(async () => {
  // Each test gets a clean module + transport set + sampler.
  jest.resetModules()
  const core = await import("./core")
  await core.shutdownLogger()
})

describe("createLogger / dispatch flow", () => {
  it("respects minLevel threshold", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "warn", enableConsole: false }, [mem])
    const logger = core.createLogger("auth")
    logger.debug("debug msg") // below threshold
    logger.info("info msg") // below threshold
    logger.warn("warn msg")
    logger.error("err msg")
    expect(mem.entries.map((e) => e.level)).toEqual(["warn", "error"])
  })

  it("merges global, additionalContext, and per-call data", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const ctx = (await import("./context")).logContext
    ctx.setContext({ userId: "u1" })
    const logger = core.createLogger("svc").withContext({ extra: 42 })
    logger.info("hi", { eventId: "evt-1" })
    const entry = mem.entries[0]
    expect(entry.eventId).toBe("evt-1")
    expect(entry.data?.userId).toBe("u1")
    expect(entry.data?.extra).toBe(42)
    ctx.clearContext()
  })

  it("error/fatal include stack from Error and ship through normalize+redact", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false, includeStackTrace: true }, [mem])
    const logger = core.createLogger("err")
    const e = new Error("boom")
    logger.error("bang", e, { extraKey: "v" })
    const entry = mem.entries.find((x) => x.level === "error")!
    expect(entry.stack).toMatch(/Error/)
    expect(entry.data?.errorMessage).toBe("boom")
    expect(entry.data?.errorName).toBe("Error")
    logger.fatal("doom", e)
    expect(mem.entries.find((x) => x.level === "fatal")).toBeTruthy()
  })

  it("preserves non-Error error data verbatim", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const logger = core.createLogger("err")
    logger.error("with-string", "string-error")
    const entry = mem.entries[0]
    expect(entry.data?.error).toBe("string-error")
  })

  it("trace ID resolves: data.traceId > setTraceId() > logContext.traceId", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const logger = core.createLogger("svc")
    logger.setTraceId("logger-trace")
    logger.info("a")
    logger.info("b", { traceId: "explicit" })
    expect(mem.entries[0].traceId).toBe("logger-trace")
    expect(mem.entries[1].traceId).toBe("explicit")
  })

  it("child() concatenates submodule names", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const parent = core.createLogger("a")
    parent.child("b").info("x")
    expect(mem.entries[0].module).toBe("a:b")
  })

  it("trace and debug levels reach the transport when enabled", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const logger = core.createLogger("svc")
    logger.trace("t")
    logger.debug("d")
    expect(mem.entries.map((e) => e.level)).toEqual(["trace", "debug"])
  })
})

describe("transport registration + health", () => {
  it("addTransport / removeTransport / getTransport / getTransports", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: false }, [])
    const a = makeMemoryTransport("a")
    core.addTransport(a)
    core.addTransport(a) // duplicate name -> ignored
    expect(core.getTransports().map((t) => t.name)).toEqual(["a"])
    expect(core.getTransport("a")).toBe(a)
    core.removeTransport("a")
    expect(core.getTransport("a")).toBeUndefined()
  })

  it("removeTransport awaits close() if defined", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: false }, [])
    const close = jest.fn(async () => undefined)
    core.addTransport(makeMemoryTransport("x", { close }))
    core.removeTransport("x")
    expect(close).toHaveBeenCalled()
  })

  it("getTransportHealth uses transport.getHealth() when present", async () => {
    const core = await import("./core")
    const reported: TransportHealthSnapshot = {
      transport: "x",
      status: "degraded",
      queueDepth: 3,
      retryCount: 1,
      droppedEntries: 0,
      updatedAt: "",
    }
    core.initLogger({ enableConsole: false }, [
      makeMemoryTransport("x", { getHealth: () => reported }),
    ])
    expect(core.getTransportHealth("x")?.status).toBe("degraded")
    expect(core.getTransportHealth("missing")).toBeUndefined()
  })

  it("getTransportHealth synthesizes a snapshot from getPendingCount()", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: false }, [
      makeMemoryTransport("x", { getPendingCount: () => 5 }),
    ])
    const h = core.getTransportHealth("x")
    expect(h?.queueDepth).toBe(5)
    expect(h?.status).toBe("degraded")
  })

  it("getTransportHealth defaults to healthy when no extras", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: false }, [makeMemoryTransport("x")])
    const h = core.getTransportHealth("x")
    expect(h?.status).toBe("healthy")
    expect(h?.queueDepth).toBe(0)
  })

  it("getTransportHealthSnapshot returns map of every transport", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: false }, [makeMemoryTransport("a"), makeMemoryTransport("b")])
    const snap = core.getTransportHealthSnapshot()
    expect(Object.keys(snap).sort()).toEqual(["a", "b"])
  })

  it("transport.log throwing emits a transport.failed diagnostic", async () => {
    const core = await import("./core")
    const failing = makeMemoryTransport("bad")
    failing.log = () => {
      throw new Error("kaboom")
    }
    const observer = makeMemoryTransport("observer")
    core.initLogger({ enableConsole: false, minLevel: "trace" }, [failing, observer])
    core.createLogger("test").info("hi")
    const diag = observer.entries.find((e) => e.code === "logger.transport.failed")
    expect(diag).toBeTruthy()
    expect(diag?.level).toBe("error")
    expect(diag?.data?.transport).toBe("bad")
  })

  it("syncBuiltinTransports adds console transport when enableConsole=true", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: true })
    expect(core.getTransport("console")).toBeDefined()
    core.updateLoggerConfig({ enableConsole: false })
    expect(core.getTransport("console")).toBeUndefined()
  })
})

describe("config + stats lifecycle", () => {
  it("updateLoggerConfig partially merges nested redaction config", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: false }, [])
    core.updateLoggerConfig({
      redaction: { redactKeys: ["only_one"] },
    })
    const cfg = core.getLoggerConfig()
    expect(cfg.redaction.redactKeys).toEqual(["only_one"])
    expect(cfg.redaction.redactPatterns.length).toBeGreaterThan(0)
  })

  it("getLoggerConfig returns a clone (no mutation leaks)", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: false }, [])
    const a = core.getLoggerConfig()
    a.redaction.redactKeys.push("malicious")
    expect(core.getLoggerConfig().redaction.redactKeys).not.toContain("malicious")
  })

  it("getLoggerStats reflects per-level + per-module counters", async () => {
    const core = await import("./core")
    core.initLogger({ minLevel: "trace", enableConsole: false }, [makeMemoryTransport()])
    const a = core.createLogger("a")
    const b = core.createLogger("b")
    a.info("1")
    a.warn("2")
    b.error("3")
    const stats = core.getLoggerStats()
    expect(stats.total).toBe(3)
    expect(stats.byLevel.info).toBe(1)
    expect(stats.byLevel.warn).toBe(1)
    expect(stats.byLevel.error).toBe(1)
    expect(stats.byModule).toMatchObject({ a: 2, b: 1 })
  })

  it("getRegisteredModules returns sorted set of modules", async () => {
    const core = await import("./core")
    core.initLogger({ enableConsole: false }, [])
    core.createLogger("zebra")
    core.createLogger("alpha")
    expect(core.getRegisteredModules()).toEqual(["alpha", "zebra"])
  })

  it("flushLogs awaits transports with flush()", async () => {
    const core = await import("./core")
    const flush = jest.fn(async () => undefined)
    core.initLogger({ enableConsole: false }, [makeMemoryTransport("a", { flush })])
    await core.flushLogs()
    expect(flush).toHaveBeenCalled()
  })

  it("shutdownLogger flushes + closes + clears state", async () => {
    const core = await import("./core")
    const close = jest.fn(async () => undefined)
    const flush = jest.fn(async () => undefined)
    core.initLogger({ enableConsole: false }, [makeMemoryTransport("a", { close, flush })])
    await core.shutdownLogger()
    expect(flush).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
    // After shutdown, getRegisteredModules is empty.
    expect(core.getRegisteredModules()).toEqual([])
  })

  it("shutdownLogger is a no-op when not initialized", async () => {
    const core = await import("./core")
    await core.shutdownLogger() // first call
    await core.shutdownLogger() // second call -> no-op
  })
})

describe("emitLoggerDiagnostic", () => {
  it("emits a diagnostic entry to all transports except skipped ones", async () => {
    const core = await import("./core")
    const a = makeMemoryTransport("a")
    const b = makeMemoryTransport("b")
    core.initLogger({ enableConsole: false }, [a, b])
    core.emitLoggerDiagnostic({
      code: "test.code",
      message: "diagnostic",
      level: "warn",
      sourceTransport: "a",
    })
    expect(a.entries).toHaveLength(0)
    expect(b.entries).toHaveLength(1)
  })

  it("rate-limits identical (level, code) pairs within configured cooldown", async () => {
    const core = await import("./core")
    const a = makeMemoryTransport("a")
    core.initLogger({ enableConsole: false, diagnosticRateLimitMs: 60_000 }, [a])
    core.emitLoggerDiagnostic({ code: "X", message: "first" })
    core.emitLoggerDiagnostic({ code: "X", message: "second" })
    expect(a.entries).toHaveLength(1)
  })

  it("does not emit while another diagnostic is in-flight (re-entrancy guard)", async () => {
    const core = await import("./core")
    let nested = 0
    const reentrant = makeMemoryTransport("a")
    reentrant.log = () => {
      nested += 1
      // Reentrant call — the guard should prevent infinite recursion.
      core.emitLoggerDiagnostic({ code: "Y", message: "from-inside" })
    }
    core.initLogger({ enableConsole: false }, [reentrant])
    core.emitLoggerDiagnostic({ code: "X", message: "outer" })
    expect(nested).toBeGreaterThan(0)
  })
})

describe("logger error path swallow", () => {
  it("normalizes Date / Error / nested objects in entry.data", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const logger = core.createLogger("svc")
    const data: Record<string, unknown> = {
      when: new Date("2026-04-30T00:00:00.000Z"),
      err: new Error("inner"),
      arr: [1, "x", { nested: true }],
    }
    logger.info("complex", data)
    const entry = mem.entries[0]
    expect(entry.data?.when).toBe("2026-04-30T00:00:00.000Z")
    expect((entry.data?.err as { message?: string }).message).toBe("inner")
    expect(Array.isArray(entry.data?.arr)).toBe(true)
  })
})

describe("span / call-context fields", () => {
  it("stamps spanId and parentSpanId from the active span context", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const ctx = (await import("./context")).logContext
    const logger = core.createLogger("svc")
    ctx.withSpan(() => {
      logger.info("outer")
      ctx.withSpan(() => {
        logger.info("inner")
      })
    })
    const outer = mem.entries.find((e) => e.message === "outer")!
    const inner = mem.entries.find((e) => e.message === "inner")!
    expect(outer.spanId).toMatch(/^[a-f0-9]{32}$/)
    expect(outer.parentSpanId).toBeUndefined()
    expect(inner.parentSpanId).toBe(outer.spanId)
    expect(inner.spanId).not.toBe(outer.spanId)
  })

  it("passes phase / attempt / durationMs through from per-call data", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    core.createLogger("svc").warn("retrying", { attempt: 2, phase: "retry", durationMs: 12 })
    const entry = mem.entries[0]
    expect(entry.attempt).toBe(2)
    expect(entry.phase).toBe("retry")
    expect(entry.durationMs).toBe(12)
    // Promoted fields are removed from data to avoid duplication.
    expect(entry.data?.attempt).toBeUndefined()
  })

  it("logger.span runs the body inside a span and stamps durationMs on completion", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const logger = core.createLogger("svc")
    const result = logger.span("do-work", () => {
      logger.info("step")
      return 42
    })
    expect(result).toBe(42)
    const step = mem.entries.find((e) => e.message === "step")!
    const end = mem.entries.find((e) => e.message === "do-work")!
    expect(step.spanId).toMatch(/^[a-f0-9]{32}$/)
    expect(end.spanId).toBe(step.spanId)
    expect(end.phase).toBe("end")
    expect(typeof end.durationMs).toBe("number")
  })

  it("logger.spanAsync awaits the body within the span", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger({ minLevel: "trace", enableConsole: false }, [mem])
    const logger = core.createLogger("svc")
    const result = await logger.spanAsync("async-work", async () => {
      logger.info("astep")
      return "ok"
    })
    expect(result).toBe("ok")
    const step = mem.entries.find((e) => e.message === "astep")!
    const end = mem.entries.find((e) => e.message === "async-work")!
    expect(end.spanId).toBe(step.spanId)
    expect(end.phase).toBe("end")
    expect(typeof end.durationMs).toBe("number")
  })
})

describe("per-module level overrides", () => {
  it("raises verbosity for a matching module while others keep the global level", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger(
      { minLevel: "info", enableConsole: false, perModuleLevels: { verbose: "debug" } },
      [mem]
    )
    core.createLogger("verbose").debug("v-debug")
    core.createLogger("quiet").debug("q-debug")
    expect(mem.entries.map((e) => `${e.module}:${e.message}`)).toEqual(["verbose:v-debug"])
  })

  it("applies a parent rule to child (hierarchical) modules", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger(
      { minLevel: "info", enableConsole: false, perModuleLevels: { verbose: "debug" } },
      [mem]
    )
    core.createLogger("verbose").child("sub").debug("child-debug")
    expect(mem.entries.map((e) => e.module)).toEqual(["verbose:sub"])
  })

  it("honors per-module rule changes applied at runtime via updateLoggerConfig", async () => {
    const core = await import("./core")
    const mem = makeMemoryTransport()
    core.initLogger(
      { minLevel: "info", enableConsole: false, perModuleLevels: { verbose: "debug" } },
      [mem]
    )
    const logger = core.createLogger("verbose")
    logger.debug("before") // passes
    core.updateLoggerConfig({ perModuleLevels: {} })
    logger.debug("after") // now filtered (back to global info)
    expect(mem.entries.map((e) => e.message)).toEqual(["before"])
  })
})
