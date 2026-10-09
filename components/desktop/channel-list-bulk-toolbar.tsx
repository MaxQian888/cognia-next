"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderIcon,
  FolderInputIcon,
  FolderPlusIcon,
  Link2Icon,
  MailIcon,
  MailOpenIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { SessionFolder } from "@cognia/agent-config-types"
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
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface ChannelListBulkToolbarProps {
  count: number
  /**
   * How many rows the selection could grow to — the rows on screen. With
   * `onSelectAll` it powers "Select all (N)", which flips to "Deselect all"
   * once everything is in.
   */
  total?: number
  /**
   * The list is showing the Archived view. Decides the bar's shape while
   * nothing is selected yet; once rows are, the selection itself decides (see
   * `archivedCount`).
   */
  archived?: boolean
  /**
   * How many selected rows are archived. A search that reaches past the
   * archive split can select both kinds at once, so the verbs follow the rows,
   * not the view: Archive while any selected row is active, Unarchive while any
   * is archived, and Pin / Move to folder / read state only while none is —
   * an archived row's pin and folder are frozen (ADR-0213). Defaults to every
   * row in the Archived view and none in the active one.
   */
  archivedCount?: number
  /**
   * `rail` — two compact rows of icon buttons, sized for the sidebar.
   * `bar` — one row of labelled buttons, for a page (the conversation
   * manager) or the phone, where there is room to say what each verb does.
   */
  layout?: "rail" | "bar"
  /**
   * Every selected row is already pinned: the pin switch offers Unpin. A
   * mixed or unpinned selection offers Pin — one button that says what it
   * will do, not two where one is always a no-op for part of the selection.
   */
  allPinned?: boolean
  /**
   * Some selected row has unread messages: the read switch offers "Mark as
   * read"; an all-read selection offers "Mark as unread" instead. Undefined
   * reads as `true`, the safe direction (clearing a badge loses nothing).
   */
  anyUnread?: boolean
  /** Some selected row sits in a folder — the only case "Remove from folder" does anything. */
  anyInFolder?: boolean
  /*
   * Each action is optional and its button is drawn only when it is handed
   * one: a toolbar that shows Delete to an owner with no delete writer would
   * be a button that silently does nothing.
   */
  onDelete?: () => void | Promise<unknown>
  onPin?: () => void | Promise<unknown>
  onUnpin?: () => void | Promise<unknown>
  onArchive?: () => void | Promise<unknown>
  onUnarchive?: () => void | Promise<unknown>
  /** Clear the unread state of every selected conversation. */
  onMarkRead?: () => void | Promise<unknown>
  /** Flag every selected conversation unread again. */
  onMarkUnread?: () => void | Promise<unknown>
  onShare: () => void
  /**
   * Folders the selection can be moved into. The control shows whenever it has
   * somewhere to send the selection: an existing folder, "New folder…", or
   * out of the folder some of it already sits in.
   */
  folders?: readonly SessionFolder[]
  /**
   * Folders that cannot hold every selected conversation (another workspace's).
   * Listed but disabled, with a note saying why — dropping them silently would
   * leave the user hunting for a folder they know exists.
   */
  blockedFolderIds?: ReadonlySet<string>
  onMoveToFolder?: (folderId: string | null) => void | Promise<unknown>
  /**
   * Make a folder for the selection and file it there in one step. Absent when
   * a new folder could not hold every selected row (it is created in the
   * active workspace).
   */
  onNewFolder?: () => void | Promise<unknown>
  onSelectAll?: () => void
  /** Empty the selection but stay in it — the counterpart of "Select all". */
  onDeselectAll?: () => void
  /** Leave the selection altogether ("Done", or Escape on the list). */
  onClear: () => void
  /**
   * The selected conversations' titles, in list order. The delete confirm names
   * them — a count alone ("Delete 3 conversations?") asked the reader to
   * trust a selection they could no longer see behind the dialog.
   */
  selectedTitles?: readonly string[]
}

/** Titles the delete confirm lists before it summarizes the rest. */
const DELETE_CONFIRM_TITLE_LIMIT = 5

const NO_BLOCKED_FOLDERS: ReadonlySet<string> = new Set()

/**
 * The bar a selection of conversations is acted on from.
 *
 * Two rows, because one did not fit: a 256px rail held a count plus eight icon
 * buttons, and the count — the one thing saying what the buttons act on — was
 * the part that got cut to "2 s…". The head row now says what is selected and
 * how to change that (select all / deselect all / done); the action row holds
 * the verbs, with the destructive one set apart at its end and gated by an
 * AlertDialog. Switches that have two directions (pin, read state) show the
 * one that applies to this selection instead of both.
 *
 * With nothing selected yet (selection mode just entered) the head row says how
 * to select, and the verbs stay on screen, disabled, so the bar does not
 * reshape under the first click.
 */
