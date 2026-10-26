/**
 * Plugin Performance API (`ctx.perf`) — **read-only** access to the Rust
 * performance dashboard (ADR-0035) for monitoring / observability plugins.
 *
 * Wraps the `lib/perf/backend/commands.ts` seam. Deliberately read-only:
 * the sampler-control commands (`perfStartSampling` / `perfSetInterval` /
 * `perfStopSampling` / `perfResetHotspots` / `perfOpenTraceDir`) are NOT
 * exposed — a plugin shouldn't reconfigure the user's sampler or open OS
 * windows. Gated by `perf:read`. Desktop-only (inert empties on web).
 */

import {
  perfSnapshot,
  perfHotspots,
  perfSystemDetails,
  perfListTraces,
  subscribePerfSample,
} from "@/lib/perf/backend/commands"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { PluginPerfAPI } from "@cognia/plugin-contract/lib/plugin/api/perf-api"
export type { PluginPerfAPI } from "@cognia/plugin-contract/lib/plugin/api/perf-api"

/** Create the read-only Performance API for a plugin (gated `perf:read`). */
export function createPerfAPI(pluginId: string): PluginPerfAPI {
  const api: PluginPerfAPI = {
    snapshot: () => perfSnapshot(),
    hotspots: () => perfHotspots(),
    systemDetails: () => perfSystemDetails(),
    listTraces: () => perfListTraces(),
    subscribe: (handler) => subscribePerfSample(handler),
  }

  return createGuardedAPI(pluginId, api, {
    snapshot: "perf:read",
    hotspots: "perf:read",
    systemDetails: "perf:read",
    listTraces: "perf:read",
    subscribe: "perf:read",
  })
}
