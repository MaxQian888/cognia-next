/**
 * Plugin Logs & Agent-Trace API (`ctx.logs`) — the **read** side of
 * observability for monitoring, debugging, and cost-tracking plugins.
 *
 * Plugins have always been able to *write* logs (`ctx.logger`, a scoped
 * `@cognia/logging` logger). They had no way to read anything back: a plugin
 * that wanted to surface "your last run cost $2.10 and failed on the third
 * tool call" had to re-instrument the world, because the spans the app already
 * persists were host-private. This closes that gap.
 *
 * Two permissions, because the two halves carry different data:
 *
 *  - `logs:read` — the structured log stream, its stats, registered modules,
 *    and transport health. Operational metadata.
 *  - `trace:read` — agent-trace spans. Same rows the `/logs` Traces channel
 *    reads, and they may carry `inputPreview` / `outputPreview` — model input
 *    and output, captured only when the user enabled content capture and only
 *    after the redaction gate passed. Gating this separately means a cost
 *    dashboard can ask for spans without also getting the log firehose, and a
 *    log viewer never silently gains access to prompt text.
 *
 * Deliberately read-only. `clear()` / `deleteEntries()` exist on the transport
 * and are NOT exposed: a plugin must not be able to destroy the user's audit
 * trail. Emission stays on `ctx.logger`, which is already scoped to the plugin
 * so its output is attributable.
 */

import Dexie, { type Subscription } from "dexie"

import {
  IndexedDBTransport,
  getRegisteredModules,
  getTransportHealthSnapshot,
} from "@cognia/logging"
import type { LogFilter, StructuredLogEntry } from "@cognia/logging"

import {
  aggregateStatsAll,
  queryByTrace,
  queryByWindow,
  queryBySession,
  queryRecent,
} from "@/lib/db/agent-traces"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { rollupTraces, buildWaterfall } from "@/lib/observability/trace-rollup"
import { serializeTrace } from "@/lib/observability/trace-export"
import { buildTraceTimeline } from "@/lib/observability/trace-timeline"
import { agentTraceWindowSinceOrZero } from "@/lib/observability/trace-window"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { PluginLogsAPI, PluginTraceAPI } from "@cognia/plugin-contract/lib/plugin/api/logs-api"
export type {
  PluginLogsAPI,
  PluginTraceAPI,
  PluginTraceListOptions,
  PluginTraceStatsOptions,
} from "@cognia/plugin-contract/lib/plugin/api/logs-api"

/** How many spans a live trace subscription looks back over per tick. */
const TRACE_SUBSCRIPTION_WINDOW = 200
/** Hard ceiling on any single read, so a plugin cannot pull the whole store. */
const MAX_QUERY_LIMIT = 5_000

function clampLimit(value: number | undefined, fallback: number, ceiling: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), ceiling)
}

/** Shared read-only transport instance. Constructing one opens the same
 * IndexedDB database the app's own logging already uses; it is not a second
 * writer (the plugin API never calls `log()` or `flush()`). */
let sharedTransport: IndexedDBTransport | null = null
function transport(): IndexedDBTransport {
  sharedTransport ??= new IndexedDBTransport()
  return sharedTransport
}

/** Reset the shared reader. Exported for tests; production never needs it. */
export function resetPluginLogsTransport(): void {
  sharedTransport = null
}

