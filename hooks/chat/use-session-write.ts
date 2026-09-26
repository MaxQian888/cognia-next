"use client"

/**
 * One way to run a conversation-list write and tell the user how it went.
 *
 * The desktop list, its bulk toolbar and its folders used to fire every write
 * and forget it (`void onDelete(id)`): a refused write — a conversation handed
 * off to another device, a failed Dexie transaction — became an unhandled
 * rejection and the row simply did not change. The phone list had already
 * solved this locally; this is that solution, shared, so both lists refuse the
 * same writes with the same words.
 *
 * - A handed-off conversation (`handoffLock`) is refused up front, before the
 *   write runs, except for the unread-state actions: read state is the reader's,
 *   not the conversation's, and the write guard does not cover it either.
 * - A write that throws is logged and toasted; a lock the row did not know
 *   about yet (the lock landed after render) still reads as "locked".
 * - `success` / `undo` let a caller confirm the write — archive offers its
 *   own reversal, since the row leaves the view it was archived from.
 */

import { useCallback, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"

import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"

const log = loggers.ui

/** Every list write the hook can name in its failure message. */
export const SESSION_WRITE_ACTIONS = [
  "rename",
  "pin",
  "unpin",
  "archive",
  "unarchive",
  "delete",
  "move",
  "moveWorkspace",
  "markRead",
  "markUnread",
  "branch",
  "folderCreate",
  "folderRename",
  "folderDelete",
  "reorder",
] as const

export type SessionWriteAction = (typeof SESSION_WRITE_ACTIONS)[number]

/** Actions that change the reader's state rather than the conversation's. */
const LOCK_EXEMPT: ReadonlySet<SessionWriteAction> = new Set(["markRead", "markUnread"])

/** Refused by the session write guard because the row is mid-handoff. */
export function isSessionHandoffLocked(error: unknown): boolean {
  if (error instanceof SessionHandoffLockedError) return true
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "session_handoff_locked"
  )
}

/** Whether `action` would be refused for these rows before it runs. */
export function isSessionWriteBlocked(
  action: SessionWriteAction,
  sessions: readonly Pick<ChatSession, "handoffLock">[]
): boolean {
  if (LOCK_EXEMPT.has(action)) return false
  return sessions.some((session) => Boolean(session.handoffLock))
}

export interface SessionWriteFeedback {
  /** Toast shown when the write lands. Omitted = silent success. */
  success?: string
  /** Offer a reversal on the success toast. Requires `success`. */
  undo?: { label: string; run: () => void | Promise<unknown> }
}

export type RunSessionWrite = (
  action: SessionWriteAction,
  sessions: ChatSession | readonly ChatSession[],
  write: () => unknown,
  feedback?: SessionWriteFeedback
) => Promise<boolean>

/**
 * Returns `runWrite(action, sessions, write, feedback?)`, which resolves `true`
 * when the write landed and `false` when it was refused or failed (after
 * telling the user). Never rejects.
 *
 * The returned function is stable for the component's lifetime: lists build
 * every row's handlers on it, and a new identity per render would re-render
 * every memoized row. `useTranslations` hands back a fresh function each
 * render, so it is read through a ref at call time.
 */
export function useSessionWrite(): RunSessionWrite {
  const translate = useTranslations("chat.sessionWrite")
  const translateRef = useRef(translate)
  useEffect(() => {
    translateRef.current = translate
  }, [translate])
  return useCallback<RunSessionWrite>(async (action, sessions, write, feedback) => {
    const t = translateRef.current
    const rows: readonly ChatSession[] = Array.isArray(sessions)
      ? (sessions as readonly ChatSession[])
      : [sessions as ChatSession]
    if (isSessionWriteBlocked(action, rows)) {
      log.info("session write refused: handoff lock", {
        action,
        sessionIds: rows.filter((s) => s.handoffLock).map((s) => s.id),
      })
      toast.error(t("actionLocked"))
      return false
    }
    try {
      await write()
    } catch (error) {
      const locked = isSessionHandoffLocked(error)
      const message = error instanceof Error ? error.message : String(error)
      log.warn("session write failed", {
        action,
        sessionIds: rows.map((s) => s.id),
        locked,
        error: message,
      })
      if (locked) toast.error(t("actionLocked"))
      else toast.error(t(`actionFailed.${action}`), { description: message })
      return false
    }
    if (feedback?.success) {
      const undo = feedback.undo
      toast.success(
        feedback.success,
        undo
          ? {
              action: {
                label: undo.label,
                onClick: () => {
                  // The reversal is a write too; its failure must not vanish.
                  void Promise.resolve()
                    .then(undo.run)
                    .catch((error: unknown) => {
                      const message = error instanceof Error ? error.message : String(error)
                      log.warn("session write undo failed", { action, error: message })
                      toast.error(t("undoFailed"), { description: message })
                    })
                },
              },
            }
          : undefined
      )
    }
    return true
  }, [])
}
