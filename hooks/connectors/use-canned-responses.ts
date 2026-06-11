"use client"

/**
 * Live canned-response library (CRM, schema v83). Seeds the built-in starter
 * templates on first mount, then reactively returns the library ordered by
 * `sortOrder` (via listCanned). CRUD goes through `lib/db/canned-responses.ts`;
 * this hook is read-only + reactive for the composer picker and the settings
 * manager. Mirrors useConversationLabels.
 */

import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listCanned, seedBuiltinCanned } from "@/lib/db/canned-responses"
import type { CannedResponseRow } from "@/lib/db/crm-types"

export function useCannedResponses(): CannedResponseRow[] {
  useEffect(() => {
    void seedBuiltinCanned()
  }, [])

  const rows = useLiveQuery<CannedResponseRow[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    return listCanned()
  }, [])

  return rows ?? []
}
