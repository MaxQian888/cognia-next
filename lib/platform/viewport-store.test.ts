/**
 * @jest-environment jsdom
 */
import { __resetViewportStoreForTests, getQuerySnapshot, subscribeToQuery } from "./viewport-store"

interface FakeMql {
  matches: boolean
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  fire: () => void
}

function installMatchMedia(initial: boolean): {
  spy: jest.Mock
  mqls: Map<string, FakeMql>
} {
  const mqls = new Map<string, FakeMql>()
  const spy = jest.fn((query: string): FakeMql => {
    // One MQL per query, persisted so the test can flip `matches` and `fire`.
    const cached = mqls.get(query)
    if (cached) return cached
    let listener: (() => void) | null = null
    const mql: FakeMql = {
      matches: initial,
      addEventListener: jest.fn((_evt: string, fn: () => void) => {
        listener = fn
      }),
      removeEventListener: jest.fn((_evt: string, fn: () => void) => {
        if (listener === fn) listener = null
      }),
      fire: () => listener?.(),
    }
    mqls.set(query, mql)
    return mql
  })
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: spy,
  })
  return { spy, mqls }
}

afterEach(() => {
  __resetViewportStoreForTests()
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  })
})

describe("getQuerySnapshot", () => {
  it("returns false when matchMedia is unavailable (SSR)", () => {
    expect(getQuerySnapshot("(min-width: 1px)")).toBe(false)
  })

  it("reflects the current match state", () => {
    installMatchMedia(true)
    expect(getQuerySnapshot("(min-width: 1024px)")).toBe(true)
  })

  it("memoizes the MediaQueryList per query (one matchMedia call)", () => {
    const { spy } = installMatchMedia(false)
    getQuerySnapshot("(min-width: 1024px)")
    getQuerySnapshot("(min-width: 1024px)")
    getQuerySnapshot("(min-width: 1024px)")
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("subscribeToQuery", () => {
  it("is a no-op when matchMedia is unavailable", () => {
    const unsub = subscribeToQuery("(min-width: 1px)", () => {})
    expect(typeof unsub).toBe("function")
    expect(() => unsub()).not.toThrow()
  })

  it("attaches a single change listener for multiple subscribers", () => {
    const { mqls } = installMatchMedia(false)
    const q = "(max-width: 767.98px)"
    const cb1 = jest.fn()
    const cb2 = jest.fn()
    const u1 = subscribeToQuery(q, cb1)
    const u2 = subscribeToQuery(q, cb2)

    const mql = mqls.get(q)!
    expect(mql.addEventListener).toHaveBeenCalledTimes(1)

    // A change notifies every subscriber.
    mql.matches = true
    mql.fire()
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
    expect(getQuerySnapshot(q)).toBe(true)

    u1()
    u2()
  })

  it("detaches the listener only when the last subscriber leaves", () => {
    const { mqls } = installMatchMedia(false)
    const q = "(max-width: 767.98px)"
    const u1 = subscribeToQuery(q, jest.fn())
    const u2 = subscribeToQuery(q, jest.fn())
    const mql = mqls.get(q)!

    u1()
    expect(mql.removeEventListener).not.toHaveBeenCalled()
    u2()
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1)
  })

  it("re-creates the entry (fresh matchMedia) after full unsubscribe", () => {
    const { spy } = installMatchMedia(false)
    const q = "(max-width: 767.98px)"
    subscribeToQuery(q, jest.fn())() // subscribe then immediately unsubscribe
    subscribeToQuery(q, jest.fn())()
    // Evicted after each unsubscribe → matchMedia called twice.
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
