import { InlineCompletionEngine, type InlineScheduler } from "./engine"
import type { InlineCompletionContext, InlineCompletionProvider, InlineSuggestion } from "./types"

/** Drain the microtask queue so provider promises settle. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * A virtual-clock scheduler. `advance` fires only the tasks that are actually
 * due, so the short debounce and the long per-provider timeout stay
 * distinguishable (flushing everything at once would let the timeout win every
 * race and hide real behaviour).
 */
class FakeScheduler implements InlineScheduler {
  now = 0
  private seq = 0
  private tasks: { id: number; at: number; fn: () => void }[] = []

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.tasks.push({ id, at: this.now + ms, fn })
    return id
  }

  clear(handle: unknown): void {
    this.tasks = this.tasks.filter((t) => t.id !== handle)
  }

  get pending(): number {
    return this.tasks.length
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      const due = this.tasks.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.tasks = this.tasks.filter((t) => t !== due)
      this.now = due.at
      due.fn()
      await drain()
    }
    this.now = target
  }
}

const DEBOUNCE = 10

function syncProvider(
  id: string,
  produce: (ctx: InlineCompletionContext) => InlineSuggestion[]
): InlineCompletionProvider {
  return {
    id,
    label: id,
    priority: 10,
    sync: true,
    getCompletions: async (ctx) => produce(ctx),
  }
}

function asyncProvider(
  id: string,
  produce: (ctx: InlineCompletionContext) => Promise<InlineSuggestion[]>
): InlineCompletionProvider {
  return { id, label: id, priority: 30, sync: false, getCompletions: (ctx) => produce(ctx) }
}

function historyHit(text: string): InlineSuggestion {
  return { text, source: "history", providerId: "sync", score: 0.5 }
}

function aiHit(text: string): InlineSuggestion {
  return { text, source: "ai", providerId: "async", score: 0.9 }
}

interface Harness {
  engine: InlineCompletionEngine
  scheduler: FakeScheduler
  changes: () => number
}

function build(
  providers: InlineCompletionProvider[],
  overrides: Partial<ConstructorParameters<typeof InlineCompletionEngine>[0]> = {}
): Harness {
  const scheduler = new FakeScheduler()
  let changes = 0
  const engine = new InlineCompletionEngine({
    providers,
    buildContext: (draft) => ({
      draft,
      caret: draft.length,
      history: [],
      commands: [],
      surface: "gui",
    }),
    onChange: () => {
      changes += 1
    },
    debounceMs: DEBOUNCE,
    scheduler,
    now: () => scheduler.now,
    ...overrides,
  })
  return { engine, scheduler, changes: () => changes }
}

describe("InlineCompletionEngine — local tier", () => {
  it("paints a suggestion without waiting for any timer", async () => {
    const { engine, scheduler } = build([syncProvider("sync", () => [historyHit("fix the build")])])
    engine.feed("fix ")
    await drain()
    expect(engine.getView().ghost).toBe("the build")
    // Nothing was scheduled: there is no async provider to debounce.
    expect(scheduler.pending).toBe(0)
  })

  it("reports no pending work when only sync providers exist", async () => {
    const { engine } = build([syncProvider("sync", () => [historyHit("fix it")])])
    engine.feed("fix ")
    await drain()
    expect(engine.getView().pending).toBe(false)
  })

  it("exposes the active suggestion with its badge", async () => {
    const { engine } = build([
      syncProvider("sync", () => [
        { text: "fix it", source: "history", providerId: "sync", detail: "history" },
      ]),
    ])
    engine.feed("fix ")
    await drain()
    expect(engine.getView().suggestion?.detail).toBe("history")
  })

  it("suggests nothing below the minimum draft length", async () => {
    const { engine } = build([syncProvider("sync", () => [historyHit("fix it")])], { minChars: 3 })
    engine.feed("fi")
    await drain()
    expect(engine.getView().ghost).toBe("")
  })

  it("suggests nothing while suppressed", async () => {
    const { engine } = build([syncProvider("sync", () => [historyHit("fix it")])])
    engine.feed("fix ", { suppress: true })
    await drain()
    expect(engine.getView().ghost).toBe("")
  })

  it("builds the context from the live draft", async () => {
    const seen: string[] = []
    const { engine } = build([
      syncProvider("sync", (ctx) => {
        seen.push(ctx.draft)
        return []
      }),
    ])
    engine.feed("abc")
    await drain()
    expect(seen).toEqual(["abc"])
  })
})

