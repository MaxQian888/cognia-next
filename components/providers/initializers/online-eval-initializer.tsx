"use client"

// Fires once on app boot. Drains the online-evaluation queue that the
// `eval-online` log transport fills when a production trace finishes, so
// enqueued work actually gets scored — and, just as importantly, settles into a
// terminal state the retention sweep can prune. Without this the queue only
// grows.
//
// Self-gating: with no enabled policy (the default, and the state whenever the
// Eval Lab flag is down) the scheduler refreshes an empty cache and drains
// nothing.
//
// Renderer only, deliberately. The queue is filled by the `eval-online` log
// transport, which exists only once `bootstrapLogger` configures the renderer
// transport graph — something the headless roster (ADR-0059) does not do. So
// the producer is absent headless too, and registering this consumer there
// alone would start a worker with nothing to consume. Register it in
// `lib/headless/runtimes/index.ts` together with a headless span feed, never
// before.

import { useEffect, useRef } from "react"

import { startOnlineEvalScheduler, type Unsubscribe } from "@/lib/ai/eval/online/scheduler"

export function OnlineEvalInitializer() {
  const hasInitialized = useRef(false)
  const unsubscribeRef = useRef<Unsubscribe | null>(null)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void startOnlineEvalScheduler().then((unsubscribe) => {
      unsubscribeRef.current = unsubscribe
    })
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [])

  return null
}

export default OnlineEvalInitializer
