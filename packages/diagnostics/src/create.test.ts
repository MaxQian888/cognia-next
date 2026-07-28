import { createDiagnostic, __resetDiagnosticSequenceForTesting } from "./create"
import { DIAGNOSTIC_CODES } from "./registry"

const now = () => 1_700_000_000_000

beforeEach(() => {
  __resetDiagnosticSequenceForTesting()
})

describe("createDiagnostic", () => {
  it("fills severity, retryability, persistence and actions from the registry", () => {
    const diag = createDiagnostic("unauthorized", { source: "provider", now, id: "d1" })

    expect(diag).toEqual({
      id: "d1",
      at: 1_700_000_000_000,
      code: "unauthorized",
      severity: "error",
      retryable: false,
      persistent: true,
      source: "provider",
      message: "",
      actions: DIAGNOSTIC_CODES.unauthorized.actions,
    })
  })

  it("omits meta and detail entirely when the producer has none", () => {
    const diag = createDiagnostic("timeout", { source: "chat", now, id: "d1" })
    expect("meta" in diag).toBe(false)
    expect("detail" in diag).toBe(false)
  })

  it("carries the raw message and stack without translating them", () => {
    const diag = createDiagnostic("serverError", {
      source: "provider",
      message: "HTTPError 503: upstream unavailable",
      detail: "at foo (bar.ts:1:1)",
      now,
      id: "d1",
    })
    expect(diag.message).toBe("HTTPError 503: upstream unavailable")
    expect(diag.detail).toBe("at foo (bar.ts:1:1)")
  })

  it("appends producer actions after the registry defaults", () => {
    const diag = createDiagnostic("prerequisiteMissing", {
      source: "external-agent",
      actions: [{ kind: "open-external", url: "https://example.test/install" }],
      now,
      id: "d1",
    })
    expect(diag.actions.at(-1)).toEqual({
      kind: "open-external",
      url: "https://example.test/install",
    })
    expect(diag.actions.slice(0, -1)).toEqual(DIAGNOSTIC_CODES.prerequisiteMissing.actions)
  })

  it("dedupes an appended action that the registry already offers", () => {
    const diag = createDiagnostic("timeout", {
      source: "chat",
      actions: [{ kind: "retry" }],
      now,
      id: "d1",
    })
    expect(diag.actions).toEqual([{ kind: "retry" }])
  })

  it("keeps two open-settings actions that point at different panes", () => {
    const diag = createDiagnostic("modelRequired", {
      source: "provider",
      actions: [{ kind: "open-settings", section: "subscription" }],
      now,
      id: "d1",
    })
    expect(diag.actions).toEqual([
      { kind: "open-settings", section: "providers" },
      { kind: "open-settings", section: "subscription" },
    ])
  })

  it("upgrades retry to a countdown when the provider stated a delay", () => {
    // The sidecar already parses Retry-After off the real response; this is
    // where that number stops being thrown away.
    const diag = createDiagnostic("rateLimited", {
      source: "provider",
      meta: { retryAfterMs: 30_000, httpStatus: 429 },
      now,
      id: "d1",
    })
    expect(diag.actions[0]).toEqual({ kind: "wait-and-retry", retryAfterMs: 30_000 })
    expect(diag.actions.some((a) => a.kind === "retry")).toBe(false)
    expect(diag.meta).toEqual({ retryAfterMs: 30_000, httpStatus: 429 })
  })

  it("ignores a non-positive delay rather than rendering a 0s countdown", () => {
    const diag = createDiagnostic("rateLimited", {
      source: "provider",
      meta: { retryAfterMs: 0 },
      now,
      id: "d1",
    })
    expect(diag.actions[0]).toEqual({ kind: "retry" })
  })

  it("leaves codes with no retry action alone when a delay is present", () => {
    const diag = createDiagnostic("quotaExceeded", {
      source: "provider",
      meta: { retryAfterMs: 60_000 },
      now,
      id: "d1",
    })
    expect(diag.actions.some((a) => a.kind === "wait-and-retry")).toBe(false)
  })

  it("does not double-apply when the producer already supplied a countdown", () => {
    const diag = createDiagnostic("rateLimited", {
      source: "provider",
      actions: [{ kind: "wait-and-retry", retryAfterMs: 5_000 }],
      meta: { retryAfterMs: 30_000 },
      now,
      id: "d1",
    })
    expect(diag.actions.filter((a) => a.kind === "wait-and-retry")).toEqual([
      { kind: "wait-and-retry", retryAfterMs: 5_000 },
    ])
    expect(diag.actions.some((a) => a.kind === "retry")).toBe(true)
  })

  it("honours explicit overrides — the Rust side owns its own retryability", () => {
    const diag = createDiagnostic("unknown", {
      source: "tauri",
      severity: "warning",
      retryable: true,
      persistent: true,
      now,
      id: "d1",
    })
    expect(diag.severity).toBe("warning")
    expect(diag.retryable).toBe(true)
    expect(diag.persistent).toBe(true)
  })

  it("gives simultaneous failures distinct ids so dedupe cannot merge them", () => {
    // A fan-out of parallel tool calls can reject inside one millisecond.
    const a = createDiagnostic("timeout", { source: "chat", now })
    const b = createDiagnostic("timeout", { source: "chat", now })
    expect(a.id).not.toBe(b.id)
    expect(a.at).toBe(b.at)
  })

  it("defaults the timestamp to the real clock", () => {
    const before = Date.now()
    const diag = createDiagnostic("timeout", { source: "chat" })
    expect(diag.at).toBeGreaterThanOrEqual(before)
  })
})
