"use client"

// Open-file tab strip for the project editor. Beyond the original strip —
// filename, dirty dot, close, Save All — this carries the full tab workflow:
// a per-tab context menu (pin / close others / close right / close all /
// copy path / revert), middle-click to close, HTML5 drag-and-drop reorder,
// and an overflow dropdown listing every tab when the strip is crowded.
//
// One tab may be the *preview* tab (VS Code's italic tab): it holds the single
// slot a tree click reuses, so browsing does not bury the user in tabs. It is
// promoted to permanent by a double-click, by the pin button, or by editing it.

import { useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  CopyIcon,
  CrosshairIcon,
  MessageSquarePlusIcon,
  PinIcon,
  RotateCcwIcon,
  SaveIcon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import type { OpenFile } from "./use-project-editor"

interface Props {
  density?: "compact" | "touch"
  files: OpenFile[]
  activePath: string | null
  /** relPath of the single preview tab, when the host tracks one. */
  previewPath?: string | null
  /**
   * This strip belongs to an unfocused editor group — the active tab keeps
   * its background (it is still the group's selection) but loses the accent
   * bar and bright text, the way VS Code dims the unfocused group's tab.
   */
  inactive?: boolean
  dirtyCount: number
  onSelect: (relPath: string) => void
  onClose: (relPath: string) => void
  /** Promote the preview tab to permanent. Omitted by hosts without preview tabs. */
  onPin?: (relPath: string) => void
  onSaveAll: () => void
  /** Drag-reorder: move `fromRelPath` onto `toRelPath`'s slot. */
  onMove?: (fromRelPath: string, toRelPath: string) => void
  onCloseOthers?: (relPath: string) => void
  onCloseToRight?: (relPath: string) => void
  onCloseAll?: () => void
  /** Reopen the most recently closed tab (⌘⇧T). Hidden when the host keeps no history. */
  onReopenClosed?: () => void
  /** Copy `relPath` (relative) or `absolutePath` to the clipboard. */
  onCopyPath?: (relPath: string, absolute: boolean) => void
  /**
   * Reload the tab from disk — "Revert" on a dirty tab (discards the draft,
   * the host confirms), "Reload" on a clean one (refreshes a stale buffer).
   */
  onRevert?: (relPath: string) => void
  /** Move this editor into the other group — present only while split. */
  onMoveToOtherGroup?: (relPath: string) => void
  /** Scroll the explorer to this tab's file (VS Code's "Reveal in Explorer"). */
  onRevealInExplorer?: (relPath: string) => void
  /** Stage this tab's file as a chat context chip. */
  onAddToChat?: (relPath: string) => void
}

export const EDITOR_TAB_DRAG_MIME = "application/x-cognia-editor-tab"
const DRAG_MIME = EDITOR_TAB_DRAG_MIME

function revealTab(strip: HTMLDivElement, tab: HTMLButtonElement) {
  // Include the file's close/pin actions, and scroll this strip only: using
  // scrollIntoView here can move the chat or steal the editor's viewport.
  const target = tab.parentElement === strip ? tab : tab.parentElement!
  const bounds = strip.getBoundingClientRect()
  if (bounds.width <= 0) return
  const rect = target.getBoundingClientRect()
  const delta =
    rect.left < bounds.left
      ? rect.left - bounds.left
      : rect.right > bounds.right
        ? Math.min(rect.right - bounds.right, rect.left - bounds.left)
        : 0
  if (delta !== 0) strip.scrollLeft += delta
}

export function ProjectEditorTabs({
  density = "compact",
  files,
  activePath,
  previewPath = null,
  inactive = false,
  dirtyCount,
  onSelect,
  onClose,
  onPin,
  onSaveAll,
  onMove,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onReopenClosed,
  onCopyPath,
  onRevert,
  onMoveToOtherGroup,
  onRevealInExplorer,
  onAddToChat,
}: Props) {
  const t = useTranslations("projectEditor")
  // relPath being dragged over — paints the insertion indicator on that tab.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragRelPath = useRef<string | null>(null)
  // Overflow list state — a DropdownMenu that closes itself on pick.
  const [listOpen, setListOpen] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  // The roving tab stop: the active file's tab, or the first tab when the
  // active path is not open in this strip.
  const activeIndex = Math.max(
    0,
    files.findIndex((file) => file.relPath === activePath)
  )
  // Draft updates must not trigger geometry reads on every keystroke. Only
  // selection, tab order, and an actual strip resize need to reveal a tab.
  const tabOrder = JSON.stringify(files.map((file) => file.relPath))
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const reveal = () => {
      const tab = strip.querySelectorAll<HTMLButtonElement>('[role="tab"]')[activeIndex]
      if (tab) revealTab(strip, tab)
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [activeIndex, tabOrder])

  if (files.length === 0) return null

  const tabActions = (f: OpenFile) => {
    const dirty = f.draftContent !== f.savedContent
    const preview = previewPath === f.relPath
    const hasOthers = files.length > 1
    const idx = files.findIndex((x) => x.relPath === f.relPath)
    return (
      <ContextMenuContent data-testid={`editor-tab-menu-${f.relPath}`}>
        {preview && onPin ? (
          <ContextMenuItem onSelect={() => onPin(f.relPath)}>
            <PinIcon className="size-3.5" />
            {t("tabs.pin")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={() => onClose(f.relPath)}>
          <XIcon className="size-3.5" />
          {t("tabs.close")}
        </ContextMenuItem>
        {onCloseOthers ? (
          <ContextMenuItem disabled={!hasOthers} onSelect={() => onCloseOthers(f.relPath)}>
            {t("tabs.closeOthers")}
          </ContextMenuItem>
        ) : null}
        {onCloseToRight ? (
          <ContextMenuItem
            disabled={idx === -1 || idx === files.length - 1}
            onSelect={() => onCloseToRight(f.relPath)}
          >
            {t("tabs.closeToRight")}
          </ContextMenuItem>
        ) : null}
        {onCloseAll ? (
          <ContextMenuItem onSelect={onCloseAll}>{t("tabs.closeAll")}</ContextMenuItem>
        ) : null}
        {onMoveToOtherGroup ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onMoveToOtherGroup(f.relPath)}>
              {t("tabs.moveToOtherGroup")}
            </ContextMenuItem>
          </>
        ) : null}
        {onReopenClosed ? (
          <ContextMenuItem onSelect={onReopenClosed}>
            <RotateCcwIcon className="size-3.5" />
            {t("tabs.reopenClosed")}
          </ContextMenuItem>
        ) : null}
        {onRevert ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onRevert(f.relPath)}>
              <RotateCcwIcon className="size-3.5" />
              {dirty ? t("tabs.revert") : t("tabs.reload")}
            </ContextMenuItem>
          </>
        ) : null}
        {onCopyPath ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onCopyPath(f.relPath, false)}>
              <CopyIcon className="size-3.5" />
              {t("action.copyRelativePath")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onCopyPath(f.relPath, true)}>
              <CopyIcon className="size-3.5" />
              {t("action.copyPath")}
            </ContextMenuItem>
          </>
        ) : null}
        {onRevealInExplorer || onAddToChat ? <ContextMenuSeparator /> : null}
        {onRevealInExplorer ? (
          <ContextMenuItem onSelect={() => onRevealInExplorer(f.relPath)}>
            <CrosshairIcon className="size-3.5" />
            {t("tabs.revealInExplorer")}
          </ContextMenuItem>
        ) : null}
        {onAddToChat ? (
          <ContextMenuItem onSelect={() => onAddToChat(f.relPath)}>
            <MessageSquarePlusIcon className="size-3.5" />
            {t("action.addToChat")}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    )
  }

  return (
    <div
      className="@container/editor-tabs flex min-w-0 shrink-0 items-center border-b"
      data-testid="project-editor-tabs"
    >
      <div
        ref={stripRef}
        className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          const target = event.target
          if (!(target instanceof HTMLButtonElement) || target.getAttribute("role") !== "tab")
            return
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
          )
          const index = tabs.indexOf(target)
          if (index < 0) return
          const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
          let next: number
          switch (event.key) {
            case "ArrowLeft":
              next = (index + (rtl ? 1 : -1) + tabs.length) % tabs.length
              break
            case "ArrowRight":
              next = (index + (rtl ? -1 : 1) + tabs.length) % tabs.length
              break
            case "Home":
              next = 0
              break
            case "End":
              next = tabs.length - 1
              break
            default:
              return
          }
          event.preventDefault()
          tabs[next].focus({ preventScroll: true })
          revealTab(event.currentTarget, tabs[next])
          tabs[next].click()
        }}
      >
        {files.map((f, index) => {
          const dirty = f.draftContent !== f.savedContent
          const name = f.relPath.split("/").pop() ?? f.relPath
          const preview = previewPath === f.relPath
          const isActive = activePath === f.relPath
          return (
            <ContextMenu key={f.relPath}>
              <ContextMenuTrigger asChild>
                <div
                  role="presentation"
                  data-preview={preview ? "true" : undefined}
                  draggable={onMove !== undefined}
                  onDragStart={(e) => {
                    dragRelPath.current = f.relPath
                    e.dataTransfer.setData(DRAG_MIME, f.relPath)
                    e.dataTransfer.effectAllowed = "move"
                  }}
                  onDragEnd={() => {
                    dragRelPath.current = null
                    setDropTarget(null)
                  }}
                  onDragOver={(e) => {
                    if (!onMove || !e.dataTransfer.types.includes(DRAG_MIME)) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = "move"
                    if (dropTarget !== f.relPath) setDropTarget(f.relPath)
                  }}
                  onDragLeave={() => {
                    if (dropTarget === f.relPath) setDropTarget(null)
                  }}
                  onDrop={(e) => {
                    const from = e.dataTransfer.getData(DRAG_MIME) || dragRelPath.current
                    setDropTarget(null)
                    if (from && from !== f.relPath) onMove?.(from, f.relPath)
                  }}
                  className={cn(
                    "group relative flex shrink-0 items-center border-r text-sm",
                    isActive
                      ? inactive
                        ? "bg-muted/70"
                        : "bg-background"
                      : "bg-muted/40 hover:bg-muted",
                    dropTarget === f.relPath &&
                      "after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:bg-primary"
                  )}
                >
                  {/* Active tab gets a top accent — but only in the focused
                      group; the unfocused group's selection stays muted. */}
                  {isActive && !inactive ? (
                    <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" aria-hidden />
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={activeIndex === index ? 0 : -1}
                    data-testid={`editor-tab-${f.relPath}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 py-1.5 pl-3",
                      density === "touch" && "min-h-11 py-2",
                      preview && "italic",
                      isActive
                        ? inactive
                          ? "text-muted-foreground"
                          : "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => onSelect(f.relPath)}
                    onDoubleClick={() => onPin?.(f.relPath)}
                    onAuxClick={(e) => {
                      // Middle-click closes — the muscle memory every tab strip
                      // in a code editor is expected to honour.
                      if (e.button === 1) {
                        e.preventDefault()
                        onClose(f.relPath)
                      }
                    }}
                    title={
                      f.deletedOnDisk
                        ? t("deletedTab", { name: f.relPath })
                        : preview
                          ? t("previewTab", { name: f.relPath })
                          : f.relPath
                    }
                  >
                    <FileTypeIcon path={name} className="size-3.5 shrink-0" />
                    <span
                      className={cn(
                        "max-w-[min(12rem,45cqw)] truncate",
                        f.deletedOnDisk && "line-through decoration-destructive"
                      )}
                    >
                      {name}
                    </span>
                    {f.deletedOnDisk ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-destructive"
                        title={t("deletedOnDisk")}
                        aria-hidden
                      />
                    ) : f.externallyChanged ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-amber-500"
                        title={t("externallyChanged")}
                        aria-hidden
                      />
                    ) : null}
                  </button>
                  {preview && onPin ? (
                    <button
                      type="button"
                      aria-label={t("pinTab", { name })}
                      data-testid={`editor-tab-pin-${f.relPath}`}
                      className={cn(
                        "ml-1 rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100",
                        density === "touch" && "flex size-11 items-center justify-center"
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        onPin(f.relPath)
                      }}
                    >
                      <PinIcon className="size-3" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t("closeTab", { name })}
                    className={cn(
                      "mx-1 rounded p-0.5 hover:bg-accent",
                      density === "touch" && "flex size-11 items-center justify-center",
                      dirty ? "text-amber-500" : "opacity-60 group-hover:opacity-100"
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(f.relPath)
                    }}
                  >
                    {dirty ? (
                      <span className="size-2 rounded-full bg-amber-500" aria-hidden />
                    ) : (
                      <XIcon className="size-3" />
                    )}
                  </button>
                </div>
              </ContextMenuTrigger>
              {tabActions(f)}
            </ContextMenu>
          )
        })}
      </div>
      {files.length > 1 ? (
        <DropdownMenu open={listOpen} onOpenChange={setListOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("mx-0.5 size-7 shrink-0", density === "touch" && "size-10")}
              aria-label={t("tabs.listOpen")}
              data-testid="editor-tabs-list"
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-auto">
            {files.map((f) => {
              const name = f.relPath.split("/").pop() ?? f.relPath
              const dirty = f.draftContent !== f.savedContent
              return (
                <DropdownMenuItem
                  key={f.relPath}
                  className={cn("gap-2", activePath === f.relPath && "bg-accent")}
                  aria-current={activePath === f.relPath || undefined}
                  data-testid={`editor-tabs-list-${f.relPath}`}
                  onSelect={() => {
                    setListOpen(false)
                    onSelect(f.relPath)
                  }}
                >
                  <FileTypeIcon path={name} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{f.relPath}</span>
                  {dirty ? <span className="size-2 rounded-full bg-amber-500" aria-hidden /> : null}
                  {previewPath === f.relPath ? (
                    <span className="text-xs italic text-muted-foreground">
                      {t("tabs.preview")}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {dirtyCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn("mx-1 h-7 shrink-0 gap-1", density === "touch" && "h-10")}
          onClick={onSaveAll}
          data-testid="editor-save-all"
          aria-label={t("saveAll", { count: dirtyCount })}
          title={t("saveAll", { count: dirtyCount })}
        >
          <SaveIcon className="size-3.5" />
          <span className="hidden @[480px]/editor-tabs:inline">
            {t("saveAll", { count: dirtyCount })}
          </span>
        </Button>
      ) : null}
    </div>
  )
}
