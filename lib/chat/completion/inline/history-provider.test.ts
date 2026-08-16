import { createHistoryProvider, rankHistoryMatches, HISTORY_PROVIDER_ID } from "./history-provider"
import type { InlineCompletionContext } from "./types"

/** Build a context whose only meaningful fields are the draft + history. */
function ctx(draft: string, history: string[]): InlineCompletionContext {
  return { draft, caret: draft.length, history, commands: [], surface: "tui" }
}

describe("rankHistoryMatches", () => {
  it("completes from a prefix match", () => {
    const out = rankHistoryMatches("fix ", ["fix the build"])
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("fix the build")
    expect(out[0].source).toBe("history")
    expect(out[0].providerId).toBe(HISTORY_PROVIDER_ID)
  })

  it("ignores entries that do not start with the draft", () => {
    expect(rankHistoryMatches("fix ", ["run the build"])).toEqual([])
  })

  it("ignores an entry identical to the draft (no ghost to show)", () => {
    expect(rankHistoryMatches("fix", ["fix"])).toEqual([])
  })

  it("prefers the more recent of two equally-used entries", () => {
    // Newest-first ordering: index 0 is the most recent submission.
    const out = rankHistoryMatches("fix ", ["fix newest", "fix oldest"])
    expect(out.map((s) => s.text)).toEqual(["fix newest", "fix oldest"])
  })

  it("lets a frequently repeated entry outrank a slightly newer one-off", () => {
    // "fix the build" is older but used repeatedly; the blended score should
    // put it ahead of the single, marginally-newer stray entry.
    const history = [
      "fix stray",
      "fix the build",
      "fix the build",
      "fix the build",
      "fix the build",
      "fix the build",
    ]
    const out = rankHistoryMatches("fix ", history)
    expect(out[0].text).toBe("fix the build")
  })

  it("collapses repeated entries into a single candidate", () => {
    const out = rankHistoryMatches("fix ", ["fix it", "fix it", "fix it"])
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("fix it")
  })

  it("completes case-insensitively while preserving what the user typed", () => {
    const out = rankHistoryMatches("fix ", ["Fix the build"])
    expect(out).toHaveLength(1)
    // The typed "fix " survives; only the historical tail is borrowed.
    expect(out[0].text).toBe("fix the build")
  })

  it("ranks an exact-case hit above a case-folded one", () => {
    const out = rankHistoryMatches("fix ", ["Fix alpha", "fix beta"])
    expect(out[0].text).toBe("fix beta")
  })

  it("rejects a multi-line completion by default", () => {
    expect(rankHistoryMatches("fix ", ["fix the\nbuild"])).toEqual([])
  })

  it("allows a multi-line completion when opted in", () => {
    const out = rankHistoryMatches("fix ", ["fix the\nbuild"], { allowMultiline: true })
    expect(out.map((s) => s.text)).toEqual(["fix the\nbuild"])
  })

  it("suggests nothing below the minimum draft length", () => {
    expect(rankHistoryMatches("f", ["fix the build"], { minChars: 3 })).toEqual([])
  })

  it("suggests nothing for a whitespace-only draft", () => {
    expect(rankHistoryMatches("   ", ["   padded"])).toEqual([])
  })

  it("honours the limit", () => {
    const out = rankHistoryMatches("fix ", ["fix a", "fix b", "fix c"], { limit: 2 })
    expect(out).toHaveLength(2)
  })

  it("reports scores inside the documented [0,1] range", () => {
    const out = rankHistoryMatches("fix ", ["fix a", "fix b", "fix a"])
    for (const s of out) {
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(s.score).toBeLessThanOrEqual(1)
    }
  })

  it("handles an empty history", () => {
    expect(rankHistoryMatches("fix ", [])).toEqual([])
  })

  it("never completes a command draft from history", () => {
    // Accepting a stale tail here produces an executable line the user did not
    // write — `/add-dir /usr/old-project` from a previous session.
    expect(rankHistoryMatches("/add-dir /u", ["/add-dir /usr/old-project"])).toEqual([])
  })

  it("suppresses history for a bare slash draft too", () => {
    expect(rankHistoryMatches("/co", ["/compact", "/config"])).toEqual([])
  })

  it("still completes a draft that only mentions a slash later", () => {
    // The rule is about command drafts, not about the character appearing
    // anywhere — a path or a date must still complete normally.
    expect(rankHistoryMatches("open /e", ["open /etc/hosts"]).map((s) => s.text)).toEqual([
      "open /etc/hosts",
    ])
  })
})

describe("createHistoryProvider", () => {
  it("is declared synchronous so the engine never debounces it", () => {
    expect(createHistoryProvider().sync).toBe(true)
  })

  it("returns ranked matches for the context draft", async () => {
    const provider = createHistoryProvider()
    const out = await provider.getCompletions(
      ctx("fix ", ["fix the build"]),
      new AbortController().signal
    )
    expect(out.map((s) => s.text)).toEqual(["fix the build"])
  })

  it("forwards its options to the matcher", async () => {
    const provider = createHistoryProvider({ limit: 1 })
    const out = await provider.getCompletions(
      ctx("fix ", ["fix a", "fix b"]),
      new AbortController().signal
    )
    expect(out).toHaveLength(1)
  })
})
