/**
 * Headless registration of the A2UI dispatch subscription (ADR-0059 T-A4).
 *
 * The sidecar's `a2ui_dispatch` lines reach the headless brain over
 * `/ws/events`; the injected bridge feeds them into the same
 * `useA2UIStore.processMessage` pipeline the desktop uses, so connector
 * A2UI projections (`lib/connectors/a2ui-bridge`) work server-side.
 */
import { subscribeA2UIDispatch } from "@/lib/a2ui/ipc"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "a2ui-dispatch",
  hosts: ["brain"],
  start: (ctx) => subscribeA2UIDispatch({ bridge: ctx.bridge }),
})
