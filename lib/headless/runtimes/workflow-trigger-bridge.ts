/**
 * Headless workflow trigger bridge (spec
 * `docs/superpowers/specs/2026-08-16-scheduler-host-neutral-design.md`, F).
 *
 * cognia-server runs the same Rust workflow cron daemon and webhook router as
 * the desktop (`src-tauri/src/headless/mod.rs` spawns `workflow.cron.run_loop`
 * and the webhook router with a `HeadlessWorkflowEmitter` that publishes
 * `workflow:trigger` on the event bus). Until now nobody in the brain
 * subscribed to that channel — it is `default_on: false` in the channel
 * catalog and `CompanionTransport` never sent a `subscribe` control frame —
 * so a cron trigger authored in the workflow editor never fired on a cloud
 * host. This runtime installs the SAME `installTriggerBridge()` the desktop
 * `WorkflowRuntimeProvider` mounts; `listenTriggerEvents` subscribes through
 * the brain's transport (`/internal/events`) off-desktop.
 *
 * Kept separate from the `workflow-runtime` initializer entry so a bridge
 * failure (no event plane yet) never blocks the rest of the workflow runtime
 * from booting, and so the roster names the capability explicitly.
 */

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "workflow-trigger-bridge",
  hosts: ["brain"],
  start: async (ctx) => {
    const { installTriggerBridge } = await import("@/lib/workflow/runtime/trigger-bridge")
    let dispose: (() => void) | null = null
    try {
      dispose = await installTriggerBridge()
      ctx.log("info", "workflow trigger bridge installed (workflow:trigger via events plane)")
    } catch (error) {
      ctx.log(
        "error",
        `workflow trigger bridge failed to install: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return () => {
      dispose?.()
      dispose = null
    }
  },
})
