import fs from "node:fs"
import path from "node:path"

import {
  DEFAULT_INLINE_MAX_CANDIDATES,
  DEFAULT_INLINE_SCORE,
  INLINE_SOURCE_PRIORITY,
  type InlineSuggestionSource,
} from "./types"

describe("inline completion contracts", () => {
  it("orders sources so richer origins outrank mechanical ones", () => {
    // The ranking in `rank.ts` is meaningless unless this ordering holds, and
    // silently reordering it would change which ghost the user sees.
    expect(INLINE_SOURCE_PRIORITY.plugin).toBeGreaterThan(INLINE_SOURCE_PRIORITY.agent)
    expect(INLINE_SOURCE_PRIORITY.agent).toBeGreaterThan(INLINE_SOURCE_PRIORITY.ai)
    expect(INLINE_SOURCE_PRIORITY.ai).toBeGreaterThan(INLINE_SOURCE_PRIORITY.command)
    expect(INLINE_SOURCE_PRIORITY.command).toBeGreaterThan(INLINE_SOURCE_PRIORITY.history)
  })

  it("assigns every source a distinct weight", () => {
    const sources: InlineSuggestionSource[] = ["plugin", "agent", "ai", "command", "history"]
    const weights = sources.map((s) => INLINE_SOURCE_PRIORITY[s])
    expect(new Set(weights).size).toBe(sources.length)
  })

  it("uses a neutral default score inside the confidence range", () => {
    expect(DEFAULT_INLINE_SCORE).toBeGreaterThan(0)
    expect(DEFAULT_INLINE_SCORE).toBeLessThan(1)
  })

  it("keeps the candidate cap small enough to cycle by hand", () => {
    expect(DEFAULT_INLINE_MAX_CANDIDATES).toBeGreaterThan(1)
    expect(DEFAULT_INLINE_MAX_CANDIDATES).toBeLessThanOrEqual(10)
  })
})

/**
 * `plugin` is a deliberately dormant source: the ranking slot and the badge
 * label exist, but nothing can produce one — there is no SDK surface for
 * registering an `InlineCompletionProvider`, and both composers build their
 * provider lists from the built-in factories only.
 *
 * This is the third axis of that dormancy (type docs + the composer's badge
 * comment are the other two). It is a scan rather than an assertion about one
 * file because the point is that NO producer exists anywhere — and a scan that
 * silently matched zero files would pass for the wrong reason, so the file
 * count is asserted too.
 */
describe("the `plugin` source is dormant, on purpose", () => {
  const roots = ["lib/chat/completion", "hooks/chat", "cli/src/tui/input"]
  const repoRoot = path.resolve(__dirname, "../../../..")

  function walk(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, out)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full)
    }
    return out
  }

  // Only files that speak the inline-completion vocabulary. `source:` is a
  // common field name — a plugin-authored *diagnostic* also has one — so a bare
  // text match over every file finds unrelated code and makes the assertion
  // about something else entirely.
  const files = roots
    .flatMap((r) => walk(path.join(repoRoot, r)))
    .filter((f) => /InlineSuggestion|InlineCompletionProvider/.test(fs.readFileSync(f, "utf8")))

  it("scanned the completion sources at all", () => {
    // Guards the assertion below: an empty walk would make it vacuously true.
    expect(files.length).toBeGreaterThan(5)
  })

  it('has no producer — nothing emits `source: "plugin"`', () => {
    const producers = files.filter((f) => {
      const text = fs.readFileSync(f, "utf8")
      return /source:\s*["']plugin["']/.test(text)
    })
    // When this fails, the source is no longer dormant: drop this block and
    // give the new provider real coverage instead.
    expect(producers.map((f) => path.relative(repoRoot, f))).toEqual([])
  })

  it("keeps the slot reserved, so a future provider ranks above the built-ins", () => {
    expect(INLINE_SOURCE_PRIORITY.plugin).toBeGreaterThan(INLINE_SOURCE_PRIORITY.agent)
  })
})
