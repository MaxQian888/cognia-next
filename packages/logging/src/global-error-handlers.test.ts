/**
 * @jest-environment node
 *
 * Tests for the global uncaught-error capture. A fake EventTarget records the
 * registered listeners so we can fire synthetic `error` / `unhandledrejection`
 * events without a DOM, then assert the routing into the (mocked) logger.
 */

jest.mock("./index", () => ({
  loggers: { app: { error: jest.fn(), fatal: jest.fn(), warn: jest.fn() } },
}))
jest.mock("./sampling", () => ({
  logSampler: { checkDedupe: jest.fn(() => ({ shouldLog: true })) },
}))

import {
  installGlobalErrorHandlers,
  resetGlobalErrorHandlersForTest,
} from "./global-error-handlers"
import { loggers } from "./index"
import { logSampler } from "./sampling"

const appLogger = loggers.app as unknown as {
  error: jest.Mock
  fatal: jest.Mock
  warn: jest.Mock
}
const checkDedupe = logSampler.checkDedupe as unknown as jest.Mock

type Handler = (event: Event) => void

class FakeTarget {
  listeners = new Map<string, Handler[]>()
  added: Array<{ type: string; handler: Handler; capture?: boolean }> = []
  removed: Array<{ type: string; handler: Handler }> = []

  addEventListener(type: string, handler: Handler, capture?: boolean): void {
    this.added.push({ type, handler, capture })
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: Handler): void {
    this.removed.push({ type, handler })
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((h) => h !== handler)
    )
  }

  fire(type: string, event: Record<string, unknown>): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event as unknown as Event)
    }
  }
}

beforeEach(() => {
  resetGlobalErrorHandlersForTest()
  appLogger.error.mockReset()
  appLogger.fatal.mockReset()
  appLogger.warn.mockReset()
  checkDedupe.mockReset()
  checkDedupe.mockReturnValue({ shouldLog: true })
})

