/**
 * Headless registration of the plan notification actions (ADR-0045, wired per
 * ADR-0059).
 *
 * `installPlanNotificationActions` registers the `plan.respond` notification
 * command backing the Approve / Discard buttons. Unlike the issue tracker's
 * `issue.open` — which is pure navigation and therefore renderer-bound — this
 * handler is a data mutation plus an orchestration start: it calls
 * `runtime.rejectPlan` / `approvePlan` / `startPlan`, and for an orchestrated
 * plan `runPlan`. Its own source note says orchestrated plans "can start
 * headlessly from here", and the plan runtime and its Dexie tables live in the
 * brain — so the brain is where the command belongs, not only the desktop.
 *
 * Nothing in the handler touches React, the router, or the DOM, so the desktop
 * effect body ports across unchanged.
 */

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "plan-notification",
  hosts: ["brain"],
  start: async () => {
    const { installPlanNotificationActions } = await import("@/lib/agent/plan/notify")
    return installPlanNotificationActions()
  },
})
