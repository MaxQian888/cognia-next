import { InlineCompletionEngine, type InlineScheduler } from "./engine"
import type {
  InlineCompletionContext,
  InlineCompletionProvider,
  InlineEmitFn,
  InlineSuggestion,
} from "./types"

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

function manualProvider(
  id: string,
  produce: (ctx: InlineCompletionContext) => Promise<InlineSuggestion[]>
): InlineCompletionProvider {
  return { id, label: id, priority: 20, manual: true, getCompletions: (ctx) => produce(ctx) }
}

/** An async provider whose `produce` also receives the engine's partial channel. */
function emittingProvider(
  id: string,
  produce: (ctx: InlineCompletionContext, emit: InlineEmitFn) => Promise<InlineSuggestion[]>
): InlineCompletionProvider {
  return {
    id,
    label: id,
    priority: 30,
    sync: false,
    getCompletions: (ctx, _signal, emit) => produce(ctx, emit ?? (() => {})),
  }
}

/** An ai-source candidate with a stable id, as a streaming provider emits it. */
function streamHit(providerId: string, text: string): InlineSuggestion {
  return { id: `${providerId}:0`, text, source: "ai", providerId, score: 0.9 }
}

/** A promise plus the resolve handle, for a provider call the test completes by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function agentHit(text: string): InlineSuggestion {
  return { text, source: "agent", providerId: "manual", score: 0.85 }
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

describe("InlineCompletionEngine — manual tier", () => {
  it("never runs a manual provider from feed(), however long you wait", async () => {
    let calls = 0
    const { engine, scheduler } = build([
      manualProvider("manual", async () => {
        calls += 1
        return [agentHit("deploy the staging build")]
      }),
    ])
    engine.feed("deploy ")
    await drain()
    // The whole point of the tier: no debounce fires it, because one agent turn
    // per typing burst is the cost shape it exists to avoid.
    await scheduler.advance(10_000)
    expect(calls).toBe(0)
    expect(engine.getView().ghost).toBe("")
  })

  it("runs on requestManual() and merges into the candidate list", async () => {
    const { engine } = build([
      syncProvider("sync", () => [historyHit("deploy it")]),
      manualProvider("manual", async () => [agentHit("deploy the staging build")]),
    ])
    engine.feed("deploy ")
    await drain()
    expect(engine.getView().ghost).toBe("it")

    engine.requestManual()
    await drain()
    const view = engine.getView()
    // `agent` outranks `history`, so the requested answer is active — and the
    // history hit is still there to cycle back to.
    expect(view.ghost).toBe("the staging build")
    expect(view.candidates).toHaveLength(2)
    expect(view.manualPending).toBe(false)
  })

  it("reports manualAvailable so a surface knows whether to offer the key", async () => {
    const without = build([syncProvider("sync", () => [historyHit("x y")])])
    without.engine.feed("x ")
    await drain()
    expect(without.engine.getView().manualAvailable).toBe(false)

    const withManual = build([manualProvider("manual", async () => [])])
    withManual.engine.feed("x ")
    await drain()
    expect(withManual.engine.getView().manualAvailable).toBe(true)
  })

  it("reports manualPending while the turn is in flight", async () => {
    let release: (v: InlineSuggestion[]) => void = () => {}
    const { engine } = build([
      manualProvider("manual", () => new Promise<InlineSuggestion[]>((r) => (release = r))),
    ])
    engine.feed("deploy ")
    await drain()

    engine.requestManual()
    await drain()
    expect(engine.getView().manualPending).toBe(true)

    release([agentHit("deploy now")])
    await drain()
    expect(engine.getView().manualPending).toBe(false)
    expect(engine.getView().ghost).toBe("now")
  })

  it("ignores a second request while one is in flight", async () => {
    let calls = 0
    let release: (v: InlineSuggestion[]) => void = () => {}
    const { engine } = build([
      manualProvider("manual", () => {
        calls += 1
        return new Promise<InlineSuggestion[]>((r) => (release = r))
      }),
    ])
    engine.feed("deploy ")
    await drain()

    engine.requestManual()
    await drain()
    engine.requestManual()
    engine.requestManual()
    await drain()
    // A key the user can lean on must not fan out into three agent turns.
    expect(calls).toBe(1)
    release([])
    await drain()
  })

  it("serves a repeat request for the same draft from cache", async () => {
    let calls = 0
    const { engine } = build([
      manualProvider("manual", async () => {
        calls += 1
        return [agentHit("deploy now")]
      }),
    ])
    engine.feed("deploy ")
    await drain()

    engine.requestManual()
    await drain()
    engine.dismiss()
    engine.feed("deploy ")
    await drain()
    engine.requestManual()
    await drain()

    expect(calls).toBe(1)
    expect(engine.getView().ghost).toBe("now")
  })

  it("does not let an auto-tier round answer a later manual request", async () => {
    let manualCalls = 0
    const { engine, scheduler } = build([
      asyncProvider("async", async () => [aiHit("deploy it")]),
      manualProvider("manual", async () => {
        manualCalls += 1
        return [agentHit("deploy the staging build")]
      }),
    ])
    engine.feed("deploy ")
    await scheduler.advance(DEBOUNCE)
    expect(engine.getView().ghost).toBe("it")

    // The async tier cached this exact draft. Asking explicitly must still run
    // the agent — the user asked precisely because the cheap answer was not it.
    engine.requestManual()
    await drain()
    expect(manualCalls).toBe(1)
    expect(engine.getView().ghost).toBe("the staging build")
  })

  it("survives typing forward along the suggestion without re-running", async () => {
    let calls = 0
    const { engine } = build([
      manualProvider("manual", async () => {
        calls += 1
        return [agentHit("deploy the staging build")]
      }),
    ])
    engine.feed("deploy ")
    await drain()
    engine.requestManual()
    await drain()

    engine.feed("deploy the ")
    await drain()
    expect(engine.getView().ghost).toBe("staging build")
    expect(calls).toBe(1)
  })

  it("still lands when the user typed along while the turn ran", async () => {
    let release: (v: InlineSuggestion[]) => void = () => {}
    const { engine } = build([
      manualProvider("manual", () => new Promise<InlineSuggestion[]>((r) => (release = r))),
    ])
    engine.feed("deploy ")
    await drain()
    engine.requestManual()
    await drain()

    // Typing forward is the normal thing to do while waiting on a slow turn.
    // The answer the user paid for must survive it.
    engine.feed("deploy the ")
    await drain()
    release([agentHit("deploy the staging build")])
    await drain()

    expect(engine.getView().ghost).toBe("staging build")
    expect(engine.getView().manualPending).toBe(false)
  })

  it("drops an answer whose draft moved on, and clears the spinner", async () => {
    let release: (v: InlineSuggestion[]) => void = () => {}
    const { engine } = build([
      manualProvider("manual", () => new Promise<InlineSuggestion[]>((r) => (release = r))),
    ])
    engine.feed("deploy ")
    await drain()
    engine.requestManual()
    await drain()

    // The user kept typing somewhere the answer cannot cover.
    engine.feed("something else entirely")
    await drain()
    release([agentHit("deploy the staging build")])
    await drain()

    expect(engine.getView().ghost).toBe("")
    expect(engine.getView().manualPending).toBe(false)
  })

  it("keeps the empty view identity-stable so surfaces can bail out", async () => {
    const { engine } = build([manualProvider("manual", async () => [])])
    engine.feed("deploy ")
    await drain()
    const first = engine.getView()
    expect(first.suggestion).toBeNull()
    // Both surfaces push this into setState; a fresh object each call would
    // re-render the composer on every no-op notification.
    expect(engine.getView()).toBe(first)

    // A run that produces nothing ends on the same flags, so the SAME object
    // comes back — no re-render for a request that found nothing.
    engine.requestManual()
    await drain()
    expect(engine.getView()).toBe(first)
  })

  it("allocates a new empty view when a flag actually changes", async () => {
    let release: (v: InlineSuggestion[]) => void = () => {}
    const { engine } = build([
      manualProvider("manual", () => new Promise<InlineSuggestion[]>((r) => (release = r))),
    ])
    engine.feed("deploy ")
    await drain()
    const idle = engine.getView()

    engine.requestManual()
    await drain()
    const pending = engine.getView()
    // `manualPending` flipped, so the surface MUST see a new object or the
    // spinner never appears.
    expect(pending).not.toBe(idle)
    expect(pending.manualPending).toBe(true)
    expect(engine.getView()).toBe(pending)

    release([])
    await drain()
    expect(engine.getView().manualPending).toBe(false)
  })

  it("is a no-op with no manual provider registered", async () => {
    const { engine } = build([syncProvider("sync", () => [historyHit("fix it")])])
    engine.feed("fix ")
    await drain()
    engine.requestManual()
    await drain()
    expect(engine.getView().ghost).toBe("it")
  })

  it("treats a provider that sets both manual and sync as manual", async () => {
    let calls = 0
    const both: InlineCompletionProvider = {
      id: "both",
      label: "both",
      sync: true,
      manual: true,
      getCompletions: async () => {
        calls += 1
        return [agentHit("deploy now")]
      },
    }
    const { engine } = build([both])
    engine.feed("deploy ")
    await drain()
    expect(calls).toBe(0)

    engine.requestManual()
    await drain()
    expect(calls).toBe(1)
  })
})

describe("InlineCompletionEngine — streaming partials", () => {
  it("paints emitted partials before the call settles", async () => {
    const call = deferred<InlineSuggestion[]>()
    const { engine, scheduler } = build([
      emittingProvider("async", async (_ctx, emit) => {
        emit([streamHit("async", "fix the")])
        emit([streamHit("async", "fix the build")])
        return call.promise
      }),
    ])
    engine.feed("fix ")
    // `querying` is true only once the debounce has fired — the armed timer
    // alone must not flash a "thinking" state on every keystroke.
    expect(engine.getView().querying).toBe(false)
    await scheduler.advance(DEBOUNCE)
    expect(engine.getView().querying).toBe(true)
    expect(engine.getView().ghost).toBe("the build")
    expect(engine.getView().streaming).toBe(true)

    call.resolve([streamHit("async", "fix the build please")])
    await drain()
    expect(engine.getView().ghost).toBe("the build please")
    expect(engine.getView().streaming).toBe(false)
    expect(engine.getView().querying).toBe(false)
  })

  it("keeps a cycled-to streaming candidate pinned as its text grows", async () => {
    const calls = deferred<InlineSuggestion[]>()
    let emitA: InlineEmitFn = () => {}
    let emitB: InlineEmitFn = () => {}
    const { engine, scheduler } = build([
      emittingProvider("a", async (_ctx, emit) => {
        emitA = emit
        emit([streamHit("a", "fix alpha")])
        return calls.promise
      }),
      emittingProvider("b", async (_ctx, emit) => {
        emitB = emit
        emit([streamHit("b", "fix beta")])
        return calls.promise
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)

    // Both streamers are ranked ai-source; `b` sits second (arrival order).
    // Cycle onto it — the pin must ride on its stable `id`, because its `text`
    // is about to mutate.
    engine.cycleTo(1)
    expect(engine.getView().suggestion?.providerId).toBe("b")
    emitB([streamHit("b", "fix beta and more")])
    await drain()
    // With text-keyed pinning this emit would have lost the pin ("fix beta" ≠
    // "fix beta and more") and snapped the view back to index 0.
    expect(engine.getView().suggestion?.text).toBe("fix beta and more")
    expect(engine.getView().suggestion?.providerId).toBe("b")
    // And the pin also survives a grow that temporarily drops the candidate
    // out of the ranked list (draft moved past it is covered separately; here
    // a sibling simply emits again).
    emitA([streamHit("a", "fix alpha extended")])
    await drain()
    expect(engine.getView().suggestion?.providerId).toBe("b")

    calls.resolve([])
    await drain()
  })

  it("routes each emission to the provider that made it", async () => {
    const callA = deferred<InlineSuggestion[]>()
    const callB = deferred<InlineSuggestion[]>()
    const { engine, scheduler } = build([
      emittingProvider("a", async (_ctx, emit) => {
        emit([streamHit("a", "fix alpha")])
        return callA.promise
      }),
      emittingProvider("b", async (_ctx, emit) => {
        emit([streamHit("b", "fix beta")])
        return callB.promise
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    const texts = engine.getView().candidates.map((c) => c.text)
    expect(texts).toEqual(expect.arrayContaining(["fix alpha", "fix beta"]))
    callA.resolve([streamHit("a", "fix alpha")])
    callB.resolve([streamHit("b", "fix beta")])
    await drain()
    expect(engine.getView().candidates.map((c) => c.text)).toEqual(
      expect.arrayContaining(["fix alpha", "fix beta"])
    )
  })

  it("ignores partials emitted by a run that was superseded", async () => {
    let staleEmit: InlineEmitFn = () => {}
    const calls: string[] = []
    const { engine, scheduler } = build([
      emittingProvider("async", async (ctx, emit) => {
        calls.push(ctx.draft)
        if (calls.length === 1) staleEmit = emit
        return [aiHit(`${ctx.draft}!`)]
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    // Diverge — the first run is aborted; its late emit must not resurrect a
    // candidate for the old draft.
    engine.feed("fix z")
    await scheduler.advance(DEBOUNCE)
    staleEmit([streamHit("async", "fix the stale ghost")])
    await drain()
    expect(engine.getView().ghost).toBe("!")
    expect(engine.getView().candidates.map((c) => c.text)).toEqual(["fix z!"])
  })

  it("keeps an in-flight candidate when the draft moves past its partial", async () => {
    const call = deferred<InlineSuggestion[]>()
    let emitNow: InlineEmitFn = () => {}
    const calls: string[] = []
    const { engine, scheduler } = build([
      emittingProvider("async", async (ctx, emit) => {
        calls.push(ctx.draft)
        emitNow = emit
        emit([streamHit("async", "fix the")])
        return call.promise
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    expect(engine.getView().ghost).toBe("the")

    // The user types AHEAD of the streamed prefix. Strict `extendsDraft` would
    // kill the candidate and re-bill; the relaxed narrow keeps the run alive —
    // but the prefix is not a usable completion yet, so nothing is painted and
    // nothing can be accepted.
    engine.feed("fix the b")
    await drain()
    expect(calls).toEqual(["fix "])
    expect(engine.getView().ghost).toBe("")
    expect(engine.accept()).toBeNull()

    // The stream catches up and the candidate reappears without a re-query.
    emitNow([streamHit("async", "fix the build")])
    await drain()
    expect(engine.getView().ghost).toBe("uild")
    call.resolve([streamHit("async", "fix the build")])
    await drain()
    expect(engine.getView().ghost).toBe("uild")
    expect(calls).toEqual(["fix "])
  })

  it("re-arms the timeout watchdog on every emitted partial", async () => {
    const { engine, scheduler } = build(
      [
        emittingProvider(
          "async",
          (_ctx, emit) =>
            new Promise<InlineSuggestion[]>((resolve) => {
              // Chunks 900ms apart under a 1s watchdog: each re-arms it, so the
              // stream is alive the whole time — the watchdog bounds SILENCE,
              // not total duration.
              scheduler.set(() => emit([streamHit("async", "fix a")]), 900)
              scheduler.set(() => emit([streamHit("async", "fix ab")]), 1800)
              scheduler.set(() => resolve([streamHit("async", "fix abc")]), 2500)
            })
        ),
      ],
      { providerTimeoutMs: 1_000 }
    )
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    await scheduler.advance(2_500)
    expect(engine.getView().ghost).toBe("abc")
    expect(engine.getView().completionError).toBe(false)
  })
})

describe("InlineCompletionEngine — failure and retry", () => {
  it("flags a provider throw as a completion error, not silence", async () => {
    const { engine, scheduler } = build([
      asyncProvider("async", async () => {
        throw new Error("upstream down")
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    await drain()
    expect(engine.getView().ghost).toBe("")
    expect(engine.getView().completionError).toBe(true)
    expect(engine.getView().querying).toBe(false)
  })

  it("flags a timeout as a completion error", async () => {
    const { engine, scheduler } = build(
      [asyncProvider("hang", () => new Promise<InlineSuggestion[]>(() => {}))],
      { providerTimeoutMs: 1_000 }
    )
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    await scheduler.advance(1_000)
    expect(engine.getView().completionError).toBe(true)
  })

  it("retry() re-runs the failed round immediately, bypassing the debounce", async () => {
    let calls = 0
    const { engine, scheduler } = build([
      asyncProvider("async", async (ctx) => {
        calls += 1
        if (calls === 1) throw new Error("blip")
        return [aiHit(`${ctx.draft}fixed`)]
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    await drain()
    expect(engine.getView().completionError).toBe(true)

    engine.retry()
    // No debounce wait — the user already asked.
    await drain()
    expect(calls).toBe(2)
    expect(engine.getView().ghost).toBe("fixed")
    expect(engine.getView().completionError).toBe(false)
  })

  it("does not cache a failed round — the same draft is queryable again", async () => {
    let calls = 0
    const { engine, scheduler } = build(
      [
        asyncProvider("async", async (ctx) => {
          calls += 1
          if (calls === 1) throw new Error("blip")
          return [aiHit(`${ctx.draft}back`)]
        }),
      ],
      { cacheTtlMs: 60_000 }
    )
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    await drain()
    engine.feed("other")
    await scheduler.advance(DEBOUNCE)
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    await drain()
    // Three queries, not two — the failure was never written to the cache.
    expect(calls).toBe(3)
    expect(engine.getView().ghost).toBe("back")
  })

  it("retry() is a no-op when nothing failed or a run is in flight", async () => {
    const call = deferred<InlineSuggestion[]>()
    let calls = 0
    const { engine, scheduler } = build([
      asyncProvider("async", async (ctx) => {
        calls += 1
        void ctx
        return call.promise
      }),
    ])
    engine.feed("fix ")
    await scheduler.advance(DEBOUNCE)
    engine.retry()
    await drain()
    expect(calls).toBe(1)

    call.resolve([])
    await drain()
    // A settled empty round is not a failure — retry stays inert.
    engine.retry()
    await drain()
    expect(calls).toBe(1)
  })

  it("re-runs a failed manual round from retry()", async () => {
    let calls = 0
    const { engine } = build([
      manualProvider("manual", async () => {
        calls += 1
        if (calls === 1) throw new Error("turn failed")
        return [agentHit("deploy now")]
      }),
    ])
    engine.feed("deploy ")
    await drain()
    engine.requestManual()
    await drain()
    expect(engine.getView().completionError).toBe(true)
    expect(engine.getView().manualPending).toBe(false)

    engine.retry()
    await drain()
    expect(calls).toBe(2)
    expect(engine.getView().ghost).toBe("now")
  })
})
