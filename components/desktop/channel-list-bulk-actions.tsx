"use client"

import dynamic from "next/dynamic"
import { useCallback, useMemo, useState } from "react"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"
import { AnimatePresence, motion } from "motion/react"

import { folderAcceptsSession } from "@/lib/chat/conversation-list-model"
import { trackConversationRowAction } from "@/lib/telemetry/conversation-list-events"
import { useReducedMotionVariants } from "@/lib/ui/motion"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { useTranslations } from "next-intl"
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
  /**
   * The list is showing the Archived view — the bar's shape before anything is
   * selected. Once rows are, each verb follows the rows it applies to (see
   * `ChannelListBulkToolbarProps.archivedCount`).
   */
  archived: boolean
  /** `rail` for the sidebar, `bar` for a page or the phone. */
  layout?: "rail" | "bar"
  /*
   * Writers resolve `false` when the list's action boundary refused or failed
   * the write (it has already said so); the selection is kept then, so the
   * user can retry or narrow it instead of rebuilding it.
   */
  onDelete?: (ids: string[]) => void | Promise<unknown>
  onSetPinned?: (ids: string[], pinned: boolean) => void | Promise<unknown>
  onArchive?: (ids: string[]) => void | Promise<unknown>
  onUnarchive?: (ids: string[]) => void | Promise<unknown>
  /** Clear the unread state of the selected conversations. */
  onMarkRead?: (ids: string[]) => void | Promise<unknown>
  /** Flag the selected conversations unread again. */
  onMarkUnread?: (ids: string[]) => void | Promise<unknown>
  /**
   * Conversations with unread messages — whatever the badge preference says.
   * Decides which way the read switch points for this selection.
   */
  unreadIds?: ReadonlySet<string>
  /**
   * The workspace's folders. Offered to the selection only where the folder
   * can hold *every* selected conversation (a folder is workspace-scoped; see
   * `folderAcceptsSession`) — the others are shown disabled.
   */
  folders?: readonly SessionFolder[]
  onMoveToFolder?: (ids: string[], folderId: string | null) => void | Promise<unknown>
  /**
   * Make a folder for the selection and file it there (`useChannelListActions`
   * → `handleNewFolderWith`). Offered only when the new folder — created in
   * `newFolderProjectId`, the active workspace — can hold every selected row.
   */
  onNewFolder?: (ids: readonly string[]) => Promise<boolean>
  newFolderProjectId?: string | null
  /** Grow the selection to every row on screen. */
  onSelectAll?: () => void
  /** Empty the selection without leaving it. */
  onDeselectAll?: () => void
  onClear: () => void
}

