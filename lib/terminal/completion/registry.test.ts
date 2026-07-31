import {
  __resetCompletionRegistryForTesting,
  getCompletions,
  listProviders,
  rankSuggestions,
  registerCompletionProvider,
} from "./registry"
import type {
  TerminalCompletionContext,
  TerminalCompletionProvider,
  TerminalCompletionSuggestion,
} from "./types"

function ctx(): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "bash",
    shellPath: "/bin/bash",
    cwd: "/x",
    input: "g",
    cursor: 1,
    recentCommands: [],
    platform: "linux",
  }
}

function provider(
  id: string,
  result: TerminalCompletionSuggestion[] | (() => Promise<TerminalCompletionSuggestion[]>),
  priority?: number
): TerminalCompletionProvider {
  return {
    id,
    label: id,
    priority,
    getCompletions: typeof result === "function" ? result : async () => result,
  }
}

function sug(
  text: string,
  source: TerminalCompletionSuggestion["source"],
  score?: number
): TerminalCompletionSuggestion {
  return { text, source, providerId: source, score }
}

beforeEach(() => __resetCompletionRegistryForTesting())

describe("registration", () => {
  it("registers and lists providers sorted by priority", () => {
    registerCompletionProvider(provider("b", [], 200))
    registerCompletionProvider(provider("a", [], 50))
    expect(listProviders().map((p) => p.id)).toEqual(["a", "b"])
  })
  it("unregister removes the provider", () => {
    const off = registerCompletionProvider(provider("a", []))
    expect(listProviders()).toHaveLength(1)
    off()
    expect(listProviders()).toHaveLength(0)
  })
  it("re-registering the same id replaces the old one", () => {
    registerCompletionProvider(provider("a", [sug("x", "history")]))
    registerCompletionProvider(provider("a", [sug("y", "history")]))
    expect(listProviders()).toHaveLength(1)
  })

  it("an old disposer is a no-op after the id was re-registered", () => {
    const off1 = registerCompletionProvider(provider("a", [sug("x", "history")]))
    registerCompletionProvider(provider("a", [sug("y", "history")])) // replaces
    off1() // must NOT remove the newer registration
    expect(listProviders().map((p) => p.id)).toEqual(["a"])
  })
})

describe("rankSuggestions", () => {
  it("orders plugin > ai > history, then by score", () => {
    const ranked = rankSuggestions([
      sug("h", "history", 0.9),
      sug("a", "ai", 0.1),
      sug("p", "plugin", 0.1),
    ])
    expect(ranked.map((s) => s.text)).toEqual(["p", "a", "h"])
  })
  it("breaks source ties by score descending", () => {
    const ranked = rankSuggestions([sug("low", "ai", 0.2), sug("high", "ai", 0.8)])
    expect(ranked[0].text).toBe("high")
  })
  it("dedupes by text keeping the highest-ranked", () => {
    const ranked = rankSuggestions([sug("git status", "history"), sug("git status", "ai")])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].source).toBe("ai")
  })
  it("treats a missing score as the neutral default", () => {
    const ranked = rankSuggestions([sug("a", "ai"), sug("b", "ai")])
    expect(ranked).toHaveLength(2) // both default 0.5 → stable order, no crash
  })
})

describe("getCompletions", () => {
  it("merges + ranks results across providers", async () => {
    registerCompletionProvider(provider("h", [sug("git stash", "history")]))
    registerCompletionProvider(provider("a", [sug("git status", "ai")]))
    const out = await getCompletions(ctx(), new AbortController().signal)
    expect(out.map((s) => s.source)).toEqual(["ai", "history"])
  })
  it("isolates a throwing provider (returns the others)", async () => {
    registerCompletionProvider(
      provider("bad", () => {
        throw new Error("boom")
      })
    )
    registerCompletionProvider(provider("good", [sug("ls", "history")]))
    const out = await getCompletions(ctx(), new AbortController().signal)
    expect(out.map((s) => s.text)).toEqual(["ls"])
  })
  it("drops a provider that exceeds the per-provider timeout", async () => {
    registerCompletionProvider(
      provider(
        "slow",
        () => new Promise((resolve) => setTimeout(() => resolve([sug("late", "ai")]), 80))
      )
    )
    registerCompletionProvider(provider("fast", [sug("quick", "history")]))
    const out = await getCompletions(ctx(), new AbortController().signal, {
      perProviderTimeoutMs: 15,
    })
    expect(out.map((s) => s.text)).toEqual(["quick"])
  })
  it("coerces a provider that returns a non-array to []", async () => {
    registerCompletionProvider(provider("weird", (() => Promise.resolve(null)) as never))
    registerCompletionProvider(provider("ok", [sug("ls", "history")]))
    const out = await getCompletions(ctx(), new AbortController().signal)
    expect(out.map((s) => s.text)).toEqual(["ls"])
  })

  it("returns [] immediately when the signal is already aborted", async () => {
    registerCompletionProvider(provider("a", [sug("x", "ai")]))
    const ac = new AbortController()
    ac.abort()
    expect(await getCompletions(ctx(), ac.signal)).toEqual([])
  })
  it("caps the number of returned suggestions", async () => {
    registerCompletionProvider(
      provider("many", [sug("a", "ai", 0.9), sug("b", "ai", 0.8), sug("c", "ai", 0.7)])
    )
    const out = await getCompletions(ctx(), new AbortController().signal, { max: 2 })
    expect(out).toHaveLength(2)
  })
})

describe("rankSuggestions — extended sources", () => {
  it("orders plugin > spec > ai > path > exe > history", () => {
    const ranked = rankSuggestions([
      sug("h", "history"),
      sug("e", "exe"),
      sug("p", "path"),
      sug("a", "ai"),
      sug("s", "spec"),
      sug("g", "plugin"),
    ])
    expect(ranked.map((r) => r.source)).toEqual(["plugin", "spec", "ai", "path", "exe", "history"])
  })

  it("keeps same-text suggestions with different replace spans distinct", () => {
    const a: TerminalCompletionSuggestion = {
      ...sug("cd src/", "path", 0.9),
      replace: { from: 3, insert: "src/" },
    }
    const b: TerminalCompletionSuggestion = {
      ...sug("cd src/", "path", 0.8),
      replace: { from: 0, insert: "cd src/" },
    }
    expect(rankSuggestions([a, b])).toHaveLength(2)
  })

  it("dedupes same text + same replace span keeping the highest-ranked", () => {
    const a: TerminalCompletionSuggestion = {
      ...sug("cd src/", "spec", 0.9),
      replace: { from: 3, insert: "src/" },
    }
    const b: TerminalCompletionSuggestion = {
      ...sug("cd src/", "path", 0.8),
      replace: { from: 3, insert: "src/" },
    }
    const ranked = rankSuggestions([b, a])
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.source).toBe("spec")
  })
})
