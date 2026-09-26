"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { listSessionBranches } from "@/lib/db/sessions"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { HoverScrollText } from "@/components/chat/ui/hover-scroll-text"
import { JumpFlash } from "@/components/chat/jump-flash"
import { ThreadHandoffSourceDialog } from "@/components/thread-handoff/thread-handoff-source-dialog"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { SessionRunIndicator } from "@/components/chat/session-run-indicator"
import {
  CONTEXT_MENU_KIT,
  DROPDOWN_MENU_KIT,
  SessionRowMenuItems,
  type CogniaAgentStatus,
  type SessionRowMenuItemsProps,
} from "@/components/desktop/session-row-menu-items"
import type { ChatStatus } from "@/stores/chat/chat-store"
import { isImeComposing } from "@/lib/ui/ime"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { cn } from "@/lib/utils"
import { HOVER_REVEAL_CONTROL_CLASS, HOVER_REVEAL_GROUP_CLASS } from "@/lib/ui/hover-reveal"
import {
  CONVERSATION_TIMESTAMP_FORMATS,
  conversationTimestampShape,
} from "@/lib/chat/conversation-timestamp"
import { folderAcceptsSession } from "@/lib/chat/conversation-list-model"
import { useMoveSessionWorkspace } from "@/hooks/workspace/use-move-session-workspace"
import { useProjectStore } from "@/stores/project/project-store"
import type { AvatarSubject } from "@/lib/ui/avatar"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import type {
  ChatSession,
  ConversationSidebarMetadata,
  SessionFolder,
} from "@cognia/agent-config-types"
import {
  BotIcon,
  BoxesIcon,
  GitBranchIcon,
  GripVerticalIcon,
  HashIcon,
  LockKeyholeIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  CpuIcon,
  MoreHorizontalIcon,
  PinIcon,
  UsersIcon,
  WaypointsIcon,
} from "lucide-react"
import { toast } from "sonner"
import { useFormatter, useNow, useTimeZone, useTranslations } from "next-intl"
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react"

const log = loggers.ui

type SessionRowMetadataKind = ConversationSidebarMetadata

export interface SessionRowMetadataItem {
  kind: SessionRowMetadataKind
  value: string
}

const METADATA_ICON = {
  agent: BotIcon,
  model: CpuIcon,
  provider: WaypointsIcon,
  workspace: BoxesIcon,
} satisfies Record<SessionRowMetadataKind, typeof BotIcon>

/**
 * Row actions beyond the list's core writes, bundled so the list threads one
 * stable object through its sections instead of a prop per action. Each takes
 * the row's id; an absent one hides its menu item.
 */
export interface SessionRowExtraActions {
  onMarkRead?: (id: string) => void
  onMarkUnread?: (id: string) => void
  /** Branch the whole conversation into a new, linked one. */
  onBranch?: (id: string) => void
  /** Copy a link that opens this conversation. */
  onCopyLink?: (id: string) => void
  /** Open the single-conversation export / share-link dialog. */
  onExportShare?: (id: string) => void
}

