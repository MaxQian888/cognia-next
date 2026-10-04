"use client"

/**
 * Every write a conversation list makes to its rows, with the feedback that
 * goes with it — shared by the desktop sidebar (`useChannelListActions`) and
 * the mobile drawer (`MobileChannelList`), so the two cannot word, gate or
 * track the same action differently:
 *
 * - every write goes through `useSessionWrite`: a handed-off conversation is
 *   refused up front, a failed write is toasted instead of becoming an
 *   unhandled rejection, and the returned promise resolves `true` / `false`
 *   (never rejects), so a caller can keep a selection when a bulk write fails;
 * - the confirmations live here (the owner's writers are plain writes), so
 *   single and bulk actions word their outcome the same way, and archive
 *   and unarchive offer their own undo — the row leaves the view it was in,
 *   and undoing an archive reopens the conversation that was open;
 * - deleting or archiving the open conversation opens the row that takes its
 *   place (`nextAfterRemoval`) instead of dropping to the welcome screen;
 * - each action is counted once (`trackConversationRowAction`).
 *
 * Also the row-menu extras that need no owner writer (read state, copy link)
 * or only one (branch), and the export dialog's target — hosted once by the
 * list rather than once per row (`ConversationExportDialog`).
 *
 * Every returned handler is stable across renders while the set of available
 * owner callbacks stays the same: the rows are memoized on them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import { useSessionWrite, type SessionWriteAction } from "@/hooks/chat/use-session-write"
import { buildConversationLink } from "@/lib/chat/message-permalink"
import { nextAfterRemoval } from "@/lib/chat/next-after-removal"
import { markSessionRead, markSessionUnread } from "@/lib/db/session-state"
import { isTauri } from "@/lib/tauri"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { trackConversationRowAction } from "@/lib/telemetry/conversation-list-events"

const log = loggers.ui

type Write<A extends unknown[]> = (...args: A) => void | Promise<unknown>

/** The row-menu actions that are not plain owner writes. */
export interface ConversationRowExtraActions {
  onMarkRead?: (id: string) => void
  onMarkUnread?: (id: string) => void
  /** Branch the whole conversation into a new, linked one. */
  onBranch?: (id: string) => void
  /** Copy a link that opens this conversation. */
  onCopyLink?: (id: string) => void
  /** Open the single-conversation export / share-link dialog. */
  onExportShare?: (id: string) => void
}

export interface ConversationRowWriters {
  onDelete: Write<[id: string]>
  onRename: Write<[id: string, title: string]>
  onTogglePinned?: Write<[id: string, pinned: boolean]>
  onArchive?: Write<[id: string]>
  onUnarchive?: Write<[id: string]>
  onBulkDelete?: Write<[ids: string[]]>
  onBulkSetPinned?: Write<[ids: string[], pinned: boolean]>
  onBulkArchive?: Write<[ids: string[]]>
  onBulkUnarchive?: Write<[ids: string[]]>
  onRenameFolder?: Write<[id: string, name: string]>
  onDeleteFolder?: Write<[id: string]>
  onAssignToFolder?: Write<[sessionId: string, folderId: string | null]>
  /** Batched folder assignment for a multi-selection (one write for all of it). */
  onBulkAssignToFolder?: Write<[ids: string[], folderId: string | null]>
  /** A folder was deleted — forget any view state kept for it. */
  onFolderDeleted?: (id: string) => void
  /** Persist one section's manual order (drag reorder). */
  onReorderSessions?: Write<[ids: string[], sectionKey: string]>
  /**
   * Branch a whole conversation and resolve with the new row, or `null` when
   * there is nothing to branch yet. The list opens it and says so; absent, the
   * row menus offer no Branch.
   */
  onBranch?: (id: string) => Promise<ChatSession | null>
}

export interface UseConversationRowActionsOptions extends ConversationRowWriters {
  /**
   * The list's rows by id, read at call time — what the write gate checks a
   * handoff lock on, and where an undo or a toast finds a title. Omitted,
   * writes run unchecked by the gate (the write guard still refuses them).
   */
  resolveSessions?: (ids: readonly string[]) => ChatSession[]
  /** The rendered order, read at call time — picks what opens after a removal. */
  getRenderedOrder?: () => readonly string[]
  /** The conversation on screen. */
  activeSessionId?: string | null
  /** Open a conversation — used to land on the next row, or on a branch. */
  onSelect?: (id: string) => void
}

