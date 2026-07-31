"use client"

/**
 * Live conversation-label catalog (CRM, schema v83). Seeds the built-in
 * starter labels on first mount, then reactively returns the catalog ordered
 * by `sortOrder`. CRUD goes through `lib/db/conversation-labels.ts`; this hook
 * is read-only + reactive for the settings manager, the label picker, and the
 * row/header chips.
 */

import { useEffect, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { seedBuiltinLabels } from "@/lib/db/conversation-labels"
import type { ConversationLabelRow } from "@/lib/db/crm-types"

export function useConversationLabels(): ConversationLabelRow[] {
  useEffect(() => {
    void seedBuiltinLabels()
  }, [])

  const labels = useLiveQuery<ConversationLabelRow[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    return getDb()
      .conversationLabels.toArray()
      .then((rows) =>
        rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      )
  }, [])

  return labels ?? []
}

/** Convenience: a stable id → label lookup for resolving `labelIds` to chips. */
export function useConversationLabelMap(): Map<string, ConversationLabelRow> {
  const labels = useConversationLabels()
  return useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
}
