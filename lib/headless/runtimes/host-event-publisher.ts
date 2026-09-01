/**
 * Install the brain-side half of the host-neutral companion event publisher.
 *
 * This runtime is imported first by the headless roster so boot-time writes
 * from sync, workflow, and connector runtimes can already fan out. Reverse
 * teardown keeps it installed until every dependent runtime has stopped.
 */

import { setHostEventPublisher } from "@/lib/companion/host-event-publisher"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "host-event-publisher",
  hosts: ["brain"],
  start: (ctx) =>
    setHostEventPublisher(async (topic, event) => {
      // invoke-parity-exempt: a `ws_bridge.rs:route_respond` route, not a Tauri command — the brain reaches it over `/internal/bridge`, and `route_respond` validates the topic against a closed allowlist before publishing.
      await ctx.bridge.invoke("companion_event_publish", { topic, event })
    }),
})