export function ChannelListBulkToolbar({
  count,
  total,
  archived = false,
  archivedCount,
  layout = "rail",
  allPinned = false,
  anyUnread = true,
  anyInFolder = false,
  onDelete,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onMarkRead,
  onMarkUnread,
  onShare,
  folders = [],
  blockedFolderIds = NO_BLOCKED_FOLDERS,
  onMoveToFolder,
  onNewFolder,
  onSelectAll,
  onDeselectAll,
  onClear,
  selectedTitles = [],
}: ChannelListBulkToolbarProps) {
  const t = useTranslations("desktop.channelList.bulk")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const empty = count === 0
  const allSelected = total != null && total > 0 && count >= total
  const selectedArchived = archivedCount ?? (archived ? count : 0)
  const selectedActive = count - selectedArchived
  // Nothing selected yet: draw the verbs the view will offer, disabled, so the
  // bar does not reshape under the first click.
  const offersActiveVerbs = empty ? !archived : selectedActive > 0
  const offersArchivedVerbs = empty ? archived : selectedArchived > 0
  const frozen = empty ? archived : selectedArchived > 0
  const bar = layout === "bar"

  const pinAction = allPinned
    ? onUnpin
      ? { label: t("unpin"), icon: <PinOffIcon className="size-3.5" />, run: onUnpin }
      : null
    : onPin
      ? { label: t("pin"), icon: <PinIcon className="size-3.5" />, run: onPin }
      : null
  const readAction = !offersActiveVerbs
    ? null
    : anyUnread
      ? onMarkRead
        ? {
            label: t("markRead"),
            icon: <MailOpenIcon className="size-3.5" />,
            run: onMarkRead,
            testId: "channel-list-bulk-mark-read",
          }
        : null
      : onMarkUnread
        ? {
            label: t("markUnread"),
            icon: <MailIcon className="size-3.5" />,
            run: onMarkUnread,
            testId: "channel-list-bulk-mark-unread",
          }
        : null
  const moveVisible =
    onMoveToFolder != null && !frozen && (folders.length > 0 || anyInFolder || onNewFolder != null)

  const countLabel = (
    <span
      className={cn("min-w-0 truncate", empty ? "text-muted-foreground" : "font-medium")}
      aria-live="polite"
      data-testid="channel-list-bulk-count"
    >
      {empty ? t("selectHint") : t("selectedCount", { count })}
    </span>
  )
  const linkClass = bar
    ? "h-7 shrink-0 px-2 text-xs font-medium text-primary hover:text-primary"
    : "h-6 shrink-0 px-1.5 text-[11px] font-medium text-primary hover:text-primary"
  const selectionControl =
    allSelected && onDeselectAll ? (
      <Button
        variant="ghost"
        size="xs"
        className={linkClass}
        onClick={onDeselectAll}
        data-testid="channel-list-bulk-deselect-all"
      >
        {t("deselectAll")}
      </Button>
    ) : !allSelected && onSelectAll && total != null && total > 0 ? (
      <Button
        variant="ghost"
        size="xs"
        className={linkClass}
        onClick={onSelectAll}
        data-testid="channel-list-bulk-select-all"
      >
        {t("selectAll", { count: total })}
      </Button>
    ) : null
  const doneButton = (
    <Button
      variant={bar ? "outline" : "ghost"}
      size="xs"
      className={cn(
        "shrink-0 font-medium",
        bar ? "h-7 px-2.5 text-xs" : "ml-auto h-6 px-2 text-[11px]"
      )}
      onClick={onClear}
      aria-label={t("done")}
      aria-keyshortcuts="Escape"
      title={t("done")}
      data-testid="channel-list-bulk-done"
    >
      {t("done")}
    </Button>
  )
  const verbs = (
    <>
      <ToolbarButton label={t("share")} disabled={empty} onClick={onShare} bar={bar}>
        <Link2Icon className="size-3.5" />
      </ToolbarButton>
      {moveVisible ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={empty}>
            <Button
              size={bar ? "sm" : "icon"}
              variant="ghost"
              className={bar ? "h-7 gap-1.5 px-2 text-xs" : "size-7"}
              aria-label={t("moveToFolder")}
              title={t("moveToFolder")}
              disabled={empty}
              data-testid="channel-list-bulk-move-to-folder"
            >
              <FolderInputIcon className="size-3.5" />
              {bar ? t("moveToFolder") : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {folders.some((folder) => blockedFolderIds.has(folder.id)) ? (
              <DropdownMenuLabel
                className="text-[11px] font-normal text-muted-foreground"
                data-testid="channel-list-bulk-folder-blocked-note"
              >
                {t("folderOtherWorkspace")}
              </DropdownMenuLabel>
            ) : null}
            {folders.map((folder) => (
              <DropdownMenuItem
                key={folder.id}
                disabled={blockedFolderIds.has(folder.id)}
                onSelect={() => void onMoveToFolder!(folder.id)}
                data-testid={`channel-list-bulk-folder-${folder.id}`}
              >
                <FolderIcon className="size-4" />
                <span className="truncate">{folder.name}</span>
              </DropdownMenuItem>
            ))}
            {onNewFolder ? (
              <>
                {folders.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  onSelect={() => void onNewFolder()}
                  data-testid="channel-list-bulk-folder-new"
                >
                  <FolderPlusIcon className="size-4" />
                  {t("newFolder")}
                </DropdownMenuItem>
              </>
            ) : null}
            {anyInFolder ? (
              <>
                {folders.length > 0 || onNewFolder ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  onSelect={() => void onMoveToFolder!(null)}
                  data-testid="channel-list-bulk-folder-none"
                >
                  {t("removeFromFolder")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {readAction ? (
        <ToolbarButton
          label={readAction.label}
          disabled={empty}
          onClick={() => void readAction.run()}
          testId={readAction.testId}
          bar={bar}
        >
          {readAction.icon}
        </ToolbarButton>
      ) : null}
      {pinAction && !frozen ? (
        <ToolbarButton
          label={pinAction.label}
          disabled={empty}
          onClick={() => void pinAction.run()}
          bar={bar}
        >
          {pinAction.icon}
        </ToolbarButton>
      ) : null}
      {offersActiveVerbs && onArchive ? (
        <ToolbarButton
          label={t("archive")}
          disabled={empty}
          onClick={() => void onArchive()}
          testId="channel-list-bulk-archive"
          bar={bar}
        >
          <ArchiveIcon className="size-3.5" />
        </ToolbarButton>
      ) : null}
      {offersArchivedVerbs && onUnarchive ? (
        <ToolbarButton
          label={t("unarchive")}
          disabled={empty}
          onClick={() => void onUnarchive()}
          testId="channel-list-bulk-unarchive"
          bar={bar}
        >
          <ArchiveRestoreIcon className="size-3.5" />
        </ToolbarButton>
      ) : null}
      {onDelete ? (
        <ToolbarButton
          label={t("delete")}
          disabled={empty}
          onClick={() => setConfirmOpen(true)}
          className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
          testId="channel-list-bulk-delete"
          bar={bar}
        >
          <Trash2Icon className="size-3.5" />
        </ToolbarButton>
      ) : null}
    </>
  )

  return (
    <div
      role="toolbar"
      aria-label={empty ? t("selectHint") : t("selectedCount", { count })}
      data-testid="channel-list-bulk-toolbar"
      data-empty={empty || undefined}
      data-layout={layout}
      className={cn(
        "overflow-hidden rounded-lg border border-border/70 bg-muted/40 text-xs",
        bar ? "flex flex-wrap items-center gap-1 px-2 py-1" : "mx-2 mb-2"
      )}
    >
      {bar ? (
        <>
          <div className="flex min-w-0 items-center gap-1 pr-1">
            {countLabel}
            {selectionControl}
          </div>
          {/* One line at any width: the verbs scroll sideways rather than
              wrap. Wrapped, five labelled verbs turned the bar into a
              three-row box on a phone, pushing the list half a screen down. */}
          <div
            className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
            data-testid="channel-list-bulk-actions"
          >
            {verbs}
          </div>
          {doneButton}
        </>
      ) : (
        <>
          <div className="flex h-7 items-center gap-1 pr-1 pl-2.5">
            {countLabel}
            {selectionControl}
            {doneButton}
          </div>
          <div
            className="flex items-center gap-0.5 border-t border-border/60 px-1 py-0.5"
            data-testid="channel-list-bulk-actions"
          >
            {verbs}
          </div>
        </>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-[90vw] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle", { count })}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          {selectedTitles.length > 0 ? (
            <ul
              className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 text-sm"
              data-testid="channel-list-bulk-delete-titles"
            >
              {selectedTitles.slice(0, DELETE_CONFIRM_TITLE_LIMIT).map((title, index) => (
                <li key={index} className="truncate">
                  {title}
                </li>
              ))}
              {selectedTitles.length > DELETE_CONFIRM_TITLE_LIMIT ? (
                <li className="text-xs text-muted-foreground">
                  {t("deleteConfirmMore", {
                    count: selectedTitles.length - DELETE_CONFIRM_TITLE_LIMIT,
                  })}
                </li>
              ) : null}
            </ul>
          ) : null}
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full sm:w-auto">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({
                variant: "destructive",
                className: "w-full sm:w-auto",
              })}
              onClick={() => {
                setConfirmOpen(false)
                void onDelete?.()
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * One verb on the action row. Icon-only on the rail, where it carries both an
 * accessible name and a hover title saying the same thing; icon and label on
 * the bar.
 */
function ToolbarButton({
  label,
  disabled,
  onClick,
  testId,
  className,
  bar = false,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  testId?: string
  className?: string
  bar?: boolean
  children: ReactNode
}) {
  return (
    <Button
      size={bar ? "sm" : "icon"}
      variant="ghost"
      className={cn(bar ? "h-7 gap-1.5 px-2 text-xs" : "size-7", className)}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {children}
      {bar ? <span>{label}</span> : null}
    </Button>
  )
}
