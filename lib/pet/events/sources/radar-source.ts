// Attention Radar → pet. Fires `radarReport` once for every newly saved radar
// report, whichever path produced it: the scheduled background run
// (`radar-report::singleton`) or the console's "Run now". A run the radar's own
// guards skipped saves no row, so it cannot fire this.
//
// Content never enters this module. The observer projects each report down to
// `{ id, generatedAt }` before the source sees it, and the emitted meta is only
// `{ reportId }`. The bubble that announces the report
// (`hooks/pet/use-pet-insight.ts`) reads the verdict itself, through the PII
// gate and the shared speak limiter.
//
// The observation is injectable so the detection logic is unit-tested with a
// plain fake, like `twin-activity-source.ts` and `goal-source.ts`.

import Dexie from "dexie"
import { getLatestRadarReport } from "@/lib/db/radar-reports"
import { useSettingsStore } from "@/stores/settings"
import type { PetEmit } from "../pet-event-bus"

/** The only two facts about a report this source may know. */
export interface RadarReportStamp {
  id: string
  generatedAt: number
}

/** Push-style observation of the newest report (`undefined` when there is none). */
export type RadarObserver = (onLatest: (latest: RadarReportStamp | undefined) => void) => () => void

const defaultObserve: RadarObserver = (onLatest) => {
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  // The projection runs inside the query so the report body is dropped before
  // it leaves this function.
  const sub = Dexie.liveQuery(async () => {
    const latest = await getLatestRadarReport("self")
    return latest ? { id: latest.id, generatedAt: latest.generatedAt } : undefined
  }).subscribe({ next: onLatest })
  return () => sub.unsubscribe()
}

/** The radar is opt-in; with it switched off a report should not reach the pet. */
function defaultIsEnabled(): boolean {
  return useSettingsStore.getState().settings?.attentionRadar?.enabled === true
}

export interface RadarSourceDeps {
  observe?: RadarObserver
  isEnabled?: () => boolean
}

/**
 * Build the radar source.
 *
 * Detection is a `generatedAt` high-water mark, not an id comparison. Every
 * save is followed by a prune that re-fires the query, and deleting the newest
 * report makes an OLDER one the latest again; an id check would announce that
 * old report as new. The mark is taken on the FIRST callback even when there is
 * no report yet, so the very first report on a fresh install fires (returning
 * before marking would make it the baseline and swallow it). The mark advances
 * whether or not the radar setting allows an emit, so turning the radar on
 * later never replays a report that already landed.
 */
export function createRadarSource(deps: RadarSourceDeps = {}): (emit: PetEmit) => () => void {
  const observe = deps.observe ?? defaultObserve
  const isEnabled = deps.isEnabled ?? defaultIsEnabled
  return (emit) => {
    let started = false
    let watermark = Number.NEGATIVE_INFINITY
    return observe((latest) => {
      if (!started) {
        started = true
        watermark = latest?.generatedAt ?? Number.NEGATIVE_INFINITY
        return
      }
      if (!latest || latest.generatedAt <= watermark) return
      watermark = latest.generatedAt
      if (!isEnabled()) return
      emit({ source: "radar", kind: "radarReport", meta: { reportId: latest.id } })
    })
  }
}

/** Default wire used by `DEFAULT_PET_SOURCES`. */
export const wireRadarSource = createRadarSource()