describe("installGlobalErrorHandlers", () => {
  it("routes an uncaught error to loggers.app.fatal with the Error preserved", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })

    const err = new Error("boom")
    target.fire("error", { error: err, message: "boom", target })

    expect(appLogger.fatal).toHaveBeenCalledTimes(1)
    const [message, error, data] = appLogger.fatal.mock.calls[0]
    expect(message).toContain("boom")
    expect(error).toBe(err)
    expect(data).toMatchObject({ source: "window.onerror" })
  })

  it("routes an unhandled rejection to loggers.app.error", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })

    const reason = new Error("rejected")
    target.fire("unhandledrejection", { reason })

    expect(appLogger.error).toHaveBeenCalledTimes(1)
    const [message, error, data] = appLogger.error.mock.calls[0]
    expect(message).toContain("rejected")
    expect(error).toBe(reason)
    expect(data).toMatchObject({ source: "unhandledrejection" })
  })

  it.each([
    new DOMException(
      "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.",
      "NotAllowedError"
    ),
    new DOMException("Canceled", "AbortError"),
    new Error("Canceled"),
  ])("suppresses the benign platform rejection %p", (reason) => {
    const target = new FakeTarget()
    const preventDefault = jest.fn()
    const stopImmediatePropagation = jest.fn()
    installGlobalErrorHandlers({ target })

    expect(target.added).toContainEqual(
      expect.objectContaining({ type: "unhandledrejection", capture: true })
    )
    target.fire("unhandledrejection", { reason, preventDefault, stopImmediatePropagation })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(appLogger.error).not.toHaveBeenCalled()
    expect(appLogger.fatal).not.toHaveBeenCalled()
    expect(appLogger.warn).toHaveBeenCalledTimes(1)
  })

  it("still reports a real NotAllowedError with an unrelated message", () => {
    const target = new FakeTarget()
    const preventDefault = jest.fn()
    installGlobalErrorHandlers({ target })

    target.fire("unhandledrejection", {
      reason: new DOMException("Policy invariant violated", "NotAllowedError"),
      preventDefault,
    })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(appLogger.error).toHaveBeenCalledTimes(1)
    expect(appLogger.warn).not.toHaveBeenCalled()
  })

  it("downgrades resource-load failures to warn", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })

    const imgTarget = { tagName: "IMG", src: "https://x/y.png" }
    target.fire("error", { target: imgTarget })

    expect(appLogger.warn).toHaveBeenCalledTimes(1)
    expect(appLogger.fatal).not.toHaveBeenCalled()
    const [message] = appLogger.warn.mock.calls[0]
    expect(message).toContain("img")
  })

  it.each([
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
  ])("downgrades the benign browser error %p to warn", (message) => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })

    target.fire("error", { message, target })

    expect(appLogger.fatal).not.toHaveBeenCalled()
    expect(appLogger.warn).toHaveBeenCalledTimes(1)
    expect(appLogger.warn.mock.calls[0][0]).toContain("ResizeObserver")
  })

  it("still reports a real error whose message merely mentions ResizeObserver", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })

    const err = new Error("cannot construct ResizeObserver loop helper")
    target.fire("error", { error: err, message: err.message, target })

    expect(appLogger.fatal).toHaveBeenCalledTimes(1)
    expect(appLogger.warn).not.toHaveBeenCalled()
  })

  it("stringifies non-Error rejection reasons", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })

    target.fire("unhandledrejection", { reason: { code: 42 } })

    expect(appLogger.error).toHaveBeenCalledTimes(1)
    const [message, error] = appLogger.error.mock.calls[0]
    expect(message).toContain("42")
    expect(error).toBeUndefined()
  })

  it("handles a plain string rejection reason", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })
    target.fire("unhandledrejection", { reason: "just a string" })
    expect(appLogger.error.mock.calls[0][0]).toContain("just a string")
  })

  it("handles a null rejection reason", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })
    target.fire("unhandledrejection", { reason: null })
    expect(appLogger.error.mock.calls[0][0]).toContain("null")
  })

  it("falls back to String() when the reason is not JSON-serialisable", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })
    target.fire("unhandledrejection", { reason: circular })
    expect(appLogger.error).toHaveBeenCalledTimes(1)
    expect(appLogger.error.mock.calls[0][0]).toContain("[object Object]")
  })

  it("uncaught error with only a message string is reported as fatal", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })
    target.fire("error", { message: "scripterror", target })
    expect(appLogger.fatal).toHaveBeenCalledTimes(1)
    expect(appLogger.fatal.mock.calls[0][0]).toContain("scripterror")
  })

  it("degrades a tag-less resource error to a generic resource warning", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })
    // A non-window target with neither tagName nor src/href.
    target.fire("error", { target: {} })
    expect(appLogger.warn).toHaveBeenCalledTimes(1)
    expect(appLogger.warn.mock.calls[0][0]).toContain("resource")
  })

  it("suppresses storms via logSampler.checkDedupe", () => {
    checkDedupe.mockReturnValue({ shouldLog: false })
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })

    target.fire("error", { error: new Error("dup"), target })

    expect(appLogger.fatal).not.toHaveBeenCalled()
    expect(checkDedupe).toHaveBeenCalledWith("app", "fatal", expect.stringContaining("dup"))
  })

  it("attaches an aggregated duplicate count when checkDedupe flushes", () => {
    checkDedupe.mockReturnValue({ shouldLog: true, count: 10 })
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })

    target.fire("error", { error: new Error("flood"), target })

    const [, , data] = appLogger.fatal.mock.calls[0]
    expect(data).toMatchObject({ duplicateCount: 10 })
  })

  it("is idempotent — a second install does not double-register", () => {
    const target = new FakeTarget()
    installGlobalErrorHandlers({ target })
    const secondCleanup = installGlobalErrorHandlers({ target })
    // The second install returns an inert cleanup — calling it must not
    // tear down the first install's listeners.
    secondCleanup()

    target.fire("error", { error: new Error("once"), target })

    expect(appLogger.fatal).toHaveBeenCalledTimes(1)
  })

  it("cleanup removes the listeners and re-arms installation", () => {
    const target = new FakeTarget()
    const cleanup = installGlobalErrorHandlers({ target })
    cleanup()

    expect(target.removed.map((r) => r.type).sort()).toEqual(["error", "unhandledrejection"])

    // Re-arm: a fresh install on a new target works again.
    const target2 = new FakeTarget()
    installGlobalErrorHandlers({ target: target2 })
    target2.fire("unhandledrejection", { reason: "again" })
    expect(appLogger.error).toHaveBeenCalledTimes(1)
  })

  it("is a no-op under SSR (no window, no injected target)", () => {
    const cleanup = installGlobalErrorHandlers({})
    expect(typeof cleanup).toBe("function")
    cleanup() // inert — must not throw
    expect(appLogger.fatal).not.toHaveBeenCalled()
  })
})
