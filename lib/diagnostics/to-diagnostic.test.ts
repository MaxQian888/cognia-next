import { createDiagnostic } from "@cognia/diagnostics"
import { CommandInvokeError } from "@/lib/tauri/command-error"
import { AgentHostUnavailableError } from "@/lib/ai/agent/execution/agent-execution-service"

import { diagnosticFromCode, toDiagnostic } from "./to-diagnostic"

const now = () => 1_700_000_000_000
const ctx = { source: "chat" as const, now, id: "d1" }

describe("toDiagnostic — structure before text", () => {
  it("passes an existing diagnostic through, merging extra context", () => {
    const existing = createDiagnostic("timeout", { source: "provider", now, id: "orig" })
    const out = toDiagnostic(existing, { ...ctx, meta: { sessionId: "s1" } })
    expect(out.id).toBe("orig")
    expect(out.code).toBe("timeout")
    expect(out.meta).toEqual({ sessionId: "s1" })
  })

  it("returns an already-classified diagnostic untouched when there is nothing to merge", () => {
    const existing = createDiagnostic("timeout", { source: "provider", now, id: "orig" })
    expect(toDiagnostic(existing, { source: "chat", now })).toBe(existing)
  })

  it("recognises a typed execution error before looking at its message", () => {
    const out = toDiagnostic(new AgentHostUnavailableError("host-1"), ctx)
    expect(out.code).toBe("hostUnavailable")
    expect(out.detail).toContain("AgentHostUnavailableError")
  })

  it("recognises a decoded Tauri rejection and keeps its retryability", () => {
    const err = new CommandInvokeError({
      code: "sidecar_error",
      message: "died",
      retryable: true,
      structured: true,
    })
    const out = toDiagnostic(err, ctx)
    expect(out.code).toBe("sidecarExited")
    expect(out.retryable).toBe(true)
  })

  it("recognises a raw dispatch envelope", () => {
    const out = toDiagnostic(
      { code: "rejection-cycle", message: "loop", retryable: false },
      { ...ctx, source: "plugin" }
    )
    expect(out.code).toBe("dispatchRejectedCycle")
  })

  it("prefers the dispatch envelope over the command envelope on an ambiguous shape", () => {
    // A dispatch envelope satisfies the command-envelope duck test too; checking
    // the looser one first would swallow every dispatch failure.
    const out = toDiagnostic({ code: "budget-exhausted", message: "spent", retryable: false }, ctx)
    expect(out.code).toBe("budgetExhausted")
  })

  it("recognises a bare command envelope", () => {
    const out = toDiagnostic(
      { code: "task_not_found", message: "gone" },
      { ...ctx, source: "tauri" }
    )
    expect(out.code).toBe("notFound")
    expect(out.retryable).toBe(false)
  })
})

describe("toDiagnostic — text fallback", () => {
  it("classifies a transport error through the parsers", () => {
    const out = toDiagnostic(new Error("connect ECONNREFUSED 127.0.0.1:1234"), ctx)
    expect(out.code).toBe("connectionRefused")
    expect(out.message).toContain("ECONNREFUSED")
  })

  it("classifies an HTTP status through the parsers", () => {
    const out = toDiagnostic(new Error("HTTPError 429: rate_limit_error"), ctx)
    expect(out.code).toBe("rateLimited")
  })

  it("falls through to the provider classifier for shapes the parsers miss", () => {
    // "prompt is too long" carries no status code and no transport keyword, so
    // only the provider classifier recognises it.
    const out = toDiagnostic(new Error("prompt is too long: 224864 tokens > 200000 maximum"), {
      ...ctx,
      source: "provider",
    })
    expect(out.code).toBe("contextWindowExceeded")
  })

  it("lets a real HTTP status rescue an otherwise unclassifiable message", () => {
    const out = toDiagnostic(new Error("upstream said no"), {
      ...ctx,
      source: "provider",
      meta: { httpStatus: 503 },
    })
    expect(out.code).toBe("serverError")
    expect(out.meta?.httpStatus).toBe(503)
  })

  it("turns a real Retry-After into a countdown action", () => {
    const out = toDiagnostic(new Error("slow down"), {
      ...ctx,
      source: "provider",
      meta: { httpStatus: 429, retryAfterMs: 30_000 },
    })
    expect(out.code).toBe("rateLimited")
    expect(out.actions[0]).toEqual({ kind: "wait-and-retry", retryAfterMs: 30_000 })
  })

  it("keeps the message and stack when nothing recognises it", () => {
    const err = new Error("something nobody has seen before")
    const out = toDiagnostic(err, ctx)
    expect(out.code).toBe("unknown")
    expect(out.message).toContain("something nobody has seen before")
    expect(out.detail).toBe(err.stack)
  })

  it("handles non-Error throws without a stack", () => {
    const out = toDiagnostic("just a string", ctx)
    expect(out.code).toBe("unknown")
    expect(out.detail).toBeUndefined()
  })

  it("survives null and undefined", () => {
    expect(toDiagnostic(null, ctx).code).toBe("unknown")
    expect(toDiagnostic(undefined, ctx).code).toBe("unknown")
  })

  it("stamps the caller's source and context meta on every path", () => {
    const out = toDiagnostic(new Error("boom"), {
      ...ctx,
      source: "agent-team",
      meta: { sessionId: "s9" },
    })
    expect(out.source).toBe("agent-team")
    expect(out.meta).toEqual({ sessionId: "s9" })
  })

  it("omits meta entirely when there is nothing to record", () => {
    expect(toDiagnostic(new Error("boom"), ctx).meta).toBeUndefined()
  })
})

describe("diagnosticFromCode", () => {
  it("builds directly from a known code without classifying", () => {
    const out = diagnosticFromCode("teamMissing", {
      source: "agent-team",
      message: "team-7",
      now,
      id: "d1",
    })
    expect(out.code).toBe("teamMissing")
    expect(out.message).toBe("team-7")
  })

  it("degrades an unrecognised code instead of throwing", () => {
    expect(diagnosticFromCode("not-a-code", { source: "chat", now, id: "d1" }).code).toBe("unknown")
  })
})
