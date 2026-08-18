/**
 * Headless registration of the issue tracker (ADR-0132, wired per ADR-0059).
 *
 * Runs the SAME `bootIssueTracker` the desktop `IssueTrackerInitializer` uses:
 * the four issue sources (local, the GitHub mirror, and the two agent engines),
 * the run bridge that dispatches an issue to an agent engine, the lifecycle →
 * Notification Center watcher, the starter label catalogue, and the GitHub
 * refresh schedule. Everything underneath is Dexie plus `schedulerDb`, both of
 * which the brain already owns, so no seam had to be remapped for this.
 *
 * Why it needed registering at all: the tracker booted only from a React
 * provider effect, so a cloud install ran an issue tracker whose board filled
 * from sync and whose runs never started — the built-but-unreachable shape
 * ADR-0059's closing rule exists to prevent. `bootIssueTracker` was already
 * exported "so the headless CLI host and tests can boot the tracker without
 * mounting React"; only this registration was missing.
 *
 * NOT included here, and deliberately: `installIssueNotificationCommands`,
 * whose whole body is a Next App Router `router.push`. Navigation acts on a UI
 * surface the brain does not have — the paired device that RECEIVES the
 * notification registers that command in its own renderer. Recorded in
 * scripts/gates/headless-registry-exclusions.json.
 */

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "issue-tracker",
  hosts: ["brain"],
  start: async (ctx) => {
    const { bootIssueTracker } = await import("@/lib/issues/boot")
    return bootIssueTracker({
      // The desktop passes `useTranslations("issues")`, whose keys are relative
      // to that namespace. `resolveMessage` is absolute over the same message
      // tree, so the prefix is re-applied here rather than forking the keys.
      translate: (key, values) => ctx.resolveMessage(`issues.${key}`, values),
    })
  },
})