function createTraceAPI(pluginId: string): PluginTraceAPI {
  const api: PluginTraceAPI = {
    async list(options = {}) {
      const since = agentTraceWindowSinceOrZero(options.window ?? "today")
      const limit = clampLimit(options.limit, 50, 500)
      const spans = await queryByWindow({ since })
      const rows = rollupTraces(spans)
      const filtered = options.errorsOnly ? rows.filter((row) => row.errorCount > 0) : rows
      return filtered.slice(0, limit)
    },

    spans: (traceId) => queryByTrace(traceId),

    bySession: (sessionId, limit) =>
      queryBySession(sessionId, clampLimit(limit, 500, MAX_QUERY_LIMIT)),

    async waterfall(traceId) {
      return buildWaterfall(await queryByTrace(traceId))
    },

    async timeline(traceId, options) {
      return buildTraceTimeline(await queryByTrace(traceId), options)
    },

    stats(options = {}) {
      const since = agentTraceWindowSinceOrZero(options.window ?? "today")
      return aggregateStatsAll(since > 0 ? { since } : undefined)
    },

    async serialize(traceId, format = "json", options) {
      return serializeTrace(await queryByTrace(traceId), format, options)
    },

    subscribe(handler) {
      const seen = new Set<string>()
      let primed = false
      let subscription: Subscription | null = null
      try {
        // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
        // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
        // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
        subscription = Dexie.liveQuery(() => queryRecent(TRACE_SUBSCRIPTION_WINDOW)).subscribe({
          next: (spans: AgentTraceSpan[]) => {
            // The first emission is the existing tail, not news. Record it and
            // stay quiet, so `subscribe` means "from now on".
            if (!primed) {
              primed = true
              for (const span of spans) seen.add(span.id)
              return
            }
            const fresh = spans.filter((span) => !seen.has(span.id))
            if (fresh.length === 0) return
            for (const span of fresh) seen.add(span.id)
            // Bound the dedupe set so a long-lived subscription cannot grow
            // without limit.
            if (seen.size > TRACE_SUBSCRIPTION_WINDOW * 10) {
              const keep = spans.map((span) => span.id)
              seen.clear()
              for (const id of keep) seen.add(id)
            }
            handler(fresh)
          },
          error: () => {
            // A failed live query must not take the plugin down with it.
          },
        })
      } catch {
        return () => {}
      }
      return () => subscription?.unsubscribe()
    },
  }

  return createGuardedAPI(pluginId, api, {
    list: "trace:read",
    spans: "trace:read",
    bySession: "trace:read",
    waterfall: "trace:read",
    timeline: "trace:read",
    stats: "trace:read",
    serialize: "trace:read",
    subscribe: "trace:read",
  })
}

/** Create the read-only Logs API for a plugin (`logs:read` + `trace:read`). */
export function createLogsAPI(pluginId: string): PluginLogsAPI {
  const traces = createTraceAPI(pluginId)

  const api = {
    query: (filter?: LogFilter) =>
      transport().getLogs({
        ...filter,
        limit: clampLimit(filter?.limit, 500, MAX_QUERY_LIMIT),
      }),
    stats: () => transport().getStats(),
    modules: () => getRegisteredModules(),
    export: (filter?: LogFilter) => transport().export(filter),
    subscribe(handler: (entries: StructuredLogEntry[]) => void) {
      // The transport broadcasts a flush count, not the entries; re-read the
      // tail and hand over only what the subscriber has not seen.
      const seen = new Set<string>()
      let primed = false
      return IndexedDBTransport.onLogsUpdated((count) => {
        void transport()
          .getLogs({ limit: clampLimit(count, 50, 500) })
          .then((entries) => {
            if (!primed) {
              primed = true
              for (const entry of entries) seen.add(entry.id)
              return
            }
            const fresh = entries.filter((entry) => !seen.has(entry.id))
            if (fresh.length === 0) return
            for (const entry of fresh) seen.add(entry.id)
            if (seen.size > 5_000) {
              seen.clear()
              for (const entry of entries) seen.add(entry.id)
            }
            handler(fresh)
          })
          .catch(() => {
            // A read failure between flushes is not the plugin's problem.
          })
      })
    },
    transports: () => getTransportHealthSnapshot(),
  }

  const guarded = createGuardedAPI(pluginId, api, {
    query: "logs:read",
    stats: "logs:read",
    modules: "logs:read",
    export: "logs:read",
    subscribe: "logs:read",
    transports: "logs:read",
  })

  // `traces` is a nested object, not a method, so it rides alongside the
  // guarded surface with its own per-method gate already applied.
  return { ...guarded, traces }
}

export default createLogsAPI
