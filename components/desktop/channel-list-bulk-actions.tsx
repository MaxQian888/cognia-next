"use client"

import dynamic from "next/dynamic"
import { useCallback, useMemo, useState } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { AnimatePresence, motion } from "motion/react"

import { useReducedMotionVariants } from "@/lib/ui/motion"
import { ChannelListBulkToolbar } from "./channel-list-bulk-toolbar"

const MultiConversationShareDialog = dynamic(
  () =>
    import("@/components/share/multi-conversation-share-dialog").then(
      (module) => module.MultiConversationShareDialog
    ),
  { ssr: false }
)

const TOOLBAR_VARIANTS = {
  initial: { height: 0, opacity: 0, y: -4 },
  animate: { height: "auto", opacity: 1, y: 0 },
  exit: { height: 0, opacity: 0, y: -4 },
}

export interface ChannelListBulkActionsProps {
  visible: boolean
  selected: ReadonlySet<string>
  orderedIds: readonly string[]
  sessions: readonly ChatSession[]
  archived: boolean
  onDelete?: (ids: string[]) => void | Promise<void>
  onSetPinned?: (ids: string[], pinned: boolean) => void | Promise<void>
  onArchive?: (ids: string[]) => void | Promise<void>
  onUnarchive?: (ids: string[]) => void | Promise<void>
  onClear: () => void
}

export function ChannelListBulkActions({
  visible,
  selected,
  orderedIds,
  sessions,
  archived,
  onDelete,
  onSetPinned,
  onArchive,
  onUnarchive,
  onClear,
}: ChannelListBulkActionsProps) {
  const toolbarVariants = useReducedMotionVariants(TOOLBAR_VARIANTS)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareDialogRequested, setShareDialogRequested] = useState(false)
  const selectedIds = useMemo(() => [...selected], [selected])
  const shareSessions = useMemo(() => {
    const sessionById = new Map(sessions.map((session) => [session.id, session]))
    return orderedIds.flatMap((id) => {
      const session = selected.has(id) ? sessionById.get(id) : undefined
      return session ? [session] : []
    })
  }, [orderedIds, selected, sessions])

  const runAndClear = useCallback(
    async (action: (() => void | Promise<void>) | undefined) => {
      if (!action || selectedIds.length === 0) return
      await action()
      onClear()
    },
    [onClear, selectedIds.length]
  )

  const handleShareOpenChange = useCallback(
    (next: boolean) => {
      setShareOpen(next)
      if (!next) onClear()
    },
    [onClear]
  )

  return (
    <>
      <AnimatePresence initial={false}>
        {visible ? (
          <motion.div
            key="channel-list-bulk-toolbar"
            className="overflow-hidden"
            variants={toolbarVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
          >
            <ChannelListBulkToolbar
              count={selected.size}
              archived={archived}
              onDelete={() => runAndClear(onDelete ? () => onDelete(selectedIds) : undefined)}
              onPin={() =>
                runAndClear(onSetPinned ? () => onSetPinned(selectedIds, true) : undefined)
              }
              onUnpin={() =>
                runAndClear(onSetPinned ? () => onSetPinned(selectedIds, false) : undefined)
              }
              onArchive={() => runAndClear(onArchive ? () => onArchive(selectedIds) : undefined)}
              onUnarchive={() =>
                runAndClear(onUnarchive ? () => onUnarchive(selectedIds) : undefined)
              }
              onShare={() => {
                if (shareSessions.length === 0) return
                setShareDialogRequested(true)
                setShareOpen(true)
              }}
              onClear={onClear}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {shareDialogRequested ? (
        <MultiConversationShareDialog
          sessions={shareSessions}
          open={shareOpen}
          onOpenChange={handleShareOpenChange}
        />
      ) : null}
    </>
  )
}