export function useConversationRowActions(options: UseConversationRowActionsOptions) {
  const tBulk = useTranslations("desktop.channelList.bulk")
  const tRow = useTranslations("desktop.channelList.rowToast")
  const runWrite = useSessionWrite()

  // Everything the handlers read at call time. Refreshed after every commit,
  // so a handler created once still sees the latest owner callbacks, rows,
  // order and translations.
  const latest = useRef({ options, tBulk, tRow })
  useEffect(() => {
    latest.current = { options, tBulk, tRow }
  })

  const rowsFor = useCallback(
    (ids: readonly string[]) => latest.current.options.resolveSessions?.(ids) ?? [],
    []
  )

  /**
   * Run a write that may take the open conversation out of the list, then open
   * whatever took its slot. The neighbour is chosen from the order *before*
   * the write, while the removed rows are still in it.
   */
  const runRemoval = useCallback(
    async (
      action: SessionWriteAction,
      ids: readonly string[],
      write: () => unknown,
      feedback?: Parameters<typeof runWrite>[3]
    ): Promise<boolean> => {
      const { options: current } = latest.current
      const next = nextAfterRemoval(
        current.getRenderedOrder?.() ?? [],
        new Set(ids),
        current.activeSessionId ?? null
      )
      const ok = await runWrite(action, rowsFor(ids), write, feedback)
      if (ok && next) {
        log.info("conversation list open next after removal", { action })
        latest.current.options.onSelect?.(next)
      }
      return ok
    },
    [runWrite, rowsFor]
  )

  const has = {
    togglePinned: Boolean(options.onTogglePinned),
    archive: Boolean(options.onArchive),
    unarchive: Boolean(options.onUnarchive),
    assign: Boolean(options.onAssignToFolder),
    bulkDelete: Boolean(options.onBulkDelete),
    bulkSetPinned: Boolean(options.onBulkSetPinned),
    bulkArchive: Boolean(options.onBulkArchive),
    bulkUnarchive: Boolean(options.onBulkUnarchive),
    bulkAssign: Boolean(options.onBulkAssignToFolder || options.onAssignToFolder),
    renameFolder: Boolean(options.onRenameFolder),
    deleteFolder: Boolean(options.onDeleteFolder),
    reorderSessions: Boolean(options.onReorderSessions),
  }

  const rowActions = useMemo(() => {
    const cb = () => latest.current.options
    const bulkT = () => latest.current.tBulk
    const unarchiveIds = (ids: string[]) =>
      runWrite("unarchive", rowsFor(ids), () =>
        ids.length === 1 ? cb().onUnarchive?.(ids[0]!) : cb().onBulkUnarchive?.(ids)
      )
    /**
     * Undo an archive: restore the rows, and when the conversation that was
     * open is among them, open it again — the archive moved the user onto its
     * neighbour, and an undo that left them there would only half undo it.
     */
    const undoArchive = async (ids: string[], reopen: string | null) => {
      const ok = await unarchiveIds(ids)
      if (ok && reopen) cb().onSelect?.(reopen)
    }
    /** The open conversation, if it is one of `ids` — read before the write. */
    const openAmong = (ids: readonly string[]) => {
      const active = cb().activeSessionId ?? null
      return active && ids.includes(active) ? active : null
    }
    /**
     * Undo an unarchive. Written straight through the routed writer rather
     * than the owner's `onArchive`: the owner's archive leaves the open
     * conversation, and reversing a restore must not close the chat the user
     * is reading.
     */
    //
    // Loaded on use: the routed writer reaches the chat store and the sidecar
    // teardown, which every list importing this hook would otherwise load up
    // front for a toast button most users never press.
    const undoUnarchive = async (ids: string[]) => {
      const { setSessionsArchived } = await import("@/lib/chat/session-archive-writes")
      await setSessionsArchived(ids, true)
    }
    return {
      onDelete: (id: string) => {
        void trackConversationRowAction("delete")
        return runRemoval("delete", [id], () => cb().onDelete(id))
      },
      onRename: (id: string, title: string) => {
        void trackConversationRowAction("rename")
        return runWrite("rename", rowsFor([id]), () => cb().onRename(id, title))
      },
      onTogglePinned: has.togglePinned
        ? (id: string, pinned: boolean) => {
            void trackConversationRowAction(pinned ? "pin" : "unpin")
            return runWrite(
              pinned ? "pin" : "unpin",
              rowsFor([id]),
              () => cb().onTogglePinned!(id, pinned),
              { success: bulkT()(pinned ? "pinSuccess" : "unpinSuccess", { count: 1 }) }
            )
          }
        : undefined,
      onArchive: has.archive
        ? (id: string) => {
            void trackConversationRowAction("archive")
            const reopen = openAmong([id])
            return runRemoval("archive", [id], () => cb().onArchive!(id), {
              success: bulkT()("archiveSuccess", { count: 1 }),
              undo: has.unarchive
                ? {
                    label: latest.current.tRow("undo"),
                    run: () => undoArchive([id], reopen),
                  }
                : undefined,
            })
          }
        : undefined,
      onUnarchive: has.unarchive
        ? (id: string) => {
            void trackConversationRowAction("unarchive")
            return runWrite("unarchive", rowsFor([id]), () => cb().onUnarchive!(id), {
              success: bulkT()("unarchiveSuccess", { count: 1 }),
              undo: { label: latest.current.tRow("undo"), run: () => undoUnarchive([id]) },
            })
          }
        : undefined,
      onAssignToFolder: has.assign
        ? (sessionId: string, folderId: string | null) => {
            void trackConversationRowAction(folderId ? "assign-folder" : "unassign-folder")
            return runWrite(
              "move",
              rowsFor([sessionId]),
              () => cb().onAssignToFolder!(sessionId, folderId),
              {
                success: bulkT()(folderId ? "moveSuccess" : "removeFromFolderSuccess", {
                  count: 1,
                }),
              }
            )
          }
        : undefined,
      onBulkDelete: has.bulkDelete
        ? (ids: string[]) => {
            void trackConversationRowAction("delete", ids.length)
            return runRemoval("delete", ids, () => cb().onBulkDelete!(ids), {
              success: bulkT()("deleteSuccess", { count: ids.length }),
            })
          }
        : undefined,
      onBulkSetPinned: has.bulkSetPinned
        ? (ids: string[], pinned: boolean) => {
            void trackConversationRowAction(pinned ? "pin" : "unpin", ids.length)
            return runWrite(
              pinned ? "pin" : "unpin",
              rowsFor(ids),
              () => cb().onBulkSetPinned!(ids, pinned),
              { success: bulkT()(pinned ? "pinSuccess" : "unpinSuccess", { count: ids.length }) }
            )
          }
        : undefined,
      onBulkArchive: has.bulkArchive
        ? (ids: string[]) => {
            void trackConversationRowAction("archive", ids.length)
            const reopen = openAmong(ids)
            return runRemoval("archive", ids, () => cb().onBulkArchive!(ids), {
              success: bulkT()("archiveSuccess", { count: ids.length }),
              undo:
                has.bulkUnarchive || (ids.length === 1 && has.unarchive)
                  ? {
                      label: latest.current.tRow("undo"),
                      run: () => undoArchive(ids, reopen),
                    }
                  : undefined,
            })
          }
        : undefined,
      onBulkUnarchive: has.bulkUnarchive
        ? (ids: string[]) => {
            void trackConversationRowAction("unarchive", ids.length)
            return runWrite("unarchive", rowsFor(ids), () => cb().onBulkUnarchive!(ids), {
              success: bulkT()("unarchiveSuccess", { count: ids.length }),
              undo: { label: latest.current.tRow("undo"), run: () => undoUnarchive(ids) },
            })
          }
        : undefined,
      onBulkAssignToFolder: has.bulkAssign
        ? (ids: string[], folderId: string | null) => {
            void trackConversationRowAction(
              folderId ? "assign-folder" : "unassign-folder",
              ids.length
            )
            // The batch writer files the whole selection in one transaction
            // (one live-query emit, all-or-nothing). An owner that only has
            // the per-row writer still works — one write per row, in order,
            // so a failure stops the move where it happened.
            return runWrite(
              "move",
              rowsFor(ids),
              async () => {
                const { onBulkAssignToFolder, onAssignToFolder } = cb()
                if (onBulkAssignToFolder) return onBulkAssignToFolder(ids, folderId)
                for (const id of ids) await onAssignToFolder!(id, folderId)
              },
              {
                success: bulkT()(folderId ? "moveSuccess" : "removeFromFolderSuccess", {
                  count: ids.length,
                }),
              }
            )
          }
        : undefined,
      // Read state is the reader's own and needs no owner writer.
      onBulkMarkRead: (ids: string[]) => {
        void trackConversationRowAction("mark-read", ids.length)
        return runWrite("markRead", rowsFor(ids), () =>
          Promise.all(ids.map((id) => markSessionRead(id)))
        )
      },
      // The other direction of the same switch: a selection that is already
      // read is flagged back for later, as one row's menu does.
      onBulkMarkUnread: (ids: string[]) => {
        void trackConversationRowAction("mark-unread", ids.length)
        return runWrite("markUnread", rowsFor(ids), () =>
          Promise.all(ids.map((id) => markSessionUnread(id)))
        )
      },
      onRenameFolder: has.renameFolder
        ? (id: string, name: string) =>
            runWrite("folderRename", [], () => cb().onRenameFolder!(id, name))
        : undefined,
      onDeleteFolder: has.deleteFolder
        ? async (id: string) => {
            const ok = await runWrite("folderDelete", [], () => cb().onDeleteFolder!(id))
            // A deleted folder's persisted collapse flag would otherwise sit in
            // the UI store for good.
            if (ok) cb().onFolderDeleted?.(id)
            return ok
          }
        : undefined,
      onReorderSessions: has.reorderSessions
        ? (ids: string[], sectionKey: string) =>
            runWrite("reorder", rowsFor(ids), () => cb().onReorderSessions!(ids, sectionKey))
        : undefined,
    }
    // Rebuilt only when an owner callback appears or disappears — the handlers
    // read the callbacks themselves through `latest`.
  }, [
    runWrite,
    runRemoval,
    rowsFor,
    has.togglePinned,
    has.archive,
    has.unarchive,
    has.assign,
    has.bulkDelete,
    has.bulkSetPinned,
    has.bulkArchive,
    has.bulkUnarchive,
    has.bulkAssign,
    has.renameFolder,
    has.deleteFolder,
    has.reorderSessions,
  ])

  // The single-conversation export / share-link dialog, hosted once by the
  // list rather than once per row.
  const [exportSessionId, setExportSessionId] = useState<string | null>(null)
  const closeExport = useCallback(() => setExportSessionId(null), [])

  const hasBranch = Boolean(options.onBranch)
  const extraActions = useMemo<ConversationRowExtraActions>(
    () => ({
      onMarkRead: (id: string) => {
        void trackConversationRowAction("mark-read")
        void runWrite("markRead", rowsFor([id]), () => markSessionRead(id))
      },
      onMarkUnread: (id: string) => {
        void trackConversationRowAction("mark-unread")
        void runWrite("markUnread", rowsFor([id]), () => markSessionUnread(id))
      },
      onBranch: hasBranch
        ? (id: string) => {
            void trackConversationRowAction("branch")
            let created: ChatSession | null = null
            void runWrite("branch", rowsFor([id]), async () => {
              created = await latest.current.options.onBranch!(id)
            }).then((ok) => {
              if (!ok) return
              const branch = created as ChatSession | null
              if (!branch) {
                toast.info(latest.current.tRow("nothingToBranch"))
                return
              }
              toast.success(latest.current.tRow("branched"))
              latest.current.options.onSelect?.(branch.id)
            })
          }
        : undefined,
      onCopyLink: (id: string) => {
        void trackConversationRowAction("copy-link")
        const link = buildConversationLink(id, { desktop: isTauri() })
        void writeClipboardText(link)
          .then(() => toast.success(latest.current.tRow("linkCopied")))
          .catch((error: unknown) => {
            log.warn("conversation copy link failed", { error: String(error) })
            toast.error(latest.current.tRow("linkCopyFailed"))
          })
      },
      onExportShare: (id: string) => {
        void trackConversationRowAction("export")
        setExportSessionId(id)
      },
    }),
    [runWrite, rowsFor, hasBranch]
  )

  return { rowActions, extraActions, exportSessionId, closeExport }
}

/** The id-keyed row and bulk writers `useConversationRowActions` hands out. */
export type ConversationRowActions = ReturnType<typeof useConversationRowActions>["rowActions"]
