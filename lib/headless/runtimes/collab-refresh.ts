/**
 * Brain half of the collaboration-plane refresh loop (ADR-0149, wired per
 * ADR-0059).
 *
 * The collab server is authoritative and `lib/db/collab-*-mirror.ts` holds four
 * rebuildable read caches. Something has to pull. On the desktop that is
 * `installCollabRefreshScheduler`, which is shaped around a browser: it gates
 * every tick on `document.visibilityState`, re-runs on `focus`, and returns a
 * no-op when `window` or `document` is missing. Registering that function here
 * would have produced the worst possible outcome, a runtime that appears in the
 * roster, starts without error, and refreshes nothing.
 *
 * So the brain gets the loop's actual body instead. `requestCollabRefresh` and
 * `collabRefreshDelay` are already host-neutral and hold the shared in-flight
 * map and failure backoff, so both hosts run one implementation on one
 * schedule. Only the "should I tick now" question differs, and a brain has no
 * visibility to consult. It is always the answer the desktop's `visible` branch
 * gives.
 */

import {
  collabRefreshDelay,
  getCollabRefreshState,
  requestCollabRefresh,
} from "@/lib/collab/refresh-scheduler"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "collab-refresh",
  hosts: ["brain"],
  start: (ctx) => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (stopped) return
      if (timer !== undefined) clearTimeout(timer)
      // Read the failure count at scheduling time rather than at install time.
      // The backoff is the whole reason to re-read it: a server that is down
      // must not be retried every minute for the life of the process.
      timer = setTimeout(run, collabRefreshDelay(getCollabRefreshState(ctx.accountId).failures))
      // A refresh must never hold the process open. `serveCommand` blocks on
      // SIGINT, and a timer that was not unref'd would keep the event loop
      // alive through teardown.
      timer.unref?.()
    }

    const run = () => {
      if (stopped) return
      void requestCollabRefresh(ctx.accountId)
        .catch(() => {
          // `requestCollabRefresh` already records the failure and swallows it.
          // This catch exists only so an unexpected throw cannot kill the loop.
        })
        .finally(schedule)
    }

    schedule()

    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  },
})
