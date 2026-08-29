"use client"

/**
 * The captured output of one version's build, loaded on demand.
 *
 * A live query keyed on the version, mounted only inside an open viewer: build
 * logs are the largest rows in the Sites tables after the archives themselves,
 * and the whole reason they live in `siteBuildLogs` rather than on the version
 * row is that nothing should read them until someone asks.
 */
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"

import { listSiteBuildLogs } from "@/lib/db/sites"
import type { SiteBuildLogRow } from "@/types/sites"

const EMPTY: SiteBuildLogRow[] = []

export function useSiteBuildLogs(versionId: string | null): {
  logs: readonly SiteBuildLogRow[]
  loading: boolean
} {
  const rows = useClientLiveQuery<SiteBuildLogRow[]>(
    async () => (versionId ? listSiteBuildLogs(versionId) : EMPTY),
    [versionId],
    EMPTY
  )
  return { logs: rows ?? EMPTY, loading: rows === undefined }
}
