"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { loggers } from "@/lib/logging"
import { isTauri } from "@/lib/tauri"
import type { ChatSession, SessionFolder } from "@/lib/claude/types"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  FolderIcon,
  FolderInputIcon,
  GitBranchIcon,
  GripVerticalIcon,
  HashIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  TerminalIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react"

const log = loggers.ui

export interface SessionRowProps {
  session: ChatSession
  active: boolean
  /** Optional dot color (assistant character avatarColor) shown left of title. */
  accentColor?: string
  /** Optional unread count → shows a badge. */
  unread?: number
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
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  /** Toggle the pinned state for this row. */
  onTogglePinned?: (id: string, pinned: boolean) => void | Promise<void>
  /** Archive this session (hides it from the active list). */
  onArchive?: (id: string) => void | Promise<void>
  /** Restore this session from the Archived view back to the active list. */
  onUnarchive?: (id: string) => void | Promise<void>
  /** Folders available for the "Move to folder" submenu. */
  folders?: SessionFolder[]
  /** Move this session into a folder, or to loose (`null`). */
  onAssignToFolder?: (sessionId: string, folderId: string | null) => void | Promise<void>
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
  /** @dnd-kit node ref from the Sortable wrapper (applied to the `<li>`). */
  dragRef?: (el: HTMLElement | null) => void
  /** @dnd-kit drag listeners — applied to the hover grip handle. */
  dragListeners?: Record<string, unknown>
  /** @dnd-kit a11y attributes for the grip handle. */
  dragAttributes?: Record<string, unknown>
  /** Transform/transition style from the Sortable wrapper. */
  dragStyle?: CSSProperties
  /** True while this row is being dragged. */
  dragging?: boolean
}

/**
 * The row used in the channel list — extracted from the legacy SessionSidebar
 * so the new Discord shell and any other surface can share rename/delete UX.
 *
 * Double-click the title to rename inline. Enter commits, Escape cancels.
 *
 * Wrapped in React.memo so that toggling the multi-selection on row B
 * does not force every other row in the list to re-render — the upstream
 * callbacks are all `useCallback`'d and the data props are primitives,
 * so a shallow compare is sufficient.
 */
