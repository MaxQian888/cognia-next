"use client"

import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
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
            className={cn(
              "group flex min-h-11 shrink-0 items-center whitespace-nowrap md:min-h-0",
              active ? "border-l border-r bg-background" : "hover:bg-muted"
            )}
          >
            <Button
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={f.path}
              variant="ghost"
              onClick={() => onSelect(f.id)}
              className="h-full min-h-11 gap-2 rounded-none px-3 py-1.5 text-xs md:min-h-0"
            >
              <span className="max-w-[160px] truncate">{f.path}</span>
              {dirty && (
                <span data-testid={`dirty-${f.id}`} className="size-1.5 rounded-full bg-primary" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("closeTab", { path: f.path })}
              className="mr-1 opacity-60 hover:text-destructive hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                onClose(f.id, dirty)
              }}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
