"use client"

/**
 * The single-conversation export / share-link dialog, as a conversation list
 * hosts it: once per list (not once per row), opened for whichever row asked
 * (`useConversationRowActions().exportSessionId`).
 *
 * The dialog itself is loaded on first use — it pulls in the HTML exporters
 * and the theme gallery, which neither list needs until someone exports.
 */

import dynamic from "next/dynamic"
import { useEffect, useRef, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { getDb } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import type { ChatSession } from "@cognia/agent-config-types"

const SingleExportDialog = dynamic(
  () =>
    import("@/components/data/export/single-export-dialog").then(
      (module) => module.SingleExportDialog
    ),
  { ssr: false }
)

export interface ConversationExportDialogProps {
  /** The row being exported; `null` renders nothing. */
  session: ChatSession | null
  onClose: () => void
}

export function ConversationExportDialog({ session, onClose }: ConversationExportDialogProps) {
  const scope = useSyncExternalStore(
    subscribeRuntimeTargetContext,
    getRuntimeTargetScopeKey,
    getRuntimeTargetScopeKey
  )
  if (!session) return null
  return (
    <LoadedConversationExportDialog
      key={`${scope}:${session.id}`}
      session={session}
      onClose={onClose}
    />
  )
}

function LoadedConversationExportDialog({ session, onClose }: ConversationExportDialogProps) {
  const t = useTranslations("export")
  const latest = useRef({ onClose, t })
  useEffect(() => {
    latest.current = { onClose, t }
  }, [onClose, t])
  const id = session?.id
  const scope = getRuntimeTargetScopeKey()
  const databaseName = typeof window === "undefined" ? null : getDb().name
  const read = useLiveQuery(async () => {
    if (!id || databaseName === null) return null
    try {
      const row = await getSession(id)
      if (scope !== getRuntimeTargetScopeKey() || databaseName !== getDb().name) return null
      return { row, error: null }
    } catch (error: unknown) {
      return { row: undefined, error: error instanceof Error ? error.message : String(error) }
    }
  }, [id])
  useEffect(() => {
    if (!read || read.row) return
    if (read.error !== null) {
      toast.error(latest.current.t("location.exportFailed", { message: read.error }))
    }
    latest.current.onClose()
  }, [read])
  const loaded = read?.row
  if (!id || loaded?.id !== id) return null
  return (
    <SingleExportDialog
      session={loaded}
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    />
  )
}
