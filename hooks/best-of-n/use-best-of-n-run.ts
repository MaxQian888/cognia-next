"use client"

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { canManageBestOfNRuns, getBestOfNRun, refreshBestOfNRun } from "@/lib/best-of-n/projection"

/** Synced reads work on paired devices; only the executing Host polls its ledger. */
export function useBestOfNRun(groupId: string | null) {
  const summary = useLiveQuery(() => (groupId ? getBestOfNRun(groupId) : undefined), [groupId])
  const [failedGroup, setFailedGroup] = useState<string | null>(null)
  const canManage = canManageBestOfNRuns()
  const refresh = useCallback(async () => {
    if (!groupId || !canManage) return
    try {
      await refreshBestOfNRun(groupId)
      setFailedGroup(null)
    } catch {
      setFailedGroup(groupId)
    }
  }, [groupId, canManage])
  useEffect(() => {
    if (!groupId || !canManage) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh()
      if (active) timer = setTimeout(() => void poll(), 3000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [groupId, canManage, refresh])
  return { summary, refresh, canManage, failed: Boolean(groupId && failedGroup === groupId) }
}
