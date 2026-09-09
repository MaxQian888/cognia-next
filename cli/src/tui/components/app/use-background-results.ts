import { useCallback, useEffect, useRef, useState } from "react"
import type { Dispatch } from "react"
import {
  formatElapsed,
  frameBackgroundResults,
  type BackgroundResultDeliveryEntry,
} from "@/lib/background-tasks/completion-delivery"
import {
  listPendingCliBackgroundDeliveries,
  markCliBackgroundDelivery,
  subscribeCliBackgroundSettle,
  type CliBackgroundSettleEvent,
} from "../../../agent/subagent-background-tasks"
import type { TuiAction } from "../../state/types"

/**
 * Background-run completion delivery for the TUI (the OpenCode `resumeWhenIdle`
 * pattern, the desktop twin is `hooks/chat/background-result-runtime.ts`).
 *
 * When a background sub-agent this chat session started settles, its outcome
 * is queued here and re-injected into the session as ONE framed turn, so the
 * model reacts to the result without polling `dispatch_agent({collect})`:
 *
 *  - session idle ⇒ delivered right away (a fresh turn on the model's behalf).
 *  - a turn or goal/loop run in flight ⇒ stays queued, drained at the next
 *    turn boundary (after any `btw` steer, `takeBackgroundResults` is the
 *    drain the plain-turn sender calls).
 *  - results left `pending` in the journal by an earlier process are picked
 *    up at boot so a resumed session still hears about them.
 *
 * `settleSeq` bumps on EVERY settlement the session owns (delivered or not) so
 * footer counters that read the process-global registry can recompute.
 */
export interface UseBackgroundResultsDeps {
  sessionId: string
  home?: string
  dispatch: Dispatch<TuiAction>
  /** The session can accept an injected turn right now (idle, no run driver, not copilot). */
  idle: boolean
  /** Inject the framed turn (App owns `agent.send` + the follow-up drain). */
  deliver: (framedText: string) => Promise<void>
  /** Injection seams for tests, production reads the CLI registry. */
  subscribe?: typeof subscribeCliBackgroundSettle
  listPending?: typeof listPendingCliBackgroundDeliveries
  markDelivery?: typeof markCliBackgroundDelivery
}

export interface UseBackgroundResultsApi {
  /** Frame + clear every queued result (null when nothing is queued). */
  takeBackgroundResults: () => string | null
  /** Queued results not yet injected. */
  pendingCount: number
  /** Monotonic: bumps on each settlement this session owns. */
  settleSeq: number
}

/** Notice line for a settlement (the model-facing text is framed separately). */
export function backgroundSettleNotice(
  event: Pick<CliBackgroundSettleEvent, "subagentId" | "status" | "startedAt" | "settledAt">,
  idle: boolean
): string {
  const elapsed = formatElapsed(event.settledAt - event.startedAt)
  const tail = idle
    ? "delivering the result to the model."
    : "result queued, delivered at the next turn boundary."
  return `⏺ Background subagent "${event.subagentId}" ${event.status} in ${elapsed}: ${tail}`
}

export function useBackgroundResults(deps: UseBackgroundResultsDeps): UseBackgroundResultsApi {
  const {
    sessionId,
    home,
    dispatch,
    idle,
    deliver,
    subscribe = subscribeCliBackgroundSettle,
    listPending = listPendingCliBackgroundDeliveries,
    markDelivery = markCliBackgroundDelivery,
  } = deps
  const queue = useRef(new Map<string, BackgroundResultDeliveryEntry>())
  const delivering = useRef(false)
  // Latest idle flag + deliver for the settle listener (component `idle` is
  // only the snapshot at render time, the listener fires from the registry).
  const idleRef = useRef(idle)
  const deliverRef = useRef(deliver)
  useEffect(() => {
    idleRef.current = idle
    deliverRef.current = deliver
  }, [idle, deliver])
  const [pendingCount, setPendingCount] = useState(0)
  const [settleSeq, setSettleSeq] = useState(0)

  const takeBackgroundResults = useCallback((): string | null => {
    if (queue.current.size === 0) return null
    const entries = [...queue.current.values()]
    queue.current.clear()
    setPendingCount(0)
    void markDelivery(
      entries.map((entry) => entry.runId),
      "delivered",
      home
    )
    return frameBackgroundResults(entries)
  }, [markDelivery, home])

  // Per-session mutex: one injected turn at a time, a result that lands while
  // the injected turn streams is picked up by that turn's follow-up drain.
  const attemptDelivery = useCallback(async () => {
    if (delivering.current || !idleRef.current || queue.current.size === 0) return
    delivering.current = true
    try {
      const framed = takeBackgroundResults()
      if (framed !== null) await deliverRef.current(framed)
    } finally {
      delivering.current = false
    }
  }, [takeBackgroundResults])

  const enqueue = useCallback(
    (entries: readonly BackgroundResultDeliveryEntry[]) => {
      for (const entry of entries) {
        // A live settlement wins over the journal copy of the same run.
        queue.current.set(entry.runId, entry)
      }
      setPendingCount(queue.current.size)
      void attemptDelivery()
    },
    [attemptDelivery]
  )

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.sessionId !== sessionId) return
      setSettleSeq((n) => n + 1)
      if (event.kind !== "subagent" || !event.entry) return
      dispatch({
        type: "NOTICE",
        message: backgroundSettleNotice(event, idleRef.current),
        ...(event.status === "done" ? {} : { severity: "warning" as const }),
      })
      void markDelivery([event.runId], "pending", event.home ?? home)
      enqueue([event.entry])
    })
    return unsubscribe
  }, [subscribe, sessionId, dispatch, markDelivery, home, enqueue])

  // Boot: results an earlier process settled but never delivered.
  useEffect(() => {
    let cancelled = false
    void listPending({ home, owner: sessionId })
      .then((entries) => {
        if (cancelled || entries.length === 0) return
        // Do not clobber a live settlement that raced the journal read.
        enqueue(entries.filter((entry) => !queue.current.has(entry.runId)))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [listPending, home, sessionId, enqueue])

  // A run that settled mid-turn is delivered as soon as the session goes idle
  // (covers a goal/loop driver ending without a plain-turn drain).
  useEffect(() => {
    if (idle) void attemptDelivery()
  }, [idle, attemptDelivery])

  return { takeBackgroundResults, pendingCount, settleSeq }
}
