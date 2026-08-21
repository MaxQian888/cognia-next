"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { listSessionBranches } from "@/lib/db/sessions"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { HoverScrollText } from "@/components/chat/ui/hover-scroll-text"
import { JumpFlash } from "@/components/chat/jump-flash"
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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  CONVERSATION_TIMESTAMP_FORMATS,
  conversationTimestampShape,
} from "@/lib/chat/conversation-timestamp"
import type { AvatarSubject } from "@/lib/ui/avatar"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import type {
  ChatSession,
  ConversationSidebarMetadata,
  SessionFolder,
} from "@cognia/agent-config-types"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  BoxesIcon,
  CheckIcon,
  FolderIcon,
  FolderInputIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GripVerticalIcon,
  HashIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  CpuIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  TerminalIcon,
  Trash2Icon,
  UsersIcon,
  WaypointsIcon,
} from "lucide-react"
import { toast } from "sonner"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react"

const log = loggers.ui

export type SessionRowMetadataKind = ConversationSidebarMetadata

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

export interface SessionRowProps {
  session: ChatSession
  active: boolean
  /** Optional dot color (assistant character avatarColor) shown left of title. */
  accentColor?: string
  /** Resolved Agent/Team identity rendered in preference to the generic icon. */
  iconSubject?: AvatarSubject
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
  /** Toggle this row in the channel-list multi-selection (menu/touch entry point). */
  onToggleSelection?: (id: string) => void
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
 * Wrapped in React.memo so that toggling the multi-selection on row B
 * does not force every other row in the list to re-render — the upstream
 * callbacks are all `useCallback`'d and the data props are primitives,
 * so a shallow compare is sufficient.
 */
function SessionRowImpl({
  session,
  active,
  accentColor,
  iconSubject,
  unread,
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
  // helper rendered raw English abbreviations for zh-CN). `useNow()` without an
  // update interval is a stable read — no per-row timer.
  const format = useFormatter()
  const now = useNow()
  const [editing, setEditing] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  // Only queried while the confirm is open — this row renders once per session
  // in the sidebar, and an always-live count would be one index read per row on
  // every session write.
  const branchCount =
    useLiveQuery(
      async () => (deleteConfirmOpen ? (await listSessionBranches(session.id)).length : 0),
      [deleteConfirmOpen, session.id]
    ) ?? 0
  const [draft, setDraft] = useState(session.title)
  const [cogniaAgentStatus, setCogniaAgentStatus] = useState<
    "unknown" | "checking" | "available" | "missing"
  >("unknown")
  const [codexDispatching, setCodexDispatching] = useState(false)
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

  // Merge the caller's node ref (sortable, or the virtualizer's measurer) with
  // our local ref for scroll-into-view.
  const setLiRef = (el: HTMLLIElement | null) => {
    liRef.current = el
    nodeRef?.(el)
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

  // Only this conversation's own workspace can file it: a folder is
  // workspace-scoped, and the list may span every workspace under
  // `groupBy: "workspace"`. Offering a foreign folder would file the row into
  // something that isn't loaded where it lives, so the membership would show
  // here and be gone after the next workspace switch. Both sides are optional
  // (either predates workspace isolation), so only a known mismatch is dropped.
  const assignableFolders = useMemo(
    () =>
      (folders ?? []).filter(
        (f) => !f.projectId || !session.projectId || f.projectId === session.projectId
      ),
    [folders, session.projectId]
  )

  const isArchived = session.archivedAt != null
  const handleArchive = () => {
    log.info("session archive", { sessionId: session.id })
    void onArchive?.(session.id)
  }
  const handleUnarchive = () => {
    log.info("session unarchive", { sessionId: session.id })
    void onUnarchive?.(session.id)
  }

  const handleActionsOpenChange = (open: boolean) => {
    if (!open || cogniaAgentStatus === "checking" || cogniaAgentStatus === "available") return
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
        toast.success(t("openedInTerminal"))
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
        toast.error(t("openInCodexAppFailed"))
      })
      .finally(() => setCodexDispatching(false))
  }

  const Icon =
    session.kind === "team" ? UsersIcon : session.characterId ? HashIcon : MessageSquareIcon
  const displayTitle = session.title || t("untitled")
  // `null` when the session has never been stamped — the column is dropped
  // rather than rendering the epoch.
  const timestampAt = showTimestamp ? (session.lastMessageAt ?? session.updatedAt ?? null) : null
  // Vertical rhythm lives on the interactive child, not the `<li>`, so the
  // padding is part of the click target.
  const rowPadding = density === "compact" ? "py-1" : "py-2"

  return (
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
        selected && "bg-primary/10 ring-1 ring-primary/45",
        focused && "ring-2 ring-ring",
        dragging && "opacity-40",
        dropPosition === "before" &&
          "before:absolute before:inset-x-2 before:-top-0.5 before:h-0.5 before:rounded-full before:bg-primary before:shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_25%,transparent)] before:content-['']",
        dropPosition === "after" &&
          "after:absolute after:inset-x-2 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-primary after:shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_25%,transparent)] after:content-['']"
      )}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      data-density={density}
      data-drop-position={dropPosition}
      data-settled={settleFlash ? "" : undefined}
    >
      {settleFlash ? (
        <JumpFlash nonce={settleFlash.nonce} holdMs={settleFlash.holdMs} className="rounded-lg" />
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
          className="absolute inset-y-0 left-0.5 flex w-3 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
            className="h-6 px-1 py-0 text-sm"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={handleSelect}
          onDoubleClick={() => setEditing(true)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            rowPadding
          )}
        >
          {iconSubject ? (
            <AvatarBadge subject={iconSubject} size={18} textClassName="text-[10px]" />
          ) : accentColor ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: accentColor }}
              aria-hidden
            />
          ) : (
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Title line: title stretches, status/time pin to the trailing
                edge so every title in the rail starts at the same x. */}
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
                      conversationTimestampShape(now.getTime(), timestampAt)
                    ]
                  )}
                </span>
              ) : null}
              {unread && unread > 0 ? (
                <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
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
                    <span
                      key={`${item.kind}:${item.value}`}
                      className={cn(
                        "flex min-w-0 shrink-0 items-center gap-1",
                        index > 0 && "before:mr-0.5 before:content-['·']"
                      )}
                      data-metadata-kind={item.kind}
                    >
                      <MetadataIcon className="size-2.5 shrink-0" aria-hidden />
                      <span>{item.value}</span>
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
        </button>
      )}
      {!editing ? (
        <div className="flex shrink-0 items-center gap-0.5 self-center pr-1.5">
          {session.parentSessionId && onJumpToParent ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground"
              title={t("branchedFrom")}
              aria-label={t("branchedFrom")}
              onClick={() => onJumpToParent(session.parentSessionId!)}
            >
              <GitBranchIcon className="size-3" />
            </Button>
          ) : null}
          <DropdownMenu onOpenChange={handleActionsOpenChange}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                aria-label={t("actionsMenu")}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onToggleSelection ? (
                <DropdownMenuItem onSelect={() => onToggleSelection(session.id)}>
                  <ListChecksIcon className="mr-2 size-4" />
                  {selected ? t("deselect") : t("select")}
                </DropdownMenuItem>
              ) : null}
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
              {onAssignToFolder && (assignableFolders.length || session.folderId) ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <FolderInputIcon className="mr-2 size-4" />
                    {t("moveToFolder")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {assignableFolders.map((f) => (
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
                <>
                  <DropdownMenuItem onSelect={handleOpenInCodexApp} disabled={codexDispatching}>
                    {codexDispatching ? (
                      <Loader2Icon className="mr-2 size-4 animate-spin" />
                    ) : (
                      <ExternalLinkIcon className="mr-2 size-4" />
                    )}
                    {t("openInCodexApp")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleOpenInTerminal}
                    disabled={cogniaAgentStatus !== "available"}
                    title={
                      cogniaAgentStatus === "missing"
                        ? t("cogniaAgentNotInstalled")
                        : cogniaAgentStatus !== "available"
                          ? t("cogniaAgentChecking")
                          : undefined
                    }
                  >
                    <TerminalIcon className="mr-2 size-4" />
                    {t("openInTerminal")}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setDeleteConfirmOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2Icon className="mr-2 size-4" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent className="max-w-[90vw] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle", { title: session.title })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmBody")}
              {/* Branches are standalone conversations — `direct` mode copies
                  the messages outright — so deleting the parent leaves them
                  alone and re-points them at their grandparent. Say so, or the
                  count in the sidebar not dropping reads as a bug. */}
              {branchCount > 0 ? ` ${t("deleteConfirmBranches", { count: branchCount })}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full sm:w-auto">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive", className: "w-full sm:w-auto" })}
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
    </li>
  )
}

export const SessionRow = memo(SessionRowImpl)
SessionRow.displayName = "SessionRow"
