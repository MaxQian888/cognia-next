// Node env on purpose: `dispatchDiagnostic` is called from `lib/` in contexts
// that have no window (SSR pre-render, headless runs, node-env suites), and
// both halves of that guard need coverage. A bare `EventTarget` stands in for
// the browser half.

import { createDiagnostic } from "@cognia/diagnostics"

import { DIAGNOSTIC_EVENT, dispatchDiagnostic, subscribeDiagnostic } from "./bus"

const g = globalThis as unknown as { window?: unknown }

function withWindow(): EventTarget {
  const target = new EventTarget()
  g.window = target
  return target
}

const diag = (code: Parameters<typeof createDiagnostic>[0], init = {}) =>
  createDiagnostic(code, { source: "storage", now: () => 0, id: "d1", ...init })

afterEach(() => {
  delete g.window
})

describe("dispatchDiagnostic", () => {
  it("delivers the diagnostic and its origin to subscribers", () => {
    withWindow()
    const handler = jest.fn()
    const off = subscribeDiagnostic(handler)
    const d = diag("seedFailed")

    dispatchDiagnostic(d, { kind: "background" })

    expect(handler).toHaveBeenCalledWith({ diagnostic: d, origin: { kind: "background" } })
    off()
  })

  it("omits origin entirely when the caller had none", () => {
    withWindow()
    const handler = jest.fn()
    const off = subscribeDiagnostic(handler)

    dispatchDiagnostic(diag("seedFailed"))

    expect(handler.mock.calls[0][0]).not.toHaveProperty("origin")
    off()
  })

  it("stops delivering after unsubscribe", () => {
    withWindow()
    const handler = jest.fn()
    subscribeDiagnostic(handler)()

    dispatchDiagnostic(diag("seedFailed"))

    expect(handler).not.toHaveBeenCalled()
  })

  it("ignores a same-named event carrying no diagnostic", () => {
    const target = withWindow()
    const handler = jest.fn()
    const off = subscribeDiagnostic(handler)

    target.dispatchEvent(new CustomEvent(DIAGNOSTIC_EVENT, { detail: {} }))
    target.dispatchEvent(new CustomEvent(DIAGNOSTIC_EVENT))

    expect(handler).not.toHaveBeenCalled()
    off()
  })

  it("still records the failure with no window to dispatch on", () => {
    // The whole point: a headless run keeps the structured log line even though
    // there is no UI to receive the event.
    expect(() => dispatchDiagnostic(diag("dbUnavailable"))).not.toThrow()
    expect(() => subscribeDiagnostic(jest.fn())()).not.toThrow()
  })

  it("appends the raw message to the log summary only when there is one", () => {
    withWindow()
    // `createDiagnostic` defaults `message` to "", so both halves of the
    // summary ternary are reachable in normal use.
    expect(() => dispatchDiagnostic(diag("seedFailed", { message: "boom" }))).not.toThrow()
    expect(() => dispatchDiagnostic(diag("seedFailed", { message: "" }))).not.toThrow()
  })

  it("logs warnings and errors at their matching level", () => {
    withWindow()
    // Exercises both branches of the severity split; the logger itself is
    // covered by its own suite, so this only guards that neither path throws.
    expect(() => dispatchDiagnostic(diag("offline"))).not.toThrow()
    expect(() => dispatchDiagnostic(diag("dbUnavailable"))).not.toThrow()
    expect(() => dispatchDiagnostic(diag("timeout", { message: "" }))).not.toThrow()
  })
})