interface SessionRowProps {
  session: ChatSession
  active: boolean
  /** Optional dot color (assistant character avatarColor) shown left of title. */
  accentColor?: string
  /** Resolved Agent/Team identity rendered in preference to the generic icon. */
  iconSubject?: AvatarSubject
  /** Optional unread count → shows a badge. */
  unread?: number
  /**
   * Whether the conversation has unread messages, independent of `unread`:
   * the badge count is dropped when badges are turned off, but the read-state
   * menu item still has to know which way it points.
   */
  isUnread?: boolean
  /** Mark read / unread, branch, copy link, export & share. */
  extraActions?: SessionRowExtraActions
  /**
   * Roving tab stop. `false` takes the row's controls out of the Tab order —
   * the list keeps a single tab stop and moves between rows with the arrow
   * keys. Omitted (other surfaces), every control stays tabbable.
   */
  tabbable?: boolean
  /** The row's select button received focus — the list syncs its focus ring. */
  onRowFocus?: (id: string) => void
  /**
   * Live turn state of this conversation (streaming, waiting on an approval,
   * last turn failed). Supplied by the list from one chat-store read rather
   * than a selector per row; omitted or `"idle"`, nothing is drawn.
   */
  runStatus?: ChatStatus
  /**
   * Whether this row participates in the channel-list multi-selection.
   * Renders a distinct ring + accent background separate from the single
   * `active` highlight so the user can tell "the session in the chat
   * panel" from "rows about to be acted on by the bulk toolbar".
   */
  selected?: boolean
  /**
   * Modifier-aware select. The parent decides — based on
   * `e.ctrlKey/metaKey/shiftKey` — whether to additionally activate the
   * session in the chat panel.
   */
  onSelect: (id: string, e: ReactMouseEvent) => void
  /** Toggle this row in the channel-list multi-selection (menu/touch entry point). */
  onToggleSelection?: (id: string) => void
  onDelete: (id: string) => void | Promise<unknown>
  onRename: (id: string, title: string) => void | Promise<unknown>
  /** Toggle the pinned state for this row. */
  onTogglePinned?: (id: string, pinned: boolean) => void | Promise<unknown>
  /** Archive this session (hides it from the active list). */
  onArchive?: (id: string) => void | Promise<unknown>
  /** Restore this session from the Archived view back to the active list. */
  onUnarchive?: (id: string) => void | Promise<unknown>
  /** Folders available for the "Move to folder" submenu. */
  folders?: SessionFolder[]
  /** Move this session into a folder, or to loose (`null`). */
  onAssignToFolder?: (sessionId: string, folderId: string | null) => void | Promise<unknown>
  /**
   * When this session was created by branching another (it has a
   * `parentSessionId`), a small branch indicator is shown; clicking it calls
   * this to jump back to the parent conversation. Omitted → no indicator.
   */
  onJumpToParent?: (parentSessionId: string) => void
  /** Keyboard-navigation focus ring — scrolls the row into view when set. */
  focused?: boolean
  /** Row density (Settings → Conversation). Defaults to `"comfortable"`. */
  density?: "comfortable" | "compact"
  /** Render a second line with the denormalized last-message preview. */
  showPreview?: boolean
  /** Ordered context fields rendered between the title and message preview. */
  metadata?: SessionRowMetadataItem[]
  /** Motion policy for overflowing titles. */
  titleMotion?: "hover" | "off"
  /** Active search query — emphasized inside the title when it matches. */
  searchQuery?: string
  /**
   * True when this row surfaced *only* because the query hit its message
   * content. Without the marker a result whose title has nothing to do with the
   * query reads as a broken search rather than a deeper one.
   */
  contentMatch?: boolean
  /**
   * Show the trailing activity timestamp ("14:32", "Tue", "Aug 3"). Off by
   * default so surfaces that don't want the column don't pay for it.
   *
   * Formatting happens here rather than in the list because the prop stays a
   * boolean: a pre-formatted string (or a formatter callback) from the parent
   * would change identity whenever the locale formatter did and bust this
   * row's `memo` for the whole list.
   */
  showTimestamp?: boolean
  /**
   * The list's day clock (`useConversationDayClock`): a timestamp inside the
   * current calendar day, which changes only when the day does. It is what
   * turns "14:32" into "Mon" after midnight. A plain number, so it never busts
   * the row's memo during the day. Omitted, the row reads next-intl's `now`
   * once at mount (stories, isolated renders).
   */
  now?: number
  /**
   * The row's index inside a windowed list — written as `data-index`, which
   * is how the virtualizer's `measureElement` (passed as `nodeRef`) tells which
   * item it is measuring.
   */
  virtualIndex?: number
  /**
   * Ref for the row's `<li>`, supplied by whatever owns its position: the
   * @dnd-kit Sortable wrapper while dragging, or the virtualizer's
   * `measureElement` in a long flat list.
   */
  nodeRef?: (el: HTMLElement | null) => void
  /** @dnd-kit drag listeners — applied to the hover grip handle. */
  dragListeners?: Record<string, unknown>
  /** @dnd-kit a11y attributes for the grip handle. */
  dragAttributes?: Record<string, unknown>
  /** @dnd-kit activator ref, applied to the dedicated grip handle. */
  dragActivatorRef?: (el: HTMLElement | null) => void
  /**
   * Inline style for the row's `<li>`, supplied by whatever is positioning it
   * from outside: the Sortable wrapper's transform/transition while dragging,
   * or the virtualizer's absolute placement in a long flat list.
   */
  nodeStyle?: CSSProperties
  /** True while this row is being dragged. */
  dragging?: boolean
  /** Pending insertion edge while another row is dragged over this one. */
  dropPosition?: "before" | "after"
  /**
   * "You just moved this row here": the same landing mark conversation jumps
   * paint (`JumpFlash`), held for `holdMs`. Bumping `nonce` restarts it, so
   * dragging the same row twice in a row shows twice.
   */
  settleFlash?: { nonce: number; holdMs: number }
}

/**
 * The row used in the channel list — extracted from the legacy SessionSidebar
 * so the new Discord shell and any other surface can share rename/delete UX.
 *
 * Double-click the title to rename inline. Enter commits, Escape cancels.
 *
 * Wrapped in React.memo (see {@link sessionRowPropsEqual}) so that a change to
 * row B — a streamed message, a selection toggle, a focus move — does not
 * re-render every other row in the list. That only holds while the list keeps
 * its props stable: `useCallback`'d handlers, the same `session` object for an
 * unchanged row (`useSessions` shares them across emissions), and the same
 * decoration objects (`channel-list/row-decorations.ts`).
 */
