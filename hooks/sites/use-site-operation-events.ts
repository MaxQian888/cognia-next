"use client"

/**
 * A Dexie live query scoped to one operation's event stream.
 *
 * Split out of `use-site-live-data` because `siteOperationEvents` is written
 * on every operation transition — several times per build — and keeping it in
 * the console-wide query meant each of those writes re-read all nine Sites
 * tables plus one `listSiteOperationEvents` per operation of the selected Site.
 */
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"

import { listSiteOperationEvents } from "@/lib/db/sites"
import type { SiteOperationEventRow } from "@/types/sites"

const EMPTY_EVENTS: SiteOperationEventRow[] = []

/**
 * Events for exactly one operation.
 *
 * `siteOperationEvents` is written on every operation transition, so keeping it
 * in the console-wide query made a build re-read all nine tables several times
 * per phase. Only two surfaces need events: the publish flow's sub-status for
 * the one running operation, and an expanded journal row. Both address a single
 * operation, and both unmount when they stop needing it — a collapsed journal
 * issues no query at all.
 *
 * @param operationId the operation to watch, or null to read nothing.
 */
export function useSiteOperationEvents(
  operationId: string | null
): readonly SiteOperationEventRow[] {
  const events = useClientLiveQuery<SiteOperationEventRow[]>(
    async () => (operationId ? listSiteOperationEvents(operationId) : EMPTY_EVENTS),
    [operationId],
    EMPTY_EVENTS
  )
  return events ?? EMPTY_EVENTS
}
