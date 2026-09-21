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

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, CopyIcon, PinIcon, RotateCcwIcon, SaveIcon, XIcon } from "lucide-react"
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
import type { ReactNode } from "react"

export interface ProjectEditorFixedTab {
  id: string
  label: string
  icon?: ReactNode
  active: boolean
  onSelect: () => void
}

interface Props {
  fixedTabs?: ProjectEditorFixedTab[]
  /** Controls that share the tab-strip row without participating in tab semantics. */
  trailingContent?: ReactNode
  density?: "compact" | "touch"
  files: OpenFile[]
  activePath: string | null
  /** relPath of the single preview tab, when the host tracks one. */
  previewPath?: string | null
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
  /** Discard the draft and reload from disk (dirty tabs only). */
  onRevert?: (relPath: string) => void
}

const DRAG_MIME = "application/x-cognia-editor-tab"

export function ProjectEditorTabs({
  fixedTabs = [],
  trailingContent,
  density = "compact",
  files,
  activePath,
  previewPath = null,
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
}: Props) {
  const t = useTranslations("projectEditor")
  // relPath being dragged over — paints the insertion indicator on that tab.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragRelPath = useRef<string | null>(null)
  // Overflow list state — a DropdownMenu that closes itself on pick.
  const [listOpen, setListOpen] = useState(false)

  if (files.length === 0 && fixedTabs.length === 0 && !trailingContent) return null

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
        {onReopenClosed ? (
          <ContextMenuItem onSelect={onReopenClosed}>
            <RotateCcwIcon className="size-3.5" />
            {t("tabs.reopenClosed")}
          </ContextMenuItem>
        ) : null}
        {dirty && onRevert ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onRevert(f.relPath)}>
              <RotateCcwIcon className="size-3.5" />
              {t("tabs.revert")}
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
      </ContextMenuContent>
    )
  }

  return (
    <div className="flex items-center border-b" data-testid="project-editor-tabs">
      <div
        className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
      >
        {fixedTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.active}
            data-testid={`editor-fixed-tab-${tab.id}`}
            className={cn(
              "relative flex shrink-0 items-center gap-1 border-r px-3 py-1.5 text-sm",
              density === "touch" && "min-h-11 py-2",
              tab.active
                ? "bg-background text-foreground"
                : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
            onClick={tab.onSelect}
          >
            {tab.active ? (
              <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" aria-hidden />
            ) : null}
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
        {files.map((f) => {
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
                    isActive ? "bg-background" : "bg-muted/40 hover:bg-muted",
                    dropTarget === f.relPath &&
                      "after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:bg-primary"
                  )}
                >
                  {/* Active tab gets a top accent — the cheapest cue that reads
                      at a glance without fighting the row's density. */}
                  {isActive ? (
                    <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" aria-hidden />
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    data-testid={`editor-tab-${f.relPath}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 py-1.5 pl-3",
                      density === "touch" && "min-h-11 py-2",
                      preview && "italic",
                      isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
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
                    title={preview ? t("previewTab", { name: f.relPath }) : f.relPath}
                  >
                    <FileTypeIcon path={name} className="size-3.5 shrink-0" />
                    <span className="max-w-[12rem] truncate">{name}</span>
                    {f.externallyChanged ? (
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
        >
          <SaveIcon className="size-3.5" />
          {t("saveAll", { count: dirtyCount })}
        </Button>
      ) : null}
      {trailingContent ? (
        <div className="shrink-0 px-1" data-testid="project-editor-tabs-trailing">
          {trailingContent}
        </div>
      ) : null}
    </div>
  )
}
