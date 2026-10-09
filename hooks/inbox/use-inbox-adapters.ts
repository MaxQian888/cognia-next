"use client"

/**
 * The enabled adapters, for the Inbox sidebar (its scope list) and the
 * conversation list (section labels and order) — one read shared by both.
 *
 * Like `useConversationRows`, a failed read is captured rather than thrown:
 * the shell reads this above the sidebar's and list's error boundaries, and
 * a throw would escape both. `undefined` adapters means "still loading", so
 * the sidebar can show a skeleton instead of "no adapters" during the read.
 */

import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export interface InboxAdaptersState {
  adapters: AdapterInstanceRow[] | undefined
  error: Error | null
  retry: () => void
}

export function useInboxAdapters(): InboxAdaptersState {
  const [attempt, setAttempt] = useState(0)
  const result = useLiveQuery<{ adapters?: AdapterInstanceRow[]; error?: Error }>(async () => {
    if (typeof window === "undefined") return { adapters: [] }
    try {
      return {
        adapters: await getDb()
          .adapterInstances.filter((row) => row.enabled)
          .toArray(),
      }
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) }
    }
  }, [attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { adapters: result?.adapters, error: result?.error ?? null, retry }
}