describe("InlineCompletionEngine — model tier", () => {
  it("debounces the async providers and upgrades the ghost in place", async () => {
    const calls: string[] = []
    const { engine, scheduler } = build([
      syncProvider("sync", () => [historyHit("fix the old way")]),
      asyncProvider("async", async (ctx) => {
        calls.push(ctx.draft)
        return [aiHit("fix the build please")]
      }),
    ])

    engine.feed("fix ")
    await drain()
    // Local tier already visible; the model has not been asked yet.
    expect(engine.getView().ghost).toBe("the old way")
    expect(engine.getView().pending).toBe(true)
    expect(calls).toEqual([])

    await scheduler.advance(DEBOUNCE)
    // The higher-priority `ai` source takes over the ghost.
    expect(engine.getView().ghost).toBe("the build please")
    expect(engine.getView().pending).toBe(false)
    expect(calls).toEqual(["fix "])
  })

  it("does not query the model while the user keeps typing", async () => {
    const calls: string[] = []
    const { engine, scheduler } = build([
      asyncProvider("async", async (ctx) => {
        calls.push(ctx.draft)
        return [aiHit(`${ctx.draft}done`)]
      }),
    ])
    engine.feed("f")
    engine.feed("fi")
    engine.feed("fix")
    await drain()
    await scheduler.advance(DEBOUNCE)
    expect(calls).toEqual(["fix"])
  })

  it("ignores a reply whose draft has moved on", async () => {
    let release: (v: InlineSuggestion[]) => void = () => {}
    const { engine, scheduler } = build([
      asyncProvider(
        "async",
        () =>
          new Promise<InlineSuggestion[]>((resolve) => {
            release = resolve
          })
      ),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    // The user typed something unrelated before the model answered.
    engine.feed("totally different")
    release([aiHit("fix the build")])
    await drain()
    expect(engine.getView().ghost).toBe("")
  })

  it("serves a repeated draft from cache instead of re-billing the model", async () => {
    const calls: string[] = []
    const { engine, scheduler } = build([
      asyncProvider("async", async (ctx) => {
        calls.push(ctx.draft)
        return [aiHit(`${ctx.draft}done`)]
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    engine.feed("other draft")
    await scheduler.advance(DEBOUNCE)
    engine.feed("fix ")
    await drain()
    expect(engine.getView().ghost).toBe("done")
    expect(engine.getView().pending).toBe(false)
    expect(calls).toEqual(["fix ", "other draft"])
  })

  it("re-queries once the cached entry has expired", async () => {
    const calls: string[] = []
    const { engine, scheduler } = build(
      [
        asyncProvider("async", async (ctx) => {
          calls.push(ctx.draft)
          return [aiHit(`${ctx.draft}done`)]
        }),
      ],
      { cacheTtlMs: 100 }
    )
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    engine.feed("other draft")
    await scheduler.advance(500)
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    expect(calls).toEqual(["fix ", "other draft", "fix "])
  })

  it("isolates a provider that throws", async () => {
    const { engine, scheduler } = build([
      asyncProvider("boom", async () => {
        throw new Error("provider exploded")
      }),
      asyncProvider("ok", async () => [aiHit("fix the build")]),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    expect(engine.getView().ghost).toBe("the build")
  })

  it("abandons a provider that hangs past its timeout", async () => {
    const { engine, scheduler } = build(
      [asyncProvider("hang", () => new Promise<InlineSuggestion[]>(() => {}))],
      { providerTimeoutMs: 1_000 }
    )
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    expect(engine.getView().pending).toBe(true)
    await scheduler.advance(1_000)
    expect(engine.getView().pending).toBe(false)
    expect(engine.getView().ghost).toBe("")
  })

  it("does not cache a timeout, so the same draft is retried", async () => {
    // A timeout resolves as `[]`, which looks exactly like "no suggestions".
    // Caching it would serve the miss for the whole TTL, so a provider that is
    // merely slow would read as permanently empty.
    const calls: string[] = []
    let hang = true
    const { engine, scheduler } = build(
      [
        asyncProvider("slow", async (ctx) => {
          calls.push(ctx.draft)
          if (hang) return await new Promise<InlineSuggestion[]>(() => {})
          return [aiHit("fix the build")]
        }),
      ],
      { providerTimeoutMs: 1_000, cacheTtlMs: 60_000 }
    )
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    await scheduler.advance(1_000)
    expect(engine.getView().ghost).toBe("")

    hang = false
    engine.feed("other")
    await scheduler.advance(DEBOUNCE)
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    expect(calls).toEqual(["fix ", "other", "fix "])
    expect(engine.getView().ghost).toBe("the build")
  })

  it("aborts the request behind a timed-out provider", async () => {
    // Losing the race does not stop the work: an un-aborted call keeps running
    // and, for a model-backed provider, keeps billing after nothing is reading.
    let observed: AbortSignal | undefined
    const { engine, scheduler } = build(
      [
        asyncProvider("hang", (ctx) => {
          void ctx
          return new Promise<InlineSuggestion[]>(() => {})
        }),
      ],
      { providerTimeoutMs: 1_000 }
    )
    const provider = (engine as unknown as { asyncProviders: InlineCompletionProvider[] })
      .asyncProviders[0]
    const original = provider.getCompletions
    provider.getCompletions = (ctx, signal) => {
      observed = signal
      return original(ctx, signal)
    }
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    expect(observed?.aborted).toBe(false)
    await scheduler.advance(1_000)
    expect(observed?.aborted).toBe(true)
  })

  it("keeps sibling providers alive when one times out", async () => {
    // The timeout is per provider: cancelling the shared run would throw away
    // an answer that was still on its way.
    const { engine, scheduler } = build(
      [
        asyncProvider("hang", () => new Promise<InlineSuggestion[]>(() => {})),
        asyncProvider(
          "slower",
          () =>
            new Promise<InlineSuggestion[]>((resolve) => {
              scheduler.set(() => resolve([aiHit("fix the build")]), 500)
            })
        ),
      ],
      { providerTimeoutMs: 1_000 }
    )
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    await scheduler.advance(1_000)
    expect(engine.getView().ghost).toBe("the build")
  })
})

describe("InlineCompletionEngine — live narrow", () => {
  it("shaves the ghost as the user types into it, without re-querying", async () => {
    const calls: string[] = []
    const { engine, scheduler } = build([
      asyncProvider("async", async (ctx) => {
        calls.push(ctx.draft)
        return [aiHit("fix the build")]
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    expect(engine.getView().ghost).toBe("the build")

    engine.feed("fix t")
    await drain()
    expect(engine.getView().ghost).toBe("he build")
    expect(calls).toEqual(["fix "])
    expect(scheduler.pending).toBe(0)
  })

  it("drops the ghost when the user diverges from it", async () => {
    const { engine, scheduler } = build([
      asyncProvider("async", async () => [aiHit("fix the build")]),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    engine.feed("fix z")
    await drain()
    expect(engine.getView().ghost).toBe("")
  })

  it("re-queries after divergence", async () => {
    const calls: string[] = []
    const { engine, scheduler } = build([
      asyncProvider("async", async (ctx) => {
        calls.push(ctx.draft)
        return [aiHit(`${ctx.draft}!`)]
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    engine.feed("fix z")
    await scheduler.advance(DEBOUNCE)
    expect(calls).toEqual(["fix ", "fix z"])
    expect(engine.getView().ghost).toBe("!")
  })
})

describe("InlineCompletionEngine — acceptance and cycling", () => {
  it("accept returns the completed draft and clears the ghost", async () => {
    const { engine } = build([syncProvider("sync", () => [historyHit("fix the build")])])
    engine.feed("fix ")
    await drain()
    expect(engine.accept()).toBe("fix the build")
    expect(engine.getView().ghost).toBe("")
    expect(engine.currentDraft).toBe("fix the build")
  })

  it("accept returns null with nothing to accept", () => {
    const { engine } = build([])
    expect(engine.accept()).toBeNull()
  })

  it("cycles through candidates and wraps", async () => {
    const { engine } = build([
      syncProvider("sync", () => [historyHit("fix a"), historyHit("fix b")]),
    ])
    engine.feed("fix ")
    await drain()
    expect(engine.getView().ghost).toBe("a")
    engine.cycleNext()
    expect(engine.getView().ghost).toBe("b")
    engine.cycleNext()
    expect(engine.getView().ghost).toBe("a")
    engine.cyclePrev()
    expect(engine.getView().ghost).toBe("b")
  })

  it("cycling is a no-op with a single candidate", async () => {
    const { engine } = build([syncProvider("sync", () => [historyHit("fix a")])])
    engine.feed("fix ")
    await drain()
    engine.cycleNext()
    expect(engine.getView().index).toBe(0)
  })

  it("keeps a cycled-to candidate when a late model reply re-ranks the list", async () => {
    const { engine, scheduler } = build([
      syncProvider("sync", () => [historyHit("fix a"), historyHit("fix b")]),
      asyncProvider("async", async () => [aiHit("fix c")]),
    ])
    engine.feed("fix ")
    await drain()
    engine.cycleNext()
    expect(engine.getView().ghost).toBe("b")

    await scheduler.advance(DEBOUNCE)
    // "fix c" now ranks first, but the user's explicit choice still shows.
    expect(engine.getView().ghost).toBe("b")
    expect(engine.getView().candidates[0].text).toBe("fix c")
  })

  it("accepts the cycled-to candidate, not the top-ranked one", async () => {
    const { engine } = build([
      syncProvider("sync", () => [historyHit("fix a"), historyHit("fix b")]),
    ])
    engine.feed("fix ")
    await drain()
    engine.cycleNext()
    expect(engine.accept()).toBe("fix b")
  })

  it("drops a pinned choice once the draft moves somewhere it cannot apply", async () => {
    const { engine } = build([
      syncProvider("sync", (ctx) =>
        ctx.draft === "fix " ? [historyHit("fix a"), historyHit("fix b")] : [historyHit("zzz one")]
      ),
    ])
    engine.feed("fix ")
    await drain()
    engine.cycleNext()
    engine.feed("zzz")
    await drain()
    expect(engine.getView().ghost).toBe(" one")
    expect(engine.getView().index).toBe(0)
  })
})

describe("InlineCompletionEngine — lifecycle", () => {
  it("dismiss clears the ghost but keeps the draft", async () => {
    const { engine } = build([syncProvider("sync", () => [historyHit("fix the build")])])
    engine.feed("fix ")
    await drain()
    engine.dismiss()
    expect(engine.getView().ghost).toBe("")
    expect(engine.currentDraft).toBe("fix ")
  })

  it("notifies the surface as the view changes", async () => {
    const { engine, changes } = build([syncProvider("sync", () => [historyHit("fix it")])])
    engine.feed("fix ")
    await drain()
    expect(changes()).toBeGreaterThan(0)
  })

  it("stops accepting work after dispose", async () => {
    const { engine, scheduler } = build([syncProvider("sync", () => [historyHit("fix it")])])
    engine.dispose()
    engine.feed("fix ")
    await drain()
    expect(engine.getView().ghost).toBe("")
    expect(scheduler.pending).toBe(0)
  })

  it("cancels a scheduled query on dispose", async () => {
    const calls: string[] = []
    const { engine, scheduler } = build([
      asyncProvider("async", async (ctx) => {
        calls.push(ctx.draft)
        return []
      }),
    ])
    engine.feed("fix ")
    engine.dispose()
    await scheduler.advance(DEBOUNCE)
    expect(calls).toEqual([])
  })
})
