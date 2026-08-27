"use client"

/**
 * Live conversation-label catalog. Seeds the built-in starter labels on first
 * mount, then reactively returns the catalog ordered by `sortOrder`. CRUD goes
 * through `lib/db/conversation-labels.ts`; this hook is read-only + reactive
 * for the settings manager, the label picker, and the row/header chips.
 *
 * Reads through that facade rather than hitting a table directly. Schema v170
 * folded the CRM catalogue into the shared `labels` table under
 * `scope: "conversation"` and moved every write there, but this hook kept
 * querying the legacy `conversationLabels` table — which the upgrade leaves in
 * place under the append-only rule and nothing writes to any more. So a fresh
 * install had no labels at all here, and an upgraded one showed its pre-v170
 * snapshot and never saw a label created since. `useLiveQuery` tracks whatever
 * tables the query touches, so delegating keeps the reactivity and puts the
 * read on the table the writes actually land in.
 */

import { useEffect, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listLabels, seedBuiltinLabels } from "@/lib/db/conversation-labels"
import type { ConversationLabelRow } from "@/lib/db/crm-types"

export function useConversationLabels(): ConversationLabelRow[] {
  useEffect(() => {
    void seedBuiltinLabels()
  }, [])

  const labels = useLiveQuery<ConversationLabelRow[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listLabels()),
    []
  )

  return labels ?? []
}

/** Convenience: a stable id → label lookup for resolving `labelIds` to chips. */
export function useConversationLabelMap(): Map<string, ConversationLabelRow> {
  const labels = useConversationLabels()
  return useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
}
