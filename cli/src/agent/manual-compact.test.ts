/**
 * @jest-environment node
 */
import {
  manualCompactOutcomeFromInner,
  runManualCompact,
  type RunManualCompactDeps,
} from "./manual-compact"
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
  it("ends default observation when the owning backend exits", async () => {
    jest.useFakeTimers()
    try {
      const h = harness({
        timeoutMs: undefined,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      })
      let settled = false
      const pending = runManualCompact(h.deps).then(() => {
        settled = true
      })
      h.fire({ type: "sidecar_exited" })
      await Promise.resolve()
      expect(settled).toBe(true)
      expect(h.notices.at(-1)).toMatch(/Compaction interrupted.*backend stopped/)
      expect(h.emitted).toEqual([])
      expect(h.unsub).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(0)
      await pending
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not send or subscribe when the owner is already closed", async () => {
    const controller = new AbortController()
    controller.abort()
    const subscribe = jest.fn(() => jest.fn())
    const setTimer = jest.fn()
    const h = harness({ ...{ signal: controller.signal }, subscribe, setTimer })
    await runManualCompact(h.deps)
    expect(h.compact).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(setTimer).not.toHaveBeenCalled()
    expect(h.notices).toEqual([])
  })

  it("ignores a late control failure after cancellation", async () => {
    const controller = new AbortController()
    let rejectSend!: (error: Error) => void
    const h = harness({
      ...{ signal: controller.signal },
      compact: () =>
        new Promise((_, reject) => {
          rejectSend = reject
        }),
    })
    const pending = runManualCompact(h.deps)
    controller.abort()
    await pending
    rejectSend(new Error("sidecar closed"))
    await Promise.resolve()
    expect(h.notices).toEqual(["Compacting context…"])
    expect(h.unsub).toHaveBeenCalledTimes(1)
  })

  it("cancels the waiter and its timer when its owning session closes", async () => {
    jest.useFakeTimers()
    try {
      const controller = new AbortController()
      const h = harness({
        ...{ signal: controller.signal },
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      })
      let settled = false
      const pending = runManualCompact(h.deps).then(() => {
        settled = true
      })
      expect(jest.getTimerCount()).toBe(1)
      controller.abort()
      await Promise.resolve()
      expect(settled).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
      expect(h.unsub).toHaveBeenCalledTimes(1)
      const notices = [...h.notices]
      h.fire(boundaryEnvelope("manual", 100, 10))
      jest.runAllTimers()
      expect(h.emitted).toEqual([])
      expect(h.notices).toEqual(notices)
      await pending
    } finally {
      jest.useRealTimers()
    }
  })

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

  it("resolves at once with the sidecar's reason when there is nothing to compact", async () => {
    const h = harness()
    const done = runManualCompact(h.deps)
    h.fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "informational",
        compact_outcome: "nothing_to_compact",
        content:
          "Nothing to compact yet: the conversation still fits in the 6 most recent messages kept verbatim.",
      },
    })
    await done
    expect(h.emitted).toEqual([])
    expect(h.notices).toEqual([
      "Compacting context…",
      "Nothing to compact yet: the conversation still fits in the 6 most recent messages kept verbatim.",
    ])
    expect(h.unsub).toHaveBeenCalled()
  })

  it("resolves on a failed outcome with the sidecar's reason", async () => {
    const h = harness()
    const done = runManualCompact(h.deps)
    h.fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "informational",
        level: "warning",
        compact_outcome: "failed",
        content:
          "Compaction failed: the summary model used its whole 4596-token output budget without writing a summary (likely all reasoning). Nothing was compacted.",
      },
    })
    await done
    expect(h.emitted).toEqual([])
    expect(h.notices.at(-1)).toMatch(/^Compaction failed: .*Nothing was compacted\.$/)
    expect(h.unsub).toHaveBeenCalledTimes(1)
  })

  it("ignores ordinary informational events while waiting", async () => {
    const h = harness()
    void runManualCompact(h.deps)
    h.fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "system", subtype: "informational", content: "unrelated" },
    })
    await Promise.resolve()
    expect(h.unsub).not.toHaveBeenCalled()
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
    expect(h.notices.at(-1)).toBe(
      "Compaction has not finished after 1s — nothing has been compacted yet. Run /compact again if the context meter does not drop."
    )
    expect(h.notices.join("\n")).not.toMatch(/next turn/)
    expect(h.unsub).toHaveBeenCalledTimes(1)
  })

  it("keeps observing a slow default compaction after its status notice", async () => {
    const timers: Array<() => void> = []
    const h = harness({
      timeoutMs: undefined,
      setTimer: (fn) => {
        timers.push(fn)
        return 1
      },
    })
    let settled = false
    const done = runManualCompact(h.deps).then(() => {
      settled = true
    })
    timers[0]!()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(h.unsub).not.toHaveBeenCalled()
    expect(h.notices.at(-1)).toMatch(/still running/i)
    h.fire(boundaryEnvelope("manual", 100000, 10000))
    await done
    expect(h.emitted).toHaveLength(1)
    expect(h.unsub).toHaveBeenCalledTimes(1)
  })

  it("resolves with an error notice when the control message rejects", async () => {
    const h = harness({ compact: jest.fn(async () => Promise.reject(new Error("no session"))) })
    await runManualCompact(h.deps)
    expect(h.notices.at(-1)).toBe("Compaction failed: no session")
    expect(h.unsub).toHaveBeenCalledTimes(1)
  })
})

describe("manualCompactOutcomeFromInner", () => {
  it("reads each outcome and falls back to a stock message when content is empty", () => {
    expect(
      manualCompactOutcomeFromInner({
        type: "system",
        subtype: "informational",
        compact_outcome: "deferred",
      })
    ).toEqual({
      outcome: "deferred",
      message: "A turn is running; compaction will apply before the next turn.",
    })
    expect(
      manualCompactOutcomeFromInner({
        type: "system",
        subtype: "informational",
        compact_outcome: "skipped_by_plugin",
        content: " Declined. ",
      })
    ).toEqual({ outcome: "skipped_by_plugin", message: "Declined." })
    expect(
      manualCompactOutcomeFromInner({
        type: "system",
        subtype: "informational",
        compact_outcome: "failed",
      })
    ).toEqual({
      outcome: "failed",
      message: "Compaction failed: the summary model returned no text. Nothing was compacted.",
    })
  })

  it("rejects anything that is not a compaction outcome", () => {
    expect(manualCompactOutcomeFromInner(null)).toBeNull()
    expect(
      manualCompactOutcomeFromInner({ type: "system", subtype: "informational", content: "x" })
    ).toBeNull()
    expect(
      manualCompactOutcomeFromInner({
        type: "system",
        subtype: "compact_boundary",
        compact_outcome: "deferred",
      })
    ).toBeNull()
    expect(
      manualCompactOutcomeFromInner({
        type: "system",
        subtype: "informational",
        compact_outcome: "bogus",
      })
    ).toBeNull()
  })
})
