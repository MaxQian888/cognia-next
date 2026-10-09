"use client"

/**
 * Keyboard triage for the Inbox conversation list.
 *
 * Binds the pure keymap (`lib/inbox/triage-keymap.ts`) to the list the way the
 * chat rail does (`components/desktop/channel-list.tsx`, its container
 * `onKeyDown`): one handler on the list container, acting only while focus is
 * on the list itself — the container, a row's own button (`data-inbox-row-select`)
 * or a row's checkbox (`data-inbox-row-check`). Any other control inside it (a
 * section header's collapse button, a row's `⋯`, a plugin action) keeps its own
 * keys, and nothing fires while a text field, menu or dialog has the keystroke.
 *
 * Moving (`j`/`k`, arrows, Home/End) previews the row it lands on, keeps DOM
 * focus on that row's button and scrolls it into view, so the triage pane
 * follows the keyboard the way it follows a click. Shift+move extends the
 * checked set from its anchor. Triage keys act on the checked rows when any
 * are checked, else on the focused (or previewed) row.
 */

import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import {
  resolveTriageKey,
  triageMoveIndex,
  type InboxTriageCommand,
} from "@/lib/inbox/triage-keymap"

/** The triage commands that act on rows rather than on the list. */
export type InboxRowCommandKind = Extract<
  InboxTriageCommand["kind"],
  "toggleRead" | "togglePin" | "toggleArchive" | "resolve" | "snooze" | "assign" | "label"
>

const ROW_COMMANDS = new Set<InboxTriageCommand["kind"]>([
  "toggleRead",
  "togglePin",
  "toggleArchive",
  "resolve",
  "snooze",
  "assign",
  "label",
])

export interface UseInboxTriageKeyboardOptions {
  /** Off on the phone (tap model) — the hook then ignores every key. */
  enabled: boolean
  /** The rows a reader can see, top to bottom (`visibleConversationRows`). */
  rows: readonly ConversationRowItem[]
  /** The previewed session (the triage pane's), if any. */
  previewSessionId: string | null
  /** Checked session ids (bulk selection), already filtered to visible rows. */
  checked: ReadonlySet<string>
  /** The checked set's anchor, for Shift+move. */
  anchorId: string | null
  onPreview: (row: ConversationRowItem) => void
  onOpen: (row: ConversationRowItem) => void
  onToggleCheck: (sessionId: string) => void
  /** Replace the checked set; the LAST id becomes the anchor. */
  onSelectIds: (ids: readonly string[]) => void
  onSelectAll: () => void
  onClearChecked: () => void
  onClearPreview: () => void
  onFocusSearch: () => void
  onHelp: () => void
  /**
   * A triage key. `targets` are the checked rows when any are checked, else
   * the focused row; `scope` says which, so a menu key can open the bulk
   * bar's menu or the row's.
   */
  onRowCommand: (
    kind: InboxRowCommandKind,
    targets: ConversationRowItem[],
    scope: "checked" | "row"
  ) => void
}

/** Find a row's button inside `container` by session id (no selector escaping). */
export function findRowButton(
  container: HTMLElement | null,
  sessionId: string
): HTMLElement | null {
  if (!container) return null
  return (
    Array.from(container.querySelectorAll<HTMLElement>("[data-inbox-row-select]")).find(
      (element) => element.dataset.inboxRowSelect === sessionId
    ) ?? null
  )
}

/** Focus a row's button and bring it into view. */
export function focusRowButton(container: HTMLElement | null, sessionId: string): boolean {
  const button = findRowButton(container, sessionId)
  if (!button) return false
  button.focus({ preventScroll: true })
  if (typeof button.scrollIntoView === "function") button.scrollIntoView({ block: "nearest" })
  return true
}

function isTypingTarget(target: HTMLElement): boolean {
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  )
}

