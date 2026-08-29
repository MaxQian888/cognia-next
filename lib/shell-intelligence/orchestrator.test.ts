import { CompletionScheduler, rankCompletions } from "./orchestrator"
import { MAX_COMPLETIONS, type ShellCompletion, type ShellIntelligenceRequest } from "./types"

const candidate = (over: Partial<ShellCompletion> = {}): ShellCompletion => ({
  label: "x",
  insertText: "x",
  from: 0,
  to: 1,
  kind: "path",
  ...over,
})

describe("rankCompletions", () => {
  it("dedupes candidates that write the same text over the same span", () => {
    const out = rankCompletions([
      candidate({ insertText: "git", kind: "path" }),
      candidate({ insertText: "git", kind: "command" }),
    ])
    expect(out).toHaveLength(1)
  })

  it("keeps the higher-priority kind when deduping", () => {
    const out = rankCompletions([
      candidate({ insertText: "git", kind: "path" }),
      candidate({ insertText: "git", kind: "command" }),
    ])
    expect(out[0].kind).toBe("command")
  })

  it("inherits a detail the winner lacks from the duplicate", () => {
    const out = rankCompletions([
      candidate({ insertText: "git", kind: "command" }),
      candidate({ insertText: "git", kind: "path", detail: "version control" }),
    ])
    expect(out[0]).toMatchObject({ kind: "command", detail: "version control" })
  })

  it("keeps candidates that write the same text over DIFFERENT spans", () => {
    const out = rankCompletions([
      candidate({ insertText: "src", from: 0, to: 3 }),
      candidate({ insertText: "src", from: 4, to: 7 }),
    ])
    expect(out).toHaveLength(2)
  })

  it("ranks semantic answers before the filesystem fallback", () => {
    const out = rankCompletions([
      candidate({ insertText: "aaa", kind: "path" }),
      candidate({ insertText: "bbb", kind: "directory" }),
      candidate({ insertText: "ccc", kind: "argument" }),
      candidate({ insertText: "ddd", kind: "option" }),
      candidate({ insertText: "eee", kind: "command" }),
      candidate({ insertText: "fff", kind: "builtin" }),
    ])
    expect(out.map((c) => c.kind)).toEqual([
      "builtin",
      "command",
      "option",
      "argument",
      "directory",
      "path",
    ])
  })

  it("puts the closest match first within one kind", () => {
    const out = rankCompletions([
      candidate({ insertText: "git-lfs", kind: "command" }),
      candidate({ insertText: "git", kind: "command" }),
    ])
    expect(out.map((c) => c.insertText)).toEqual(["git", "git-lfs"])
  })

  it("caps the list", () => {
    const many = Array.from({ length: MAX_COMPLETIONS + 25 }, (_, i) =>
      candidate({ insertText: `cmd${String(i).padStart(3, "0")}`, kind: "command" })
    )
    expect(rankCompletions(many)).toHaveLength(MAX_COMPLETIONS)
  })

  it("returns nothing for nothing", () => {
    expect(rankCompletions([])).toEqual([])
  })
})

describe("CompletionScheduler", () => {
  const request = (line: string): ShellIntelligenceRequest => ({
    line,
    cursor: line.length,
    cwd: "/work",
    shell: { path: "/bin/zsh", kind: "zsh", source: "setting" },
    availability: "full",
  })

  /** Deferred host source so a slow answer can be resolved on demand. */
  function deferredSources() {
    const pending: Array<{ prefix: string; resolve: (names: string[]) => void }> = []
    return {
      pending,
      sources: {
        listPathExecutables: ({ prefix }: { prefix: string }) =>
          new Promise<string[]>((resolve) => pending.push({ prefix, resolve })),
        completePaths: async () => [],
      },
    }
  }

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  /** Drain the microtask queue — `collectCandidates` awaits several levels. */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  it("debounces: nothing runs before the delay elapses", () => {
    const { pending, sources } = deferredSources()
    const scheduler = new CompletionScheduler({ sources, debounceMs: 80 })
    scheduler.request(request("kub"), () => {})
    expect(pending).toHaveLength(0)
    jest.advanceTimersByTime(80)
    expect(pending).toHaveLength(1)
  })

  it("collapses a burst of keystrokes into one query", () => {
    const { pending, sources } = deferredSources()
    const scheduler = new CompletionScheduler({ sources, debounceMs: 80 })
    for (const line of ["k", "ku", "kub"]) scheduler.request(request(line), () => {})
    jest.advanceTimersByTime(80)
    expect(pending).toHaveLength(1)
    expect(pending[0].prefix).toBe("kub")
  })

  it("discards a stale answer that lands after a newer request", async () => {
    const { pending, sources } = deferredSources()
    const scheduler = new CompletionScheduler({ sources, debounceMs: 0 })
    const seen: string[][] = []

    scheduler.request(request("k"), (r) => seen.push(r.completions.map((c) => c.insertText)))
    jest.advanceTimersByTime(0)
    const slow = pending[0]

    scheduler.request(request("kub"), (r) => seen.push(r.completions.map((c) => c.insertText)))
    jest.advanceTimersByTime(0)
    const fast = pending[1]

    fast.resolve(["kubectl"])
    await flush()
    slow.resolve(["kill", "kubectl"])
    await flush()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("kubectl")
  })

  it("cancel() stops a pending query from ever firing", () => {
    const { pending, sources } = deferredSources()
    const scheduler = new CompletionScheduler({ sources, debounceMs: 80 })
    scheduler.request(request("kub"), () => {})
    scheduler.cancel()
    jest.advanceTimersByTime(200)
    expect(pending).toHaveLength(0)
    expect(scheduler.busy).toBe(false)
  })

  it("cancel() suppresses the result of an already-running query", async () => {
    const { pending, sources } = deferredSources()
    const scheduler = new CompletionScheduler({ sources, debounceMs: 0 })
    const onResult = jest.fn()
    scheduler.request(request("kub"), onResult)
    jest.advanceTimersByTime(0)
    scheduler.cancel()
    pending[0].resolve(["kubectl"])
    await flush()
    expect(onResult).not.toHaveBeenCalled()
  })

  it("never surfaces a source failure as an error", async () => {
    const scheduler = new CompletionScheduler({
      sources: {
        listPathExecutables: async () => {
          throw new Error("host exploded")
        },
        completePaths: async () => {
          throw new Error("host exploded")
        },
      },
      debounceMs: 0,
    })
    const onResult = jest.fn()
    expect(() => {
      scheduler.request(request("kub"), onResult)
      jest.advanceTimersByTime(0)
    }).not.toThrow()
    await flush()
    // The static sources still answered, so a result arrives — just a smaller one.
    expect(onResult).toHaveBeenCalled()
  })
})
