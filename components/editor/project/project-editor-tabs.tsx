"use client"

// Open-file tab strip for the project editor: filename, dirty dot, close, and
// a Save All affordance when any tab is dirty.
//
// One tab may be the *preview* tab (VS Code's italic tab): it holds the single
// slot a tree click reuses, so browsing does not bury the user in tabs. It is
// promoted to permanent by a double-click, by the pin button, or by editing it.

import { useTranslations } from "next-intl"
import { XIcon, SaveIcon, PinIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
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
}

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
}: Props) {
  const t = useTranslations("projectEditor")
  if (files.length === 0 && fixedTabs.length === 0 && !trailingContent) return null
  return (
    <div className="flex items-center border-b" data-testid="project-editor-tabs">
      <div className="flex min-w-0 flex-1 overflow-x-auto" role="tablist">
        {fixedTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.active}
            data-testid={`editor-fixed-tab-${tab.id}`}
            className={cn(
              "flex shrink-0 items-center gap-1 border-r px-3 py-1.5 text-sm",
              density === "touch" && "min-h-11 py-2",
              tab.active ? "bg-background" : "bg-muted/40 hover:bg-muted"
            )}
            onClick={tab.onSelect}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
        {files.map((f) => {
          const dirty = f.draftContent !== f.savedContent
          const name = f.relPath.split("/").pop() ?? f.relPath
          const preview = previewPath === f.relPath
          return (
            <div
              key={f.relPath}
              role="presentation"
              data-preview={preview ? "true" : undefined}
              className={cn(
                "group flex shrink-0 items-center border-r text-sm",
                activePath === f.relPath ? "bg-background" : "bg-muted/40 hover:bg-muted"
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activePath === f.relPath}
                tabIndex={activePath === f.relPath ? 0 : -1}
                data-testid={`editor-tab-${f.relPath}`}
                className={cn(
                  "flex cursor-pointer items-center gap-1 py-1.5 pl-3",
                  density === "touch" && "min-h-11 py-2",
                  preview && "italic"
                )}
                onClick={() => onSelect(f.relPath)}
                onDoubleClick={() => onPin?.(f.relPath)}
                title={preview ? t("previewTab", { name: f.relPath }) : f.relPath}
              >
                <span className="max-w-[12rem] truncate">{name}</span>
                {f.externallyChanged ? (
                  <span className="text-[10px] text-amber-500" title={t("externallyChanged")}>
                    ●
                  </span>
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
                {dirty ? <span className="text-xs">●</span> : <XIcon className="size-3" />}
              </button>
            </div>
          )
        })}
      </div>
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
