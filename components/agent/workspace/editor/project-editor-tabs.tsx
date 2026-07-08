"use client"

// Open-file tab strip for the project editor: filename, dirty dot, close, and
// a Save All affordance when any tab is dirty.

import { useTranslations } from "next-intl"
import { XIcon, SaveIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { OpenFile } from "./use-project-editor"

interface Props {
  files: OpenFile[]
  activePath: string | null
  dirtyCount: number
  onSelect: (relPath: string) => void
  onClose: (relPath: string) => void
  onSaveAll: () => void
}

export function ProjectEditorTabs({
  files,
  activePath,
  dirtyCount,
  onSelect,
  onClose,
  onSaveAll,
}: Props) {
  const t = useTranslations("agentTeamsWorkspace.editor")
  if (files.length === 0) return null
  return (
    <div className="flex items-center border-b" data-testid="project-editor-tabs">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {files.map((f) => {
          const dirty = f.draftContent !== f.savedContent
          const name = f.relPath.split("/").pop() ?? f.relPath
          return (
            <div
              key={f.relPath}
              role="tab"
              aria-selected={activePath === f.relPath}
              data-testid={`editor-tab-${f.relPath}`}
              className={cn(
                "group flex cursor-pointer items-center gap-1 border-r px-3 py-1.5 text-sm",
                activePath === f.relPath ? "bg-background" : "bg-muted/40 hover:bg-muted"
              )}
              onClick={() => onSelect(f.relPath)}
              title={f.relPath}
            >
              <span className="max-w-[12rem] truncate">{name}</span>
              {f.externallyChanged ? (
                <span className="text-[10px] text-amber-500" title={t("externallyChanged")}>
                  ●
                </span>
              ) : null}
              <button
                type="button"
                aria-label={t("closeTab", { name })}
                className={cn(
                  "ml-1 rounded p-0.5 hover:bg-accent",
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
          className="mx-1 h-7 shrink-0 gap-1"
          onClick={onSaveAll}
          data-testid="editor-save-all"
        >
          <SaveIcon className="size-3.5" />
          {t("saveAll", { count: dirtyCount })}
        </Button>
      ) : null}
    </div>
  )
}