function SessionRowImpl({
  session,
  active,
  accentColor,
  iconSubject,
  unread,
  isUnread,
  extraActions,
  tabbable,
  onRowFocus,
  runStatus = "idle",
  selected = false,
  onSelect,
  onToggleSelection,
  onDelete,
  onRename,
  onTogglePinned,
  onArchive,
  onUnarchive,
  folders,
  onAssignToFolder,
  onJumpToParent,
  focused = false,
  density = "comfortable",
  showPreview = false,
  metadata = [],
  titleMotion = "hover",
  searchQuery,
  contentMatch = false,
  showTimestamp = false,
  now,
  virtualIndex,
  nodeRef,
  dragListeners,
  dragAttributes,
  dragActivatorRef,
  nodeStyle,
  dragging = false,
  dropPosition,
  settleFlash,
}: SessionRowProps) {
  const t = useTranslations("desktop.sessionRow")
  // Locale-aware timestamp formatting (the previous hand-rolled "3m"/"2d"
  // helper rendered raw English abbreviations for zh-CN). The shape is decided
  // in the zone the formatter prints in, or "today" and the printed clock time
  // would describe two different calendars.
  const format = useFormatter()
  const timeZone = useTimeZone()
  // `useNow()` without an update interval is a stable read — no per-row timer.
  // Only the fallback: the list passes its own day clock as `now`.
  const mountNow = useNow()
  const nowMs = now ?? mountNow.getTime()
  const [editing, setEditing] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [handoffDialogOpen, setHandoffDialogOpen] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [cogniaAgentStatus, setCogniaAgentStatus] = useState<CogniaAgentStatus>("unknown")
  const [codexDispatching, setCodexDispatching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const liRef = useRef<HTMLLIElement>(null)
  const selectButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!editing) setDraft(session.title)
  }, [editing, session.title])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // Keep the keyboard-focused row visible as the user arrows through the list.
  useEffect(() => {
    if (focused) {
      liRef.current?.scrollIntoView({ block: "nearest" })
      // Windowing can unmount the previously focused button. Keep subsequent
      // keyboard events in the sidebar instead of dropping focus to <body>.
      const activeElement = document.activeElement
      // Global conversation shortcuts also set `focused`, but promise to keep
      // the composer focused. Only move DOM focus that belongs to the list,
      // or that fell to body when its previous virtual row unmounted.
      const viewport = liRef.current?.closest("[data-slot=scroll-area-viewport]")
      const focusIsOnRow =
        activeElement instanceof HTMLButtonElement &&
        activeElement.closest("li[data-density]") &&
        (viewport ?? liRef.current?.parentElement)?.contains(activeElement)
      if (activeElement === document.body || focusIsOnRow) {
        selectButtonRef.current?.focus({ preventScroll: true })
      }
    }
  }, [focused])

  // Merge the caller's node ref (sortable, or the virtualizer's measurer) with
  // our local ref for scroll-into-view. Stable for a stable `nodeRef`: a fresh
  // callback ref each render makes React detach and re-attach it, and for the
  // virtualizer that means a forced layout read per row per render.
  const setLiRef = useCallback(
    (el: HTMLLIElement | null) => {
      liRef.current = el
      nodeRef?.(el)
    },
    [nodeRef]
  )

  const commit = () => {
    const next = draft.trim()
    if (next && next !== session.title) {
      log.info("session rename commit", { sessionId: session.id, length: next.length })
      void onRename(session.id, next)
    } else {
      setDraft(session.title)
    }
    setEditing(false)
  }

  const cancel = () => {
    log.info("session rename cancel", { sessionId: session.id })
    setDraft(session.title)
    setEditing(false)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter while an IME is composing picks a candidate; committing there saved
    // half-typed titles for anyone typing Chinese or Japanese.
    if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault()
      commit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancel()
    }
  }

  const locked = Boolean(session.handoffLock)
  const startRename = () => {
    // Renaming a handed-off conversation would only fail at commit time.
    if (locked) return
    setEditing(true)
  }

  // Keys that act on the row itself while its button has focus. Everything
  // else (arrows, Enter, Escape) belongs to the list's container handler.
  const handleRowKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey) return
    if (e.key === "F2" && !e.metaKey && !e.shiftKey) {
      e.preventDefault()
      startRename()
      return
    }
    const deleteChord =
      (e.key === "Delete" && !e.metaKey && !e.shiftKey) || (e.key === "Backspace" && e.metaKey)
    if (deleteChord) {
      e.preventDefault()
      if (!locked) setDeleteConfirmOpen(true)
      return
    }
    // Space toggles the row in the multi-selection (listbox convention); the
    // button's default would open it, which Enter already does.
    if (e.key === " " && !e.metaKey && !e.shiftKey && onToggleSelection) {
      e.preventDefault()
      onToggleSelection(session.id)
    }
  }

  // Keyboard focus only: a mouse press focuses the button too, and moving the
  // list's ring onto every clicked row would draw a keyboard highlight nobody
  // asked for.
  const handleRowButtonFocus = (e: ReactFocusEvent<HTMLButtonElement>) => {
    let keyboard = true
    try {
      keyboard = e.currentTarget.matches(":focus-visible")
    } catch {
      // Engines without `:focus-visible` support: treat focus as keyboard.
    }
    if (keyboard) onRowFocus?.(session.id)
  }

  const handleSelect = (e: ReactMouseEvent) => {
    log.info("session select", {
      sessionId: session.id,
      kind: session.kind,
      ctrl: e.ctrlKey || e.metaKey,
      shift: e.shiftKey,
    })
    onSelect(session.id, e)
  }

  const handleDelete = () => {
    log.info("session delete", { sessionId: session.id, kind: session.kind })
    void onDelete(session.id)
  }

  const handleTogglePinned = () => {
    const next = !session.pinned
    log.info("session toggle-pinned", { sessionId: session.id, pinned: next })
    void onTogglePinned?.(session.id, next)
  }

  // Only this conversation's own workspace can file it: a folder is
  // workspace-scoped, and the list may span every workspace under
  // `groupBy: "workspace"`. Offering a foreign folder would file the row into
  // something that isn't loaded where it lives, so the membership would show
  // here and be gone after the next workspace switch. Both sides are optional
  // (either predates workspace isolation), so only a known mismatch is dropped.
  const sessionProjectId = session.projectId
  const assignableFolders = useMemo(
    () =>
      (folders ?? []).filter((folder) =>
        folderAcceptsSession(folder, { projectId: sessionProjectId })
      ),
    [folders, sessionProjectId]
  )

  // Attribution is correctable from where a misplaced conversation is noticed:
  // the list. Archived workspaces are not destinations. Read as the stable
  // store array and filtered here, so a row does not re-render per keystroke
  // elsewhere in the store.
  const workspaces = useProjectStore((s) => s.projects)
  const workspaceTargets = useMemo(
    () => workspaces.filter((workspace) => !workspace.isArchived),
    [workspaces]
  )
  const canMoveWorkspace = workspaceTargets.some((workspace) => workspace.id !== sessionProjectId)
  const { move: moveToWorkspace, busy: movingWorkspace } = useMoveSessionWorkspace()

  const handleArchive = () => {
    log.info("session archive", { sessionId: session.id })
    void onArchive?.(session.id)
  }
  const handleUnarchive = () => {
    log.info("session unarchive", { sessionId: session.id })
    void onUnarchive?.(session.id)
  }

  const handleActionsOpenChange = (open: boolean) => {
    // The terminal hand-off is Tauri-only (its item is not rendered anywhere
    // else), so the CLI probe has nothing to answer on the web.
    if (!open || !isTauri()) return
    if (cogniaAgentStatus === "checking" || cogniaAgentStatus === "available") return
    setCogniaAgentStatus("checking")
    void import("@/lib/cli-bridge/detect-cli")
      .then(({ detectCli }) => detectCli("cognia-agent"))
      .then((result) => setCogniaAgentStatus(result.available ? "available" : "missing"))
      .catch(() => setCogniaAgentStatus("missing"))
  }

  /**
   * Hand this session BACK to the standalone CLI: write its transcript to
   * `~/.cognia/handoff/<id>.jsonl`, then launch `cognia-agent resume <id>` in
   * a fresh dock tab. Desktop only; heavy collaborators stay lazy-loaded.
   */
  const handleOpenInTerminal = () => {
    void (async () => {
      try {
        const [
          { listMessages },
          { exportHandoffToCli },
          { launchCogniaAgent },
          { useTerminalStore },
          { homeDir },
        ] = await Promise.all([
          import("@/lib/db/messages"),
          import("@/lib/chat/export-handoff-to-cli"),
          import("@/lib/terminal/run-cognia"),
          import("@/stores/terminal/terminal-store"),
          import("@tauri-apps/api/path"),
        ])
        const messages = await listMessages(session.id)
        await exportHandoffToCli({ sessionId: session.id, messages })
        const cwd = session.workingDir?.trim() || (await homeDir())
        const outcome = await launchCogniaAgent({
          handoffSessionId: session.id,
          cwd,
          store: useTerminalStore.getState(),
        })
        if (outcome.kind !== "launched") {
          throw new Error(outcome.kind === "error" ? outcome.message : outcome.reason || "denied")
        }
        log.info("session open-in-terminal", { sessionId: session.id })
        toast.success(t("openedInTerminal", { command: `cognia-agent resume ${session.id}` }))
      } catch (err) {
        toast.error(t("openInTerminalFailed"))
        log.warn("session open-in-terminal failed", { error: String(err) })
      }
    })()
  }

  const handleOpenInCodexApp = () => {
    setCodexDispatching(true)
    void import("@/lib/chat/dispatch-to-codex-app")
      .then(({ dispatchSessionToCodexApp }) => dispatchSessionToCodexApp(session))
      .then(() => {
        log.info("session open-in-codex-app", { sessionId: session.id })
        toast.success(t("openedInCodexApp"))
      })
      .catch((error) => {
        log.warn("session open-in-codex-app failed", { error: String(error) })
        const code = (error as { code?: string } | null)?.code
        const detail = String(error)
        toast.error(
          t(
            code === "PII_BLOCKED"
              ? "codexHandoffPiiBlocked"
              : code === "UNTRANSFERABLE_CONTENT"
                ? "codexHandoffUnsupported"
                : detail.includes("uncertain outcome") ||
                    detail.includes("timed out") ||
                    detail.includes("not yet discoverable") ||
                    detail.includes("recovery scan limit")
                  ? "codexHandoffPending"
                  : "openInCodexAppFailed"
          ),
          { description: detail }
        )
      })
      .finally(() => setCodexDispatching(false))
  }

  const handleReturnFromCodexApp = (event: ReactMouseEvent) => {
    setCodexDispatching(true)
    void import("@/lib/chat/dispatch-to-codex-app")
      .then(({ returnSessionFromCodexApp }) => returnSessionFromCodexApp(session))
      .then((sessionId) => {
        onSelect(sessionId, event)
        toast.success(t("returnedFromCodexApp"))
      })
      .catch((error) => {
        const code = (error as { code?: string } | null)?.code
        toast.error(
          t(code === "TARGET_NOT_FOUND" ? "codexHandoffTargetMissing" : "returnFromCodexAppFailed"),
          { description: String(error) }
        )
      })
      .finally(() => setCodexDispatching(false))
  }

  const Icon =
    session.kind === "team" ? UsersIcon : session.characterId ? HashIcon : MessageSquareIcon
  // A stored machine placeholder ("New chat") reads in the reader's language.
  const displayTitle = sessionDisplayTitle(session.title, {
    untitled: t("untitled"),
    placeholder: t("placeholderTitle"),
  })
  const rowTabIndex = tabbable === false ? -1 : undefined

  const menuItemsProps: Omit<SessionRowMenuItemsProps, "kit" | "surface"> = {
    session,
    selected,
    unread: isUnread ?? (unread ?? 0) > 0,
    onToggleSelection: onToggleSelection ? () => onToggleSelection(session.id) : undefined,
    onRename: startRename,
    onTogglePinned: onTogglePinned ? handleTogglePinned : undefined,
    onMarkRead: extraActions?.onMarkRead ? () => extraActions.onMarkRead!(session.id) : undefined,
    onMarkUnread: extraActions?.onMarkUnread
      ? () => extraActions.onMarkUnread!(session.id)
      : undefined,
    onBranch: extraActions?.onBranch ? () => extraActions.onBranch!(session.id) : undefined,
    onCopyLink: extraActions?.onCopyLink ? () => extraActions.onCopyLink!(session.id) : undefined,
    onExportShare: extraActions?.onExportShare
      ? () => extraActions.onExportShare!(session.id)
      : undefined,
    onArchive: onArchive ? handleArchive : undefined,
    onUnarchive: onUnarchive ? handleUnarchive : undefined,
    assignableFolders,
    onAssignToFolder: onAssignToFolder
      ? (folderId) => void onAssignToFolder(session.id, folderId)
      : undefined,
    workspaceTargets,
    canMoveWorkspace,
    movingWorkspace,
    onMoveWorkspace: (workspaceId) => void moveToWorkspace(session, workspaceId),
    onHandoff: () => setHandoffDialogOpen(true),
    desktop: isTauri()
      ? {
          codexDispatching,
          onOpenInCodexApp: handleOpenInCodexApp,
          onReturnFromCodexApp: session.codexHandoff ? handleReturnFromCodexApp : undefined,
          cogniaAgentStatus,
          onOpenInTerminal: handleOpenInTerminal,
        }
      : undefined,
    onDelete: () => setDeleteConfirmOpen(true),
  }
  // `null` when the session has never been stamped — the column is dropped
  // rather than rendering the epoch.
  const timestampAt = showTimestamp ? (session.lastMessageAt ?? session.updatedAt ?? null) : null
  // Vertical rhythm lives on the interactive child, not the `<li>`, so the
  // padding is part of the click target. It reads the appearance density's
  // `--density-row-padding` (Settings → Appearance → Density → sidebar; the
  // list root is that density surface) — comfortable rows take it whole,
  // compact rows half — so the defaults land exactly on the old `py-2` / `py-1`
  // and the appearance knob now actually moves the rows.
  const rowPadding =
    density === "compact"
      ? "py-[calc(var(--density-row-padding,0.5rem)/2)]"
      : "py-[var(--density-row-padding,0.5rem)]"

  return (
    // Right-click offers the same items as the ⋯ menu (and runs the same CLI
    // probe on open, which the terminal item needs), without hunting for a
    // hover-revealed button.
    <ContextMenu onOpenChange={handleActionsOpenChange}>
      <ContextMenuTrigger asChild disabled={editing}>
        <li
          ref={setLiRef}
          style={nodeStyle}
          className={cn(
            // No padding on the `<li>` itself: the select button below owns the
            // row's inner padding so the whole surface — not just the text — is a
            // hit target. The left gutter (`pl-3.5`) is reserved for the active
            // accent bar and the hover-revealed drag grip, which are both overlaid
            // so titles start at the same x whether or not the list is reorderable.
            "group relative flex items-stretch rounded-lg pl-3.5 text-sm transition-colors duration-150",
            // Hover and active were both `bg-accent`, which made every hovered row
            // look like the open conversation. Active now owns a stronger surface
            // plus the left accent bar below; hover stays a lighter wash.
            !active && "hover:bg-accent/60",
            active &&
              "bg-accent shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_18%,transparent)]",
            // Inset rings: the sections' collapsible bodies clip their overflow
            // (for the open / close animation), and an outset ring on the first or
            // last row of a section was cut off there.
            selected && "bg-primary/10 ring-1 ring-inset ring-primary/45",
            focused && "ring-2 ring-inset ring-ring",
            dragging && "opacity-40",
            dropPosition === "before" &&
              "before:absolute before:inset-x-2 before:-top-0.5 before:h-0.5 before:rounded-full before:bg-primary before:shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_25%,transparent)] before:content-['']",
            dropPosition === "after" &&
              "after:absolute after:inset-x-2 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-primary after:shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_25%,transparent)] after:content-['']"
          )}
          data-index={virtualIndex}
          data-selected={selected || undefined}
          data-focused={focused || undefined}
          data-density={density}
          data-drop-position={dropPosition}
          data-settled={settleFlash ? "" : undefined}
        >
          {settleFlash ? (
            <JumpFlash
              nonce={settleFlash.nonce}
              holdMs={settleFlash.holdMs}
              className="rounded-lg"
            />
          ) : null}
          {/* Left accent bar for the open conversation. A real element rather than
          a `before:` pseudo — the drop indicator already owns `before:`. */}
          {active ? (
            <span
              aria-hidden
              data-testid="session-row-active-bar"
              className="pointer-events-none absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
            />
          ) : null}
          {dragListeners && !editing ? (
            <button
              type="button"
              ref={dragActivatorRef}
              {...dragAttributes}
              {...dragListeners}
              // Overlaid in the row gutter (full row height for an easy grab)
              // instead of sitting in flow, so a hidden grip never steals 24px of
              // title width or a click that should have opened the conversation.
              // Revealed on row hover, keyboard focus and touch (shared policy).
              data-testid="session-row-drag-handle"
              tabIndex={rowTabIndex}
              className={cn(
                "absolute inset-y-0 left-0.5 flex w-3 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                HOVER_REVEAL_CONTROL_CLASS
              )}
              aria-label={t("dragHandle")}
            >
              <GripVerticalIcon className="size-3" />
            </button>
          ) : null}
          {editing ? (
            <div className={cn("flex flex-1 items-center gap-2 pr-1", rowPadding)}>
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                onBlur={commit}
                aria-label={t("renameInput", { title: displayTitle })}
                className="h-6 px-1 py-0 text-sm"
              />
            </div>
          ) : (
            <button
              ref={selectButtonRef}
              type="button"
              onClick={handleSelect}
              onDoubleClick={startRename}
              onKeyDown={handleRowKeyDown}
              onFocus={onRowFocus ? handleRowButtonFocus : undefined}
              tabIndex={rowTabIndex}
              // The list's container keys only act on its own rows' buttons, not
              // on the actions trigger or a drag handle inside the same row.
              data-session-row-select={session.id}
              aria-current={active ? "page" : undefined}
              aria-keyshortcuts="F2 Delete"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-lg pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                rowPadding
              )}
            >
              {/* One fixed 20px leading slot, whatever sits in it (an IM avatar, an
              agent / team avatar, an accent dot, the kind glyph), so every
              title in the rail starts at the same x — and no glyph is taller
              than a compact row's text line, so it never grows the row. */}
              <span
                className="flex size-5 shrink-0 items-center justify-center"
                data-testid="session-row-leading"
              >
                {session.platformBinding ? (
                  <span className="relative flex">
                    <AvatarBadge
                      subject={{ name: session.title || session.platformBinding.conversationKey }}
                      size={20}
                      textClassName="text-[9px]"
                    />
                    <PlatformBadge
                      platform={session.platformBinding.platform}
                      iconOnly
                      className="absolute -bottom-1 -end-1 rounded-full bg-background p-0.5 [&_svg]:size-2.5"
                    />
                  </span>
                ) : iconSubject ? (
                  <AvatarBadge subject={iconSubject} size={18} textClassName="text-[10px]" />
                ) : accentColor ? (
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: accentColor }}
                    aria-hidden
                  />
                ) : (
                  <Icon className="size-3.5 text-muted-foreground" />
                )}
              </span>
              <span
                className={cn(
                  "flex min-w-0 flex-1 flex-col gap-0.5",
                  // While the actions button is up it sits over the end of these
                  // lines (it takes no width of its own — see below); fading them
                  // out under it is what keeps the two from printing on top of
                  // each other without ever re-flowing the title.
                  "group-hover:[mask-image:linear-gradient(to_left,transparent_1.75rem,black_3rem)]",
                  "group-has-[:focus-visible]:[mask-image:linear-gradient(to_left,transparent_1.75rem,black_3rem)]",
                  "group-has-[[data-state=open]]:[mask-image:linear-gradient(to_left,transparent_1.75rem,black_3rem)]",
                  "[@media(hover:none)]:[mask-image:none]"
                )}
              >
                {/* Title line: the title stretches and the status/time pin to the
                trailing edge; the leading slot above fixes where it starts. */}
                <span className="flex min-w-0 items-center gap-1.5">
                  <HoverScrollText
                    className={cn("flex-1", active && "font-medium")}
                    text={displayTitle}
                    motion={titleMotion}
                    highlight={searchQuery}
                  />
                  {session.pinned ? (
                    <PinIcon
                      className="size-3 shrink-0 text-muted-foreground"
                      aria-label={t("pinned")}
                    />
                  ) : null}
                  {session.handoffLock ? (
                    <LockKeyholeIcon
                      className="size-3 shrink-0 text-amber-600"
                      aria-label={t("handoffReadonly")}
                    />
                  ) : null}
                  <SessionRunIndicator status={runStatus} testIdPrefix="session-row-run" />
                  {timestampAt != null ? (
                    <span
                      className="shrink-0 text-[10px] leading-4 text-muted-foreground/80 tabular-nums"
                      data-testid="session-row-timestamp"
                      title={format.dateTime(new Date(timestampAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    >
                      {format.dateTime(
                        new Date(timestampAt),
                        CONVERSATION_TIMESTAMP_FORMATS[
                          conversationTimestampShape(nowMs, timestampAt, timeZone)
                        ]
                      )}
                    </span>
                  ) : null}
                  {unread && unread > 0 ? (
                    <span className="shrink-0 rounded-pill bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  ) : null}
                </span>
                {contentMatch ? (
                  <span
                    className="flex min-w-0 items-center gap-1 text-[10px] leading-4 text-muted-foreground"
                    data-testid="session-row-content-match"
                  >
                    <MessageSquareTextIcon className="size-2.5 shrink-0" aria-hidden />
                    <span className="truncate">{t("contentMatch")}</span>
                  </span>
                ) : null}
                {metadata.length > 0 ? (
                  <span
                    className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] leading-4 text-muted-foreground"
                    data-testid="session-row-metadata"
                    title={metadata.map((item) => item.value).join(" · ")}
                  >
                    {metadata.map((item, index) => {
                      const MetadataIcon = METADATA_ICON[item.kind]
                      return (
                        // Items shrink and ellipsize rather than run off the rail:
                        // a long model name must not push the workspace out of
                        // sight uncut. The separator and icon keep their size.
                        <span
                          key={`${item.kind}:${item.value}`}
                          className={cn(
                            "flex min-w-0 shrink items-center gap-1",
                            index > 0 && "before:mr-0.5 before:shrink-0 before:content-['·']"
                          )}
                          data-metadata-kind={item.kind}
                        >
                          <MetadataIcon className="size-2.5 shrink-0" aria-hidden />
                          <span className="min-w-0 truncate">{item.value}</span>
                        </span>
                      )
                    })}
                  </span>
                ) : null}
                {showPreview && session.lastMessagePreview ? (
                  <span className="truncate text-xs leading-4 text-muted-foreground">
                    {session.lastMessagePreview}
                  </span>
                ) : null}
              </span>
              {/* The selection ring is visual only; say it for screen readers. */}
              {selected ? <span className="sr-only">{t("selectedState")}</span> : null}
            </button>
          )}
          {!editing ? (
            // The trailing cluster takes width only for what is always on screen
            // (the lineage chip). The actions button overlays the end of the text
            // column — faded out under it — and shows on hover, keyboard focus or
            // while its menu is open, so the title gets the width back instead of
            // every row reserving an invisible 24px slot. Touch pointers have no
            // hover to reveal it with: there it drops back into the flow, visible.
            // Only the opacity fades (`lib/ui/hover-reveal.ts`): the button is
            // never `pointer-events-none`, so a click that arrives without a
            // pointerover first (assistive tech, automation) still lands. A mouse
            // is always hovering the row when it presses there, so that changes
            // nothing for it.
            <div className="relative flex shrink-0 items-center gap-0.5 self-center pr-1">
              {session.parentSessionId && onJumpToParent ? (
                <Button
                  variant="ghost"
                  size="icon"
                  tabIndex={rowTabIndex}
                  className="size-6 text-muted-foreground"
                  title={t("branchedFrom")}
                  aria-label={t("branchedFrom")}
                  onClick={() => onJumpToParent(session.parentSessionId!)}
                >
                  <GitBranchIcon className="size-3" />
                </Button>
              ) : null}
              <div
                data-testid="session-row-actions"
                className={cn(
                  "absolute top-1/2 right-full flex -translate-y-1/2 items-center duration-150",
                  HOVER_REVEAL_GROUP_CLASS,
                  // Row-wide reveals on top of the shared ones: keyboard focus on
                  // the row's own button, and any popup the row opened.
                  "group-has-[:focus-visible]:opacity-100 group-has-[[data-state=open]]:opacity-100",
                  "[@media(hover:none)]:static [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100"
                )}
              >
                <DropdownMenu onOpenChange={handleActionsOpenChange}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      tabIndex={rowTabIndex}
                      className="touch-hit size-6"
                      aria-label={t("actionsMenu")}
                      data-testid={`session-row-actions-trigger-${session.id}`}
                    >
                      <MoreHorizontalIcon className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <SessionRowMenuItems
                      kit={DROPDOWN_MENU_KIT}
                      surface="dropdown"
                      {...menuItemsProps}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ) : null}
          <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
            <AlertDialogContent className="max-w-[90vw] sm:max-w-md">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("deleteConfirmTitle", { title: displayTitle })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("deleteConfirmBody")}
                  <DeleteConfirmBranchNote sessionId={session.id} />
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
                <AlertDialogCancel className="w-full sm:w-auto">{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  className={buttonVariants({
                    variant: "destructive",
                    className: "w-full sm:w-auto",
                  })}
                  onClick={() => {
                    setDeleteConfirmOpen(false)
                    handleDelete()
                  }}
                >
                  {t("deleteConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {/* Mounted only while open, for the same reason the delete confirm's
           * message count is: this row renders once per conversation, and the
           * dialog body holds a live query over `pairedDevices`, the handoff
           * tickets and the dispatch queue — always-mounted, that is one live
           * subscription per sidebar row, re-running on every write to any of
           * those tables. */}
          {handoffDialogOpen ? (
            <ThreadHandoffSourceDialog session={session} open onOpenChange={setHandoffDialogOpen} />
          ) : null}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56" data-testid={`session-row-context-menu-${session.id}`}>
        <SessionRowMenuItems kit={CONTEXT_MENU_KIT} surface="context" {...menuItemsProps} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * Branches are standalone conversations — `direct` mode copies the messages
 * outright — so deleting the parent leaves them alone and re-points them at
 * their grandparent. Say so, or the count in the sidebar not dropping reads as
 * a bug.
 *
 * Its own component so the branch count's live query exists only while the
 * confirm is open: the dialog content (and so this) is mounted only then. In
 * the row itself it was one index subscription per sidebar row, re-run on
 * every session write, with the dialog closed.
 */
function DeleteConfirmBranchNote({ sessionId }: { sessionId: string }) {
  const t = useTranslations("desktop.sessionRow")
  const branchCount =
    useLiveQuery(async () => (await listSessionBranches(sessionId)).length, [sessionId]) ?? 0
  return branchCount > 0 ? <> {t("deleteConfirmBranches", { count: branchCount })}</> : null
}

function sameStyle(a: CSSProperties | undefined, b: CSSProperties | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a) as (keyof CSSProperties)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is(a[key], b[key]))
}

function sameMetadata(
  a: readonly SessionRowMetadataItem[] | undefined,
  b: readonly SessionRowMetadataItem[] | undefined
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((item, index) => item.kind === b[index]!.kind && item.value === b[index]!.value)
}

function sameSubject(a: AvatarSubject | undefined, b: AvatarSubject | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.name === b.name &&
    a.avatarColor === b.avatarColor &&
    a.avatarEmoji === b.avatarEmoji &&
    a.avatarImageUrl === b.avatarImageUrl
  )
}

