"use client"

import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { EditorFile } from "@/stores/skills/skills-store"

interface Props {
  files: EditorFile[]
  activeFileId: string | null
  onSelect: (id: string) => void
  onClose: (id: string, dirty: boolean) => void
}

export function SkillTabStrip({ files, activeFileId, onSelect, onClose }: Props) {
  const t = useTranslations("skills.editor")
  return (
    <div role="tablist" className="flex items-center gap-px overflow-x-auto border-b bg-muted/30">
      {files.map((f) => {
        const dirty = f.draftContent !== f.savedContent
        const active = activeFileId === f.id
        return (
          <div
            key={f.id}
            role="tab"
            aria-selected={active}
            aria-label={f.path}
            onClick={() => onSelect(f.id)}
            className={cn(
              "group flex min-h-11 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap px-3 py-1.5 text-xs md:min-h-0",
              active ? "border-l border-r bg-background" : "hover:bg-muted"
            )}
          >
            <span className="max-w-[160px] truncate">{f.path}</span>
            {dirty && (
              <span data-testid={`dirty-${f.id}`} className="size-1.5 rounded-full bg-amber-500" />
            )}
            <button
              type="button"
              aria-label={t("closeTab", { path: f.path })}
              className="ml-1 rounded p-1.5 opacity-60 hover:bg-destructive/20 hover:opacity-100 md:p-0.5"
              onClick={(e) => {
                e.stopPropagation()
                onClose(f.id, dirty)
              }}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