export function useInboxTriageKeyboard(options: UseInboxTriageKeyboardOptions) {
  const {
    enabled,
    rows,
    previewSessionId,
    checked,
    anchorId,
    onPreview,
    onOpen,
    onToggleCheck,
    onSelectIds,
    onSelectAll,
    onClearChecked,
    onClearPreview,
    onFocusSearch,
    onHelp,
    onRowCommand,
  } = options

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!enabled || event.defaultPrevented) return
      const target = event.target as HTMLElement
      // A key spent on a menu or dialog (portaled out of this element in the
      // DOM, not in React's tree, so it still bubbles here) is theirs.
      if (target.closest('[role="menu"],[role="dialog"],[role="alertdialog"]')) return
      if (isTypingTarget(target)) return

      const rowButton = target.closest<HTMLElement>("[data-inbox-row-select]")
      const rowCheck = target.closest<HTMLElement>("[data-inbox-row-check]")
      const onList =
        target === event.currentTarget ||
        (rowButton !== null && rowButton === target) ||
        rowCheck !== null
      if (!onList) return

      const command = resolveTriageKey({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
      })
      if (!command) return

      const consume = () => {
        event.preventDefault()
        // Keep app-level single-key handlers (`/` is `app.search.focus`) from
        // acting on a key the list already answered.
        event.stopPropagation()
      }

      const fromId =
        rowButton?.dataset.inboxRowSelect ??
        rowCheck?.dataset.inboxRowCheck ??
        previewSessionId ??
        null
      const ids = rows.map((row) => row.session.id)
      const currentIndex = fromId ? ids.indexOf(fromId) : -1
      const currentRow = currentIndex >= 0 ? rows[currentIndex] : undefined
      const container = event.currentTarget

      switch (command.kind) {
        case "move": {
          if (rows.length === 0) return
          consume()
          const nextIndex = triageMoveIndex(currentIndex, rows.length, command.to)
          const next = rows[nextIndex]!
          if (command.extend) {
            const anchor =
              anchorId && ids.includes(anchorId) ? anchorId : (fromId ?? next.session.id)
            const a = ids.indexOf(anchor)
            const lo = Math.min(a, nextIndex)
            const hi = Math.max(a, nextIndex)
            // Anchor last, so `selectIds` keeps it as the anchor and the next
            // Shift+move extends from the same place.
            const range = ids.slice(lo, hi + 1).filter((id) => id !== anchor)
            onSelectIds([...range, anchor])
          }
          onPreview(next)
          focusRowButton(container, next.session.id)
          return
        }
        case "open":
          if (!currentRow) return
          consume()
          onOpen(currentRow)
          return
        case "toggleCheck":
          if (!currentRow) return
          consume()
          onToggleCheck(currentRow.session.id)
          return
        case "selectAll":
          if (rows.length === 0) return
          consume()
          onSelectAll()
          return
        case "focusSearch":
          consume()
          onFocusSearch()
          return
        case "help":
          consume()
          onHelp()
          return
        case "escape":
          if (checked.size > 0) {
            consume()
            onClearChecked()
          } else if (previewSessionId) {
            consume()
            onClearPreview()
          }
          return
        default: {
          if (!ROW_COMMANDS.has(command.kind)) return
          const checkedRows = rows.filter((row) => checked.has(row.session.id))
          if (checkedRows.length > 0) {
            consume()
            onRowCommand(command.kind as InboxRowCommandKind, checkedRows, "checked")
          } else if (currentRow) {
            consume()
            onRowCommand(command.kind as InboxRowCommandKind, [currentRow], "row")
          }
        }
      }
    },
    [
      enabled,
      rows,
      previewSessionId,
      checked,
      anchorId,
      onPreview,
      onOpen,
      onToggleCheck,
      onSelectIds,
      onSelectAll,
      onClearChecked,
      onClearPreview,
      onFocusSearch,
      onHelp,
      onRowCommand,
    ]
  )

  return { onKeyDown }
}
