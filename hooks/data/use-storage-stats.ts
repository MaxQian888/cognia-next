"use client"

// Live-queried storage stats for the overview tab. Counts rows per table and
// (where supported) attempts to read the browser's storage estimate so the
// user can see "120 KB / 60 MB used".

import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"

export interface StorageStats {
  counts: Record<string, number>
  totalRows: number
  /** Estimated bytes used by the IDB origin, when navigator.storage allows. */
  usageBytes?: number
  quotaBytes?: number
}

export function useStorageStats(): StorageStats {
  const counts = useLiveQuery(async () => {
    const db = getDb()
    const [
      sessions,
      messages,
      characters,
      skills,
      skillResources,
      teams,
      promptPresets,
      mcpServers,
      trustedWorkspaces,
      sessionState,
      backupHistory,
    ] = await Promise.all([
      db.sessions.count(),
      db.messages.count(),
      db.characters.count(),
      db.skills.count(),
      db.skillResources.count(),
      db.teams.count(),
      db.promptPresets.count(),
      db.mcpServers.count(),
      db.trustedWorkspaces.count(),
      db.sessionState.count(),
      db.backupHistory.count(),
    ])
    return {
      sessions,
      messages,
      characters,
      skills,
      skillResources,
      teams,
      promptPresets,
      mcpServers,
      trustedWorkspaces,
      sessionState,
      backupHistory,
    }
  }, [])

  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number }>({})

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return
    let active = true
    navigator.storage
      .estimate()
      .then((res) => {
        if (active) setEstimate({ usage: res.usage, quota: res.quota })
      })
      .catch(() => {
        // Origin doesn't allow estimates — fall back to row counts only.
      })
    return () => {
      active = false
    }
  }, [])

  const safeCounts: Record<string, number> = counts ?? {}
  const totalRows = Object.values(safeCounts).reduce<number>(
    (sum, n) => sum + (typeof n === "number" ? n : 0),
    0
  )
  return {
    counts: safeCounts,
    totalRows,
    usageBytes: estimate.usage,
    quotaBytes: estimate.quota,
  }
}
