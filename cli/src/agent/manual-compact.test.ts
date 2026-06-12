/**
 * @jest-environment node
 */
import { runManualCompact, type RunManualCompactDeps } from "./manual-compact"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

const SESSION = "ses_1"

function boundaryEnvelope(
  trigger: "manual" | "auto",
  pre: number,
  post: number,
  sessionId = SESSION
) {
  return {
    type: "event",
    sessionId,
    event: {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger, pre_tokens: pre, post_tokens: post },
    },
  }
}

/** Build deps with a controllable subscribe channel + spies. */
function harness(over: Partial<RunManualCompactDeps> = {}) {
  let handler: ((p: unknown) => void) | null = null
  const unsub = jest.fn()
  const emitted: Array<Extract<CaptureStreamEvent, { type: "compact" }>> = []
  const notices: string[] = []
  const compact = jest.fn(async () => undefined)
  const deps: RunManualCompactDeps = {
    sessionId: SESSION,
    subscribe: (h) => {
      handler = h
      return unsub
    },
    compact,
    emit: (e) => emitted.push(e),
    onNotice: (m) => notices.push(m),
    timeoutMs: 1_000,
    setTimer: () => 0, // never auto-fire the timeout in these cases
    clearTimer: () => undefined,
    ...over,
  }
  return { deps, fire: (p: unknown) => handler?.(p), unsub, emitted, notices, compact }
}

describe("runManualCompact", () => {
  it("sends the control message and resolves on the matching boundary, emitting the typed event", async () => {
    const h = harness()
    const p = runManualCompact(h.deps)
    expect(h.compact).toHaveBeenCalledWith(SESSION, undefined)
    expect(h.notices[0]).toBe("Compacting context…")
    h.fire(boundaryEnvelope("manual", 45_000, 8_000))
    await p
    expect(h.emitted).toEqual([
      { type: "compact", trigger: "manual", preTokens: 45_000, postTokens: 8_000 },
    ])
    expect(h.unsub).toHaveBeenCalledTimes(1)
  })

  it("passes the focus through and shows it in the start notice", async () => {
    const h = harness({ focus: "the API changes" })
    const p = runManualCompact(h.deps)
    expect(h.compact).toHaveBeenCalledWith(SESSION, "the API changes")
    expect(h.notices[0]).toBe("Compacting context (focus: the API changes)…")
    h.fire(boundaryEnvelope("manual", 10, 5))
    await p
  })

  it("ignores boundaries for other sessions and non-boundary events", async () => {
    const h = harness()
    const p = runManualCompact(h.deps)
    h.fire(boundaryEnvelope("auto", 1, 1, "other"))
    h.fire({ type: "event", sessionId: SESSION, event: { type: "assistant" } })
    h.fire(null)
    expect(h.emitted).toHaveLength(0)
    // The real boundary still resolves it.
    h.fire(boundaryEnvelope("auto", 9, 2))
    await p
    expect(h.emitted).toHaveLength(1)
  })

  it("resolves via the timeout with an advisory notice when no boundary arrives", async () => {
    const timers: Array<() => void> = []
    const h = harness({
      setTimer: (fn) => {
        timers.push(fn)
        return 1
      },
    })
    const p = runManualCompact(h.deps)
    timers[0]?.()
    await p
    expect(h.notices.at(-1)).toBe("Compaction requested — it will apply before the next turn.")
    expect(h.unsub).toHaveBeenCalledTimes(1)
  })

  it("resolves with an error notice when the control message rejects", async () => {
    const h = harness({ compact: jest.fn(async () => Promise.reject(new Error("no session"))) })
    await runManualCompact(h.deps)
    expect(h.notices.at(-1)).toBe("Compaction failed: no session")
    expect(h.unsub).toHaveBeenCalledTimes(1)
  })
})