export function ChannelListBulkActions({
  visible,
  selected,
  orderedIds,
  sessions,
  archived,
  layout = "rail",
  onDelete,
  onSetPinned,
  onArchive,
  onUnarchive,
  onMarkRead,
  onMarkUnread,
  unreadIds,
  folders,
  onMoveToFolder,
  onNewFolder,
  newFolderProjectId,
  onSelectAll,
  onDeselectAll,
  onClear,
}: ChannelListBulkActionsProps) {
  const toolbarVariants = useReducedMotionVariants(TOOLBAR_VARIANTS)
  const tRow = useTranslations("desktop.sessionRow")
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
  // A folder the list model would refuse for even one of the selected rows
  // (another workspace's folder under a cross-workspace list) is not a place
  // the selection can go: filing it there would show the move and then undo
  // it on screen. Only the rows actually selected decide.
  // What the delete confirm names, in list order and in the rows' own words.
  const selectedTitles = useMemo(
    () =>
      shareSessions.map((session) =>
        sessionDisplayTitle(session.title, {
          untitled: tRow("untitled"),
          placeholder: tRow("placeholderTitle"),
        })
      ),
    [shareSessions, tRow]
  )
  const selectedSessions = useMemo(
    () => sessions.filter((session) => selected.has(session.id)),
    [sessions, selected]
  )
  const blockedFolderIds = useMemo(() => {
    const blocked = new Set<string>()
    for (const folder of folders ?? []) {
      if (!selectedSessions.every((session) => folderAcceptsSession(folder, session))) {
        blocked.add(folder.id)
      }
    }
    return blocked
  }, [folders, selectedSessions])
  // What the selection already is, so each two-way switch offers the
  // direction that changes something. An empty selection reads as "not
  // pinned, unread, unfiled" — the bar's buttons are disabled then anyway.
  const allPinned =
    selectedSessions.length > 0 && selectedSessions.every((session) => session.pinned === true)
  const anyUnread =
    selectedSessions.length === 0 ||
    unreadIds === undefined ||
    selectedSessions.some((session) => unreadIds.has(session.id))
  const anyInFolder = selectedSessions.some((session) => session.folderId != null)
  // A search that reaches past the archive split can select both kinds. Each
  // verb acts on the rows it means something for: Archive on the active ones
  // (re-archiving would restamp `archivedAt`), Unarchive on the archived ones,
  // read state on the active ones (an archived row carries none).
  // An id whose row is not in `sessions` (not loaded yet) is taken to be on
  // the side the view shows.
  const { archivedIds, activeIds } = useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const archivedOut: string[] = []
    const activeOut: string[] = []
    for (const id of selectedIds) {
      const row = byId.get(id)
      const isArchived = row ? row.archivedAt != null : archived
      ;(isArchived ? archivedOut : activeOut).push(id)
    }
    return { archivedIds: archivedOut, activeIds: activeOut }
  }, [sessions, selectedIds, archived])
  // A folder made from here lands in the active workspace; it is only offered
  // when that folder could hold every selected row.
  const newFolderFits = selectedSessions.every((session) =>
    folderAcceptsSession({ projectId: newFolderProjectId ?? undefined }, session)
  )

  const runAndClear = useCallback(
    async (action: () => void | Promise<unknown>) => {
      if (selectedIds.length === 0) return
      const outcome = await action()
      // `false` = refused or failed; keep the selection for a retry.
      if (outcome !== false) onClear()
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
              total={orderedIds.length}
              archived={archived}
              archivedCount={archivedIds.length}
              layout={layout}
              allPinned={allPinned}
              anyUnread={anyUnread}
              anyInFolder={anyInFolder}
              onDelete={onDelete ? () => runAndClear(() => onDelete(selectedIds)) : undefined}
              onPin={
                onSetPinned ? () => runAndClear(() => onSetPinned(selectedIds, true)) : undefined
              }
              onUnpin={
                onSetPinned ? () => runAndClear(() => onSetPinned(selectedIds, false)) : undefined
              }
              onArchive={onArchive ? () => runAndClear(() => onArchive(activeIds)) : undefined}
              onUnarchive={
                onUnarchive ? () => runAndClear(() => onUnarchive(archivedIds)) : undefined
              }
              onMarkRead={onMarkRead ? () => runAndClear(() => onMarkRead(activeIds)) : undefined}
              onMarkUnread={
                onMarkUnread ? () => runAndClear(() => onMarkUnread(activeIds)) : undefined
              }
              folders={folders}
              blockedFolderIds={blockedFolderIds}
              onMoveToFolder={
                onMoveToFolder
                  ? (folderId) => runAndClear(() => onMoveToFolder(selectedIds, folderId))
                  : undefined
              }
              onNewFolder={
                onNewFolder && newFolderFits
                  ? () => runAndClear(() => onNewFolder(selectedIds))
                  : undefined
              }
              onSelectAll={onSelectAll}
              onDeselectAll={onDeselectAll}
              selectedTitles={selectedTitles}
              onShare={() => {
                if (shareSessions.length === 0) return
                // Every sibling action reports itself through the list's
                // wrapper; share went through a dialog instead and reported
                // nothing at all.
                void trackConversationRowAction("share", shareSessions.length)
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
