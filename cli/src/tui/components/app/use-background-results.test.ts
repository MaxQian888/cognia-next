/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { BackgroundResultDeliveryEntry } from "@/lib/background-tasks/completion-delivery"
import type { CliBackgroundSettleEvent } from "../../../agent/subagent-background-tasks"
import { backgroundSettleNotice, useBackgroundResults } from "./use-background-results"

function entry(
  overrides: Partial<BackgroundResultDeliveryEntry> = {}
): BackgroundResultDeliveryEntry {
  return {
    runId: "run_1",
    subagentId: "reviewer",
    status: "done",
    startedAt: 1_000,
    settledAt: 4_000,
    text: "All good.",
    ...overrides,
  }
}

function settleEvent(overrides: Partial<CliBackgroundSettleEvent> = {}): CliBackgroundSettleEvent {
  const e = entry(overrides.entry ?? {})
  return {
    runId: e.runId,
    kind: "subagent",
    subagentId: e.subagentId,
    sessionId: "ses_1",
    status: "done",
    startedAt: e.startedAt,
    settledAt: e.settledAt,
    resultText: e.text,
    entry: e,
    ...overrides,
  }
}

function harness(opts: { idle?: boolean; pending?: BackgroundResultDeliveryEntry[] } = {}) {
  const listeners = new Set<(event: CliBackgroundSettleEvent) => void>()
  const subscribe = jest.fn((listener: (event: CliBackgroundSettleEvent) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  const listPending = jest.fn(async () => opts.pending ?? [])
  const markDelivery = jest.fn(async () => undefined)
  const deliver = jest.fn(async (_text: string) => undefined)
  const dispatch = jest.fn()
  const hook = renderHook(
    ({ idle }: { idle: boolean }) =>
      useBackgroundResults({
        sessionId: "ses_1",
        home: "/home",
        dispatch,
        idle,
        deliver,
        subscribe,
        listPending,
        markDelivery,
      }),
    { initialProps: { idle: opts.idle ?? true } }
  )
  const fire = (event: CliBackgroundSettleEvent) =>
    act(() => {
      for (const listener of listeners) listener(event)
    })
  return { ...hook, subscribe, listPending, markDelivery, deliver, dispatch, fire, listeners }
}

describe("backgroundSettleNotice", () => {
  it("names the agent, outcome, elapsed and what happens next", () => {
    const base = { subagentId: "reviewer", status: "done" as const, startedAt: 0, settledAt: 3_000 }
    expect(backgroundSettleNotice(base, true)).toBe(
      '⏺ Background subagent "reviewer" done in 3s: delivering the result to the model.'
    )
    expect(backgroundSettleNotice({ ...base, status: "error" }, false)).toBe(
      '⏺ Background subagent "reviewer" error in 3s: result queued, delivered at the next turn boundary.'
    )
  })
})

describe("useBackgroundResults", () => {
  it("subscribes once and unsubscribes on unmount", () => {
    const h = harness()
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    expect(h.listeners.size).toBe(1)
    h.unmount()
    expect(h.listeners.size).toBe(0)
  })

  it("delivers a settlement right away while idle, framed for the model", async () => {
    const h = harness({ idle: true })
    h.fire(settleEvent())
    await waitFor(() => expect(h.deliver).toHaveBeenCalledTimes(1))
    const framed = h.deliver.mock.calls[0][0]
    expect(framed).toContain('[background task update] Subagent "reviewer" (runId run_1)')
    expect(framed).toContain("All good.")
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "NOTICE",
        message: expect.stringContaining("delivering the result to the model"),
      })
    )
    expect(h.markDelivery).toHaveBeenCalledWith(["run_1"], "pending", "/home")
    expect(h.markDelivery).toHaveBeenCalledWith(["run_1"], "delivered", "/home")
    expect(h.result.current.pendingCount).toBe(0)
    expect(h.result.current.settleSeq).toBe(1)
  })

  it("queues while busy, exposes the count, and drains through takeBackgroundResults", async () => {
    const h = harness({ idle: false })
    h.fire(settleEvent())
    h.fire(settleEvent({ runId: "run_2", entry: entry({ runId: "run_2", settledAt: 2_000 }) }))
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.result.current.pendingCount).toBe(2)
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("result queued") })
    )
    let framed: string | null = null
    act(() => {
      framed = h.result.current.takeBackgroundResults()
    })
    // Ordered by settledAt: run_2 settled first.
    expect(framed!.indexOf("run_2")).toBeLessThan(framed!.indexOf("run_1"))
    expect(h.result.current.pendingCount).toBe(0)
    expect(h.result.current.takeBackgroundResults()).toBeNull()
    expect(h.markDelivery).toHaveBeenCalledWith(["run_1", "run_2"], "delivered", "/home")
  })

  it("delivers a queued result as soon as the session goes idle", async () => {
    const h = harness({ idle: false })
    h.fire(settleEvent())
    expect(h.deliver).not.toHaveBeenCalled()
    h.rerender({ idle: true })
    await waitFor(() => expect(h.deliver).toHaveBeenCalledTimes(1))
  })

  it("ignores other sessions and non-subagent kinds but still counts own settlements", () => {
    const h = harness({ idle: true })
    h.fire(settleEvent({ sessionId: "other" }))
    expect(h.result.current.settleSeq).toBe(0)
    h.fire(settleEvent({ kind: "plugin-agent" }))
    expect(h.result.current.settleSeq).toBe(1)
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it("flags an error or interrupted settlement as a warning notice", () => {
    const h = harness({ idle: false })
    h.fire(
      settleEvent({
        status: "interrupted",
        entry: entry({ status: "error", text: "cut off" }),
      })
    )
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("interrupted"),
      })
    )
  })

  it("picks up journal-pending results at boot without clobbering a live one", async () => {
    const h = harness({
      idle: false,
      pending: [
        entry({ runId: "old", text: "from journal" }),
        entry({ runId: "run_1", text: "stale" }),
      ],
    })
    // A live settlement for run_1 lands before the journal read resolves.
    h.fire(settleEvent({ entry: entry({ text: "fresh" }) }))
    await waitFor(() => expect(h.result.current.pendingCount).toBe(2))
    expect(h.listPending).toHaveBeenCalledWith({ home: "/home", owner: "ses_1" })
    let framed = ""
    act(() => {
      framed = h.result.current.takeBackgroundResults() ?? ""
    })
    expect(framed).toContain("from journal")
    expect(framed).toContain("fresh")
    expect(framed).not.toContain("stale")
  })

  it("never runs two injected turns at once", async () => {
    let release!: () => void
    const h = harness({ idle: true })
    h.deliver.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    h.fire(settleEvent())
    await waitFor(() => expect(h.deliver).toHaveBeenCalledTimes(1))
    h.fire(settleEvent({ runId: "run_2", entry: entry({ runId: "run_2" }) }))
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.result.current.pendingCount).toBe(1)
    act(() => release())
    // The second result waits for the next idle edge or the follow-up drain.
    expect(h.result.current.takeBackgroundResults()).toContain("run_2")
  })
})
