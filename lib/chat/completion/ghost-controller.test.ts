import { GhostController, type GhostScheduler } from "./ghost-controller"

/** Manual scheduler: capture the debounced fn so the test can flush it. */
function makeScheduler() {
  let pending: (() => void) | null = null
  const scheduler: GhostScheduler = {
    set: (fn) => {
      pending = fn
      return 1
    },
    clear: () => {
      pending = null
    },
  }
  return {
    scheduler,
    flush: () => {
      const fn = pending
      pending = null
      fn?.()
    },
    hasPending: () => pending !== null,
  }
}

/** Let queued microtasks (the async query body) settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe("GhostController", () => {
  it("does not query below the minChars floor", async () => {
    const query = jest.fn(async () => " suffix")
    const { scheduler, hasPending } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler, minChars: 3 })
    ctl.feed("hi")
    expect(hasPending()).toBe(false)
    expect(ctl.getView().ghost).toBe("")
    expect(query).not.toHaveBeenCalled()
  })

  it("debounces then shows the resolved ghost", async () => {
    const query = jest.fn(async () => " world")
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    expect(query).not.toHaveBeenCalled()
    flush()
    await tick()
    expect(query).toHaveBeenCalledWith("hello", expect.any(AbortSignal))
    expect(ctl.getView().ghost).toBe(" world")
  })

  it("serves a cached suffix without re-querying", async () => {
    const query = jest.fn(async () => " world")
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    flush()
    await tick()
    ctl.feed("hell") // shrink — different key, no cache
    ctl.feed("hello") // back to cached key
    expect(ctl.getView().ghost).toBe(" world")
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("re-queries after the cache TTL expires", async () => {
    let now = 1_000_000
    const query = jest.fn(async () => " world")
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({
      query,
      onChange: () => {},
      scheduler,
      now: () => now,
      cacheTtlMs: 1000,
    })
    ctl.feed("hello")
    flush()
    await tick()
    now += 2000
    ctl.feed("hello")
    flush()
    await tick()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("narrows the ghost live as the user types into it (no re-query)", async () => {
    const query = jest.fn(async () => " world peace")
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    flush()
    await tick()
    expect(ctl.getView().ghost).toBe(" world peace")
    ctl.feed("hello wor")
    expect(ctl.getView().ghost).toBe("ld peace")
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("ignores a stale result when the input moved on", async () => {
    let resolve!: (v: string | null) => void
    const query = jest.fn(() => new Promise<string | null>((r) => (resolve = r)))
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    flush()
    ctl.feed("hello there now") // not a forward-narrow of (no ghost yet) → re-query path
    resolve(" old") // late result for "hello"
    await tick()
    expect(ctl.getView().ghost).toBe("")
  })

  it("treats a thrown query as no suggestion", async () => {
    const query = jest.fn(async () => {
      throw new Error("boom")
    })
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    flush()
    await tick()
    expect(ctl.getView().ghost).toBe("")
  })

  it("accept() returns the joined value and clears the ghost", async () => {
    const query = jest.fn(async () => " world")
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    flush()
    await tick()
    expect(ctl.accept()).toBe("hello world")
    expect(ctl.getView().ghost).toBe("")
    expect(ctl.currentInput).toBe("hello world")
  })

  it("accept() returns null when there is no ghost", () => {
    const ctl = new GhostController({ query: async () => null, onChange: () => {} })
    expect(ctl.accept()).toBeNull()
  })

  it("dismiss() clears the ghost and cancels pending work", async () => {
    const query = jest.fn(async () => " world")
    const { scheduler, flush, hasPending } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    expect(hasPending()).toBe(true)
    ctl.dismiss()
    expect(hasPending()).toBe(false)
    flush()
    await tick()
    expect(ctl.getView().ghost).toBe("")
  })

  it("suppress clears any ghost and skips querying", async () => {
    const query = jest.fn(async () => " world")
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    flush()
    await tick()
    expect(ctl.getView().ghost).toBe(" world")
    ctl.feed("hello", { suppress: true })
    expect(ctl.getView().ghost).toBe("")
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("aborts the previous in-flight query when re-querying", async () => {
    const signals: AbortSignal[] = []
    const query = jest.fn((_input: string, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<string | null>(() => {}) // never resolves
    })
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange: () => {}, scheduler })
    ctl.feed("hello")
    flush()
    await tick()
    ctl.feed("hello again different")
    flush()
    await tick()
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })

  it("emits onChange on feed and on resolution", async () => {
    const onChange = jest.fn()
    const query = jest.fn(async () => " world")
    const { scheduler, flush } = makeScheduler()
    const ctl = new GhostController({ query, onChange, scheduler })
    ctl.feed("hello")
    expect(onChange).toHaveBeenCalledTimes(1)
    flush()
    await tick()
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})