/**
 * The row's memo comparison: identity for everything, except the few props
 * whose *value* is what the row renders and whose object is rebuilt by
 * whoever positions it — the virtualizer's per-render `nodeStyle`, the landing
 * mark's `{ nonce, holdMs }` — or derived per row (metadata, avatar). Comparing
 * those by value keeps a row that did not change from re-rendering just
 * because its container did. Exported for its tests.
 */
export function sessionRowPropsEqual(prev: SessionRowProps, next: SessionRowProps): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof SessionRowProps>
  for (const key of keys) {
    const a = prev[key]
    const b = next[key]
    if (Object.is(a, b)) continue
    switch (key) {
      case "nodeStyle":
        if (sameStyle(a as CSSProperties | undefined, b as CSSProperties | undefined)) continue
        return false
      case "metadata":
        if (sameMetadata(a as SessionRowMetadataItem[], b as SessionRowMetadataItem[])) continue
        return false
      case "iconSubject":
        if (sameSubject(a as AvatarSubject | undefined, b as AvatarSubject | undefined)) continue
        return false
      case "settleFlash": {
        const x = a as SessionRowProps["settleFlash"]
        const y = b as SessionRowProps["settleFlash"]
        if (x && y && x.nonce === y.nonce && x.holdMs === y.holdMs) continue
        return false
      }
      default:
        return false
    }
  }
  return true
}

export const SessionRow = memo(SessionRowImpl, sessionRowPropsEqual)
SessionRow.displayName = "SessionRow"