function SessionRowImpl({
  session,
  active,
  accentColor,
  unread,
  selected = false,
  onSelect,
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
  dragRef,
  dragListeners,
  dragAttributes,
  dragStyle,
  dragging = false,
}: SessionRowProps) {
  const t = useTranslations("desktop.sessionRow")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const liRef = useRef<HTMLLIElement>(null)

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
    if (focused) liRef.current?.scrollIntoView({ block: "nearest" })
  }, [focused])

  // Merge the @dnd-kit sortable ref with our local ref for scroll-into-view.
  const setLiRef = (el: HTMLLIElement | null) => {
    liRef.current = el
    dragRef?.(el)
  }

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
    if (e.key === "Enter") {
      e.preventDefault()
      commit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancel()
    }
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

  const isArchived = session.archivedAt != null
  const handleArchive = () => {
    log.info("session archive", { sessionId: session.id })
    void onArchive?.(session.id)
  }
  const handleUnarchive = () => {
    log.info("session unarchive", { sessionId: session.id })
    void onUnarchive?.(session.id)
  }

  /**
   * Hand this session BACK to the standalone CLI: write its transcript to
   * `~/.cognia/handoff/<id>.jsonl` and surface the `resume` command. Desktop
   * only; lazy-imports the DB + export helper so the row stays light.
   */
  const handleOpenInTerminal = () => {
    void (async () => {
      try {
        const [{ listMessages }, { exportHandoffToCli }] = await Promise.all([
          import("@/lib/db/messages"),
          import("@/lib/chat/export-handoff-to-cli"),
        ])
        const messages = await listMessages(session.id)
        const { command } = await exportHandoffToCli({ sessionId: session.id, messages })
        log.info("session open-in-terminal", { sessionId: session.id })
        toast.success(t("openedInTerminal", { command }))
      } catch (err) {
        toast.error(t("openInTerminalFailed"))
        log.warn("session open-in-terminal failed", { error: String(err) })
      }
    })()
  }

  const Icon =
    session.kind === "team" ? UsersIcon : session.characterId ? HashIcon : MessageSquareIcon

  return (
    <li
      ref={setLiRef}
      style={dragStyle}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent",
        density === "compact" ? "py-1" : "py-1.5",
        active && "bg-accent",
        selected && "bg-accent/60 ring-1 ring-primary/50",
        focused && "ring-2 ring-ring",
        dragging && "opacity-50"
      )}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
    >
      {dragListeners && !editing ? (
        <span
          {...dragAttributes}
          {...dragListeners}
          className="flex size-4 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100"
          aria-label={t("dragHandle")}
        >
          <GripVerticalIcon className="size-3.5" />
        </span>
      ) : null}
      {editing ? (
        <div className="flex flex-1 items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
            className="h-6 px-1 py-0 text-sm"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={handleSelect}
          onDoubleClick={() => setEditing(true)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={session.title}
        >
          {accentColor ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: accentColor }}
              aria-hidden
            />
          ) : (
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {session.pinned ? (
            <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t("pinned")} />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{session.title || t("untitled")}</span>
            {showPreview && session.lastMessagePreview ? (
              <span className="truncate text-xs text-muted-foreground">
                {session.lastMessagePreview}
              </span>
            ) : null}
          </span>
          {unread && unread > 0 ? (
            <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </button>
      )}
      {!editing && session.parentSessionId && onJumpToParent ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground"
          title={t("branchedFrom")}
          aria-label={t("branchedFrom")}
          onClick={() => onJumpToParent(session.parentSessionId!)}
        >
          <GitBranchIcon className="size-3" />
        </Button>
      ) : null}
      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
              aria-label={t("actionsMenu")}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <PencilIcon className="mr-2 size-4" />
              {t("rename")}
            </DropdownMenuItem>
            {onTogglePinned ? (
              <DropdownMenuItem onSelect={handleTogglePinned}>
                {session.pinned ? (
                  <PinOffIcon className="mr-2 size-4" />
                ) : (
                  <PinIcon className="mr-2 size-4" />
                )}
                {session.pinned ? t("unpin") : t("pin")}
              </DropdownMenuItem>
            ) : null}
            {isArchived && onUnarchive ? (
              <DropdownMenuItem onSelect={handleUnarchive}>
                <ArchiveRestoreIcon className="mr-2 size-4" />
                {t("unarchive")}
              </DropdownMenuItem>
            ) : null}
            {!isArchived && onArchive ? (
              <DropdownMenuItem onSelect={handleArchive}>
                <ArchiveIcon className="mr-2 size-4" />
                {t("archive")}
              </DropdownMenuItem>
            ) : null}
            {onAssignToFolder && (folders?.length || session.folderId) ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInputIcon className="mr-2 size-4" />
                  {t("moveToFolder")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {(folders ?? []).map((f) => (
                    <DropdownMenuItem
                      key={f.id}
                      onSelect={() => void onAssignToFolder(session.id, f.id)}
                    >
                      {session.folderId === f.id ? (
                        <CheckIcon className="mr-2 size-4" />
                      ) : (
                        <FolderIcon className="mr-2 size-4" />
                      )}
                      <span className="truncate">{f.name}</span>
                    </DropdownMenuItem>
                  ))}
                  {session.folderId ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => void onAssignToFolder(session.id, null)}>
                        {t("removeFromFolder")}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {isTauri() ? (
              <DropdownMenuItem onSelect={handleOpenInTerminal}>
                <TerminalIcon className="mr-2 size-4" />
                {t("openInTerminal")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={handleDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2Icon className="mr-2 size-4" />
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  )
}

export const SessionRow = memo(SessionRowImpl)
SessionRow.displayName = "SessionRow"
