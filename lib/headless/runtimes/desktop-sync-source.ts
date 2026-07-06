/**
 * Headless registration of the desktop sync source (ADR-0059 T-A2).
 *
 * `installDesktopSyncSource` was already bridge-injectable — the brain
 * reuses it VERBATIM with the socket-backed bridge from the runtime
 * context, so `sync_pull` answers from the brain's Dexie exactly as the
 * desktop WebView answers from its own.
 */
import { installDesktopSyncSource } from "@/lib/sync/desktop-sync-source"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "desktop-sync-source",
  hosts: ["brain"],
  start: (ctx) => installDesktopSyncSource({ bridge: ctx.bridge }),
})
