import {
  StepMemoCache,
  iterationCacheKey,
  type DurableStepCompletion,
} from "@/lib/durable/idempotency"

describe("iterationCacheKey", () => {
  it("namespaces a child step by loop and iteration", () => {
    expect(iterationCacheKey("loop1", 0, "body")).toBe("loop1#0#body")
    expect(iterationCacheKey("loop1", 2, "body")).toBe("loop1#2#body")
  })

  it("keeps two iterations of the same body distinct", () => {
    expect(iterationCacheKey("loop1", 0, "body")).not.toBe(iterationCacheKey("loop1", 1, "body"))
  })
})

describe("StepMemoCache", () => {
  it("stores, reads and clears", () => {
    const cache = new StepMemoCache()
    expect(cache.has("a")).toBe(false)

    cache.set("a", { ok: true })
    expect(cache.has("a")).toBe(true)
    expect(cache.get("a")).toEqual({ ok: true })

    cache.clear()
    expect(cache.has("a")).toBe(false)
    expect(cache.get("a")).toBeUndefined()
  })

  it("distinguishes a stored undefined output from a missing step", () => {
    const cache = new StepMemoCache()
    cache.set("a", undefined)
    // `has` is what the runtimes branch on. A step that legitimately returned
    // undefined must still count as completed, or it reruns on every resume.
    expect(cache.has("a")).toBe(true)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.has("b")).toBe(false)
  })

  it("hydrates top-level completions under the bare step id", () => {
    const cache = new StepMemoCache().hydrateFrom([
      { stepId: "one", output: 1 },
      { stepId: "two", output: 2 },
    ])

    expect(cache.get("one")).toBe(1)
    expect(cache.get("two")).toBe(2)
  })

  it("hydrates loop-body completions under the per-iteration key ONLY", () => {
    const cache = new StepMemoCache().hydrateFrom([
      { stepId: "body", output: "i0", loopId: "loop1", iterationIndex: 0 },
    ])

    expect(cache.get(iterationCacheKey("loop1", 0, "body"))).toBe("i0")
    // The bare id must miss, otherwise iteration 1 would replay iteration 0's
    // output and the rest of the loop would be skipped.
    expect(cache.has("body")).toBe(false)
  })

  it("treats a partial loop stamp as a top-level completion", () => {
    const cache = new StepMemoCache().hydrateFrom([
      { stepId: "body", output: "x", loopId: "loop1" },
      { stepId: "other", output: "y", iterationIndex: 3 },
    ] as DurableStepCompletion[])

    expect(cache.get("body")).toBe("x")
    expect(cache.get("other")).toBe("y")
  })

  it("returns itself so hydration can chain", () => {
    const cache = new StepMemoCache()
    expect(cache.hydrateFrom([])).toBe(cache)
  })

  it("hydrates through an overridden set, so a redirecting subclass stays consistent", () => {
    class PrefixedCache extends StepMemoCache {
      constructor(
        private readonly inner: StepMemoCache,
        private readonly prefix: string
      ) {
        super()
      }
      override has(key: string): boolean {
        return this.inner.has(this.prefix + key)
      }
      override get(key: string): unknown {
        return this.inner.get(this.prefix + key)
      }
      override set(key: string, output: unknown): void {
        this.inner.set(this.prefix + key, output)
      }
    }

    const inner = new StepMemoCache()
    const view = new PrefixedCache(inner, "outer#0#")
    view.hydrateFrom([{ stepId: "child", output: 7 }])

    expect(inner.get("outer#0#child")).toBe(7)
    expect(view.get("child")).toBe(7)
  })

  it("lets a later completion win over an earlier one for the same step", () => {
    const cache = new StepMemoCache().hydrateFrom([
      { stepId: "one", output: "first" },
      { stepId: "one", output: "retried" },
    ])

    expect(cache.get("one")).toBe("retried")
  })
})
